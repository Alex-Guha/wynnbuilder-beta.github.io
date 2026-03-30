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
            const mr = document.getElementById('combo-mana-row');
            if (mr) mr.style.display = 'none';
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
        this._refresh_selection_timing(aug_spell_map);

        const crit_chance = skillPointsToPercentage(base_stats.get('dex'));

        let rows = this._read_combo_rows(aug_spell_map);

        // Annotate rows with mana_excl for shared helpers.
        for (const r of rows) {
            r.mana_excl = r.dom_row?.querySelector('.combo-mana-toggle')
                ?.classList.contains('mana-excluded') ?? false;
        }

        // Run simulation pre-pass to determine per-row Blood Pact bonus,
        // corruption %, health warnings, and mana tracking. Also auto-fills
        // the calculated boost fields, Corrupted sliders, and cast delays
        // (compute_delay), so the damage loop reads the correct boost values.
        const sim_result = simulate_spell_by_spell(
            rows, base_stats, aug_spell_map, registry,
            this._health_config ?? DEFAULT_HEALTH_CONFIG, build);
        // Re-read rows so boost_tokens and auto-filled delays reflect simulation output.
        rows = this._read_combo_rows(aug_spell_map);

        // Auto-compute cycle time AFTER simulation, since simulate_spell_by_spell
        // may auto-fill cast delays (e.g. compute_delay for Manic Edge drain).
        for (const r of rows) {
            r.mana_excl = r.dom_row?.querySelector('.combo-mana-toggle')
                ?.classList.contains('mana-excluded') ?? false;
        }
        this._auto_cycle_time = compute_combo_cycle_time(rows, base_stats);
        {
            const ct_display = document.getElementById('combo-cycle-time-display');
            if (ct_display) ct_display.textContent = this._auto_cycle_time > 0
                ? `Cycle Time: ${this._auto_cycle_time}s` : '';
        }

        // ── Pre-parse rows: extract DOM state for pure function ──
        const parsed_rows = [];
        for (const { qty, sim_qty, spell, boost_tokens, dom_row, is_melee_time } of rows) {
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
            parsed_rows.push({ qty, sim_qty, spell, boost_tokens, dmg_excl, pseudo, dps_hits_override, dom_row, is_melee_time });
        }

        // ── Compute damage via shared pure function ──
        if (SOLVER_DEBUG_COMBO && sim_result) {
            console.log('[COMBO-DEBUG][PAGE] ═══ Page combo damage computation ═══');
            const item_names = build.equipment.map(it =>
                it.statMap.get('displayName') ?? it.statMap.get('name') ?? '').filter(n => n);
            console.log('[COMBO-DEBUG][PAGE] items:', item_names.join(', '));
            const _dbg_rows = sim_result.row_results.map((r, i) => ({
                row: i, bp_bonus: Math.round(r.blood_pact_bonus * 100) / 100,
                states: r.state_values, hp_warn: r.hp_warning, mana_warn: r.mana_warning,
                computed_delay: r.computed_delay,
                mana_lost: Math.round(r.mana_lost * 100) / 100,
                mana_gained: Math.round((r.mana_gained ?? 0) * 100) / 100,
                elapsed_t: Math.round((r.elapsed_time ?? 0) * 1000) / 1000,
                row_dt: Math.round((r.row_dt ?? 0) * 1000) / 1000,
                cast_time: r.cast_time, delay: r.delay,
            }));
            if (_dbg_rows.length) {
                const _cols = Object.keys(_dbg_rows[0]);
                const _csv = [_cols.join(','), ..._dbg_rows.map(r => _cols.map(k => {
                    const v = r[k];
                    return typeof v === 'object' ? JSON.stringify(v) : v;
                }).join(','))].join('\n');
                console.log('[COMBO-DEBUG][PAGE] sim rows CSV:\n' + _csv);
            }
            console.log('[COMBO-DEBUG][PAGE] sim mana:', JSON.stringify({
                start: sim_result.start_mana, end: sim_result.end_mana, max: sim_result.max_mana,
                total_cost: Math.round(sim_result.total_mana_cost * 100) / 100,
                recast_penalty: Math.round(sim_result.recast_penalty_total * 100) / 100,
                wasted: Math.round((sim_result.mana_wasted ?? 0) * 100) / 100,
            }));
            console.log('[COMBO-DEBUG][PAGE] sim hp:', JSON.stringify({
                end: Math.round(sim_result.end_hp), max: sim_result.max_hp,
                melee_hits: sim_result.melee_hits,
            }));
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

        // (Tally-mode mana cost tracking removed — simulation always provides mana data.)

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

        this._update_mana_display(base_stats, sim_result);

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
            const ct_inp = row.querySelector('.combo-row-cast-time');
            const dl_inp = row.querySelector('.combo-row-delay');
            const cast_time = ct_inp ? parseFloat(ct_inp.value) : SPELL_CAST_TIME;
            const delay = dl_inp ? parseFloat(dl_inp.value) : SPELL_CAST_DELAY;
            const auto_delay = dl_inp ? (dl_inp.dataset.auto !== 'false') : true;
            const is_melee_time = (spell_id === MELEE_TIME_SPELL_ID);
            const eff_spell = is_melee_time ? (spell_map.get(0) ?? null) : spell;
            return { qty, sim_qty: Math.round(qty), spell: eff_spell, boost_tokens, dom_row: row, cast_time, delay, auto_delay, is_melee_time };
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
            let spell_name = spell?.name ?? '';
            if (spell_id === MANA_RESET_SPELL_ID) spell_name = 'Mana Reset';
            else if (spell_id === ADD_FLAT_MANA_SPELL_ID) spell_name = 'Add Flat Mana';
            else if (spell_id === MELEE_TIME_SPELL_ID) spell_name = 'Melee Time';
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
            // Per-row timing (cast spells and melee — not pseudo-spells).
            let cast_time, delay;
            const is_cast_spell = spell && spell.cost != null
                && spell_id !== 0 && spell_id !== MELEE_TIME_SPELL_ID
                && spell_id !== MANA_RESET_SPELL_ID
                && ![...STATE_CANCEL_IDS.values()].includes(spell_id);
            const is_melee = spell_id === 0 || spell_id === MELEE_TIME_SPELL_ID
                || (spell && spell._is_powder_special);
            if (is_cast_spell) {
                const dl_inp = row.querySelector('.combo-row-delay');
                if (dl_inp?.dataset.auto === 'false') {
                    const ct_inp = row.querySelector('.combo-row-cast-time');
                    cast_time = ct_inp ? parseFloat(ct_inp.value) : SPELL_CAST_TIME;
                    delay = parseFloat(dl_inp.value);
                }
            } else if (is_melee) {
                const dl_inp = row.querySelector('.combo-row-delay');
                if (dl_inp?.dataset.auto === 'false') {
                    cast_time = 0;
                    delay = parseFloat(dl_inp.value) || SPELL_CAST_DELAY;
                }
            }
            return { qty, spell_name, boost_tokens_text: boost_parts.join(', '), mana_excl, dmg_excl, hits, cast_time, delay };
        });
    }

    /** Replace rows from data (import, URL restore). */
    _write_rows_from_data(data) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;
        container.innerHTML = '';
        for (const { qty, spell_name, spell_value, boost_tokens_text, mana_excl, dmg_excl, hits, cast_time, delay } of data) {
            // Resolve spell_value from spell_name when missing (text import).
            // This lets _refresh_selection_boosts filter boosts by spell before
            // _apply_pending_selection_data runs.
            let resolved_value = spell_value;
            if (resolved_value == null && spell_name && this._spell_map_cache) {
                const name_l = spell_name.toLowerCase();
                for (const [id, s] of this._spell_map_cache) {
                    const sn = s._is_powder_special
                        ? s.name + ' (Powder Special)' : s.name;
                    if (sn.toLowerCase() === name_l) {
                        resolved_value = String(id);
                        break;
                    }
                }
                // Check pseudo-spells
                if (resolved_value == null) {
                    if (name_l === 'mana reset') resolved_value = String(MANA_RESET_SPELL_ID);
                    else if (name_l === 'add flat mana') resolved_value = String(ADD_FLAT_MANA_SPELL_ID);
                    else if (name_l === 'melee time') resolved_value = String(MELEE_TIME_SPELL_ID);
                    else if (name_l.startsWith('cancel ')) {
                        const state_name = spell_name.substring(7);
                        const cancel_id = get_cancel_spell_id(state_name);
                        if (cancel_id != null) resolved_value = String(cancel_id);
                    }
                }
            }
            const row = _build_selection_row(qty, spell_name, boost_tokens_text, mana_excl, dmg_excl, resolved_value, cast_time, delay);
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
            // Re-evaluate timing button highlight for URL-restored overrides.
            _update_timing_btn_highlight(row);
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
            // Mana Reset pseudo-spell: resets the spell recast counter (advanced-only).
            const reset_opt = document.createElement('option');
            reset_opt.value = String(MANA_RESET_SPELL_ID);
            reset_opt.textContent = 'Mana Reset';
            if (!combo_is_advanced()) reset_opt.style.display = 'none';
            sel.appendChild(reset_opt);
            // Add Flat Mana pseudo-spell: injects qty mana at this point (advanced-only).
            const fm_opt = document.createElement('option');
            fm_opt.value = String(ADD_FLAT_MANA_SPELL_ID);
            fm_opt.textContent = 'Add Flat Mana';
            if (!combo_is_advanced()) fm_opt.style.display = 'none';
            sel.appendChild(fm_opt);
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

            // Melee Time: advanced-mode-only option
            const mt_opt = document.createElement('option');
            mt_opt.value = String(MELEE_TIME_SPELL_ID);
            mt_opt.textContent = 'Melee Time';
            if (!combo_is_advanced()) mt_opt.style.display = 'none';
            sel.appendChild(mt_opt);

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

            // Pseudo-spells with no boosts: skip boost/DPS rendering entirely.
            const is_boostless_pseudo = spell_id === MANA_RESET_SPELL_ID
                || spell_id === ADD_FLAT_MANA_SPELL_ID;
            if (is_boostless_pseudo) {
                area.dataset.renderedSpellId = cur_spell_id_str;
                const boost_btn_el = row.querySelector('.combo-boost-menu-btn');
                if (boost_btn_el) boost_btn_el.disabled = true;
                continue;
            }

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

            // Ensure qty input always allows decimal (step='any' set in ui.js).


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

    /** Grey out the timing button for spells that don't use cast time/delay. */
    _refresh_selection_timing(spell_map) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;
        for (const row of container.querySelectorAll('.combo-row')) {
            const btn = row.querySelector('.combo-timing-menu-btn');
            if (!btn) continue;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            const spell = spell_map.get(spell_id) ?? null;
            const is_cast_spell = spell && spell.cost != null
                && spell_id !== 0 && spell_id !== MELEE_TIME_SPELL_ID
                && spell_id !== MANA_RESET_SPELL_ID
                && ![...STATE_CANCEL_IDS.values()].includes(spell_id);
            const is_melee = spell_id === 0 || spell_id === MELEE_TIME_SPELL_ID
                || (spell && spell._is_powder_special);
            btn.disabled = !(is_cast_spell || is_melee);
            // Melee ignores cast time — force hidden input to 0 and grey out the field.
            const ct_hidden = row.querySelector('.combo-row-cast-time');
            if (is_melee && ct_hidden) ct_hidden.value = '0';
            const ct_field = row.querySelector('.timing-cast-time');
            if (ct_field) ct_field.disabled = is_melee;
            if (is_melee && ct_field) ct_field.value = '0';
            _update_timing_btn_highlight(row);
        }
    }

    /** Update the mana display below the combo total. */
    _update_mana_display(base_stats, sim_result) {
        const mana_row = document.getElementById('combo-mana-row');
        const mana_elem = document.getElementById('combo-mana-display');
        const health_elem = document.getElementById('combo-health-display');
        const mana_tooltip = document.getElementById('combo-mana-tooltip');
        const mana_btn = document.getElementById('combo-mana-btn');
        const downtime_btn = document.getElementById('combo-downtime-btn');
        if (!mana_elem) return;

        const mana_enabled = mana_btn?.classList.contains('toggleOn') ?? true;
        if (!mana_enabled) {
            if (mana_row) mana_row.style.display = 'none';
            mana_elem.textContent = '';
            if (health_elem) { health_elem.textContent = ''; health_elem.style.display = 'none'; }
            return;
        }

        const combo_time = this._auto_cycle_time || 0;
        const allow_down = downtime_btn?.classList.contains('toggleOn') ?? false;
        const mr = base_stats.get('mr') ?? 0;
        const ms = base_stats.get('ms') ?? 0;
        const item_mana = base_stats.get('maxMana') ?? 0;
        const int_mana = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
        const display_start_mana = 100 + item_mana + int_mana;

        const end_mana = sim_result.end_mana;
        const deficit = sim_result.start_mana - end_mana;

        let text = `Mana: ${Math.round(end_mana)}/${display_start_mana}`;
        const has_blood_pact = this._health_config?.hp_casting ?? false;
        if (!allow_down && !has_blood_pact && deficit > 5) {
            text += ' \u26a0 not sustainable (\u2212' + Math.round(deficit) + ')';
            mana_elem.className = 'small text-warning';
        } else {
            mana_elem.className = 'small text-secondary';
        }
        mana_elem.textContent = text;
        if (mana_row) mana_row.style.display = 'flex';

        // Health display — only shown for HP-casting builds (Blood Pact etc.)
        const show_hp = this._health_config?.hp_casting ?? false;
        if (health_elem) {
            if (show_hp) {
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
            const spell_costs = sim_result.spell_costs ?? [];
            const mana_cost = sim_result.total_mana_cost ?? 0;
            const has_transcendence = sim_result.has_transcendence ?? false;
            const melee_hits = sim_result.melee_hits ?? 0;
            const recast_penalty_total = sim_result.recast_penalty_total ?? 0;

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
                start_str += ` = ${display_start_mana}`;
            }
            let cost_str = fmt(-mana_cost);
            if (has_transcendence) cost_str += ' (\u00d70.75 Transcendence)';
            html +=
                `<div>Starting mana: ${start_str}</div>` +
                `<div>Spell costs: ${cost_str}</div>`;

            // Aggregate breakdown for tooltip (regen, steal)
            const mana_regen = ((mr + BASE_MANA_REGEN) / 5) * combo_time;
            html += `<div>Regen \u00d7${combo_time}s: ${fmt(mana_regen)} (${mr + BASE_MANA_REGEN}/5s)</div>`;
            if (ms !== 0 && melee_hits > 0) {
                let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
                    + (base_stats.get('atkTier') ?? 0);
                adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
                const mana_steal = melee_hits * ms / 3 / baseDamageMultiplier[adjAtkSpd];
                const mana_per_hit = ms / 3 / baseDamageMultiplier[adjAtkSpd];
                html += `<div>Mana steal \u00d7${melee_hits} hits: ${fmt(mana_steal)} (${Math.round(mana_per_hit * 10) / 10}/hit)</div>`;
            }
            const mana_drain = sim_result.total_mana_drain ?? 0;
            if (mana_drain > 0) {
                html += `<div>Drain: ${fmt(-mana_drain)}</div>`;
            }
            html +=
                `<hr class="my-1 border-secondary">` +
                `<div>Ending mana: ${Math.round(end_mana)} / ${display_start_mana}</div>`;
            const mana_waste = sim_result.mana_wasted ?? 0;
            if (mana_waste > 0) {
                html += `<div>Excess Mana: ${Math.round(mana_waste)}</div>`;
            }
            // For BP builds, additionally show ending HP
            if (show_hp) {
                html += `<div>Ending HP: ${Math.round(sim_result.end_hp)} / ${sim_result.max_hp}</div>`;
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
