// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WORKER HELPERS
// Worker-only code that cannot be shared with the main thread.
//
// Dependencies (loaded via importScripts before this file):
//   - utils.js:       zip2, round_near, clamp, rawToPct, rawToPctUncapped, etc.
//   - build_utils.js: merge_stat, skp_order, skp_elements, skillPointsToPercentage,
//                     skillpoint_final_mult, reversedIDs, levelToHPBase,
//                     STATMAP_STATIC_IDS, STATMAP_STATIC_ID_SET,
//                     createBaseStatmap, applySetBonuses, finalizeStatmap
//   - damage_calc.js: calculateSpellDamage
//   - shared_game_stats.js: classDefenseMultipliers, damageMultipliers,
//                           specialNames, radiance_affected, getDefenseStats,
//                           getBaseSpellCost, getSpellCost
//   - pure.js: computeSpellDisplayAvg, find_all_matching_boosts,
//                     apply_combo_row_boosts, atree_compute_scaling,
//                     atree_translate, apply_spell_prop_overrides,
//                     spell_has_heal, computeSpellHealingTotal,
//                     _deep_clone_statmap, _merge_into,
//                     _apply_radiance_scale
// ══════════════════════════════════════════════════════════════════════════════

// worker_atree_scaling and atree_translate moved to pure.js (atree_compute_scaling)

// ── Build stat assembly (replaces Build.initBuildStats without DOM) ─────────

// ── Incremental stat accumulation helpers ────────────────────────────────────
// Uses STATMAP_STATIC_IDS / STATMAP_STATIC_ID_SET from build_utils.js

/**
 * Add an item's stats to a running statMap (incremental accumulation).
 * Only handles additive stats (staticIDs + maxRolls). damMult/defMult/healMult
 * are set up at the leaf, not during incremental search.
 */
function _incr_add_item(running_sm, item_sm) {
    const maxRolls = item_sm.get('maxRolls');
    if (maxRolls) {
        for (const [id, value] of maxRolls) {
            if (STATMAP_STATIC_ID_SET.has(id)) continue;
            running_sm.set(id, (running_sm.get(id) || 0) + value);
        }
    }
    for (let i = 0; i < STATMAP_STATIC_IDS.length; i++) {
        const id = STATMAP_STATIC_IDS[i];
        const v = item_sm.get(id);
        if (v) running_sm.set(id, (running_sm.get(id) || 0) + v);
    }
}

/**
 * Remove an item's stats from a running statMap (backtrack).
 * Exact inverse of _incr_add_item.
 */
function _incr_remove_item(running_sm, item_sm) {
    const maxRolls = item_sm.get('maxRolls');
    if (maxRolls) {
        for (const [id, value] of maxRolls) {
            if (STATMAP_STATIC_ID_SET.has(id)) continue;
            running_sm.set(id, (running_sm.get(id) || 0) - value);
        }
    }
    for (let i = 0; i < STATMAP_STATIC_IDS.length; i++) {
        const id = STATMAP_STATIC_IDS[i];
        const v = item_sm.get(id);
        if (v) running_sm.set(id, (running_sm.get(id) || 0) - v);
    }
}

/**
 * Initialize a running statMap from level + fixed items (locked equips, tomes, weapon).
 * This is the base that free items are incrementally added to/removed from during search.
 */
function _init_running_statmap(level, fixed_item_sms) {
    const sm = createBaseStatmap(level);
    for (const item_sm of fixed_item_sms) {
        _incr_add_item(sm, item_sm);
    }
    return sm;
}

/**
 * Finalize a leaf statMap from the running accumulated stats.
 * Applies set bonuses, sets up damMult/defMult/healMult/majorIDs.
 * Finalizes all stats at the leaf level of the search tree.
 */
function _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets_map, all_equip_sms, target, inner_scratch) {
    let sm;
    if (target) {
        sm = target;
        sm.clear();
        for (const [k, v] of running_sm) sm.set(k, v);
    } else {
        sm = new Map(running_sm);
    }

    applySetBonuses(sm, activeSetCounts, sets_map);
    finalizeStatmap(sm, weapon_sm, all_equip_sms, inner_scratch);

    return sm;
}

// getBaseSpellCost and getSpellCost moved to shared_game_stats.js
