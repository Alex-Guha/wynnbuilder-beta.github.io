class SolverComboTotalNode extends ComputeNode {
    constructor() {
        super('solver-combo-total');
        this.fail_cb = true;
        this._last_registry_sig = '';
        this._spell_map_cache = null;
        this._registry_cache = null;
        this._health_config = null;
    }

    compute_func(input_map) {
        const build = input_map.get('build');
        const base_stats = input_map.get('base-stats');
        const spell_map = input_map.get('spells');
        const atree_mg = input_map.get('atree-merged');
        const total_elem = document.getElementById('combo-total-avg');

        // Extract health-related ability config from the merged atree.
        this._health_config = extract_health_config(atree_mg);

        if (!build || !base_stats || !spell_map || build.weapon.statMap.has('NONE')) {
            // Refresh with the raw spell map (no powder specials) for the invalid-build case.
            this._spell_map_cache = spell_map;
            if (spell_map) this._refresh_selection_spells(spell_map);
            if (total_elem) total_elem.textContent = '—';
            return null;
        }

        const weapon = build.weapon.statMap;

        // Augment spell map with damaging powder specials (Quake, Chain Lightning, Courage)
        // based on the weapon's element powder counts.
        const weapon_powders = weapon.get('powders') ?? [];
        const aug_spell_map = new Map(spell_map);
        for (const ps_idx of [0, 1, 3]) {  // Quake(earth), Chain Lightning(thunder), Courage(fire)
            const tier = get_element_powder_tier(weapon_powders, ps_idx);
            if (tier === 0) continue;
            aug_spell_map.set(-1000 - ps_idx, make_powder_special_spell(ps_idx, tier));
        }
        apply_deferred_powder_special_effects(aug_spell_map, spell_map);
        this._spell_map_cache = aug_spell_map;
        this._refresh_selection_spells(aug_spell_map);

        const registry = build_combo_boost_registry(atree_mg ?? new Map(), build);
        this._registry_cache = registry;
        this._refresh_selection_boosts(registry);
        this._apply_pending_selection_data();

        const crit_chance = skillPointsToPercentage(base_stats.get('dex'));

        let rows = this._read_combo_rows(aug_spell_map);
        const spell_to_spell_mode = this._health_config?.hp_casting ?? false;

        // Auto-fill combo time from spell sequence (count non-melee spell casts).
        // Only auto-fill in spell-to-spell mode (Blood Pact / HP casting builds).
        const ctime_inp = document.getElementById('combo-time');
        if (ctime_inp) ctime_inp.placeholder = spell_to_spell_mode ? 'auto' : 'sec';
        if (ctime_inp && ctime_inp.dataset.auto === 'true' && spell_to_spell_mode) {
            let adjAtkSpd_t = attackSpeeds.indexOf(base_stats.get('atkSpd'))
                + (base_stats.get('atkTier') ?? 0);
            adjAtkSpd_t = Math.max(0, Math.min(6, adjAtkSpd_t));
            const melee_period = 1 / baseDamageMultiplier[adjAtkSpd_t];

            let auto_time = 0;
            let melee_cd = 0;
            for (const { qty, spell, dom_row } of rows) {
                if (!spell) continue;
                const mana_excl = dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false;
                const recast_base = spell.mana_derived_from ?? spell.base_spell;
                const is_melee = recast_base === 0;
                if (is_melee && mana_excl) continue;
                for (let i = 0; i < qty; i++) {
                    if (is_melee) {
                        auto_time += melee_cd;
                        melee_cd = melee_period;
                    } else if (spell.cost != null) {
                        const spell_dt = SPELL_CAST_TIME + SPELL_CAST_DELAY;
                        const wall_dt = Math.max(spell_dt, melee_cd);
                        melee_cd = Math.max(0, melee_cd - wall_dt);
                        auto_time += wall_dt;
                    }
                }
            }
            // Flush any remaining melee cooldown at end of combo
            auto_time += melee_cd;
            ctime_inp.value = auto_time > 0 ? String(Math.round(auto_time * 100) / 100) : '';
        }

        // In spell-to-spell mode, run simulation pre-pass to determine per-row
        // Blood Pact bonus, corruption %, and health warnings. This also auto-fills
        // the calculated boost fields and Corrupted sliders, so the damage loop
        // reads the correct boost values.
        let sim_result = null;
        if (spell_to_spell_mode) {
            sim_result = simulate_spell_by_spell(
                rows, base_stats, aug_spell_map, registry, this._health_config, build);
            // Re-read rows so boost_tokens reflect auto-filled Blood Pact / Corrupted values.
            rows = this._read_combo_rows(aug_spell_map);
        }

        // Clear warning borders in tally mode (simulation sets them in spell-to-spell mode).
        if (!spell_to_spell_mode) {
            for (const row of document.querySelectorAll('#combo-selection-rows .combo-row-spell')) {
                row.classList.remove('combo-row-warning');
            }
        }

        // ── Pre-parse rows: extract DOM state for pure function ──
        const parsed_rows = [];
        for (const { qty, spell, boost_tokens, dom_row } of rows) {
            const spell_id = parseInt(dom_row?.querySelector('.combo-row-spell')?.value);
            const dmg_excl = dom_row?.querySelector('.combo-dmg-toggle')
                ?.classList.contains('dmg-excluded') ?? false;
            let pseudo = null;
            if (spell_id === MANA_RESET_SPELL_ID) pseudo = 'mana_reset';
            else {
                for (const [state_name, cancel_id] of STATE_CANCEL_IDS) {
                    if (spell_id === cancel_id) { pseudo = 'cancel_state:' + state_name; break; }
                }
            }
            // DPS hits override from DOM input
            const hits_inp = dom_row?.querySelector('.combo-row-hits');
            const dps_hits_override = hits_inp ? (parseFloat(hits_inp.value) || undefined) : undefined;
            parsed_rows.push({ qty, spell, boost_tokens, dmg_excl, pseudo, dps_hits_override, dom_row });
        }

        // ── Compute damage via shared pure function ──
        if (SOLVER_DEBUG_COMBO && sim_result) {
            console.log('[COMBO-DEBUG][PAGE] ═══ Page combo damage computation ═══');
            const item_names = build.equipment.map(it =>
                it.statMap.get('displayName') ?? it.statMap.get('name') ?? '').filter(n => n);
            console.log('[COMBO-DEBUG][PAGE] items:', item_names.join(', '));
            console.log('[COMBO-DEBUG][PAGE] sim results:', JSON.stringify(sim_result.row_results.map((r, i) => ({
                row: i, bp_bonus: Math.round(r.blood_pact_bonus * 100) / 100,
                states: r.state_values, hp_warn: r.hp_warning,
            }))));
            console.log('[COMBO-DEBUG][PAGE] sim end_mana:', sim_result.end_mana,
                'end_hp:', Math.round(sim_result.end_hp), 'max_hp:', sim_result.max_hp,
                'start_mana:', sim_result.start_mana);
        }
        const dmg_result = compute_combo_damage_totals(
            base_stats, weapon, parsed_rows, crit_chance, registry, atree_mg,
            { detailed: true, debug: SOLVER_DEBUG_COMBO });
        let total = dmg_result.total_damage;
        let total_heal = dmg_result.total_healing;

        // ── DOM update pass ──
        for (let i = 0; i < parsed_rows.length; i++) {
            const row = parsed_rows[i];
            const pr = dmg_result.per_row[i];
            const dom_row = row.dom_row;

            const dmg_wrap = dom_row?.querySelector('.combo-row-damage-wrap');
            const dmg_span = dmg_wrap?.querySelector('.combo-row-damage')
                ?? dom_row?.querySelector('.combo-row-damage');
            const dmg_popup = dmg_wrap?.querySelector('.combo-dmg-popup');
            const heal_span = dom_row?.querySelector('.combo-row-heal');

            if (!row.spell || row.qty <= 0 || row.pseudo) {
                if (dmg_span) dmg_span.textContent = '';
                if (dmg_popup) { dmg_popup.textContent = ''; }
                dmg_wrap?.classList.remove('has-popup', 'popup-locked');
                if (heal_span) heal_span.textContent = '';
                continue;
            }

            if (dmg_span) dmg_span.textContent = Math.round(pr.damage).toLocaleString()
                + (spell_is_dps(row.spell) && !pr.dps_info ? ' DPS' : '');

            if (heal_span) {
                if (pr.healing > 0) {
                    heal_span.textContent = '+' + Math.round(pr.healing).toLocaleString();
                } else {
                    heal_span.textContent = '';
                }
            }

            // DPS max label update
            if (pr.dps_info) {
                const max_rounded = Math.round(pr.dps_info.max_hits * 100) / 100;
                const max_lbl = dom_row?.querySelector('.combo-row-hits-max');
                if (max_lbl) max_lbl.textContent = '/' + max_rounded;
                const hits_inp = dom_row?.querySelector('.combo-row-hits');
                if (hits_inp) hits_inp.max = String(max_rounded);
            }

            // Populate the breakdown popup
            if (dmg_popup && pr.full_display && pr.full_display.avg > 0) {
                let popup_html = renderSpellPopupHTML(pr.full_display, crit_chance, pr.spell_cost);
                if (pr.dps_info) {
                    const hits_inp = dom_row?.querySelector('.combo-row-hits');
                    const hits = parseFloat(hits_inp?.value) || pr.dps_info.max_hits;
                    popup_html += '<div class="text-secondary small mt-1">'
                        + '\u00d7 ' + hits + ' hits = '
                        + Math.round(pr.full_display.avg * hits).toLocaleString() + '</div>';
                }
                dmg_popup.innerHTML = popup_html;
                dmg_wrap?.classList.add('has-popup');
            } else if (dmg_popup) {
                dmg_popup.textContent = '';
                dmg_wrap?.classList.remove('has-popup', 'popup-locked');
            }
        }

        // ── Tally-mode mana cost tracking (skipped in spell-to-spell mode) ──
        let mana_cost = 0;
        let melee_hits = 0;
        let recast_penalty_total = 0;
        const spell_costs = [];
        if (!spell_to_spell_mode) {
            let last_spell_base = null;
            let consecutive_count = 0;
            let penalty_counter = 0;

            for (let i = 0; i < parsed_rows.length; i++) {
                const row = parsed_rows[i];
                const pr = dmg_result.per_row[i];
                if (row.pseudo || !row.spell || row.qty <= 0) continue;
                const mana_excluded = row.dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false;
                if (mana_excluded) continue;

                if (row.spell.scaling === 'melee') melee_hits += row.qty;

                // Mana Reset resets recast counter
                if (row.pseudo === 'mana_reset') {
                    last_spell_base = null;
                    consecutive_count = 0;
                    penalty_counter = 0;
                    continue;
                }

                if (pr.spell_cost != null) {
                    const cost_per = pr.spell_cost;
                    let row_recast_penalty = 0;
                    const recast_base = row.spell.mana_derived_from ?? row.spell.base_spell;
                    const is_melee = recast_base === 0;
                    if (!is_melee) {
                        let is_switch = false;
                        if (recast_base !== last_spell_base) {
                            is_switch = true;
                            if (consecutive_count <= 1) {
                                penalty_counter = 0;
                            } else {
                                penalty_counter += 1;
                            }
                            consecutive_count = 0;
                            last_spell_base = recast_base;
                        }

                        if (is_switch && penalty_counter > 0) {
                            row_recast_penalty = penalty_counter * RECAST_MANA_PENALTY;
                            penalty_counter = 0;
                            consecutive_count = 1;
                            const remaining = row.qty - 1;
                            if (remaining > 0) {
                                const free_remaining = Math.min(remaining, 1);
                                const penalty_remaining = remaining - free_remaining;
                                if (penalty_remaining > 0) {
                                    row_recast_penalty += RECAST_MANA_PENALTY * penalty_remaining * (penalty_remaining + 1) / 2;
                                    penalty_counter = penalty_remaining;
                                }
                                consecutive_count += remaining;
                            }
                        } else if (penalty_counter > 0) {
                            row_recast_penalty = RECAST_MANA_PENALTY * (row.qty * penalty_counter + row.qty * (row.qty + 1) / 2);
                            penalty_counter += row.qty;
                            consecutive_count += row.qty;
                        } else {
                            const free_casts = Math.max(0, Math.min(row.qty, 2 - consecutive_count));
                            const penalty_casts = row.qty - free_casts;
                            if (penalty_casts > 0) {
                                row_recast_penalty = RECAST_MANA_PENALTY * penalty_casts * (penalty_casts + 1) / 2;
                                penalty_counter = penalty_casts;
                            }
                            consecutive_count += row.qty;
                        }
                    }

                    mana_cost += cost_per * row.qty + row_recast_penalty;
                    recast_penalty_total += row_recast_penalty;
                    spell_costs.push({ name: row.spell.name, qty: row.qty, cost: cost_per, recast_penalty: row_recast_penalty });
                }
            }
        }

        // Normalize damage & heal columns: measure the widest span in each
        // column and apply that as min-width so all rows line up.
        const sel_rows_el = document.getElementById('combo-selection-rows');
        if (sel_rows_el) {
            const dmg_spans = sel_rows_el.querySelectorAll('.combo-row-damage');
            const heal_spans = sel_rows_el.querySelectorAll('.combo-row-heal');
            const any_has_heal = [...heal_spans].some(s => s.textContent !== '');

            // Reset min-width so we measure natural widths.
            for (const ds of dmg_spans) ds.style.minWidth = '';
            for (const hs of heal_spans) {
                hs.style.minWidth = '';
                hs.style.display = any_has_heal ? '' : 'none';
                hs.style.visibility = '';
            }

            // Damage column — always present.
            let max_dmg = 0;
            for (const ds of dmg_spans) max_dmg = Math.max(max_dmg, ds.offsetWidth);
            for (const ds of dmg_spans) ds.style.minWidth = max_dmg + 'px';

            // Heal column — only when at least one row has healing.
            if (any_has_heal) {
                let max_heal = 0;
                for (const hs of heal_spans) max_heal = Math.max(max_heal, hs.offsetWidth);
                for (const hs of heal_spans) {
                    hs.style.minWidth = max_heal + 'px';
                    hs.style.visibility = hs.textContent ? '' : 'hidden';
                }
            }
        }

        if (total_elem) total_elem.textContent = Math.round(total).toLocaleString();

        if (spell_to_spell_mode && sim_result) {
            // Spell-to-spell mode: use simulation results for mana/health display.
            this._update_mana_display(base_stats, sim_result.total_mana_cost,
                sim_result.spell_costs, sim_result.has_transcendence,
                sim_result.melee_hits, sim_result.recast_penalty_total,
                sim_result);
        } else {
            // Tally mode: standard mana display.
            const has_transcendence = build.statMap.get('activeMajorIDs')?.has('ARCANES') ?? false;
            if (has_transcendence) mana_cost *= 0.75;
            this._update_mana_display(base_stats, mana_cost, spell_costs, has_transcendence, melee_hits, recast_penalty_total);
        }

        // Schedule a hash update; combo data is encoded into the URL hash.
        _schedule_solver_hash_update();
        return null;
    }

    /**
     * Shared row iterator: extracts raw DOM state from each combo row.
     * Returns [{row, qty, spell_id, toggles, sliders, calcs}] where
     * toggles/sliders/calcs are NodeLists of active boost elements.
     */
    _iterate_combo_rows() {
        const rows = [];
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const qty = parseFloat(row.querySelector('.combo-row-qty')?.value) || 0;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            const toggles = row.querySelectorAll('.combo-row-boost-toggle.toggleOn');
            const sliders = row.querySelectorAll('.combo-row-boost-slider');
            const calcs = row.querySelectorAll('.combo-row-boost-calc');
            rows.push({ row, qty, spell_id, toggles, sliders, calcs });
        }
        return rows;
    }

    /** Read rows for calculation — returns [{qty, spell, boost_tokens, dom_row}]. */
    _read_combo_rows(spell_map) {
        return this._iterate_combo_rows().map(({ row, qty, spell_id, toggles, sliders, calcs }) => {
            const spell = spell_map.get(spell_id) ?? null;
            // Only DPS spells without a Total/Max hit-count part allow decimal
            // qty (representing duration in seconds).  All others are integer.
            const dps_info = spell ? compute_dps_spell_hits_info(spell) : null;
            const allow_decimal = spell_is_dps(spell) && !dps_info;
            const eff_qty = allow_decimal ? qty : Math.round(qty);
            const boost_tokens = [];
            for (const btn of toggles) {
                boost_tokens.push({ name: btn.dataset.boostName, value: 1, is_pct: false });
            }
            for (const inp of sliders) {
                const val = parseFloat(inp.value) || 0;
                const rm = parseInt(inp.dataset.realMin || '0');
                if (val > 0 && (rm === 0 || val >= rm)) {
                    const tok = { name: inp.dataset.boostName, value: val, is_pct: false };
                    if (inp.dataset.auto === 'false') tok.manual = true;
                    boost_tokens.push(tok);
                }
            }
            // Calculated boost fields (Blood Pact): read the value as a percentage token.
            for (const inp of calcs) {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) boost_tokens.push({ name: inp.dataset.boostName, value: val, is_pct: true });
            }
            return { qty: eff_qty, spell, boost_tokens, dom_row: row };
        });
    }

    // ── Model read / write (cross-mode sync, URL, clipboard) ─────────────────

    /** Read rows as plain data [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}]. */
    _read_rows_as_data() {
        return this._read_selection_rows_as_data();
    }

    _read_selection_rows_as_data() {
        return this._iterate_combo_rows().map(({ row, qty, spell_id, toggles, sliders, calcs }) => {
            const spell = this._spell_map_cache?.get(spell_id);
            // Only DPS spells without a Total/Max part allow decimal qty.
            const dps_info = spell ? compute_dps_spell_hits_info(spell) : null;
            const allow_decimal = spell_is_dps(spell) && !dps_info;
            if (!allow_decimal) qty = Math.round(qty);
            let spell_name = spell?.name ?? '';
            if (spell_id === MANA_RESET_SPELL_ID) spell_name = 'Mana Reset';
            else {
                for (const [state_name, cancel_id] of STATE_CANCEL_IDS) {
                    if (spell_id === cancel_id) { spell_name = 'Cancel ' + state_name; break; }
                }
            }
            const boost_parts = [];
            for (const btn of toggles) {
                boost_parts.push(btn.dataset.boostName);
            }
            for (const inp of sliders) {
                const val = parseFloat(inp.value) || 0;
                const rm = parseInt(inp.dataset.realMin || '0');
                if (val > 0 && (rm === 0 || val >= rm)) boost_parts.push(inp.dataset.boostName + ' ' + val);
            }
            for (const inp of calcs) {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) boost_parts.push(inp.dataset.boostName + ' ' + val + '%');
            }
            const mana_excl = row.querySelector('.combo-mana-toggle')
                ?.classList.contains('mana-excluded') ?? false;
            const dmg_excl = row.querySelector('.combo-dmg-toggle')
                ?.classList.contains('dmg-excluded') ?? false;
            // DPS hits (only present for DPS spells with a Total/Max part).
            const hits_inp = row.querySelector('.combo-row-hits');
            const hits = hits_inp ? parseFloat(hits_inp.value) || 0 : undefined;
            return { qty, spell_name, boost_tokens_text: boost_parts.join(', '), mana_excl, dmg_excl, hits };
        });
    }

    /** Replace rows from data (import, URL restore). */
    _write_rows_from_data(data) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;
        container.innerHTML = '';
        for (const { qty, spell_name, spell_value, boost_tokens_text, mana_excl, dmg_excl, hits } of data) {
            const row = _build_selection_row(qty, spell_name, boost_tokens_text, mana_excl, dmg_excl, spell_value);
            if (hits !== undefined && hits !== null) row.dataset.pendingHits = String(hits);
            container.appendChild(row);
        }
    }

    /**
     * After _refresh_selection_spells/_boosts run, apply any data-pending-*
     * attributes set on rows by _build_selection_row (from mode switch / URL restore).
     */
    _apply_pending_selection_data() {
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const ps = row.dataset.pendingSpell;
            const psv = row.dataset.pendingSpellValue;
            const pb = row.dataset.pendingBoosts;
            const pm = row.dataset.pendingManaExcl;
            const pd = row.dataset.pendingDmgExcl;
            if (ps === undefined && psv === undefined && pb === undefined && pm === undefined && pd === undefined) continue;

            if (ps !== undefined || psv !== undefined) {
                delete row.dataset.pendingSpell;
                delete row.dataset.pendingSpellValue;
                const sel = row.querySelector('.combo-row-spell');
                if (sel) {
                    let matched = false;
                    const available_opts = [...sel.options].map(o => `${o.value}=${o.textContent}`);
                    // console.log('[combo pending] ps=', JSON.stringify(ps), 'psv=', JSON.stringify(psv),
                    //     'options=', available_opts);
                    // Prefer direct value match (from URL decode) — immune to name changes
                    // from replacement abilities.
                    if (psv && [...sel.options].some(o => o.value === psv)) {
                        sel.value = psv;
                        matched = true;
                        // console.log('[combo pending] matched by value, sel.value=', sel.value,
                        //     'text=', sel.options[sel.selectedIndex]?.textContent);
                    }
                    // Fall back to name match (from clipboard import, which has no spell_value)
                    if (!matched && ps) {
                        const name_l = ps.toLowerCase();
                        for (const opt of sel.options) {
                            // Strip " (Powder Special)" suffix for comparison so powder specials restore correctly.
                            const opt_name = opt.textContent.toLowerCase().replace(/\s*\(powder special\)$/, '');
                            if (opt_name === name_l) { sel.value = opt.value; matched = true; break; }
                        }
                        // console.log('[combo pending] name match result: matched=', matched, 'sel.value=', sel.value);
                    }
                    if (!matched) console.warn('[combo pending] NO MATCH for ps/psv');
                }
            }
            if (pb !== undefined) {
                delete row.dataset.pendingBoosts;
                if (pb) {
                    const area = row.querySelector('.combo-row-boosts');
                    if (area) {
                        for (const { name, value } of parse_combo_boost_tokens(pb)) {
                            const nl = name.toLowerCase();
                            for (const btn of area.querySelectorAll('.combo-row-boost-toggle')) {
                                const bn = btn.dataset.boostName.toLowerCase();
                                if (bn === nl || bn === 'activate ' + nl) btn.classList.add('toggleOn');
                            }
                            for (const inp of area.querySelectorAll('.combo-row-boost-slider')) {
                                const bn = inp.dataset.boostName.toLowerCase();
                                if (bn === nl || bn === 'activate ' + nl) {
                                    inp.value = String(value);
                                    // Mark manually-set auto-fill sliders (e.g. Corrupted)
                                    if (inp.dataset.auto !== undefined) inp.dataset.auto = 'false';
                                }
                            }
                            for (const inp of area.querySelectorAll('.combo-row-boost-calc')) {
                                const bn = inp.dataset.boostName.toLowerCase();
                                if (bn === nl || bn === 'activate ' + nl) {
                                    inp.value = String(value);
                                    inp.dataset.auto = 'false';
                                }
                            }
                        }
                    }
                    // Auto-toggle: if Emboldening Cry is on, ensure War Scream is too
                    const ec = area.querySelector('.combo-row-boost-toggle[data-boost-name="Emboldening Cry"]');
                    const ws = area.querySelector('.combo-row-boost-toggle[data-boost-name="War Scream"]');
                    if (ec?.classList.contains('toggleOn') && ws && !ws.classList.contains('toggleOn')) {
                        ws.classList.add('toggleOn');
                    }
                }
                // Re-evaluate highlight now that boost state has been restored.
                _update_boost_btn_highlight(row);
            }
            if (pm !== undefined) {
                delete row.dataset.pendingManaExcl;
                if (pm === '1') {
                    row.querySelector('.combo-mana-toggle')?.classList.add('mana-excluded');
                }
            }
            if (pd !== undefined) {
                delete row.dataset.pendingDmgExcl;
                if (pd === '1') {
                    row.querySelector('.combo-dmg-toggle')?.classList.add('dmg-excluded');
                }
            }
        }
    }

    /** Repopulate spell <select> options in selection-mode rows. */
    _refresh_selection_spells(spell_map) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;

        const all_selectable = [...spell_map.entries()]
            .filter(([, s]) => spell_has_damage(s) || spell_has_heal(s) || s.cost != null);
        // Regular spells (positive IDs) sorted ascending; powder specials (negative IDs) last.
        const regular = all_selectable.filter(([id]) => id >= 0).sort((a, b) => a[0] - b[0]);
        const powder = all_selectable.filter(([id]) => id < 0).sort((a, b) => b[0] - a[0]);
        const selectable = [...regular, ...powder];

        for (const row of container.querySelectorAll('.combo-row')) {
            const sel = row.querySelector('.combo-row-spell');
            if (!sel) continue;
            const cur = sel.value;
            sel.innerHTML = '<option value="">— Select Attack —</option>';
            for (const [id, s] of selectable) {
                const opt = document.createElement('option');
                opt.value = String(id);
                opt.textContent = s._is_powder_special ? s.name + ' (Powder Special)' : s.name;
                sel.appendChild(opt);
            }
            // Mana Reset pseudo-spell: resets the spell recast counter.
            const reset_opt = document.createElement('option');
            reset_opt.value = String(MANA_RESET_SPELL_ID);
            reset_opt.textContent = 'Mana Reset';
            sel.appendChild(reset_opt);
            // Cancel pseudo-spells: data-driven from buff_state effects.
            for (const bs of (this._health_config?.buff_states ?? [])) {
                if (bs.deactivate === 'cancel') {
                    const cancel_id = get_cancel_spell_id(bs.state_name);
                    if (cancel_id == null) continue;
                    const opt = document.createElement('option');
                    opt.value = String(cancel_id);
                    opt.textContent = 'Cancel ' + bs.state_name;
                    sel.appendChild(opt);
                }
            }

            if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
        }
    }

    /** Repopulate boost toggle/slider controls in selection-mode rows. */
    _refresh_selection_boosts(registry) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;

        const sig = registry.map(e => {
            let s = e.name + ':' + e.type + (e.max != null ? ':' + e.max : '');
            if (e.stat_bonuses.length) s += '|' + e.stat_bonuses.map(b => b.key).join('+');
            if (e.prop_bonuses.length) s += '|' + e.prop_bonuses.map(p => p.ref).join('+');
            return s;
        }).join(',');
        const registry_changed = sig !== this._last_registry_sig;
        if (registry_changed) this._last_registry_sig = sig;

        for (const row of container.querySelectorAll('.combo-row')) {
            const area = row.querySelector('.combo-row-boosts');
            if (!area) continue;

            // Skip rows that already have controls and the registry hasn't changed
            // AND the spell's DPS hits status hasn't changed AND the spell hasn't changed.
            // Always populate rows with empty boost areas (newly added or from mode switch).
            let cur_spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            if (isNaN(cur_spell_id) && row.dataset.pendingSpellValue) {
                cur_spell_id = parseInt(row.dataset.pendingSpellValue);
            }
            const cur_spell_id_str = String(cur_spell_id ?? '');
            const spell_changed = area.dataset.renderedSpellId !== cur_spell_id_str;
            if (!registry_changed && !spell_changed && area.children.length > 0) {
                const cur_spell = this._spell_map_cache?.get(cur_spell_id) ?? null;
                const cur_dps = cur_spell ? compute_dps_spell_hits_info(cur_spell) : null;
                const has_hits_el = !!area.querySelector('.combo-row-hits');
                if (!!cur_dps === has_hits_el) continue;
            }

            // Save existing values.
            const old_toggle = new Map();
            const old_slider = new Map();
            const old_auto = new Map();
            for (const b of area.querySelectorAll('.combo-row-boost-toggle')) {
                old_toggle.set(b.dataset.boostName, b.classList.contains('toggleOn'));
            }
            for (const i of area.querySelectorAll('.combo-row-boost-calc')) {
                old_slider.set(i.dataset.boostName, i.value);
                if (i.dataset.auto !== undefined) old_auto.set(i.dataset.boostName, i.dataset.auto);
            }
            for (const i of area.querySelectorAll('.combo-row-boost-slider')) {
                old_slider.set(i.dataset.boostName, i.value);
                if (i.dataset.auto !== undefined) old_auto.set(i.dataset.boostName, i.dataset.auto);
            }
            const old_hits = area.querySelector('.combo-row-hits')?.value ?? null;

            area.innerHTML = '';

            // DPS hits input: render at the top when the row's spell is a
            // DPS ability with a discoverable Total/Max aggregate.
            // Also check pendingSpellValue for URL-restore (spell may not be set yet).
            let spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            if (isNaN(spell_id) && row.dataset.pendingSpellValue) {
                spell_id = parseInt(row.dataset.pendingSpellValue);
            }
            const spell = this._spell_map_cache?.get(spell_id) ?? null;
            const dps_info = spell ? compute_dps_spell_hits_info(spell) : null;
            if (dps_info) {
                const wrap = document.createElement('div');
                wrap.className = 'd-inline-flex align-items-center gap-1 m-1 combo-row-hits-wrap';
                const lbl = document.createElement('span');
                lbl.className = 'text-secondary small text-nowrap';
                lbl.textContent = 'Hits:';
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.className = 'combo-row-input combo-row-hits';
                inp.style.cssText = 'width:4.5em; text-align:center;';
                inp.min = '0';
                inp.step = 'any';
                const max_rounded = Math.round(dps_info.max_hits * 100) / 100;
                inp.max = String(max_rounded);
                inp.value = old_hits ?? row.dataset.pendingHits ?? String(max_rounded);
                if (row.dataset.pendingHits !== undefined) delete row.dataset.pendingHits;
                const max_lbl = document.createElement('span');
                max_lbl.className = 'text-secondary small combo-row-hits-max';
                max_lbl.textContent = '/' + max_rounded;
                inp.addEventListener('input', () => {
                    _update_boost_btn_highlight(row);
                    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
                });
                wrap.append(lbl, inp, max_lbl);
                area.appendChild(wrap);
                const sep = document.createElement('hr');
                sep.className = 'my-1';
                area.appendChild(sep);
            }

            // DPS spells without a Total/Max hit-count part: allow decimal qty
            // (the qty field represents duration in seconds, not discrete casts).
            const qty_inp = row.querySelector('.combo-row-qty');
            if (qty_inp) {
                const is_dps_no_hits = spell_is_dps(spell) && !dps_info;
                if (is_dps_no_hits) {
                    qty_inp.step = 'any';
                } else {
                    qty_inp.step = '1';
                    // Round to integer when switching away from a decimal-qty spell.
                    const cur = parseFloat(qty_inp.value);
                    if (cur !== Math.round(cur)) qty_inp.value = String(Math.round(cur));
                }
            }

            // Render toggles first, then sliders (with max-modifier toggles).
            // Filter by relevance to the selected spell.
            const toggles = registry.filter(e => e.type === 'toggle' && is_boost_relevant(e, spell));
            const sliders = registry.filter(e => e.type === 'slider' && is_boost_relevant(e, spell));

            for (const entry of toggles) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-sm button-boost border-0 text-white dark-8u dark-shadow-sm m-1 combo-row-boost-toggle';
                btn.dataset.boostName = entry.name;
                btn.textContent = entry.name;
                if (old_toggle.get(entry.name)) btn.classList.add('toggleOn');
                btn.addEventListener('click', () => {
                    btn.classList.toggle('toggleOn');
                    // Auto-toggle: Emboldening Cry ON → War Scream ON
                    if (btn.dataset.boostName === 'Emboldening Cry' && btn.classList.contains('toggleOn')) {
                        const ws = area.querySelector('.combo-row-boost-toggle[data-boost-name="War Scream"]');
                        if (ws && !ws.classList.contains('toggleOn')) ws.classList.add('toggleOn');
                    }
                    // Auto-toggle: War Scream OFF → Emboldening Cry OFF
                    if (btn.dataset.boostName === 'War Scream' && !btn.classList.contains('toggleOn')) {
                        const ec = area.querySelector('.combo-row-boost-toggle[data-boost-name="Emboldening Cry"]');
                        if (ec && ec.classList.contains('toggleOn')) ec.classList.remove('toggleOn');
                    }
                    _update_boost_btn_highlight(row);
                    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
                });
                area.appendChild(btn);
            }

            if (toggles.length > 0 && sliders.length > 0) {
                const sep = document.createElement('hr');
                sep.className = 'my-1';
                area.appendChild(sep);
            }

            for (const entry of sliders) {
                const wrap = document.createElement('div');
                wrap.className = 'd-inline-flex align-items-center gap-1 m-1';
                const lbl = document.createElement('span');
                lbl.className = 'text-secondary small text-nowrap';
                lbl.textContent = (entry.display_label ?? entry.name) + ':';
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.className = 'combo-row-input combo-row-boost-slider';
                inp.style.cssText = 'width:4em; text-align:center;';
                inp.dataset.boostName = entry.name;
                const real_min = entry.min ?? 0;
                const off_pos = real_min > 0 ? real_min - (entry.step ?? 1) : 0;
                inp.min = String(off_pos);
                if (real_min > 0) inp.dataset.realMin = String(real_min);
                const effective_max = Math.min(entry.max ?? 100, BOOST_SLIDER_MAX);
                inp.max = String(effective_max);
                // Auto-fill sliders: simulation-driven sliders (Corrupted, Blood Pact, etc.)
                const _is_auto_bp = this._health_config?.damage_boost?.slider_name === entry.name;
                const _is_auto_state = (this._health_config?.buff_states ?? []).some(bs => bs.slider_name === entry.name);
                const _is_auto_slider = _is_auto_bp || _is_auto_state;
                if (_is_auto_bp) {
                    // Blood Pact: percentage display with decimal precision
                    inp.step = '0.1';
                    inp.style.cssText = 'width:4.5em; text-align:center;';
                    inp.placeholder = 'auto';
                    inp.value = old_slider.get(entry.name) ?? '';
                } else {
                    inp.step = String(entry.step ?? 1);
                    inp.value = old_slider.get(entry.name) ?? String(off_pos);
                }
                if (_is_auto_slider) {
                    inp.dataset.auto = old_auto.get(entry.name) ?? 'true';
                }
                const max_lbl = document.createElement('span');
                max_lbl.className = 'text-secondary small';
                max_lbl.textContent = _is_auto_bp ? '' : '/' + effective_max;
                _wire_encoding_cap(inp, 0, BOOST_SLIDER_MAX);
                inp.addEventListener('input', () => {
                    // Mark manual edit for auto-fill sliders
                    if (inp.dataset.auto !== undefined) {
                        inp.dataset.auto = 'false';
                    }
                    _update_boost_btn_highlight(row);
                    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
                });
                wrap.append(lbl, inp, max_lbl);
                area.appendChild(wrap);
            }
            _update_boost_btn_highlight(row);
            area.dataset.renderedSpellId = cur_spell_id_str;
            const boost_btn_el = row.querySelector('.combo-boost-menu-btn');
            const any_visible = toggles.length > 0 || sliders.length > 0;
            if (boost_btn_el) boost_btn_el.disabled = (!any_visible && !dps_info);
        }
    }

    /** Update the mana display below the combo total. */
    _update_mana_display(base_stats, mana_cost, spell_costs = [], has_transcendence = false, melee_hits = 0, recast_penalty_total = 0, sim_result = null) {
        const mana_row = document.getElementById('combo-mana-row');
        const mana_elem = document.getElementById('combo-mana-display');
        const health_elem = document.getElementById('combo-health-display');
        const mana_tooltip = document.getElementById('combo-mana-tooltip');
        const time_inp = document.getElementById('combo-time');
        const downtime_btn = document.getElementById('combo-downtime-btn');
        if (!mana_elem) return;

        const time_str = time_inp?.value?.trim() ?? '';
        if (!time_str && !sim_result) {
            if (mana_row) mana_row.style.display = 'none';
            mana_elem.textContent = '';
            if (health_elem) { health_elem.textContent = ''; health_elem.style.display = 'none'; }
            return;
        }

        const combo_time = parseFloat(time_str) || 0;
        const allow_down = downtime_btn?.classList.contains('toggleOn') ?? false;
        const mr = base_stats.get('mr') ?? 0;
        const ms = base_stats.get('ms') ?? 0;
        const item_mana = base_stats.get('maxMana') ?? 0;
        const int_mana = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
        const start_mana = 100 + item_mana + int_mana;

        let end_mana, deficit;
        if (sim_result) {
            // Spell-to-spell mode: simulation tracked mana directly
            end_mana = sim_result.end_mana;
            deficit = start_mana - end_mana;
        } else {
            // Tally mode: compute end mana from totals
            const mana_regen = ((mr + BASE_MANA_REGEN) / 5) * combo_time;
            let mana_steal = 0;
            if (ms && melee_hits > 0) {
                let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
                    + (base_stats.get('atkTier') ?? 0);
                adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
                mana_steal = melee_hits * ms / 3 / baseDamageMultiplier[adjAtkSpd];
            }
            const flat_mana = parseFloat(document.getElementById('flat-mana-input')?.value) || 0;
            end_mana = start_mana - mana_cost + mana_regen + mana_steal + flat_mana;
            deficit = start_mana - end_mana;
        }

        let text = `Mana: ${Math.round(end_mana)}/${start_mana}`;
        if (!allow_down && !sim_result && deficit > 5) {
            text += ' \u26a0 not sustainable (\u2212' + Math.round(deficit) + ')';
            mana_elem.className = 'small text-warning';
        } else {
            mana_elem.className = 'small text-secondary';
        }
        mana_elem.textContent = text;
        if (mana_row) mana_row.style.display = '';

        // Health display (spell-to-spell mode only)
        if (health_elem) {
            if (sim_result) {
                let hp_text = `HP: ${Math.round(sim_result.end_hp)}/${sim_result.max_hp}`;
                const any_hp_warning = sim_result.row_results?.some(r => r.hp_warning);
                if (sim_result.end_hp <= 0) {
                    hp_text += ' \u26a0 lethal';
                } else if (any_hp_warning) {
                    hp_text += ' \u26a0 insufficient HP';
                }
                health_elem.textContent = ' | ' + hp_text;
                health_elem.className = (sim_result.end_hp <= 0 || any_hp_warning)
                    ? 'small text-danger' : 'small text-secondary';
                health_elem.style.display = '';
            } else {
                health_elem.textContent = '';
                health_elem.style.display = 'none';
            }
        }

        if (mana_tooltip) {
            const fmt = n => (n >= 0 ? '+' : '\u2212') + Math.abs(Math.round(n));
            let html = '';
            if (spell_costs.length) {
                for (const { name, qty, cost, recast_penalty } of spell_costs) {
                    const base_total = cost * qty;
                    const row_total = base_total + (recast_penalty || 0);
                    let line = qty > 1
                        ? `${qty}\u00d7 ${name}: ${Math.round(cost)}`
                        : `${name}: ${Math.round(cost)}`;
                    if (recast_penalty > 0) {
                        line += ` (+${Math.round(recast_penalty)} recast)`;
                    }
                    if (qty > 1 || recast_penalty > 0) {
                        line += ` \u2192 ${Math.round(row_total)}`;
                    }
                    html += `<div>${line}</div>`;
                }
                if (recast_penalty_total > 0) {
                    html += `<div class="text-warning small">Recast penalty total: +${Math.round(recast_penalty_total)}</div>`;
                }
                html += '<hr class="my-1 border-secondary">';
            }
            let start_str = '100';
            if (item_mana || int_mana) {
                if (item_mana) start_str += ` + ${item_mana} item`;
                if (int_mana) start_str += ` + ${int_mana} int`;
                start_str += ` = ${start_mana}`;
            }
            let cost_str = fmt(-mana_cost);
            if (has_transcendence) cost_str += ' (\u00d70.75 Transcendence)';
            html +=
                `<div>Starting mana: ${start_str}</div>` +
                `<div>Spell costs: ${cost_str}</div>`;

            if (sim_result) {
                // Spell-to-spell mode: show simulation-based regen info
                html += `<div>Mana/HP tracked per-cast (spell-to-spell mode)</div>`;
                html += `<hr class="my-1 border-secondary">`;
                html += `<div>Ending mana: ${Math.round(sim_result.end_mana)} / ${start_mana}</div>`;
                html += `<div>Ending HP: ${Math.round(sim_result.end_hp)} / ${sim_result.max_hp}</div>`;
            } else {
                const mana_regen = ((mr + BASE_MANA_REGEN) / 5) * combo_time;
                html += `<div>Regen \u00d7${combo_time}s: ${fmt(mana_regen)} (${mr + BASE_MANA_REGEN}/5s)</div>`;
                let mana_steal = 0;
                if (ms && melee_hits > 0) {
                    let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
                        + (base_stats.get('atkTier') ?? 0);
                    adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
                    mana_steal = melee_hits * ms / 3 / baseDamageMultiplier[adjAtkSpd];
                    const mana_per_hit = ms / 3 / baseDamageMultiplier[adjAtkSpd];
                    html += `<div>Mana steal \u00d7${melee_hits} hits: ${fmt(mana_steal)} (${Math.round(mana_per_hit * 10) / 10}/hit)</div>`;
                }
                const flat_mana = parseFloat(document.getElementById('flat-mana-input')?.value) || 0;
                if (flat_mana !== 0) {
                    html += `<div>Flat mana / cycle: ${fmt(flat_mana)}</div>`;
                }
                html +=
                    `<hr class="my-1 border-secondary">` +
                    `<div>Ending mana: ${Math.round(end_mana)} / ${start_mana}</div>`;
            }
            mana_tooltip.innerHTML = html;
        }
    }
}

let solver_combo_total_node = null;

// Module-level refs for use by reset / future phases
let solver_equip_input_nodes = [];  // ItemInputNode (pre-powder) for each equipment slot
let solver_item_final_nodes = [];  // ItemPowderingNode (or ItemInputNode for accessories/tomes)
let solver_build_node = null;
let solver_aspect_input_nodes = [];  // AspectInputNode instances (Phase 3)
let solver_powder_nodes = {};  // eq → PowderInputNode (helmet/chest/legs/boots/weapon)
let _solver_aspect_agg_node = null; // set by solver_graph_init; used by solver_compute_result_hash

/**
 * Compute the build hash (B64 string) for a top-N solver result, substituting the
 * result's equipment items and skillpoints into the current graph state (weapon, tomes,
 * powders, atree, aspects, level all stay the same as the live build).
 * Returns the B64 hash string, or null if encoding fails.
 */
function solver_compute_result_hash(result) {
    try {
        // Compute item-only SP (total minus assigned) so encodeSp sees non-zero
        // deltas wherever the solver assigned SP (requirements + greedy).  On
        // decode, solver.js restores _solver_sp_override from these values.
        const item_only_sp = result.total_sp.map((v, i) => v - (result.base_sp?.[i] ?? 0));
        const mock_build = {
            equipment: result.items.slice(0, 8),
            weapon: solver_item_final_nodes[8]?.value,
            tomes: solver_item_final_nodes.slice(9).map((n, i) => n?.value ?? none_tomes[_NONE_TOME_KEY[tome_fields[i]]]),
            total_skillpoints: item_only_sp,
            level: parseInt(document.getElementById('level-choice')?.value) || MAX_PLAYER_LEVEL,
        };
        if (!mock_build.weapon) return null;
        const powderable = ['helmet', 'chestplate', 'leggings', 'boots', 'weapon'];
        const powders = powderable.map(eq => solver_powder_nodes[eq]?.value || []);
        const aspects = _solver_aspect_agg_node?.value || [];
        const bv = encodeBuild(
            mock_build, powders, result.total_sp,
            atree_node.value, atree_state_node.value, aspects
        );
        return bv?.toB64() ?? null;
    } catch (e) {
        console.warn('[solver] solver_compute_result_hash failed:', e);
        return null;
    }
}
