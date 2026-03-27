// ══════════════════════════════════════════════════════════════════════════════
// COMBO SPELL-BY-SPELL SIMULATION
// Thin wrapper around simulate_combo_mana_hp() (pure/simulate.js) — serializes DOM
// state, calls the pure kernel, then auto-fills DOM elements from results.
//
// Dependencies (loaded before this file):
//   - pure/simulate.js:     simulate_combo_mana_hp, extract_health_config
//   - combo/ui.js:          _update_boost_btn_highlight
//   - constants.js:         CANCEL_BAKALS_SPELL_ID, MANA_RESET_SPELL_ID,
//                            ADD_FLAT_MANA_SPELL_ID, RECAST_MANA_PENALTY
// ══════════════════════════════════════════════════════════════════════════════

// extract_health_config() has moved to pure/simulate.js (shared by page + worker + tests)

/**
 * Spell-to-spell simulation: thin wrapper around simulate_combo_mana_hp().
 * Serializes DOM state → calls pure kernel → applies DOM auto-fills.
 *
 * Returns { end_mana, end_hp, max_hp, start_mana, max_mana, row_results[],
 *           spell_costs[], total_mana_cost, melee_hits, recast_penalty_total,
 *           has_transcendence }.
 */
function simulate_spell_by_spell(rows, base_stats, aug_spell_map, registry, health_config, build) {
    const has_transcendence = build.statMap.get('activeMajorIDs')?.has('ARCANES') ?? false;

    // ── Pre-pass: serialize DOM state into pure rows ──
    const pure_rows = [];
    for (const { qty, sim_qty, spell, boost_tokens, dom_row, cast_time, delay, is_melee_time } of rows) {
        const spell_id = parseInt(dom_row?.querySelector('.combo-row-spell')?.value);
        const mana_excl = dom_row?.querySelector('.combo-mana-toggle')
            ?.classList.contains('mana-excluded') ?? false;

        let pseudo = null;
        if (spell_id === MANA_RESET_SPELL_ID) pseudo = 'mana_reset';
        else if (spell_id === ADD_FLAT_MANA_SPELL_ID) pseudo = 'add_flat_mana';
        else {
            // Check if this spell_id is a cancel pseudo-spell for any buff state
            for (const [state_name, cancel_id] of STATE_CANCEL_IDS) {
                if (spell_id === cancel_id) { pseudo = 'cancel_state:' + state_name; break; }
            }
        }

        pure_rows.push({ qty, sim_qty, spell, boost_tokens, mana_excl, pseudo,
            recast_penalty_per_cast: 0, cast_time, delay, is_melee_time });
    }

    // Compute recast penalties via shared pure function
    compute_recast_penalties(pure_rows);

    // ── Call pure simulation kernel ──
    const result = simulate_combo_mana_hp(
        pure_rows, base_stats, health_config, has_transcendence, registry);

    // ── Auto-fill DOM elements from simulation results ──
    for (let i = 0; i < rows.length; i++) {
        const dom_row = rows[i].dom_row;
        if (!dom_row) continue;
        const res = result.row_results[i];

        // Generic: auto-fill state sliders (Corrupted, etc.)
        for (const bs of (health_config.buff_states ?? [])) {
            const inp = dom_row.querySelector(`.combo-row-boost-slider[data-boost-name="${bs.slider_name}"]`);
            if (inp) {
                if (inp.dataset.auto === undefined) inp.dataset.auto = 'true';
                if (inp.dataset.auto === 'true') {
                    inp.value = String(Math.round(res.state_values?.[bs.state_name] ?? 0));
                }
            }
        }
        // Generic: auto-fill damage boost slider (Blood Pact)
        const db = health_config.damage_boost;
        if (db?.slider_name) {
            const inp = dom_row.querySelector(`.combo-row-boost-slider[data-boost-name="${db.slider_name}"]`);
            if (inp) {
                if (inp.dataset.auto === undefined) inp.dataset.auto = 'true';
                if (inp.dataset.auto === 'true') {
                    inp.value = res.blood_pact_bonus > 0
                        ? String(Math.round(res.blood_pact_bonus * 10) / 10) : '';
                }
            }
        }

        // Warning border (HP or mana insufficient)
        const spell_sel = dom_row.querySelector('.combo-row-spell');
        if (spell_sel) {
            spell_sel.classList.toggle('combo-row-warning', res.hp_warning || res.mana_warning);
        }

        // Re-sync boost button highlight after auto-fill
        _update_boost_btn_highlight(dom_row);
    }

    return {
        ...result,
        has_transcendence,
    };
}
