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
 * Extract health-related ability config from merged atree.
 * Reads from the new data format: buff_state effects, trigger effects,
 * stat_scaling sliders with slider_min/slider_max.
 */
function extract_health_config(atree_mg) {
    const config = {
        hp_casting: false,
        health_cost: 0,
        damage_boost: null,     // { min, max, slider_name }
        buff_states: [],        // [{ state_name, activate_on, deactivate, slider_name,
                                //    tracking, suppress_healing, spell_rate_field, spell_flat_field }]
        exit_triggers: [],      // [{ on, state, effect, value, cooldown?, slider_name? }]
    };
    if (!atree_mg) return config;

    for (const [, abil] of atree_mg) {
        const props = abil.properties;

        // HP casting (Blood Pact): inferred from health_cost property
        if (props?.health_cost != null) {
            config.hp_casting = true;
            let health_cost = props.health_cost;
            // Apply prop modifications merged into effects (e.g. Haemorrhage's -0.115)
            for (const effect of abil.effects) {
                if (effect.type === 'raw_stat' && !effect.toggle) {
                    for (const bonus of (effect.bonuses ?? [])) {
                        if (bonus.type === 'prop' && bonus.name === 'health_cost')
                            health_cost += bonus.value;
                    }
                }
            }
            config.health_cost = health_cost;
            // Find the Blood Pact slider for damage boost auto-fill
            for (const effect of abil.effects) {
                if (effect.type === 'stat_scaling' && effect.slider && effect.slider_name) {
                    config.damage_boost = {
                        min: effect.slider_min ?? 0,
                        max: effect.slider_max ?? 0,
                        slider_name: effect.slider_name,
                    };
                    break;
                }
            }
        }

        // Buff states: standalone buff_state effects
        for (const effect of abil.effects) {
            if (effect.type === 'buff_state') {
                config.buff_states.push({
                    state_name: effect.state_name,
                    activate_on: effect.activate_on,
                    deactivate: effect.deactivate,
                    slider_name: effect.state_name,  // links to stat_scaling slider by name
                    tracking: effect.tracking,
                    suppress_healing: effect.suppress_healing ?? false,
                    spell_rate_field: effect.spell_rate_field ?? null,
                    spell_flat_field: effect.spell_flat_field ?? null,
                });
            }
        }

        // Triggers: standalone trigger effects
        for (const effect of abil.effects) {
            if (effect.type === 'trigger') {
                config.exit_triggers.push(effect);
            }
        }
    }

    // Broaden hp_casting: also true if any add_spell_prop injects hp_cost
    if (!config.hp_casting) {
        outer: for (const [, abil] of atree_mg) {
            for (const effect of abil.effects) {
                if (effect.type === 'add_spell_prop' && (effect.hp_cost ?? 0) > 0) {
                    config.hp_casting = true;
                    break outer;
                }
            }
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
function simulate_spell_by_spell(rows, base_stats, aug_spell_map, registry, health_config, build, flat_mana = 0) {
    const has_transcendence = build.statMap.get('activeMajorIDs')?.has('ARCANES') ?? false;

    // ── Pre-pass: compute recast penalties and serialize DOM state ──
    let last_spell_base = null;
    let consecutive_count = 0;
    let penalty_counter = 0;

    const pure_rows = [];
    for (const { qty, sim_qty, spell, boost_tokens, dom_row, cast_time, delay, is_melee_time } of rows) {
        const spell_id = parseInt(dom_row?.querySelector('.combo-row-spell')?.value);
        const mana_excl = dom_row?.querySelector('.combo-mana-toggle')
            ?.classList.contains('mana-excluded') ?? false;

        let pseudo = null;
        if (spell_id === MANA_RESET_SPELL_ID) pseudo = 'mana_reset';
        else {
            // Check if this spell_id is a cancel pseudo-spell for any buff state
            for (const [state_name, cancel_id] of STATE_CANCEL_IDS) {
                if (spell_id === cancel_id) { pseudo = 'cancel_state:' + state_name; break; }
            }
        }

        // Mana Reset resets recast counter
        if (pseudo === 'mana_reset' && !mana_excl) {
            last_spell_base = null;
            consecutive_count = 0;
            penalty_counter = 0;
        }

        let recast_penalty_per_cast = 0;

        if (!pseudo && sim_qty > 0 && spell && !mana_excl && spell.cost != null) {
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
                    const remaining = sim_qty - 1;
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
                    row_recast_penalty = RECAST_MANA_PENALTY * (sim_qty * penalty_counter + sim_qty * (sim_qty + 1) / 2);
                    penalty_counter += sim_qty;
                    consecutive_count += sim_qty;
                } else {
                    const free_casts = Math.max(0, Math.min(sim_qty, 2 - consecutive_count));
                    const penalty_casts = sim_qty - free_casts;
                    if (penalty_casts > 0) {
                        row_recast_penalty = RECAST_MANA_PENALTY * penalty_casts * (penalty_casts + 1) / 2;
                        penalty_counter = penalty_casts;
                    }
                    consecutive_count += sim_qty;
                }

                recast_penalty_per_cast = sim_qty > 0 ? row_recast_penalty / sim_qty : 0;
            }
        }

        pure_rows.push({ qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast, cast_time, delay, is_melee_time });
    }

    // ── Call pure simulation kernel ──
    const result = simulate_combo_mana_hp(
        pure_rows, base_stats, health_config, has_transcendence, registry, undefined, flat_mana);

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
