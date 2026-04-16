// ── Sensitivity baseline — setup primitives for the sensitivity pipeline ────
//
// Self-contained building blocks: baseline statMap construction, combo
// assembly on the main thread, SP allocation, pool-calibrated deltas, and
// the main-thread score evaluator.  All consumed by sensitivity.js.
//
// Dependencies (loaded before this file):
//   - priority/helpers.js:  _NONE_EQUIP_SM, _PERTURBABLE_STATS, _DEFAULT_DELTAS,
//                           _item_stat_val
//   - worker_shims.js:      _init_running_statmap, _finalize_leaf_statmap
//   - pure/engine.js:       eval_combo_damage_with_bp, eval_combo_healing,
//                           compute_combo_cycle_time, eval_score_dispatch,
//                           assemble_combo_stats, greedy_sp_allocate
//   - game/skillpoints.js:  calculate_skillpoints
//   - globals:              sets (data/loader.js)

// ══════════════════════════════════════════════════════════════════════════════
// SENSITIVITY-BASED WEIGHT COMPUTATION — BASELINE PRIMITIVES
// ══════════════════════════════════════════════════════════════════════════════

// ── Step 3: Main-thread score evaluator ─────────────────────────────────────

/**
 * Evaluate combo damage + healing for the sensitivity system.
 * Mirrors worker's _eval_combo_damage but returns both damage and healing.
 */
function _eval_sensitivity_combo_damage(combo_base, snap) {
    return eval_combo_damage_with_bp(combo_base, snap.weapon_sm, snap.parsed_combo, {
        hp_casting: snap.hp_casting,
        has_dynamic_sliders: snap.has_dynamic_sliders,
        health_config: snap.health_config,
        boost_registry: snap.boost_registry,
        atree_merged: snap.atree_mgd,
    });
}

/**
 * Evaluate combo healing only (for total_healing target).
 */
function _eval_sensitivity_combo_healing(combo_base, snap) {
    return eval_combo_healing(snap.parsed_combo, combo_base, snap.boost_registry, null);
}

/**
 * Main-thread score evaluator — dispatches via shared eval_score_dispatch.
 */
function _sensitivity_eval_score(combo_base, snap) {
    return eval_score_dispatch(snap.scoring_target, combo_base,
        () => {
            const dmg = _eval_sensitivity_combo_damage(combo_base, snap).total_damage;
            const combo_time = compute_combo_cycle_time(
                snap.parsed_combo, snap.weapon_sm, combo_base.get('atkTier') ?? 0);
            return combo_time > 0 ? dmg / combo_time : dmg;
        },
        () => _eval_sensitivity_combo_healing(combo_base, snap),
        null,
        snap.custom_weights);
}

// ── Step 4: Baseline statMap construction ───────────────────────────────────

/**
 * Build a baseline statMap from locked items + weapon + tomes.
 * Uses worker_shims functions for consistency with the search worker.
 */
function _build_baseline_statmap(snap, locked) {
    // Collect fixed item statMaps (weapon + tomes + locked items)
    const fixed_item_sms = [snap.weapon_sm];
    for (const tome of snap.tomes) {
        if (tome && !tome.statMap.has('NONE')) fixed_item_sms.push(tome.statMap);
    }
    for (const item of Object.values(locked)) {
        if (item && !item.statMap.has('NONE')) fixed_item_sms.push(item.statMap);
    }

    const running_sm = _init_running_statmap(snap.level, fixed_item_sms);

    // Compute activeSetCounts from locked items
    const activeSetCounts = new Map();
    for (const item of Object.values(locked)) {
        if (!item || item.statMap.has('NONE')) continue;
        const setName = item.statMap.get('set');
        if (setName) activeSetCounts.set(setName, (activeSetCounts.get(setName) ?? 0) + 1);
    }

    // all_equip_sms = fixed_item_sms (weapon + tomes + locked items) — used for majorID extraction
    return _finalize_leaf_statmap(running_sm, snap.weapon_sm, activeSetCounts, sets, fixed_item_sms);
}

// ── Step 5: Main-thread combo assembly ──────────────────────────────────────

/**
 * Assemble combo stats from build_sm + total_sp — delegates to shared
 * assemble_combo_stats (no scratch allocation needed on main thread).
 */
function _assemble_baseline_combo(build_sm, total_sp, snap) {
    return assemble_combo_stats(build_sm, total_sp, snap.weapon_sm,
        snap.atree_raw, snap.radiance_boost, snap.atree_mgd,
        snap.button_states, snap.slider_states, snap.static_boosts, null);
}

// ── Step 6: Main-thread greedy SP allocator ─────────────────────────────────

/**
 * Best-effort SP allocation when calculate_skillpoints fails.
 * Ignores cascade ordering — just allocates toward requirement floors
 * proportionally, then lets greedy optimize the rest.
 */
function _best_effort_sp(equip_sms, weapon_sm, sp_budget) {
    // 1. Gather free bonuses and per-attr max requirements (simplified: no cascade)
    const free_bonus = [0, 0, 0, 0, 0];
    const max_req = [0, 0, 0, 0, 0];

    for (const item of equip_sms) {
        const skp = item.get('skillpoints');
        const req = item.get('reqs');
        // Treat all SP bonuses as "free" (best-effort: assume all items activate)
        for (let i = 0; i < 5; i++) {
            free_bonus[i] += skp[i];
            if (req[i] > max_req[i]) max_req[i] = req[i];
        }
    }
    // Weapon requirements and bonuses
    const w_req = weapon_sm.get('reqs');
    const w_skp = weapon_sm.get('skillpoints');
    for (let i = 0; i < 5; i++) {
        if (w_req[i] > max_req[i]) max_req[i] = w_req[i];
        free_bonus[i] += w_skp[i];
    }

    // 2. Compute per-attr demand = max(0, requirement - bonus), capped at SP_PER_ATTR_CAP
    const demand = [0, 0, 0, 0, 0];
    let total_demand = 0;
    for (let i = 0; i < 5; i++) {
        demand[i] = Math.max(0, max_req[i] - free_bonus[i]);
        if (demand[i] > 100) demand[i] = 100;
        total_demand += demand[i];
    }

    // 3. Allocate: if budget covers all demand, use it directly.
    //    Otherwise, scale proportionally.
    const base_sp = [0, 0, 0, 0, 0];
    if (total_demand <= sp_budget) {
        for (let i = 0; i < 5; i++) base_sp[i] = demand[i];
    } else {
        // Proportional allocation within budget
        let allocated = 0;
        for (let i = 0; i < 5; i++) {
            base_sp[i] = Math.min(Math.floor(demand[i] * sp_budget / total_demand), 100);
            allocated += base_sp[i];
        }
        // Distribute remaining budget from rounding (greedy by largest demand first)
        let remaining = sp_budget - allocated;
        const order = [0, 1, 2, 3, 4].sort((a, b) => demand[b] - demand[a]);
        for (const idx of order) {
            if (remaining <= 0) break;
            const add = Math.min(demand[idx] - base_sp[idx], remaining, 100 - base_sp[idx]);
            if (add > 0) { base_sp[idx] += add; remaining -= add; }
        }
    }

    // 4. Compute total_sp = base_sp + free_bonus
    const total_sp = [0, 0, 0, 0, 0];
    let assigned_sp = 0;
    for (let i = 0; i < 5; i++) {
        total_sp[i] = base_sp[i] + free_bonus[i];
        assigned_sp += base_sp[i];
    }

    return { base_sp, total_sp, assigned_sp };
}

/**
 * Greedy SP allocation — uses shared greedy_sp_allocate() from pure/engine.js.
 * Returns { total_sp: [5], assigned_sp }.
 */
function _greedy_sp_alloc_main(build_sm, snap, locked) {
    // Compute base SP requirements from locked items
    const base_sp = [0, 0, 0, 0, 0];
    const total_sp = [0, 0, 0, 0, 0];

    // Gather all equip statMaps for calculate_skillpoints.
    // Free (unlocked) slots use a minimal NONE statMap with required fields.
    const _slots = ['helmet', 'chestplate', 'leggings', 'boots', 'ring1', 'ring2', 'bracelet', 'necklace'];
    const equip_sms = [];
    for (let si = 0; si < _slots.length; si++) {
        const item = locked[_slots[si]];
        equip_sms.push(item ? item.statMap : _NONE_EQUIP_SM);
    }
    equip_sms.push(snap.guild_tome_item.statMap);

    const sp_result = calculate_skillpoints(equip_sms, snap.weapon_sm, snap.sp_budget);

    // SP infeasible — use best-effort requirement-driven allocation, then greedy-optimize the remaining budget for score.
    if (!sp_result) {
        const effort = _best_effort_sp(equip_sms, snap.weapon_sm, snap.sp_budget);
        const remaining = snap.sp_budget - effort.assigned_sp;
        if (remaining > 0) {
            function _trial_score() {
                const cb = _assemble_baseline_combo(build_sm, effort.total_sp, snap);
                return _sensitivity_eval_score(cb, snap);
            }
            const _default_caps = [150, 150, 150, 150, 150];
            effort.assigned_sp += greedy_sp_allocate(
                effort.base_sp, effort.total_sp, remaining, _default_caps, null, _trial_score, null
            );
        }
        return { total_sp: effort.total_sp, assigned_sp: effort.assigned_sp };
    }

    for (let i = 0; i < 5; i++) {
        base_sp[i] = sp_result[0][i];
        total_sp[i] = sp_result[1][i];
    }
    let assigned_sp = sp_result[2];

    function _trial_score() {
        const cb = _assemble_baseline_combo(build_sm, total_sp, snap);
        return _sensitivity_eval_score(cb, snap);
    }

    const _default_caps = [150, 150, 150, 150, 150];
    const remaining = snap.sp_budget - assigned_sp;
    assigned_sp += greedy_sp_allocate(base_sp, total_sp, remaining, _default_caps, null, _trial_score, null);

    return { total_sp, assigned_sp };
}

// ── Step 7: Pool-calibrated deltas ──────────────────────────────────────────

/**
 * Scan all item pools to find representative stat magnitudes.
 * Returns a Map of stat → delta, plus sp_deltas[5] for SP provisions.
 */
function _compute_pool_deltas(pools) {
    const stat_values = {};
    const sp_values = [[], [], [], [], []];

    // Collect stat values from all items in pools
    for (const pool of Object.values(pools)) {
        for (const item of pool) {
            if (item.statMap.has('NONE')) continue;
            const sm = item.statMap;

            for (const stat of _PERTURBABLE_STATS) {
                const v = _item_stat_val(sm, stat);
                if (v !== 0) {
                    if (!stat_values[stat]) stat_values[stat] = [];
                    stat_values[stat].push(Math.abs(v));
                }
            }

            const skp = sm.get('skillpoints');
            if (skp) {
                for (let i = 0; i < 5; i++) {
                    if (skp[i]) sp_values[i].push(Math.abs(skp[i]));
                }
            }
        }
    }

    const _median = (arr) => {
        if (arr.length === 0) return 0;
        arr.sort((a, b) => a - b);
        const mid = arr.length >> 1;
        return arr.length & 1 ? arr[mid] : (arr[mid - 1] + arr[mid]) / 2;
    };

    // Compute deltas for perturbable stats
    const deltas = new Map();
    for (const stat of _PERTURBABLE_STATS) {
        const values = stat_values[stat];
        if (values && values.length >= 3) {
            deltas.set(stat, _median(values));
        } else if (_DEFAULT_DELTAS[stat]) {
            deltas.set(stat, _DEFAULT_DELTAS[stat]);
        }
        // else: skip (delta = 0, no sensitivity computed)
    }

    // Compute SP deltas
    const sp_deltas = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
        sp_deltas[i] = sp_values[i].length >= 3 ? _median(sp_values[i]) : _DEFAULT_DELTAS.sp;
    }

    return { deltas, sp_deltas };
}
