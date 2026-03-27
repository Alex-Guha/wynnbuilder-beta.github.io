// ══════════════════════════════════════════════════════════════════════════════
// SOLVER PURE — Combo mana/HP simulation
// Shared between the solver main thread (<script> tag) and the Web Worker
// (importScripts). NO DOM access, NO window/document/navigator references.
//
// pure/ dependencies:
//   - pure/boost.js:  apply_combo_row_boosts
//   - pure/utils.js:  compute_wall_dt, compute_melee_time_hits
// External dependencies (must be loaded before this file):
//   - build_utils.js:      attackSpeeds, baseDamageMultiplier,
//                           skillPointsToPercentage
//   - game_rules.js:       HIDDEN_BASE_HPR, HPR_TICK_SECONDS, MANA_TICK_SECONDS,
//                           BASE_MANA_REGEN, SPELL_CAST_TIME, SPELL_CAST_DELAY
//   - utils.js:            rawToPct
//   - shared_game_stats.js: getSpellCost
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Extract health-related ability config from merged atree.
 * Reads from the new data format: buff_state effects, trigger effects,
 * stat_scaling sliders with slider_min/slider_max.
 * DOM-free — shared by page (combo/node.js), search (engine/search.js), and tests.
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

const DEFAULT_HEALTH_CONFIG = Object.freeze({
    hp_casting: false, health_cost: 0, damage_boost: null,
    buff_states: [], exit_triggers: [],
});

/**
 * Extract bp_slider_name and state_slider_names from a health_config.
 * DOM-free, used by worker init, search.js debug path, and item_priority.js.
 *
 * @param {Object|null} health_config - From extract_health_config()
 * @returns {{ bp_slider_name: string|null, state_slider_names: Object }}
 */
function extract_slider_names(health_config) {
    const bp_slider_name = health_config?.damage_boost?.slider_name ?? null;
    const state_slider_names = {};
    for (const bs of (health_config?.buff_states ?? [])) {
        if (bs.slider_name) state_slider_names[bs.state_name] = bs.slider_name;
    }
    return { bp_slider_name, state_slider_names };
}

/**
 * Compute per-row recast_penalty_per_cast for a parsed combo sequence.
 * Mutates each row's recast_penalty_per_cast field in-place.
 * DOM-free. Called by search.js (snapshot builder) and combo/simulate.js (page).
 *
 * @param {Object[]} rows - Each row must have:
 *   { sim_qty, spell, mana_excl, pseudo }
 *   spell: { cost, mana_derived_from, base_spell }
 */
function compute_recast_penalties(rows) {
    const penalty_per = (typeof RECAST_MANA_PENALTY !== 'undefined') ? RECAST_MANA_PENALTY : 5;
    let last_base = null, consec = 0, penalty = 0;
    for (const row of rows) {
        if (row.pseudo) {
            if (row.pseudo === 'mana_reset' && !row.mana_excl) {
                last_base = null; consec = 0; penalty = 0;
            }
            continue;
        }
        const { sim_qty, spell, mana_excl } = row;
        row.recast_penalty_per_cast = 0;
        if (!spell || sim_qty <= 0 || mana_excl || spell.cost == null) continue;
        const rc_base = spell.mana_derived_from ?? spell.base_spell;
        if (rc_base === 0) continue;

        let row_penalty = 0;
        let is_switch = false;
        if (rc_base !== last_base) {
            is_switch = true;
            if (consec <= 1) penalty = 0; else penalty += 1;
            consec = 0;
            last_base = rc_base;
        }
        if (is_switch && penalty > 0) {
            row_penalty = penalty * penalty_per;
            penalty = 0; consec = 1;
            const remaining = sim_qty - 1;
            if (remaining > 0) {
                const free_remaining = Math.min(remaining, 1);
                const penalty_remaining = remaining - free_remaining;
                if (penalty_remaining > 0) {
                    row_penalty += penalty_per * penalty_remaining * (penalty_remaining + 1) / 2;
                    penalty = penalty_remaining;
                }
                consec += remaining;
            }
        } else if (penalty > 0) {
            row_penalty = penalty_per * (sim_qty * penalty + sim_qty * (sim_qty + 1) / 2);
            penalty += sim_qty;
            consec += sim_qty;
        } else {
            const free_casts = Math.max(0, Math.min(sim_qty, 2 - consec));
            const penalty_casts = sim_qty - free_casts;
            if (penalty_casts > 0) {
                row_penalty = penalty_per * penalty_casts * (penalty_casts + 1) / 2;
                penalty = penalty_casts;
            }
            consec += sim_qty;
        }
        row.recast_penalty_per_cast = sim_qty > 0 ? row_penalty / sim_qty : 0;
    }
}

/**
 * Pure mana+HP simulation kernel for Blood Pact / Bak'al's Grasp / Corruption /
 * Massacre / Mindless Slaughter. Shared by both main thread and worker. DOM-free.
 *
 * Uses generic buff_state / trigger mechanism from extract_health_config().
 * Melee-cooldown-aware wall-clock timing model.
 *
 * @param {Object[]} rows - Pre-parsed combo rows. Each row:
 *   { qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast }
 *   pseudo: null | 'cancel_state:<name>' | 'mana_reset'
 * @param {Map} base_stats - Aggregated build statMap
 * @param {Object} health_config - From extract_health_config()
 * @param {boolean} has_transcendence - Whether ARCANES major ID is active
 * @param {Object[]} boost_registry - Boost registry for apply_combo_row_boosts
 * @returns {Object} { end_mana, start_mana, max_mana, end_hp, max_hp,
 *                     row_results[], spell_costs[], total_mana_cost, melee_hits,
 *                     recast_penalty_total }
 */
function simulate_combo_mana_hp(rows, base_stats, health_config, has_transcendence, boost_registry, scratch_row) {
    const mr = base_stats.get('mr') ?? 0;
    const ms = base_stats.get('ms') ?? 0;
    const item_mana = base_stats.get('maxMana') ?? 0;
    const int_mana = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
    const start_mana = 100 + item_mana + int_mana;
    const max_mana = start_mana;

    const base_hp = base_stats.get('hp') ?? 0;
    const hp_bonus = base_stats.get('hpBonus') ?? 0;
    const max_hp = Math.max(5, base_hp + hp_bonus);
    const hpr_raw = base_stats.get('hprRaw') ?? 0;
    const hpr_pct = base_stats.get('hprPct') ?? 0;
    const total_hpr = rawToPct(hpr_raw, hpr_pct / 100);
    const hpr_tick = total_hpr + HIDDEN_BASE_HPR;
    const mr_per_sec = (mr + BASE_MANA_REGEN) / MANA_TICK_SECONDS;

    const health_cost_pct = health_config.health_cost;

    // Mana steal setup
    let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
        + (base_stats.get('atkTier') ?? 0);
    adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
    const ms_per_hit = ms > 0 ? ms / 3 / baseDamageMultiplier[adjAtkSpd] : 0;

    // Generic buff state tracking
    const active_states = {};
    for (const bs of health_config.buff_states) {
        active_states[bs.state_name] = { active: false, value: 0 };
    }
    const state_melee_hits = {};
    for (const bs of health_config.buff_states) {
        state_melee_hits[bs.state_name] = 0;
    }

    // Melee cooldown tracking
    const melee_period = 1 / baseDamageMultiplier[adjAtkSpd];
    let melee_cd_remaining = 0;

    // State
    let mana = start_mana;
    let hp = max_hp;
    let elapsed_time = 0;

    const row_results = [];
    const spell_costs = [];
    let total_mana_cost = 0;
    let melee_hits = 0;
    let recast_penalty_total = 0;

    for (const row of rows) {
        const { qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast = 0,
                cast_time: row_cast_time, delay: row_delay } = row;

        // Cancel state pseudo-spell (e.g. "cancel_state:Corrupted")
        if (pseudo?.startsWith('cancel_state:')) {
            const state_name = pseudo.slice('cancel_state:'.length);
            const st = active_states[state_name];
            if (st?.active && !mana_excl) {
                for (const trigger of health_config.exit_triggers) {
                    if (trigger.state === state_name && trigger.on === 'exit') {
                        hp = _apply_exit_trigger(trigger, st.value, max_hp, hp,
                            boost_tokens, state_melee_hits[state_name], elapsed_time);
                    }
                }
                st.active = false;
                st.value = 0;
                state_melee_hits[state_name] = 0;
            }
            row_results.push({ blood_pact_bonus: 0, state_values: _snapshot_states(active_states), hp_warning: false, mana_warning: false });
            continue;
        }

        // Mana Reset pseudo-spell
        if (pseudo === 'mana_reset') {
            row_results.push({ blood_pact_bonus: 0, state_values: _snapshot_states(active_states), hp_warning: false, mana_warning: false });
            continue;
        }

        // Add Flat Mana pseudo-spell: inject (or drain) qty mana at this point
        if (pseudo === 'add_flat_mana') {
            if (!mana_excl && qty !== 0) {
                mana = Math.max(0, Math.min(max_mana, mana + qty));
            }
            row_results.push({ blood_pact_bonus: 0, state_values: _snapshot_states(active_states), hp_warning: false, mana_warning: false });
            continue;
        }

        if (qty <= 0 || !spell) {
            row_results.push({ blood_pact_bonus: 0, state_values: _snapshot_states(active_states), hp_warning: false, mana_warning: false });
            continue;
        }

        // Mana-excluded rows: skip cost/regen tracking entirely
        if (mana_excl) {
            if (spell.scaling === 'melee') {
                melee_hits += row.is_melee_time
                    ? Math.round(compute_melee_time_hits(qty, base_stats, row_delay ?? SPELL_CAST_DELAY))
                    : Math.round(qty);
            }
            row_results.push({ blood_pact_bonus: 0, state_values: _snapshot_states(active_states), hp_warning: false, mana_warning: false });
            continue;
        }

        // Get spell cost using boosted stats (matching main thread behavior)
        const { stats: row_stats } = apply_combo_row_boosts(base_stats, boost_tokens, boost_registry, scratch_row);
        const cost_per = spell.cost != null ? getSpellCost(row_stats, spell) : 0;
        const is_spell = spell.cost != null;
        const is_melee_scaling = spell.scaling === 'melee';
        const recast_base = spell.mana_derived_from ?? spell.base_spell;
        const is_melee = recast_base === 0;

        const eff_cast_time = is_melee ? 0 : (row_cast_time ?? SPELL_CAST_TIME);
        const eff_delay = row_delay ?? SPELL_CAST_DELAY;

        // Mana/HP simulation uses rounded qty (casts are discrete).
        // Fractional qty only affects damage output (per_cast * qty in
        // compute_combo_damage_totals).
        // Melee Time rows: compute effective hits from attack speed.
        const sim_qty = row.is_melee_time
            ? Math.round(compute_melee_time_hits(qty, base_stats, eff_delay))
            : Math.round(qty);
        if (is_melee_scaling) melee_hits += sim_qty;
        recast_penalty_total += recast_penalty_per_cast * sim_qty;

        let row_blood_total = 0;
        let row_blood_casts = 0;
        let hp_warning = false;
        let mana_warning = false;
        let row_mana_cost = 0;

        for (let c = 0; c < sim_qty; c++) {
            // ── Wall-clock time advancement (melee cooldown + spell overlap) ──
            const dt = compute_wall_dt(is_melee, is_spell, melee_cd_remaining, melee_period, eff_cast_time, eff_delay);
            const wall_dt = dt.wall_dt;
            melee_cd_remaining = dt.melee_cd;

            if (wall_dt > 0) {
                const prev_time = elapsed_time;
                elapsed_time += wall_dt;

                // Mana regen (proportional to wall time)
                mana = Math.min(max_mana, mana + mr_per_sec * wall_dt);

                // HP regen tick check (suppressed by active buff states with suppress_healing)
                const any_suppress = health_config.buff_states.some(
                    bs => bs.suppress_healing && active_states[bs.state_name]?.active);
                if (!any_suppress) {
                    const prev_ticks = Math.floor(prev_time / HPR_TICK_SECONDS);
                    const cur_ticks = Math.floor(elapsed_time / HPR_TICK_SECONDS);
                    if (cur_ticks > prev_ticks) {
                        hp = Math.min(max_hp, hp + hpr_tick * (cur_ticks - prev_ticks));
                    }
                }
            }

            // Melee hit tracking for states
            if (is_melee_scaling) {
                for (const bs of health_config.buff_states) {
                    if (active_states[bs.state_name]?.active) {
                        state_melee_hits[bs.state_name] += 1;
                    }
                }
            }

            // Mana steal from melee hits
            if (is_melee_scaling && ms_per_hit > 0) {
                mana = Math.min(max_mana, mana + ms_per_hit);
            }

            // Spell-level HP cost & state tracking (Massacre / Mindless Slaughter)
            for (const bs of health_config.buff_states) {
                const st = active_states[bs.state_name];
                if (!st?.active) continue;

                // Per-second rate (Massacre: melee corruption while corrupted)
                if (bs.spell_rate_field) {
                    const rate = spell[bs.spell_rate_field] ?? 0;
                    if (rate > 0) st.value = Math.min(100, st.value + rate / baseDamageMultiplier[adjAtkSpd]);
                }
                // Per-cast flat (Massacre: powder special corruption)
                if (bs.spell_flat_field) {
                    const flat = spell[bs.spell_flat_field] ?? 0;
                    if (flat > 0) st.value = Math.min(100, st.value + flat);
                }

                // HP cost from spell (Mindless Slaughter) — gated on THIS state being active
                const spell_hp_cost = spell.hp_cost ?? 0;
                if (spell_hp_cost > 0) {
                    const hp_deduction = spell_hp_cost / 100 * max_hp;
                    if (hp < hp_deduction) hp_warning = true;
                    hp -= hp_deduction;
                    // Track state value via hp_loss_pct
                    if (bs.tracking === 'hp_loss_pct') {
                        st.value = Math.min(100, st.value + spell_hp_cost);
                    }
                    // Blood Pact at 100% blood ratio (entire cost is HP)
                    if (health_config.damage_boost) {
                        row_blood_total += health_config.damage_boost.max;
                        row_blood_casts++;
                    }
                }
            }

            // Spell cost payment
            if (is_spell) {
                const effective_cost = cost_per + recast_penalty_per_cast;
                const adj_cost = has_transcendence ? effective_cost * 0.75 : effective_cost;

                if (mana >= effective_cost) {
                    // Castable — apply transcendence discount
                    mana -= adj_cost;
                } else if (health_cost_pct > 0) {
                    // Blood Pact: pay remaining from health (transcendence still applies)
                    const remaining_mana = Math.max(0, mana);
                    const health_mana = adj_cost - remaining_mana;
                    mana = 0;
                    const blood_ratio = health_mana / adj_cost;

                    // Health cost
                    const hp_cost = health_mana * health_cost_pct * max_hp / 100;
                    if (hp < hp_cost) hp_warning = true;
                    hp -= hp_cost;

                    // Track corruption from HP costs
                    for (const bs of health_config.buff_states) {
                        const st = active_states[bs.state_name];
                        if (st?.active && bs.tracking === 'hp_loss_pct') {
                            st.value = Math.min(100, st.value + hp_cost / max_hp * 100);
                        }
                    }

                    const db = health_config.damage_boost;
                    if (db) {
                        row_blood_total += db.min + (db.max - db.min) * blood_ratio;
                        row_blood_casts++;
                    }
                } else {
                    // Not castable, no BP — no transcendence benefit
                    mana -= effective_cost;
                    mana_warning = true;
                }

                row_mana_cost += adj_cost;

                // State activation (generic: replaces hardcoded base_spell === 4)
                for (const bs of health_config.buff_states) {
                    if (bs.activate_on?.spell != null && spell.base_spell === bs.activate_on.spell) {
                        const st = active_states[bs.state_name];
                        if (st && !st.active) { st.active = true; st.value = 0; }
                    }
                }
            }
        }

        const avg_blood_bonus = row_blood_casts > 0 ? row_blood_total / row_blood_casts : 0;
        total_mana_cost += row_mana_cost;
        if (is_spell) {
            spell_costs.push({ name: spell.name, qty: sim_qty, cost: cost_per, recast_penalty: recast_penalty_per_cast * sim_qty });
        }

        row_results.push({ blood_pact_bonus: avg_blood_bonus, state_values: _snapshot_states(active_states), hp_warning, mana_warning });
    }

    return {
        end_mana: mana,
        start_mana,
        max_mana,
        end_hp: hp,
        max_hp,
        row_results,
        spell_costs,
        total_mana_cost,
        melee_hits,
        recast_penalty_total,
    };
}

/**
 * Lightweight mana-only simulation for non-Blood-Pact worker checks.
 * Shares the same per-cast mana loop logic as simulate_combo_mana_hp but skips:
 *   - row_results array (tracks only a has_hp_warning boolean)
 *   - spell_costs array construction
 *   - _snapshot_states() calls
 *   - blood_pact_bonus tracking
 *
 * Returns { start_mana, end_mana, max_mana, has_hp_warning, has_mana_warning }.
 *
 * IMPORTANT: Any change to the mana loop in simulate_combo_mana_hp must be
 * mirrored here. See test_mana_sim.js for divergence guards.
 */
function simulate_combo_mana_fast(rows, base_stats, health_config, has_transcendence, boost_registry, scratch_row) {
    const mr = base_stats.get('mr') ?? 0;
    const ms = base_stats.get('ms') ?? 0;
    const item_mana = base_stats.get('maxMana') ?? 0;
    const int_mana = Math.floor(skillPointsToPercentage(base_stats.get('int') ?? 0) * 100);
    const start_mana = 100 + item_mana + int_mana;
    const max_mana = start_mana;

    const health_cost_pct = health_config.health_cost;
    const base_hp = base_stats.get('hp') ?? 0;
    const hp_bonus = base_stats.get('hpBonus') ?? 0;
    const max_hp = Math.max(5, base_hp + hp_bonus);

    const mr_per_sec = (mr + BASE_MANA_REGEN) / MANA_TICK_SECONDS;

    // Mana steal setup
    let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
        + (base_stats.get('atkTier') ?? 0);
    adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
    const ms_per_hit = ms > 0 ? ms / 3 / baseDamageMultiplier[adjAtkSpd] : 0;

    // Melee cooldown tracking
    const melee_period = 1 / baseDamageMultiplier[adjAtkSpd];
    let melee_cd_remaining = 0;

    // State
    let mana = start_mana;
    let hp = max_hp;
    let elapsed_time = 0;
    let has_hp_warning = false;
    let has_mana_warning = false;

    for (const row of rows) {
        const { qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast = 0,
                cast_time: row_cast_time, delay: row_delay } = row;

        // Add Flat Mana: inject (or drain) qty mana at this point
        if (pseudo === 'add_flat_mana') {
            if (!mana_excl && qty !== 0) mana = Math.max(0, Math.min(max_mana, mana + qty));
            continue;
        }
        if (pseudo || qty <= 0 || !spell) continue;
        if (mana_excl) continue;

        const { stats: row_stats } = apply_combo_row_boosts(base_stats, boost_tokens, boost_registry, scratch_row);
        const cost_per = spell.cost != null ? getSpellCost(row_stats, spell) : 0;
        const is_spell = spell.cost != null;
        const is_melee_scaling = spell.scaling === 'melee';
        const recast_base = spell.mana_derived_from ?? spell.base_spell;
        const is_melee = recast_base === 0;

        const eff_cast_time = is_melee ? 0 : (row_cast_time ?? SPELL_CAST_TIME);
        const eff_delay = row_delay ?? SPELL_CAST_DELAY;
        const sim_qty = row.is_melee_time
            ? Math.round(compute_melee_time_hits(qty, base_stats, eff_delay))
            : Math.round(qty);

        for (let c = 0; c < sim_qty; c++) {
            // ── Wall-clock time advancement (melee cooldown + spell overlap) ──
            const dt = compute_wall_dt(is_melee, is_spell, melee_cd_remaining, melee_period, eff_cast_time, eff_delay);
            const wall_dt = dt.wall_dt;
            melee_cd_remaining = dt.melee_cd;

            if (wall_dt > 0) {
                elapsed_time += wall_dt;
                // Mana regen (proportional to wall time)
                mana = Math.min(max_mana, mana + mr_per_sec * wall_dt);
            }

            // Mana steal from melee hits
            if (is_melee_scaling && ms_per_hit > 0) {
                mana = Math.min(max_mana, mana + ms_per_hit);
            }

            // Spell-level HP cost (Mindless Slaughter)
            const spell_hp_cost = spell.hp_cost ?? 0;
            if (spell_hp_cost > 0) {
                const hp_deduction = spell_hp_cost / 100 * max_hp;
                if (hp < hp_deduction) has_hp_warning = true;
                hp -= hp_deduction;
            }

            // Spell cost payment
            if (is_spell) {
                const effective_cost = cost_per + recast_penalty_per_cast;
                const adj_cost = has_transcendence ? effective_cost * 0.75 : effective_cost;

                if (mana >= effective_cost) {
                    // Castable — apply transcendence discount
                    mana -= adj_cost;
                } else if (health_cost_pct > 0) {
                    // Blood Pact: pay remaining from health (transcendence still applies)
                    const remaining_mana = Math.max(0, mana);
                    const health_mana = adj_cost - remaining_mana;
                    mana = 0;

                    const hp_cost = health_mana * health_cost_pct * max_hp / 100;
                    if (hp < hp_cost) has_hp_warning = true;
                    hp -= hp_cost;
                } else {
                    // Not castable, no BP — no transcendence benefit
                    mana -= effective_cost;
                    has_mana_warning = true;
                }
            }
        }
    }

    return { start_mana, end_mana: mana, max_mana, has_hp_warning, has_mana_warning };
}

function _snapshot_states(active_states) {
    const out = {};
    for (const [k, v] of Object.entries(active_states)) out[k] = v.value;
    return out;
}

function _apply_exit_trigger(trigger, state_value, max_hp, hp, boost_tokens, melee_hits, elapsed_time) {
    switch (trigger.effect) {
        case 'heal_pct_of_state':
            return Math.min(max_hp, hp + state_value * trigger.value / 100 * max_hp);
        case 'heal_per_hit': {
            const enemies = _get_boost_token_value(boost_tokens, trigger.slider_name);
            const max_procs = trigger.cooldown > 0 ? Math.floor(elapsed_time / trigger.cooldown) : melee_hits;
            const procs = Math.min(melee_hits, max_procs);
            const missing_ratio = Math.max(0, (max_hp - hp) / max_hp);
            return Math.min(max_hp, hp + procs * enemies * trigger.value * missing_ratio * max_hp);
        }
    }
    return hp;
}

function _get_boost_token_value(boost_tokens, name) {
    if (!boost_tokens || !name) return 0;
    for (const t of boost_tokens) {
        if (t.name === name) return t.value;
    }
    return 0;
}
