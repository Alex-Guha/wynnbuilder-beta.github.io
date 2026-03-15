// ══════════════════════════════════════════════════════════════════════════════
// COMBO SPELL-BY-SPELL SIMULATION
// Thin wrapper around simulate_combo_mana_hp() (pure.js) — serializes DOM
// state, calls the pure kernel, then auto-fills DOM elements from results.
//
// Dependencies (loaded before this file):
//   - pure.js:              simulate_combo_mana_hp
//   - combo/ui.js:          _update_boost_btn_highlight
//   - constants.js:         CANCEL_BAKALS_SPELL_ID, MANA_RESET_SPELL_ID,
//                            RECAST_MANA_PENALTY
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Extract health-related ability config from merged atree by scanning properties.
 * Detection is property-based (no hardcoded ability IDs):
 *   - health_cost        → HP casting (Blood Pact)
 *   - suppress_healing   → corruption system (Bak'al's Grasp)
 *   - corruption_exit_heal → heal on corruption exit (Exhilarate)
 */
function extract_health_config(atree_mg) {
    const config = {
        hp_casting: false,
        health_cost: 0,
        damage_boost_min: 0,
        damage_boost_max: 0,
        corruption: { active: false, suppress_healing: false },
        corruption_exit_heal: 0,
    };
    if (!atree_mg) return config;

    for (const [, abil] of atree_mg) {
        const props = abil.properties;
        if (!props) continue;

        // HP casting (Blood Pact): inferred from health_cost property existing
        if (props.health_cost != null) {
            config.hp_casting = true;
            let health_cost = props.health_cost;
            // Apply prop modifications merged into effects (e.g. Haemorrhage's -0.115)
            for (const effect of abil.effects) {
                if (effect.type === 'raw_stat' && !effect.toggle) {
                    for (const bonus of (effect.bonuses ?? [])) {
                        if (bonus.type === 'prop' && bonus.name === 'health_cost') {
                            health_cost += bonus.value;
                        }
                    }
                }
            }
            config.health_cost = health_cost;
            config.damage_boost_min = props.damage_boost_min ?? 0;
            config.damage_boost_max = props.damage_boost ?? 0;
        }

        // Corruption system (Bak'al's Grasp): inferred from suppress_healing
        if (props.suppress_healing) {
            config.corruption.active = true;
            config.corruption.suppress_healing = true;
        }

        // Corruption exit healing (Exhilarate): additive
        if (props.corruption_exit_heal != null) {
            config.corruption_exit_heal += props.corruption_exit_heal;
        }
    }
    return config;
}

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

    // ── Pre-pass: compute recast penalties and serialize DOM state ──
    let last_spell_base = null;
    let consecutive_count = 0;
    let penalty_counter = 0;

    const pure_rows = [];
    for (const { qty, spell, boost_tokens, dom_row } of rows) {
        const spell_id = parseInt(dom_row?.querySelector('.combo-row-spell')?.value);
        const mana_excl = dom_row?.querySelector('.combo-mana-toggle')
            ?.classList.contains('mana-excluded') ?? false;

        let pseudo = null;
        if (spell_id === CANCEL_BAKALS_SPELL_ID) pseudo = 'cancel_bakals';
        else if (spell_id === MANA_RESET_SPELL_ID) pseudo = 'mana_reset';

        // Mana Reset resets recast counter
        if (pseudo === 'mana_reset' && !mana_excl) {
            last_spell_base = null;
            consecutive_count = 0;
            penalty_counter = 0;
        }

        let recast_penalty_per_cast = 0;

        if (!pseudo && qty > 0 && spell && !mana_excl && spell.cost != null) {
            const recast_base = spell.mana_derived_from ?? spell.base_spell;
            const is_melee = recast_base === 0;

            if (!is_melee) {
                let row_recast_penalty = 0;
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
                    const remaining = qty - 1;
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
                    row_recast_penalty = RECAST_MANA_PENALTY * (qty * penalty_counter + qty * (qty + 1) / 2);
                    penalty_counter += qty;
                    consecutive_count += qty;
                } else {
                    const free_casts = Math.max(0, Math.min(qty, 2 - consecutive_count));
                    const penalty_casts = qty - free_casts;
                    if (penalty_casts > 0) {
                        row_recast_penalty = RECAST_MANA_PENALTY * penalty_casts * (penalty_casts + 1) / 2;
                        penalty_counter = penalty_casts;
                    }
                    consecutive_count += qty;
                }

                recast_penalty_per_cast = qty > 0 ? row_recast_penalty / qty : 0;
            }
        }

        pure_rows.push({ qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast });
    }

    // ── Call pure simulation kernel ──
    const result = simulate_combo_mana_hp(
        pure_rows, base_stats, health_config, has_transcendence, registry);

    // ── Auto-fill DOM elements from simulation results ──
    for (let i = 0; i < rows.length; i++) {
        const dom_row = rows[i].dom_row;
        if (!dom_row) continue;
        const res = result.row_results[i];

        // Blood Pact calc field
        const bp_inp = dom_row.querySelector('.combo-row-boost-calc[data-calc-key="blood_pact"]');
        if (bp_inp && bp_inp.dataset.auto === 'true') {
            bp_inp.value = res.blood_pact_bonus > 0 ? (Math.round(res.blood_pact_bonus * 10) / 10) : '';
        }

        // Corrupted slider (auto-fill if data-auto is set)
        const corr_inp = dom_row.querySelector('.combo-row-boost-slider[data-boost-name="Corrupted"]');
        if (corr_inp) {
            if (corr_inp.dataset.auto === undefined) corr_inp.dataset.auto = 'true';
            if (corr_inp.dataset.auto === 'true') {
                corr_inp.value = String(Math.round(res.corruption_pct));
            }
        }

        // Warning border
        const spell_sel = dom_row.querySelector('.combo-row-spell');
        if (spell_sel) {
            spell_sel.classList.toggle('combo-row-warning', res.hp_warning);
        }

        // Re-sync boost button highlight after auto-fill
        _update_boost_btn_highlight(dom_row);
    }

    return {
        ...result,
        has_transcendence,
    };
}
