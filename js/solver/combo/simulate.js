// ══════════════════════════════════════════════════════════════════════════════
// COMBO SPELL-BY-SPELL SIMULATION
// Extracted from combo/node.js — tracks mana and HP cast-by-cast for
// Blood Pact / Bak'al's Grasp / Corruption systems.
//
// Dependencies (loaded before this file):
//   - shared_game_stats.js: attackSpeeds, baseDamageMultiplier
//   - game_rules.js:        HIDDEN_BASE_HPR, HPR_TICK_SECONDS, MANA_TICK_SECONDS,
//                            BASE_MANA_REGEN
//   - skillpoints.js:       skillPointsToPercentage
//   - damage_calc.js:       getSpellCost
//   - utils.js:             rawToPct
//   - combo/boost.js:       apply_combo_row_boosts
//   - pure.js:              apply_spell_prop_overrides
//   - combo/ui.js:          _update_boost_btn_highlight
//   - constants.js:         CANCEL_BAKALS_SPELL_ID, MANA_RESET_SPELL_ID,
//                            RECAST_MANA_PENALTY, SPELL_CAST_TIME, SPELL_CAST_DELAY
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
 * Spell-to-spell simulation: track mana and HP cast-by-cast.
 * Returns { end_mana, end_hp, max_hp, start_mana, row_results[], spell_costs[], warnings[],
 *           total_mana_cost, melee_hits, recast_penalty_total }.
 * Also auto-fills Blood Pact calc fields and Corrupted sliders on auto-mode DOM elements.
 */
function simulate_spell_by_spell(rows, base_stats, aug_spell_map, registry, health_config, build) {
    const mr = base_stats.get('mr') ?? 0;
    const ms = base_stats.get('ms') ?? 0;
    const item_mana = base_stats.get('maxMana') ?? 0;
    const int_mana = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
    const start_mana = 100 + item_mana + int_mana;
    const max_mana = start_mana;

    // HP: same formula as getDefenseStats — base HP + item bonus
    const base_hp = base_stats.get('hp') ?? 0;
    const hp_bonus = base_stats.get('hpBonus') ?? 0;
    const max_hp = Math.max(5, base_hp + hp_bonus);
    const hpr_raw = base_stats.get('hprRaw') ?? 0;
    const hpr_pct = base_stats.get('hprPct') ?? 0;
    const total_hpr = rawToPct(hpr_raw, hpr_pct / 100);
    const hpr_tick = total_hpr + HIDDEN_BASE_HPR;
    const mr_per_sec = (mr + BASE_MANA_REGEN) / MANA_TICK_SECONDS;

    const health_cost_pct = health_config.health_cost; // e.g. 0.35 or 0.235

    // Mana steal setup
    let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
        + (base_stats.get('atkTier') ?? 0);
    adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
    const ms_per_hit = ms > 0 ? ms / 3 / baseDamageMultiplier[adjAtkSpd] : 0;

    // State
    let mana = start_mana;
    let hp = max_hp;
    let corrupted = false;
    let corruption_pct = 0;
    let elapsed_time = 0;

    // Recast tracking (same logic as tally mode)
    let last_spell_base = null;
    let consecutive_count = 0;
    let penalty_counter = 0;

    // Transcendence
    const has_transcendence = build.statMap.get('activeMajorIDs')?.has('ARCANES') ?? false;

    const row_results = []; // per-row: { blood_pact_bonus, corruption_pct, hp_warning }
    const spell_costs = [];
    let total_mana_cost = 0;
    let melee_hits = 0;
    let recast_penalty_total = 0;

    for (let row_idx = 0; row_idx < rows.length; row_idx++) {
        const { qty, spell, boost_tokens, dom_row } = rows[row_idx];
        const spell_id = parseInt(dom_row?.querySelector('.combo-row-spell')?.value);
        const mana_excluded = dom_row?.querySelector('.combo-mana-toggle')
            ?.classList.contains('mana-excluded') ?? false;

        let row_blood_total = 0;
        let row_blood_casts = 0;
        let hp_warning = false;
        let row_mana_cost = 0;
        let row_recast_penalty = 0;

        // Cancel Bak'al's Grasp pseudo-spell
        if (spell_id === CANCEL_BAKALS_SPELL_ID) {
            if (!mana_excluded && corrupted) {
                // Corruption exit heal (Exhilarate): heal % of corruption bar as max hp
                if (health_config.corruption_exit_heal > 0) {
                    hp = Math.min(max_hp, hp + corruption_pct * health_config.corruption_exit_heal / 100 * max_hp);
                }
                corrupted = false;
                corruption_pct = 0;
            }
            row_results.push({ blood_pact_bonus: 0, corruption_pct: 0, hp_warning: false });
            continue;
        }

        // Mana Reset pseudo-spell
        if (spell_id === MANA_RESET_SPELL_ID) {
            if (!mana_excluded) {
                last_spell_base = null;
                consecutive_count = 0;
                penalty_counter = 0;
            }
            row_results.push({ blood_pact_bonus: 0, corruption_pct: 0, hp_warning: false });
            continue;
        }

        if (qty <= 0 || !spell) {
            row_results.push({ blood_pact_bonus: 0, corruption_pct, hp_warning: false });
            continue;
        }

        // Mana-excluded rows: skip cost/regen tracking entirely
        if (mana_excluded) {
            // Still count melee hits for mana steal
            if (spell.scaling === 'melee') melee_hits += qty;
            row_results.push({ blood_pact_bonus: 0, corruption_pct, hp_warning: false });
            continue;
        }

        // Get spell cost using boosted stats
        const { stats: row_stats } = apply_combo_row_boosts(base_stats, boost_tokens, registry);
        const mod_spell = apply_spell_prop_overrides(spell, new Map(), null);
        const cost_per = mod_spell.cost != null ? getSpellCost(row_stats, mod_spell) : 0;
        const is_spell = mod_spell.cost != null;
        const is_melee_scaling = spell.scaling === 'melee';

        // Recast penalty calculation for this row
        const recast_base = spell.mana_derived_from ?? spell.base_spell;
        const is_melee = recast_base === 0;

        if (is_melee_scaling) melee_hits += qty;

        // Compute recast penalty the same way as tally mode
        if (is_spell && !is_melee) {
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
        }

        // Distribute recast penalty evenly across casts for simulation
        const penalty_per_cast = qty > 0 ? row_recast_penalty / qty : 0;

        // Simulate each cast
        for (let c = 0; c < qty; c++) {
            // Time passage (spells only, melee = 0 time)
            if (is_spell && !is_melee) {
                const time_delta = SPELL_CAST_TIME + SPELL_CAST_DELAY;
                const prev_time = elapsed_time;
                elapsed_time += time_delta;

                // Mana regen
                mana = Math.min(max_mana, mana + mr_per_sec * time_delta);

                // HP regen tick check (suppressed while corrupted if suppress_healing)
                if (!(corrupted && health_config.corruption.suppress_healing)) {
                    const prev_ticks = Math.floor(prev_time / HPR_TICK_SECONDS);
                    const cur_ticks = Math.floor(elapsed_time / HPR_TICK_SECONDS);
                    if (cur_ticks > prev_ticks) {
                        const ticks_crossed = cur_ticks - prev_ticks;
                        hp = Math.min(max_hp, hp + hpr_tick * ticks_crossed);
                    }
                }
            }

            // Mana steal from melee hits
            if (is_melee_scaling && ms_per_hit > 0) {
                mana = Math.min(max_mana, mana + ms_per_hit);
            }

            // Spell cost payment
            if (is_spell) {
                const effective_cost = cost_per + penalty_per_cast;
                let adj_cost = effective_cost;
                if (has_transcendence) adj_cost *= 0.75;

                if (mana >= adj_cost) {
                    // Pay entirely from mana
                    mana -= adj_cost;
                    row_blood_total += 0; // blood_ratio = 0
                } else {
                    // Blood Pact: pay remaining from health
                    const remaining_mana = Math.max(0, mana);
                    const health_mana = adj_cost - remaining_mana;
                    mana = 0;
                    const blood_ratio = health_mana / adj_cost;

                    // Health cost: health_mana * health_cost_pct% * maxHP / 100
                    const hp_cost = health_mana * health_cost_pct * max_hp / 100;

                    if (hp < hp_cost) {
                        hp_warning = true;
                    }
                    hp -= hp_cost;

                    // Track corruption from health costs while corrupted
                    if (corrupted) {
                        corruption_pct = Math.min(100, corruption_pct + hp_cost / max_hp * 100);
                    }

                    row_blood_total += health_config.damage_boost_min + (health_config.damage_boost_max - health_config.damage_boost_min) * blood_ratio;
                    row_blood_casts++;
                }

                row_mana_cost += adj_cost;

                // Corruption system: War Scream activates corruption
                if (health_config.corruption.active && spell.base_spell === 4 && !corrupted) {
                    corrupted = true;
                    corruption_pct = 0;
                }
            }
        }

        const avg_blood_bonus = row_blood_casts > 0 ? row_blood_total / row_blood_casts : 0;
        total_mana_cost += row_mana_cost;
        recast_penalty_total += row_recast_penalty;
        if (is_spell) {
            spell_costs.push({ name: spell.name, qty, cost: cost_per, recast_penalty: row_recast_penalty });
        }

        row_results.push({
            blood_pact_bonus: avg_blood_bonus,
            corruption_pct,
            hp_warning,
        });
    }

    // Auto-fill DOM elements for auto-mode fields
    for (let i = 0; i < rows.length; i++) {
        const dom_row = rows[i].dom_row;
        if (!dom_row) continue;
        const res = row_results[i];

        // Blood Pact calc field
        const bp_inp = dom_row.querySelector('.combo-row-boost-calc[data-calc-key="blood_pact"]');
        if (bp_inp && bp_inp.dataset.auto === 'true') {
            bp_inp.value = res.blood_pact_bonus > 0 ? (Math.round(res.blood_pact_bonus * 10) / 10) : '';
        }

        // Corrupted slider (auto-fill if data-auto is set)
        const corr_inp = dom_row.querySelector('.combo-row-boost-slider[data-boost-name="Corrupted"]');
        if (corr_inp) {
            // Add auto tracking to Corrupted slider
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
        end_mana: mana,
        start_mana,
        end_hp: hp,
        max_hp,
        row_results,
        spell_costs,
        total_mana_cost,
        melee_hits,
        recast_penalty_total,
        has_transcendence,
    };
}
