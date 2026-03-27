// ── Item priority scoring & dominance pruning ───────────────────────────────
//
// Extracted from solver_search.js for maintainability.
// Loaded before solver_search.js — all symbols are plain globals consumed there.
//
// Dependencies (loaded before this file):
//   - worker_shims.js: _init_running_statmap, _incr_add_item, _finalize_leaf_statmap,
//                      _INCR_STATIC_IDS, _INCR_STATIC_ID_SET
//   - pure/spell.js:    computeSpellHealingTotal
//   - pure/boost.js:    apply_combo_row_boosts
//   - pure/utils.js:    _deep_clone_statmap, _merge_into,
//                       _apply_radiance_scale_inplace, atree_compute_scaling
//   - pure/simulate.js: simulate_combo_mana_hp
//   - pure/engine.js:   compute_combo_damage_totals
//   - shared_game_stats.js: getDefenseStats, classDefenseMultipliers
//   - build_utils.js: skillPointsToPercentage, skp_order, levelToHPBase

// Debug toggles: SOLVER_DEBUG_PRIORITY, SOLVER_DEBUG_DOMINANCE, SOLVER_DEBUG_SENSITIVITY
// (defined in js/solver/debug_toggles.js)

// Scaling fractions for constraint/mana bonuses relative to max sensitivity weight.
const _CONSTRAINT_WEIGHT_FRACTION = 1.0;
const _MANA_WEIGHT_FRACTION = 3;
const _MANA_RATIO_EXPONENT = 0.5;

// Dampening factor for SP provision sensitivities.
// Item SP provisions don't translate 1:1 to actual allocated SP — they reduce
// requirement burden indirectly, and the freed budget may not all be allocated.
const _SP_SENSITIVITY_DAMPEN = 0.4;

// Scale factor for SP feasibility bonus.  Multiplied against
// max_abs × pressure × (per-index demand share) to produce per-unit
// SP sensitivity.  Higher → SP-providing items compete more strongly
// with damage items when SP budget is tight.
const _SP_FEASIBILITY_SCALE = 3;


// Stats that are computed from the full build (not direct item stats) —
// excluded from constraint weights and dominance check_stats.
// Shared constant from pure/engine.js: INDIRECT_CONSTRAINT_STATS
const _INDIRECT_CONSTRAINT_STATS = INDIRECT_CONSTRAINT_STATS;

// Mapping from indirect constraint stats to the direct item stats that contribute to them.
const _INDIRECT_CONTRIBUTORS = {
    ehp: ['hpBonus', 'hprRaw', 'hprPct', 'eDef', 'tDef', 'wDef', 'fDef', 'aDef'],
    ehp_no_agi: ['hpBonus', 'hprRaw', 'hprPct', 'eDef', 'tDef', 'wDef', 'fDef', 'aDef'],
    total_hp: ['hpBonus'],
    hpr: ['hprRaw', 'hprPct'],
    ehpr: ['hprRaw', 'hprPct', 'eDef', 'tDef', 'wDef', 'fDef', 'aDef'],
};

// Dampening for indirect constraint sensitivity — indirect stats are noisier
// (non-linear EHP formula, def% interaction) so we reduce their weight.
const _INDIRECT_SENS_SCALE = 0.5;

// Mapping from indirect stats to SP indices that affect them via skillPointsToPercentage.
// def (3) and agi (4) affect EHP/EHPR through defense% and agility% in getDefenseStats.
const _INDIRECT_SP_CONTRIBUTORS = {
    ehp: [3, 4],       // def%, agi%
    ehp_no_agi: [3],   // def% only (agi excluded by definition)
    ehpr: [3, 4],      // def%, agi%
    // total_hp, hpr: not affected by SP
};

// eval_indirect_stat() — shared from pure/engine.js
// Local alias for underscore-prefixed call sites.
const _eval_indirect_stat = eval_indirect_stat;

// ── Item stat helpers ────────────────────────────────────────────────────────

/**
 * Read a stat's contribution from an item statMap.
 * Checks maxRolls first (rolled stats), then falls back to direct properties (static stats).
 */
function _item_stat_val(item_sm, stat) {
    const v = item_sm.get('maxRolls')?.get(stat);
    return v !== undefined ? v : (item_sm.get(stat) ?? 0);
}

// ══════════════════════════════════════════════════════════════════════════════
// SENSITIVITY-BASED WEIGHT COMPUTATION
// ══════════════════════════════════════════════════════════════════════════════

// Minimal statMap for empty equipment slots — has the fields calculate_skillpoints needs.
const _NONE_EQUIP_SM = new Map([
    ['skillpoints', [0, 0, 0, 0, 0]],
    ['reqs', [0, 0, 0, 0, 0]],
    ['set', null],
    ['NONE', true],
]);

// Stats that can be perturbed on combo_base directly (fast-tier: additive after
// atree scaling, so perturbing combo_base is equivalent to perturbing the item).
const _PERTURBABLE_STATS = [
    // Generic damage
    'sdPct', 'sdRaw', 'mdPct', 'mdRaw', 'damPct', 'damRaw', 'critDamPct',
    // Per-element (5 × 6)
    ...['e', 't', 'w', 'f', 'a'].flatMap(e => [
        e + 'DamPct', e + 'DamRaw', e + 'SdPct', e + 'SdRaw', e + 'MdPct', e + 'MdRaw',
    ]),
    // Rainbow
    'rSdPct', 'rSdRaw', 'rMdPct', 'rMdRaw', 'rDamPct', 'rDamRaw',
    // Attack
    'atkTier',
    // Defense
    'hpBonus', 'eDef', 'tDef', 'wDef', 'fDef', 'aDef', 'hprRaw', 'hprPct',
    // Mana
    'mr', 'ms', 'maxMana',
    // Spell costs
    'spPct1', 'spPct2', 'spPct3', 'spPct4', 'spRaw1', 'spRaw2', 'spRaw3', 'spRaw4',
    // Utility
    'spd', 'poison', 'lb', 'xpb', 'healPct', 'ls',
    // Neutral damage
    'nDamPct', 'nDamRaw', 'nSdPct', 'nSdRaw', 'nMdPct', 'nMdRaw',
    // Gathering / range
    'gXp', 'gSpd', 'mainAttackRange',
];

// Default delta values when fewer than 3 items in pools have a stat.
const _DEFAULT_DELTAS = {
    sdPct: 25, sdRaw: 150, mdPct: 25, mdRaw: 150,
    damPct: 20, damRaw: 100, critDamPct: 30,
    eDamPct: 20, tDamPct: 20, wDamPct: 20, fDamPct: 20, aDamPct: 20,
    eDamRaw: 100, tDamRaw: 100, wDamRaw: 100, fDamRaw: 100, aDamRaw: 100,
    eSdPct: 20, tSdPct: 20, wSdPct: 20, fSdPct: 20, aSdPct: 20,
    eSdRaw: 100, tSdRaw: 100, wSdRaw: 100, fSdRaw: 100, aSdRaw: 100,
    eMdPct: 20, tMdPct: 20, wMdPct: 20, fMdPct: 20, aMdPct: 20,
    eMdRaw: 100, tMdRaw: 100, wMdRaw: 100, fMdRaw: 100, aMdRaw: 100,
    rSdPct: 15, rSdRaw: 80, rMdPct: 15, rMdRaw: 80,
    rDamPct: 15, rDamRaw: 80,
    hpBonus: 1000, hprRaw: 50, hprPct: 20,
    eDef: 50, tDef: 50, wDef: 50, fDef: 50, aDef: 50,
    mr: 15, ms: 10, maxMana: 5,
    spPct1: 20, spPct2: 20, spPct3: 20, spPct4: 20,
    spRaw1: 5, spRaw2: 5, spRaw3: 5, spRaw4: 5,
    spd: 20, poison: 3000, lb: 30, xpb: 20, healPct: 20, ls: 100,
    nDamPct: 20, nDamRaw: 100, nSdPct: 20, nSdRaw: 100, nMdPct: 20, nMdRaw: 100,
    gXp: 20, gSpd: 20, mainAttackRange: 20,
};

// ── Step 3: Main-thread score evaluator ─────────────────────────────────────

/**
 * Evaluate combo damage + healing for the sensitivity system.
 * Mirrors worker's _eval_combo_damage but returns both damage and healing.
 */
function _eval_sensitivity_combo_damage(combo_base, snap) {
    return eval_combo_damage_with_bp(combo_base, snap.weapon_sm, snap.parsed_combo, {
        hp_casting: snap.hp_casting,
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
        () => _eval_sensitivity_combo_damage(combo_base, snap).total_damage,
        () => _eval_sensitivity_combo_healing(combo_base, snap),
        null);
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
    if (!sp_result) {
        // SP infeasible with locked items — use zero SP
        return { total_sp: [0, 0, 0, 0, 0], assigned_sp: 0 };
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

    const sp_deltas = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
        sp_deltas[i] = sp_values[i].length >= 3 ? _median(sp_values[i]) : 10;
    }

    return { deltas, sp_deltas };
}

// ── Step 8: Core sensitivity computation ────────────────────────────────────

/**
 * Compute sensitivity weights by building a baseline, perturbing each stat,
 * and measuring the change in the scoring target.
 *
 * Returns a Map of stat → sensitivity weight, with:
 *   - ._sp_sensitivities: [5] array of SP provision sensitivities
 *   - ._priority_only: Map of mana stats → weight (when mana is tight)
 * Returns null to signal fallback to legacy weights.
 */
function _compute_sensitivity_weights(snap, locked, pools) {
    const t0 = performance.now();
    const target = snap.scoring_target ?? 'combo_damage';

    // 1. Build baseline statMap from locked items
    const build_sm = _build_baseline_statmap(snap, locked);

    // 2. Greedy SP allocation
    const { total_sp, assigned_sp } = _greedy_sp_alloc_main(build_sm, snap, locked);

    // 3. Assemble combo stats
    const combo_base = _assemble_baseline_combo(build_sm, total_sp, snap);

    // 4. Baseline score
    const baseline_score = _sensitivity_eval_score(combo_base, snap);

    // 5. Pool-calibrated deltas
    const { deltas, sp_deltas } = _compute_pool_deltas(pools);

    // 6. Fallback check: zero baseline for combo_damage means no damage at all
    //    (e.g. no combo rows, or weapon does 0 damage). Other targets (spd, poison)
    //    can legitimately start at 0 with few locked items.
    if (baseline_score === 0 && target === 'combo_damage') {
        if (SOLVER_DEBUG_SENSITIVITY) {
            console.log('[solver][sensitivity] baseline combo_damage = 0, falling back to legacy weights');
        }
        return null;
    }

    const weights = new Map();

    // ── Fast-tier perturbation: perturb combo_base directly ─────────────
    for (const stat of _PERTURBABLE_STATS) {
        const delta = deltas.get(stat);
        if (!delta || delta === 0) continue;

        const old = combo_base.get(stat) ?? 0;
        combo_base.set(stat, old + delta);
        const perturbed_score = _sensitivity_eval_score(combo_base, snap);
        combo_base.set(stat, old); // restore

        const sensitivity = (perturbed_score - baseline_score) / delta;
        if (sensitivity !== 0) {
            weights.set(stat, sensitivity);
        }
    }

    // ── Slow-tier perturbation: SP provisions ───────────────────────────
    const sp_sensitivities = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
        const delta = sp_deltas[i];
        if (!delta || delta === 0) continue;

        const trial_sp = [...total_sp];
        trial_sp[i] += delta;
        const trial_combo = _assemble_baseline_combo(build_sm, trial_sp, snap);
        const perturbed_score = _sensitivity_eval_score(trial_combo, snap);
        sp_sensitivities[i] = (perturbed_score - baseline_score) / delta * _SP_SENSITIVITY_DAMPEN;
    }
    weights._sp_sensitivities = sp_sensitivities;

    // ── SP feasibility bonus ─────────────────────────────────────────
    // When item requirements (locked + pool) exceed the SP budget, SP
    // provisions from free items are essential for build feasibility.
    // Each SP index gets its own independent sensitivity derived from its
    // demand, added on top of the score-based sensitivity (which may be
    // near zero for stats like agi that don't affect the scoring target).
    {
        // Per-index max requirement across all items (locked + weapon + pools).
        // SP is global: if any item needs 125 agi, you need ≥125 agi total.
        const max_req = [0, 0, 0, 0, 0];
        for (const item of Object.values(locked)) {
            if (!item || item.statMap.has('NONE')) continue;
            const reqs = item.statMap.get('reqs');
            if (reqs) for (let i = 0; i < 5; i++) {
                if (reqs[i] > max_req[i]) max_req[i] = reqs[i];
            }
        }
        const w_reqs = snap.weapon_sm.get('reqs');
        if (w_reqs) for (let i = 0; i < 5; i++) {
            if (w_reqs[i] > max_req[i]) max_req[i] = w_reqs[i];
        }
        for (const pool of Object.values(pools)) {
            for (const item of pool) {
                if (item.statMap.has('NONE')) continue;
                const reqs = item.statMap.get('reqs');
                if (reqs) for (let i = 0; i < 5; i++) {
                    if (reqs[i] > max_req[i]) max_req[i] = reqs[i];
                }
            }
        }

        // Subtract locked items' + weapon's SP provisions (offset requirement burden)
        const locked_prov = [0, 0, 0, 0, 0];
        for (const item of Object.values(locked)) {
            if (!item || item.statMap.has('NONE')) continue;
            const skp = item.statMap.get('skillpoints');
            if (skp) for (let i = 0; i < 5; i++) locked_prov[i] += Math.max(0, skp[i]);
        }
        const w_skp = snap.weapon_sm.get('skillpoints');
        if (w_skp) for (let i = 0; i < 5; i++) locked_prov[i] += Math.max(0, w_skp[i]);

        const net_demand = [0, 0, 0, 0, 0];
        let demand_sum = 0;
        for (let i = 0; i < 5; i++) {
            net_demand[i] = Math.max(0, max_req[i] - locked_prov[i]);
            demand_sum += net_demand[i];
        }

        const deficit = demand_sum - snap.sp_budget;
        if (deficit > 0) {
            // Compute max_abs from current stat weights for scaling reference
            let local_max_abs = 1.0;
            for (const [, w] of weights) {
                const a = Math.abs(w);
                if (a > local_max_abs) local_max_abs = a;
            }

            // Each SP index gets an independent feasibility sensitivity
            // proportional to its share of total demand.  The scale constant
            // controls how strongly SP items compete with damage items.
            const pressure = Math.min(deficit / snap.sp_budget, 3.0);
            for (let i = 0; i < 5; i++) {
                if (net_demand[i] > 0) {
                    sp_sensitivities[i] += local_max_abs * pressure
                        * (net_demand[i] / demand_sum) * _SP_FEASIBILITY_SCALE;
                }
            }
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] SP feasibility: demand=${demand_sum}, budget=${snap.sp_budget}, deficit=${deficit}, pressure=${pressure.toFixed(3)}`);
                console.log(`  net_demand:`, net_demand, 'sp_sens after:', sp_sensitivities.map((s, i) =>
                    `${skp_order[i]}: ${s.toFixed(4)}`));
            }
        }
    }

    if (SOLVER_DEBUG_SENSITIVITY) {
        const elapsed = (performance.now() - t0).toFixed(1);
        console.groupCollapsed(`[solver][sensitivity] computed in ${elapsed}ms (target: ${target})`);

        // Baseline summary
        const key_stats = ['hp', 'hpBonus', 'str', 'dex', 'int', 'def', 'agi',
            'sdPct', 'sdRaw', 'mdPct', 'mdRaw', 'damPct', 'damRaw', 'critDamPct',
            'mr', 'ms', 'atkTier'];
        const baseline_summary = {};
        for (const k of key_stats) {
            const v = combo_base.get(k);
            if (v != null && v !== 0) baseline_summary[k] = v;
        }
        console.log('baseline stats:', baseline_summary);
        console.log('baseline score:', baseline_score);
        console.log('total SP:', [...total_sp], 'assigned:', assigned_sp);

        // Sensitivities sorted by |magnitude|
        const sorted = [...weights.entries()]
            .filter(([k]) => typeof k === 'string')
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log('stat sensitivities (sorted by |magnitude|):');
        for (const [stat, sens] of sorted) {
            console.log(`  ${stat}: ${sens.toFixed(4)} (delta: ${deltas.get(stat)})`);
        }
        console.log('SP sensitivities:', sp_sensitivities.map((s, i) =>
            `${skp_order[i]}: ${s.toFixed(4)} (delta: ${sp_deltas[i]})`));

        console.groupEnd();
    }

    return { weights, baseline_score, combo_base, deltas, sp_deltas, total_sp, build_sm };
}

// ── Step 9: Constraint & mana weight integration ────────────────────────────

/**
 * Augment sensitivity weights with constraint bonuses and mana sustainability hints.
 */
function _augment_sensitivity_weights(result, snap, restrictions) {
    const { weights, combo_base, deltas, sp_deltas, total_sp, build_sm } = result;

    // Compute max absolute weight for constraint/mana bonus scaling
    let max_abs = 1.0;
    for (const [stat, w] of weights) {
        const abs_w = Math.abs(w);
        if (abs_w > max_abs) max_abs = abs_w;
    }

    // Compute reference delta (median of all non-zero deltas) for constraint scaling.
    // Stats with small per-item values (e.g. atkTier, delta=1) need proportionally
    // larger per-unit constraint bonuses to compete with multi-stat damage items.
    const all_deltas = [];
    for (const [, d] of deltas) {
        if (d > 0) all_deltas.push(d);
    }
    all_deltas.sort((a, b) => a - b);
    const ref_delta = all_deltas.length > 0
        ? all_deltas[all_deltas.length >> 1]
        : 1;

    // ── Restriction thresholds (ge constraints on direct stats) ─────────
    for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
        if (op !== 'ge' || _INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        const current = combo_base.get(stat) ?? 0;
        const deficit = value - current;
        if (deficit > 0) {
            // Normalize by stat magnitude: stats with small per-item values
            // (atkTier ~1) get larger per-unit bonuses than stats with large
            // per-item values (damPct ~20), so constraint items compete in scoring.
            const stat_delta = deltas.get(stat) || _DEFAULT_DELTAS[stat] || 1;
            const norm = ref_delta / stat_delta;
            // When threshold is positive, scale by deficit/threshold (fractional shortfall).
            // When threshold <= 0 (e.g. mainAttackRange >= 0 with negative current),
            // use deficit/stat_delta instead (how many typical items of deficit).
            const scale = value > 0 ? (deficit / value) : (deficit / stat_delta);
            const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * scale * norm;
            weights.set(stat, (weights.get(stat) ?? 0) + bonus);
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] constraint bonus: ${stat} += ${bonus.toFixed(2)} (deficit: ${deficit.toFixed(0)} / threshold: ${value}, norm: ×${norm.toFixed(1)})`);
            }
        }
    }

    // ── Indirect constraint sensitivity (ehp, ehpr, total_hp, hpr) ───────
    // These stats are computed from the full build via getDefenseStats(), so
    // we can't just read them from the statMap. Instead, perturb each
    // contributing direct stat and measure the indirect stat's response.
    for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
        if (!_INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        if (op !== 'ge') continue;
        if (!_INDIRECT_CONTRIBUTORS[stat]) continue;  // e.g. finalSpellCost — handled separately

        const baseline_val = _eval_indirect_stat(combo_base, stat);
        const deficit = value - baseline_val;
        if (deficit <= 0) continue;  // already met by baseline

        const contributors = _INDIRECT_CONTRIBUTORS[stat];
        for (const cstat of contributors) {
            const delta = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
            const old = combo_base.get(cstat) ?? 0;
            combo_base.set(cstat, old + delta);
            const perturbed_val = _eval_indirect_stat(combo_base, stat);
            combo_base.set(cstat, old);  // restore

            const indirect_sens = (perturbed_val - baseline_val) / delta;
            if (indirect_sens <= 0) continue;

            const stat_delta = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
            const norm = ref_delta / stat_delta;
            const scale = value > 0 ? (deficit / value) : (deficit / stat_delta);
            const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * scale * norm * _INDIRECT_SENS_SCALE * indirect_sens;
            weights.set(cstat, (weights.get(cstat) ?? 0) + bonus);
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] indirect constraint bonus (${stat}): ${cstat} += ${bonus.toFixed(2)} (deficit: ${deficit.toFixed(0)} / threshold: ${value}, sens: ${indirect_sens.toFixed(4)}, norm: ×${norm.toFixed(1)})`);
            }
        }

        // ── SP provision sensitivity for def/agi → EHP/EHPR ─────────────
        // Items providing def/agi SP improve EHP via skillPointsToPercentage,
        // but the direct-stat perturbation above doesn't capture this.
        const sp_indices = _INDIRECT_SP_CONTRIBUTORS[stat];
        if (sp_indices && sp_deltas && total_sp && build_sm) {
            for (const si of sp_indices) {
                const sp_delta = sp_deltas[si] || 10;
                const trial_sp = [...total_sp];
                trial_sp[si] += sp_delta;
                const trial_combo = _assemble_baseline_combo(build_sm, trial_sp, snap);
                const perturbed_val = _eval_indirect_stat(trial_combo, stat);

                const sp_sens = (perturbed_val - baseline_val) / sp_delta;
                if (sp_sens <= 0) continue;

                const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * (deficit / value)
                    * _INDIRECT_SENS_SCALE * sp_sens * _SP_SENSITIVITY_DAMPEN;
                weights._sp_sensitivities[si] += bonus;
                if (SOLVER_DEBUG_SENSITIVITY) {
                    console.log(`[solver][sensitivity] indirect SP constraint bonus (${stat}): ${skp_order[si]} += ${bonus.toFixed(2)} (deficit: ${deficit.toFixed(0)} / threshold: ${value}, sp_sens: ${sp_sens.toFixed(4)})`);
                }
            }
        }
    }

    // ── Mana sustainability (combo_time > 0, not hp_casting) ────────────
    // Uses locked items' mr/ms/int/maxMana via combo_base for accurate deficit.
    const mana_tight = _estimate_mana_tight(snap, combo_base);
    if (mana_tight) {
        if (!weights._priority_only) weights._priority_only = new Map();

        const bal = _estimate_mana_balance(snap, combo_base);
        const deficit = bal.total_cost - bal.start_mana - bal.regen_mana - bal.ms_mana;
        // ratio_raw can exceed 1.0 when negative mr/ms from locked items pushes
        // the deficit well beyond total spell cost.  The sqrt exponent dampens
        // extreme values naturally (e.g. ratio_raw=9 → ratio=3).
        const ratio_raw = bal.total_cost > 0 ? Math.max(0, deficit / bal.total_cost) : 0;
        const ratio = Math.pow(ratio_raw, _MANA_RATIO_EXPONENT);
        const mana_bonus = max_abs * _MANA_WEIGHT_FRACTION * ratio;

        const has_melee = (snap.parsed_combo ?? []).some(r => (r.spell?.scaling ?? 'spell') === 'melee');
        if (mana_bonus > 0) {
            weights._priority_only.set('mr', (weights._priority_only.get('mr') ?? 0) + mana_bonus);
            if (has_melee) {
                weights._priority_only.set('ms', (weights._priority_only.get('ms') ?? 0) + mana_bonus * 0.5);
            }
            weights._priority_only.set('maxMana', (weights._priority_only.get('maxMana') ?? 0) + mana_bonus * 0.3);
            // Boost int SP sensitivity for mana
            weights._sp_sensitivities[2] += mana_bonus * 0.5; // int is index 2

            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] mana bonus: ratio_raw=${ratio_raw.toFixed(3)}, ratio=${ratio.toFixed(3)}, mr+=${mana_bonus.toFixed(2)}` +
                    (has_melee ? `, ms+=${(mana_bonus * 0.5).toFixed(2)}` : ', ms=0 (no melee)'));
            }

            // ── Spell cost reduction bonuses ─────────────────────────
            // Weight spRaw/spPct by cast frequency relative to mr's mana value.
            const mr_equiv = Math.max((snap.combo_time ?? 0) / 5, 1);
            const casts_by_spell = new Map(); // base_spell_num → { total_casts, base_cost }
            for (const { sim_qty, spell, mana_excl } of (snap.parsed_combo ?? [])) {
                if (mana_excl || !spell || spell.cost == null) continue;
                const bs = spell.mana_derived_from ?? spell.base_spell;
                if (!bs) continue;
                const entry = casts_by_spell.get(bs);
                if (entry) {
                    entry.total_casts += sim_qty;
                } else {
                    casts_by_spell.set(bs, { total_casts: sim_qty, base_cost: spell.cost });
                }
            }

            for (const [bs, { total_casts, base_cost }] of casts_by_spell) {
                const raw_key = 'spRaw' + bs;
                const pct_key = 'spPct' + bs;

                // -1 spRaw saves total_casts mana; -1% spPct saves ~base_cost*total_casts/100
                const raw_ratio = Math.min(total_casts / mr_equiv, 3.0);
                const pct_ratio = Math.min(base_cost * total_casts / 100 / mr_equiv, 3.0);

                // Negative weight: items have negative values (cost reduction),
                // so negative × negative = positive score contribution.
                weights._priority_only.set(raw_key,
                    (weights._priority_only.get(raw_key) ?? 0) - mana_bonus * raw_ratio);
                weights._priority_only.set(pct_key,
                    (weights._priority_only.get(pct_key) ?? 0) - mana_bonus * pct_ratio);
            }

            if (SOLVER_DEBUG_SENSITIVITY && casts_by_spell.size > 0) {
                const parts = [];
                for (const [bs, { total_casts, base_cost }] of casts_by_spell) {
                    const raw_r = Math.min(total_casts / mr_equiv, 3.0);
                    const pct_r = Math.min(base_cost * total_casts / 100 / mr_equiv, 3.0);
                    parts.push(`spell${bs}: casts=${total_casts}, cost=${base_cost}, ` +
                        `spRaw${bs}=${(-mana_bonus * raw_r).toFixed(2)}, spPct${bs}=${(-mana_bonus * pct_r).toFixed(2)}`);
                }
                console.log(`[solver][sensitivity] spell cost bonuses: ${parts.join('; ')}`);
            }
        }
    }
}

// ── Weight builders ──────────────────────────────────────────────────────────

/**
 * Legacy damage weight builder — used as fallback when sensitivity computation
 * returns null (e.g. zero baseline damage with combo_damage target).
 */
function _build_dmg_weights_legacy(snap) {
    const weights = new Map();
    const add = (stat, w) => weights.set(stat, (weights.get(stat) ?? 0) + w);

    const target = snap.scoring_target ?? 'combo_damage';

    if (target === 'total_healing') {
        add('healPct', 1.0);
        add('hpBonus', 0.01);
        return weights;
    }

    if (target === 'ehp') {
        add('hpBonus', 0.01);
        add('hprRaw', 0.1);
        return weights;
    }

    if (target === 'spd' || target === 'poison' ||
        target === 'lb' || target === 'xpb') {
        add(target, 1.0);
        return weights;
    }

    add('damPct', 1.0);
    add('damRaw', 0.5);
    add('critDamPct', 0.5);

    const combo = snap.parsed_combo ?? [];
    const has_spell = combo.length === 0 ||
        combo.some(r => (r.spell?.scaling ?? 'spell') === 'spell');
    const has_melee = combo.some(r => r.spell?.scaling === 'melee');

    if (has_spell) {
        add('sdPct', 1.0);
        add('sdRaw', 0.5);
    }
    if (has_melee) {
        add('mdPct', 1.0);
        add('mdRaw', 0.5);
        add('atkTier', 0.3);
    }

    for (const ep of ['e', 't', 'w', 'f', 'a']) {
        add(ep + 'DamPct', 1.0);
        add(ep + 'DamRaw', 0.5);
        if (has_spell) {
            add(ep + 'SdPct', 0.8);
            add(ep + 'SdRaw', 0.4);
        }
        if (has_melee) {
            add(ep + 'MdPct', 0.8);
            add(ep + 'MdRaw', 0.4);
        }
    }

    if (snap.combo_time && !snap.allow_downtime) {
        weights._priority_only = new Map();
        weights._priority_only.set('mr', 0.5);
        if (has_melee) weights._priority_only.set('ms', 0.5);
    }

    return weights;
}

/**
 * Build damage/scoring weights. Uses sensitivity-based computation when possible,
 * falls back to legacy heuristic weights otherwise.
 */
function _build_dmg_weights(snap, locked, pools) {
    const result = _compute_sensitivity_weights(snap, locked, pools);
    if (!result) return _build_dmg_weights_legacy(snap);

    _augment_sensitivity_weights(result, snap, snap.restrictions);
    result.weights._deltas = result.deltas;
    return result.weights;
}

// ── Priority scoring ─────────────────────────────────────────────────────────

/**
 * Score an item's priority. Higher score → iterated earlier.
 * With sensitivity weights, negative stats with positive weights correctly
 * reduce score (no v > 0 guard on main weights).
 */
function _score_item_priority(item_sm, dmg_weights) {
    let score = 0;
    for (const [stat, w] of dmg_weights) {
        score += _item_stat_val(item_sm, stat) * w;
    }
    // SP provision bonus
    const skp = item_sm.get('skillpoints');
    if (skp && dmg_weights._sp_sensitivities) {
        for (let i = 0; i < 5; i++) {
            if (skp[i]) score += skp[i] * dmg_weights._sp_sensitivities[i];
        }
    }
    // Priority-only (mana sustainability) — take max with main weight, not sum.
    // If both systems value a stat in the same direction, use the larger magnitude;
    // the main-loop iteration already contributed main_w, so add only the excess.
    if (dmg_weights._priority_only) {
        for (const [stat, prio_w] of dmg_weights._priority_only) {
            const main_w = dmg_weights.get(stat) ?? 0;
            if (main_w !== 0 && (prio_w > 0) === (main_w > 0)) {
                const extra = Math.abs(prio_w) - Math.abs(main_w);
                if (extra > 0) score += _item_stat_val(item_sm, stat) * extra * Math.sign(prio_w);
            } else {
                score += _item_stat_val(item_sm, stat) * prio_w;
            }
        }
    }
    return score;
}

/**
 * Sort each pool so high-priority items come first, NONE items come last.
 */
function _prioritize_pools(pools, dmg_weights) {

    if (SOLVER_DEBUG_PRIORITY) {
        // Build combined effective weights matching _score_item_priority logic
        const effective = {};
        for (const [stat, w] of dmg_weights) {
            effective[stat] = w;
        }
        if (dmg_weights._priority_only) {
            for (const [stat, w] of dmg_weights._priority_only) {
                effective[stat] = (effective[stat] ?? 0) + w;
            }
        }
        // Sort by absolute value descending for readability
        const sorted = Object.entries(effective).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log('[solver] effective priority weights:', Object.fromEntries(sorted));
        if (dmg_weights._sp_sensitivities) {
            console.log('[solver] SP sensitivities:', dmg_weights._sp_sensitivities.map((s, i) =>
                `${skp_order[i]}: ${s.toFixed(4)}`));
        }
    }

    for (const [slot, pool] of Object.entries(pools)) {
        const none_bucket = [];
        const real_bucket = [];
        for (const item of pool) {
            (item.statMap.has('NONE') ? none_bucket : real_bucket).push(item);
        }

        real_bucket.sort((a, b) =>
            _score_item_priority(b.statMap, dmg_weights) -
            _score_item_priority(a.statMap, dmg_weights)
        );

        if (SOLVER_DEBUG_PRIORITY) {
            console.log(`[solver] priority order for ${slot} (${real_bucket.length} items):`);
            for (let i = 0; i < Math.min(real_bucket.length, 20); i++) {
                const it = real_bucket[i];
                const name = it.statMap.get('displayName') ?? it.statMap.get('name') ?? '?';
                const score = _score_item_priority(it.statMap, dmg_weights);
                console.log(`  #${i + 1}: ${name} (score: ${score.toFixed(1)})`);
            }
            if (real_bucket.length > 20) {
                const last = real_bucket[real_bucket.length - 1];
                const last_name = last.statMap.get('displayName') ?? last.statMap.get('name') ?? '?';
                const last_score = _score_item_priority(last.statMap, dmg_weights);
                console.log(`  ... ${real_bucket.length - 20} more ... last: ${last_name} (score: ${last_score.toFixed(1)})`);
            }
        }

        pool.length = 0;
        for (const it of real_bucket) pool.push(it);
        for (const it of none_bucket) pool.push(it);
    }
}

// ── Dominance stat classification ─────────────────────────────────────────────

/**
 * Estimate mana balance from locked items + combo, mirroring worker's
 * simulate_combo_mana_fast (pure/simulate.js).  Returns an object with mana budget
 * breakdown, or null when no mana gate applies (Blood Pact / no combo_time).
 *
 * When combo_base is null/undefined, falls back to worst-case assumptions
 * (0 mr/ms/int/maxMana from equipment) so dominance pruning with legacy
 * weights remains conservative.
 */
function _estimate_mana_balance(snap, combo_base) {
    if (snap.hp_casting) return null;
    const combo_time = snap.combo_time ?? 0;
    if (!combo_time) return null;

    // Start mana: 100 + int bonus + maxMana (matching worker pure/simulate.js)
    const int_mana = combo_base
        ? Math.floor(skillPointsToPercentage(combo_base.get('int') ?? 0) * 100)
        : 0;
    const item_mana = combo_base ? (combo_base.get('maxMana') ?? 0) : 0;
    const start_mana = 100 + int_mana + item_mana;
    const max_mana = start_mana;

    // MR regen (matching worker pure/simulate.js)
    const mr = combo_base ? (combo_base.get('mr') ?? 0) : 0;
    const mr_per_sec = (mr + BASE_MANA_REGEN) / MANA_TICK_SECONDS;
    const regen_mana = mr_per_sec * combo_time;

    // MS contribution: estimate mana steal from melee-scaling hits
    const ms = combo_base ? (combo_base.get('ms') ?? 0) : 0;
    let ms_mana = 0;
    if (ms > 0 && combo_base) {
        let adjAtkSpd = attackSpeeds.indexOf(combo_base.get('atkSpd'))
            + (combo_base.get('atkTier') ?? 0);
        adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
        const ms_per_hit = ms / 3 / baseDamageMultiplier[adjAtkSpd];

        for (const { sim_qty, spell, mana_excl } of (snap.parsed_combo ?? [])) {
            if (mana_excl || !spell) continue;
            if (spell.scaling === 'melee') {
                ms_mana += ms_per_hit * Math.round(sim_qty);
            }
        }
    }

    // Total spell costs (base costs, no int reduction — overestimates = safe)
    let total_cost = 0;
    for (const { sim_qty, spell, mana_excl, recast_penalty_per_cast } of (snap.parsed_combo ?? [])) {
        if (mana_excl || !spell || spell.cost == null) continue;
        total_cost += spell.cost * sim_qty;
        if (recast_penalty_per_cast) total_cost += recast_penalty_per_cast * sim_qty;
    }

    const end_mana = Math.min(max_mana, start_mana - total_cost + regen_mana + ms_mana);

    return { start_mana, max_mana, end_mana, total_cost, regen_mana, ms_mana };
}

/**
 * Returns true when the combo's mana budget is tight enough that mr/ms
 * should be considered in priority weighting and dominance pruning.
 *
 * When combo_base is provided, uses locked items' mr/ms/int/maxMana for an
 * accurate estimate.  When absent, falls back to worst-case (0 equipment
 * contribution) — conservative for dominance, since "mana is tight" ⇒ more
 * stats enter the dominance set, never fewer.
 */
function _estimate_mana_tight(snap, combo_base) {
    const bal = _estimate_mana_balance(snap, combo_base);
    if (!bal) return false;

    if (snap.allow_downtime) {
        return bal.end_mana < 0;                // net negative → need mr/ms
    } else {
        return (bal.start_mana - bal.end_mana) > 5;  // deficit > 5 → not sustainable
    }
}

/**
 * Classify which stats are "higher-is-better" vs "lower-is-better" for
 * dominance pruning, using sensitivity-sign-based classification.
 *
 * Stats with sensitivity > threshold → higher set
 * Stats with sensitivity < -threshold → lower set
 * Stats with |sensitivity| < threshold → excluded (not monotonic enough)
 *
 * Returns { higher: Set<string>, lower: Set<string> }.
 */
function _build_dominance_stats(snap, dmg_weights, restrictions) {
    const higher = new Set();
    const lower = new Set();

    // Compute threshold from max absolute sensitivity
    let max_abs = 0;
    for (const [stat, w] of dmg_weights) {
        const abs_w = Math.abs(w);
        if (abs_w > max_abs) max_abs = abs_w;
    }
    const threshold = max_abs * 0.005;

    // Classify by sensitivity sign
    for (const [stat, w] of dmg_weights) {
        if (w > threshold) higher.add(stat);
        else if (w < -threshold) lower.add(stat);
    }

    // ge/le restrictions on direct stats
    for (const { stat, op } of (restrictions.stat_thresholds ?? [])) {
        if (_INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        if (op === 'ge') higher.add(stat);
        else if (op === 'le') lower.add(stat);
    }

    // Indirect EHP/HP constraints: add hpBonus to higher set.
    // hpBonus is always positive for EHP and is a clear dominant-direction stat.
    // We skip individual def stats — they interact non-monotonically with EHP
    // and adding all 5 would make dominance proofs nearly impossible.
    for (const { stat, op } of (restrictions.stat_thresholds ?? [])) {
        if (op !== 'ge') continue;
        if (stat === 'ehp' || stat === 'ehp_no_agi' || stat === 'total_hp') {
            higher.add('hpBonus');
            break;
        }
    }

    // Spell cost stats when mana sustainability matters
    if (snap.combo_time > 0 && !snap.hp_casting) {
        const seen = new Set();
        for (const row of (snap.parsed_combo ?? [])) {
            if (row.mana_excl) continue;
            const bs = row.spell?.mana_derived_from ?? row.spell?.base_spell;
            if (bs === 0 || bs === undefined || seen.has(bs)) continue;
            seen.add(bs);
            lower.add('spRaw' + bs);
            lower.add('spPct' + bs);
        }
    }

    // mr/ms enter dominance only when mana is tight.
    // Pass no combo_base → worst-case (0 equipment mr/ms/int/maxMana).
    // Intentionally conservative: if mana is "fine" assuming zero equipment
    // contribution, it's truly fine with any items.  Using actual locked stats
    // could falsely exclude mr/ms from dominance when locked items have good
    // mana stats but free items could make it bad.
    const has_melee = (snap.parsed_combo ?? []).some(r => (r.spell?.scaling ?? 'spell') === 'melee');
    const mana_tight = _estimate_mana_tight(snap);
    if (mana_tight) {
        higher.add('mr');
        if (has_melee) higher.add('ms');
    }

    // Conflict resolution: stat in both sets → remove from both (non-monotonic)
    for (const stat of higher) {
        if (lower.has(stat)) { higher.delete(stat); lower.delete(stat); }
    }

    // atkTier special case: melee DPS + mana-tight/ls-constraint conflict
    const ls_constraint = (restrictions.stat_thresholds ?? []).some(t => t.stat === 'ls' && t.op === 'ge');
    if (has_melee && (mana_tight || ls_constraint)) {
        higher.delete('atkTier');
        lower.delete('atkTier');
    }

    if (SOLVER_DEBUG_SENSITIVITY) {
        console.log('[solver][sensitivity] dominance classification:',
            'higher:', higher.size, 'lower:', lower.size,
            'excluded:', _PERTURBABLE_STATS.length - higher.size - lower.size);
    }

    return { higher, lower };
}

// ── Dominance pruning ─────────────────────────────────────────────────────────

/**
 * Remove dominated items from each pool before search.
 *
 * Item B is dominated by item A when A is a strictly-at-least-as-good
 * drop-in replacement in any build:
 *   1. Every scoring-relevant stat: A >= B
 *   2. Every SP requirement:        A.reqs[i]       <= B.reqs[i]   (cheaper to equip)
 *   3. Every SP provision:          A.skillpoints[i] >= B.skillpoints[i]
 *
 * NONE items are never pruned.
 * Set-bonus interactions are not modelled — this is an approximation, but
 * removing obvious dominatees shrinks pool sizes without meaningfully
 * affecting result quality in practice.
 *
 * Complexity: O(n² × |check_stats|) per pool — fine for typical pool sizes.
 *
 * @returns {number} Total items pruned across all pools.
 */
function _prune_dominated_items(pools, dominance_stats) {
    const higher_stats = [...dominance_stats.higher];
    const lower_stats = [...dominance_stats.lower];

    const _dbg = SOLVER_DEBUG_DOMINANCE;
    if (_dbg) {
        console.groupCollapsed('[solver][dominance] check stats');
        console.log('higher-is-better:', higher_stats);
        console.log('lower-is-better:', lower_stats);
        console.groupEnd();
    }

    let total_pruned = 0;

    for (const [slot, pool] of Object.entries(pools)) {
        // Separate NONE items (never pruned) from real items
        const real = [];
        const none_bucket = [];
        for (const item of pool) {
            (item.statMap.has('NONE') ? none_bucket : real).push(item);
        }
        if (real.length < 2) continue;

        const dominated = new Array(real.length).fill(false);
        // Debug: record which item dominated each pruned item
        const dominated_by = _dbg ? new Array(real.length).fill(-1) : null;

        const _name = (sm) => sm.get('displayName') ?? sm.get('name') ?? '?';

        for (let i = 0; i < real.length; i++) {
            if (dominated[i]) continue;
            const a_sm = real[i].statMap;
            const a_reqs = a_sm.get('reqs') ?? [0, 0, 0, 0, 0];
            const a_skp = a_sm.get('skillpoints') ?? [0, 0, 0, 0, 0];
            const a_illegal = real[i]._illegalSet ?? null;

            for (let j = 0; j < real.length; j++) {
                if (i === j || dominated[j]) continue;
                const b_sm = real[j].statMap;

                // Exclusive set guard: an item from an exclusive set must not
                // dominate items outside that set (or from a different exclusive
                // set).  Only one item per exclusive set can appear in a build,
                // so the dominator might not actually be available.
                const b_illegal = real[j]._illegalSet ?? null;
                if (a_illegal && a_illegal !== b_illegal) continue;

                // 1. Higher-is-better stats: A >= B on all
                let ok = true;
                for (const stat of higher_stats) {
                    if (_item_stat_val(a_sm, stat) < _item_stat_val(b_sm, stat)) {
                        ok = false; break;
                    }
                }
                if (!ok) continue;

                // 2. Lower-is-better stats: A <= B on all
                for (const stat of lower_stats) {
                    if (_item_stat_val(a_sm, stat) > _item_stat_val(b_sm, stat)) {
                        ok = false; break;
                    }
                }
                if (!ok) continue;

                // 3. SP requirements: A.reqs[i] <= B.reqs[i] for all i
                const b_reqs = b_sm.get('reqs') ?? [0, 0, 0, 0, 0];
                for (let k = 0; k < 5; k++) {
                    if ((a_reqs[k] ?? 0) > (b_reqs[k] ?? 0)) { ok = false; break; }
                }
                if (!ok) continue;

                // 4. SP provisions: A.skillpoints[i] >= B.skillpoints[i] for all i
                const b_skp = b_sm.get('skillpoints') ?? [0, 0, 0, 0, 0];
                for (let k = 0; k < 5; k++) {
                    if ((a_skp[k] ?? 0) < (b_skp[k] ?? 0)) { ok = false; break; }
                }
                if (!ok) continue;

                dominated[j] = true;
                if (_dbg) dominated_by[j] = i;
            }
        }

        const pruned_count = dominated.filter(Boolean).length;
        total_pruned += pruned_count;

        if (_dbg) {
            const sp_names = ['str', 'dex', 'int', 'def', 'agi'];
            console.groupCollapsed(
                `[solver][dominance] ${slot}: ${real.length} → ${real.length - pruned_count} (pruned ${pruned_count})`
            );

            // Log each pruned item with its dominator and the stat comparison
            for (let j = 0; j < real.length; j++) {
                if (!dominated[j]) continue;
                const b_sm = real[j].statMap;
                const a_sm = real[dominated_by[j]].statMap;
                const b_name = _name(b_sm);
                const a_name = _name(a_sm);

                const diffs = [];
                for (const stat of higher_stats) {
                    const av = _item_stat_val(a_sm, stat), bv = _item_stat_val(b_sm, stat);
                    if (av !== 0 || bv !== 0) diffs.push(`${stat}: ${av} >= ${bv}`);
                }
                for (const stat of lower_stats) {
                    const av = _item_stat_val(a_sm, stat), bv = _item_stat_val(b_sm, stat);
                    if (av !== 0 || bv !== 0) diffs.push(`${stat}: ${av} <= ${bv}`);
                }
                const a_reqs = a_sm.get('reqs') ?? [0, 0, 0, 0, 0];
                const b_reqs = b_sm.get('reqs') ?? [0, 0, 0, 0, 0];
                for (let k = 0; k < 5; k++) {
                    if ((a_reqs[k] ?? 0) !== 0 || (b_reqs[k] ?? 0) !== 0)
                        diffs.push(`req.${sp_names[k]}: ${a_reqs[k] ?? 0} <= ${b_reqs[k] ?? 0}`);
                }
                const a_skp = a_sm.get('skillpoints') ?? [0, 0, 0, 0, 0];
                const b_skp = b_sm.get('skillpoints') ?? [0, 0, 0, 0, 0];
                for (let k = 0; k < 5; k++) {
                    if ((a_skp[k] ?? 0) !== 0 || (b_skp[k] ?? 0) !== 0)
                        diffs.push(`skp.${sp_names[k]}: ${a_skp[k] ?? 0} >= ${b_skp[k] ?? 0}`);
                }

                console.groupCollapsed(`${b_name}  dominated by  ${a_name}`);
                console.log(diffs.join('\n'));
                console.groupEnd();
            }

            // Log surviving items
            const survivors = [];
            for (let i = 0; i < real.length; i++) {
                if (!dominated[i]) survivors.push(_name(real[i].statMap));
            }
            console.log('survivors:', survivors);
            console.groupEnd();
        }

        // Rebuild pool in-place: non-dominated reals first, NONE at end
        pool.length = 0;
        for (let i = 0; i < real.length; i++) {
            if (!dominated[i]) pool.push(real[i]);
        }
        for (const ni of none_bucket) pool.push(ni);
    }

    if (total_pruned > 0) {
        console.log('[solver] dominance pruning removed', total_pruned, 'items across all pools');
    }
    return total_pruned;
}

// Test exports (Node.js only)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _item_stat_val, _build_dominance_stats, _prune_dominated_items,
        _INDIRECT_CONSTRAINT_STATS,
    };
}
