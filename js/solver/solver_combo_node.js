class SolverComboTotalNode extends ComputeNode {
    constructor() {
        super('solver-combo-total');
        this.fail_cb = true;
        this._last_registry_sig = '';
        this._spell_map_cache = null;
        this._registry_cache = null;
    }

    compute_func(input_map) {
        const build = input_map.get('build');
        const base_stats = input_map.get('base-stats');
        const spell_map = input_map.get('spells');
        const atree_mg = input_map.get('atree-merged');
        const total_elem = document.getElementById('combo-total-avg');

        // Refresh selection-mode spell dropdowns with the raw spell map initially.
        this._spell_map_cache = spell_map;
        if (spell_map) this._refresh_selection_spells(spell_map);

        if (!build || !base_stats || !spell_map || build.weapon.statMap.has('NONE')) {
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
        this._spell_map_cache = aug_spell_map;
        this._refresh_selection_spells(aug_spell_map);

        const registry = build_combo_boost_registry(atree_mg ?? new Map(), build);
        this._registry_cache = registry;
        this._refresh_selection_boosts(registry);
        this._apply_pending_selection_data();

        const crit_chance = skillPointsToPercentage(base_stats.get('dex'));

        const rows = this._read_combo_rows(aug_spell_map);
        let total = 0;
        let total_heal = 0;
        let mana_cost = 0;
        let melee_hits = 0;
        const spell_costs = []; // [{name, qty, cost_per_cast}] for tooltip breakdown
        for (const { qty, spell, boost_tokens, dom_row } of rows) {
            const dmg_wrap = dom_row?.querySelector('.combo-row-damage-wrap');
            const dmg_span = dmg_wrap?.querySelector('.combo-row-damage')
                ?? dom_row?.querySelector('.combo-row-damage');
            const dmg_popup = dmg_wrap?.querySelector('.combo-dmg-popup');
            const heal_span = dom_row?.querySelector('.combo-row-heal');
            if (qty <= 0 || !spell) {
                if (dmg_span) dmg_span.textContent = '';
                if (dmg_popup) dmg_popup.textContent = '';
                dmg_wrap?.classList.remove('has-popup', 'popup-locked');
                if (heal_span) { heal_span.textContent = ''; }
                continue;
            }
            const { stats, prop_overrides } =
                apply_combo_row_boosts(base_stats, boost_tokens, registry);
            const mod_spell =
                apply_spell_prop_overrides(spell, prop_overrides, atree_mg);
            const full = computeSpellDisplayFull(stats, weapon, mod_spell, crit_chance);
            const per_cast = full ? full.avg : 0;
            const dmg_excluded = dom_row?.querySelector('.combo-dmg-toggle')
                ?.classList.contains('dmg-excluded') ?? false;
            if (!dmg_excluded) total += per_cast * qty;
            if (dmg_span) dmg_span.textContent = Math.round(per_cast).toLocaleString();
            // Per-row healing output
            const heal_per_cast = computeSpellHealingTotal(stats, mod_spell);
            total_heal += heal_per_cast * qty;
            if (heal_span) {
                if (heal_per_cast > 0) {
                    heal_span.textContent = '+' + Math.round(heal_per_cast).toLocaleString();
                } else {
                    heal_span.textContent = '';
                }
            }
            // Populate the breakdown popup (shown on hover/click of the damage number).
            if (dmg_popup && full && full.avg > 0) {
                const spell_cost = full.has_cost && mod_spell.cost != null
                    ? getSpellCost(base_stats, mod_spell) : null;
                dmg_popup.innerHTML = renderSpellPopupHTML(full, crit_chance, spell_cost);
                dmg_wrap?.classList.add('has-popup');
            } else if (dmg_popup) {
                dmg_popup.textContent = '';
                dmg_wrap?.classList.remove('has-popup', 'popup-locked');
            }
            // Mana cost: use base_stats (not row-boosted) for consistent cost calculation.
            // spell.cost may be null (e.g. Bamboozle) — skip those.
            // Skip if the row's mana toggle is excluded.
            const mana_excluded = dom_row?.querySelector('.combo-mana-toggle')
                ?.classList.contains('mana-excluded') ?? false;
            if (!mana_excluded && spell.scaling === 'melee') melee_hits += qty;
            if (spell.cost != null && !mana_excluded) {
                const cost_per = getSpellCost(base_stats, spell);
                mana_cost += cost_per * qty;
                spell_costs.push({ name: spell.name, qty, cost: cost_per });
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

        // XXX Hardcoded MajorID
        // Transcendence (ARCANES major ID): 25% chance spell costs no mana → ×0.75 for expected value.
        const has_transcendence = build.statMap.get('activeMajorIDs')?.has('ARCANES') ?? false;
        if (has_transcendence) mana_cost *= 0.75;

        // Mana display.
        this._update_mana_display(base_stats, mana_cost, spell_costs, has_transcendence, melee_hits);

        // Schedule a hash update; combo data is encoded into the URL hash.
        _schedule_solver_hash_update();
        return null;
    }

    /** Read rows for calculation — returns [{qty, spell, boost_tokens, dom_row}]. */
    _read_combo_rows(spell_map) {
        const result = [];
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const qty = parseInt(row.querySelector('.combo-row-qty')?.value) || 0;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            const spell = spell_map.get(spell_id) ?? null;
            const boost_tokens = [];
            for (const btn of row.querySelectorAll('.combo-row-boost-toggle.toggleOn')) {
                boost_tokens.push({ name: btn.dataset.boostName, value: 1, is_pct: false });
            }
            for (const inp of row.querySelectorAll('.combo-row-boost-slider')) {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) boost_tokens.push({ name: inp.dataset.boostName, value: val, is_pct: false });
            }
            result.push({ qty, spell, boost_tokens, dom_row: row });
        }
        return result;
    }

    // ── Model read / write (cross-mode sync, URL, clipboard) ─────────────────

    /** Read rows as plain data [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}]. */
    _read_rows_as_data() {
        return this._read_selection_rows_as_data();
    }

    _read_selection_rows_as_data() {
        const result = [];
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const qty = parseInt(row.querySelector('.combo-row-qty')?.value) || 0;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            const spell = this._spell_map_cache?.get(spell_id);
            const spell_name = spell?.name ?? '';
            const boost_parts = [];
            for (const btn of row.querySelectorAll('.combo-row-boost-toggle.toggleOn')) {
                boost_parts.push(btn.dataset.boostName);
            }
            for (const inp of row.querySelectorAll('.combo-row-boost-slider')) {
                const val = parseFloat(inp.value) || 0;
                if (val > 0) boost_parts.push(inp.dataset.boostName + ' ' + val);
            }
            const mana_excl = row.querySelector('.combo-mana-toggle')
                ?.classList.contains('mana-excluded') ?? false;
            const dmg_excl = row.querySelector('.combo-dmg-toggle')
                ?.classList.contains('dmg-excluded') ?? false;
            result.push({ qty, spell_name, boost_tokens_text: boost_parts.join(', '), mana_excl, dmg_excl });
        }
        return result;
    }

    /** Replace rows from data (import, URL restore). */
    _write_rows_from_data(data) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;
        container.innerHTML = '';
        for (const { qty, spell_name, boost_tokens_text, mana_excl, dmg_excl } of data) {
            container.appendChild(
                _build_selection_row(qty, spell_name, boost_tokens_text, mana_excl, dmg_excl)
            );
        }
    }

    /**
     * After _refresh_selection_spells/_boosts run, apply any data-pending-*
     * attributes set on rows by _build_selection_row (from mode switch / URL restore).
     */
    _apply_pending_selection_data() {
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const ps = row.dataset.pendingSpell;
            const pb = row.dataset.pendingBoosts;
            const pm = row.dataset.pendingManaExcl;
            const pd = row.dataset.pendingDmgExcl;
            if (ps === undefined && pb === undefined && pm === undefined && pd === undefined) continue;

            if (ps !== undefined) {
                delete row.dataset.pendingSpell;
                const sel = row.querySelector('.combo-row-spell');
                if (sel && ps) {
                    const name_l = ps.toLowerCase();
                    for (const opt of sel.options) {
                        // Strip " (Powder Special)" suffix for comparison so powder specials restore correctly.
                        const opt_name = opt.textContent.toLowerCase().replace(/\s*\(powder special\)$/, '');
                        if (opt_name === name_l) { sel.value = opt.value; break; }
                    }
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
                                if (bn === nl || bn === 'activate ' + nl) inp.value = String(value);
                            }
                        }
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
            if ([...sel.options].some(o => o.value === cur)) sel.value = cur;
        }
    }

    /** Repopulate boost toggle/slider controls in selection-mode rows. */
    _refresh_selection_boosts(registry) {
        const container = document.getElementById('combo-selection-rows');
        if (!container) return;

        const sig = registry.map(e => e.name + ':' + e.type + (e.max != null ? ':' + e.max : '')).join(',');
        const registry_changed = sig !== this._last_registry_sig;
        if (registry_changed) this._last_registry_sig = sig;

        for (const row of container.querySelectorAll('.combo-row')) {
            const area = row.querySelector('.combo-row-boosts');
            if (!area) continue;

            // Skip rows that already have controls and the registry hasn't changed.
            // Always populate rows with empty boost areas (newly added or from mode switch).
            if (!registry_changed && area.children.length > 0) continue;

            // Save existing values.
            const old_toggle = new Map();
            const old_slider = new Map();
            for (const b of area.querySelectorAll('.combo-row-boost-toggle')) {
                old_toggle.set(b.dataset.boostName, b.classList.contains('toggleOn'));
            }
            for (const i of area.querySelectorAll('.combo-row-boost-slider')) {
                old_slider.set(i.dataset.boostName, i.value);
            }

            area.innerHTML = '';

            // Render toggles first, then sliders, with a separator between them.
            const toggles = registry.filter(e => e.type === 'toggle');
            const sliders = registry.filter(e => e.type !== 'toggle');

            for (const entry of toggles) {
                const btn = document.createElement('button');
                btn.className = 'btn btn-sm button-boost border-0 text-white dark-8u dark-shadow-sm m-1 combo-row-boost-toggle';
                btn.dataset.boostName = entry.name;
                btn.textContent = entry.name;
                if (old_toggle.get(entry.name)) btn.classList.add('toggleOn');
                btn.addEventListener('click', () => {
                    btn.classList.toggle('toggleOn');
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
                lbl.textContent = entry.name + ':';
                const inp = document.createElement('input');
                inp.type = 'number';
                inp.className = 'combo-row-input combo-row-boost-slider';
                inp.style.cssText = 'width:4em; text-align:center;';
                inp.dataset.boostName = entry.name;
                inp.min = '0';
                inp.max = String(entry.max ?? 100);
                inp.step = String(entry.step ?? 1);
                inp.value = old_slider.get(entry.name) ?? '0';
                const max_lbl = document.createElement('span');
                max_lbl.className = 'text-secondary small';
                max_lbl.textContent = '/' + (entry.max ?? 100);
                inp.addEventListener('input', () => {
                    _update_boost_btn_highlight(row);
                    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
                });
                wrap.append(lbl, inp, max_lbl);
                area.appendChild(wrap);
            }
            _update_boost_btn_highlight(row);
            const boost_btn_el = row.querySelector('.combo-boost-menu-btn');
            if (boost_btn_el) boost_btn_el.disabled = (registry.length === 0);
        }
    }

    /** Update the mana display below the combo total. */
    _update_mana_display(base_stats, mana_cost, spell_costs = [], has_transcendence = false, melee_hits = 0) {
        const mana_row = document.getElementById('combo-mana-row');
        const mana_elem = document.getElementById('combo-mana-display');
        const mana_tooltip = document.getElementById('combo-mana-tooltip');
        const time_inp = document.getElementById('combo-time');
        const downtime_btn = document.getElementById('combo-downtime-btn');
        if (!mana_elem) return;

        const time_str = time_inp?.value?.trim() ?? '';
        if (!time_str) {
            if (mana_row) mana_row.style.display = 'none';
            mana_elem.textContent = '';
            return;
        }

        const combo_time = parseFloat(time_str) || 0;
        const allow_down = downtime_btn?.classList.contains('toggleOn') ?? false;
        const mr = base_stats.get('mr') ?? 0;
        const ms = base_stats.get('ms') ?? 0;
        // Mana pool: 100 base + item maxMana bonus + int scaling (same mult=1 as str/dex, up to +80 at 150 int).
        const item_mana = base_stats.get('maxMana') ?? 0;
        const int_mana = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
        const start_mana = 100 + item_mana + int_mana;
        // mr is per 5 seconds; divide by 5 to get per-second rate.
        const mana_regen = (mr / 5) * combo_time;
        // Mana steal: each melee-scaling hit restores ms/3/atkSpdMult mana.
        let mana_steal = 0;
        if (ms && melee_hits > 0) {
            let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
                + (base_stats.get('atkTier') ?? 0);
            adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
            mana_steal = melee_hits * ms / 3 / baseDamageMultiplier[adjAtkSpd];
        }
        const flat_mana = parseFloat(document.getElementById('flat-mana-input')?.value) || 0;
        const end_mana = start_mana - mana_cost + mana_regen + mana_steal + flat_mana;
        const deficit = start_mana - end_mana; // positive = net loss per combo

        let text = `Mana: ${Math.round(end_mana)}/${start_mana}`;
        if (!allow_down && deficit > 5) {
            text += ' \u26a0 not sustainable (\u2212' + Math.round(deficit) + ')';
            mana_elem.className = 'small text-warning';
        } else {
            mana_elem.className = 'small text-secondary';
        }
        mana_elem.textContent = text;
        if (mana_row) mana_row.style.display = '';

        if (mana_tooltip) {
            const fmt = n => (n >= 0 ? '+' : '\u2212') + Math.abs(Math.round(n));
            let html = '';
            // Per-spell cost breakdown — group rows with the same spell name.
            if (spell_costs.length) {
                const grouped = [];
                const seen = new Map(); // name → index in grouped
                for (const { name, qty, cost } of spell_costs) {
                    if (seen.has(name)) {
                        grouped[seen.get(name)].qty += qty;
                    } else {
                        seen.set(name, grouped.length);
                        grouped.push({ name, qty, cost });
                    }
                }
                for (const { name, qty, cost } of grouped) {
                    const total = cost * qty;
                    html += qty > 1
                        ? `<div>${qty}\u00d7 ${name}: ${Math.round(cost)} (\u2192 ${Math.round(total)})</div>`
                        : `<div>${name}: ${Math.round(cost)}</div>`;
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
                `<div>Spell costs: ${cost_str}</div>` +
                `<div>Regen \u00d7${combo_time}s: ${fmt(mana_regen)} (${mr}/5s)</div>`;
            if (mana_steal > 0) {
                const mana_per_hit = ms / 3 / baseDamageMultiplier[
                    Math.max(0, Math.min(6,
                        attackSpeeds.indexOf(base_stats.get('atkSpd'))
                        + (base_stats.get('atkTier') ?? 0)))];
                html += `<div>Mana steal \u00d7${melee_hits} hits: ${fmt(mana_steal)} (${Math.round(mana_per_hit * 10) / 10}/hit)</div>`;
            }
            if (flat_mana > 0) {
                html += `<div>Flat mana / cycle: ${fmt(flat_mana)}</div>`;
            }
            html +=
                `<hr class="my-1 border-secondary">` +
                `<div>Ending mana: ${Math.round(end_mana)} / ${start_mana}</div>`;
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
        const mock_build = {
            equipment: result.items.slice(0, 8),
            weapon: solver_item_final_nodes[8]?.value,
            tomes: solver_item_final_nodes.slice(9).map((n, i) => n?.value ?? none_tomes[_NONE_TOME_KEY[tome_fields[i]]]),
            total_skillpoints: result.total_sp,
            level: parseInt(document.getElementById('level-choice')?.value) || MAX_PLAYER_LEVEL,
        };
        if (!mock_build.weapon) return null;
        const powderable = ['helmet', 'chestplate', 'leggings', 'boots', 'weapon'];
        const powders = powderable.map(eq => solver_powder_nodes[eq]?.value || []);
        const aspects = _solver_aspect_agg_node?.value || [];
        // Pass total_sp so encodeSp sees spDeltas=[0,0,0,0,0] → AUTOMATIC flag.
        // WynnBuilder then re-derives SP from items rather than having stale base values applied.
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
