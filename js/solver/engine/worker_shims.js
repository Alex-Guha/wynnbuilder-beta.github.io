// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WORKER HELPERS
// Worker-only code that cannot be shared with the main thread.
//
// Dependencies (loaded via importScripts before this file):
//   - utils.js:       zip2, round_near, clamp, rawToPct, rawToPctUncapped, etc.
//   - build_utils.js: merge_stat, skp_order, skp_elements, skillPointsToPercentage,
//                     skillpoint_final_mult, reversedIDs, levelToHPBase
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

const _INCR_STATIC_IDS = ["hp", "eDef", "tDef", "wDef", "fDef", "aDef", "str", "dex", "int", "def", "agi", "damMobs", "defMobs"];
const _INCR_STATIC_ID_SET = new Set(_INCR_STATIC_IDS);

/**
 * Add an item's stats to a running statMap (incremental accumulation).
 * Only handles additive stats (staticIDs + maxRolls). damMult/defMult/healMult
 * are set up at the leaf, not during incremental search.
 */
function _incr_add_item(running_sm, item_sm) {
    const maxRolls = item_sm.get('maxRolls');
    if (maxRolls) {
        for (const [id, value] of maxRolls) {
            if (_INCR_STATIC_ID_SET.has(id)) continue;
            running_sm.set(id, (running_sm.get(id) || 0) + value);
        }
    }
    for (let i = 0; i < _INCR_STATIC_IDS.length; i++) {
        const id = _INCR_STATIC_IDS[i];
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
            if (_INCR_STATIC_ID_SET.has(id)) continue;
            running_sm.set(id, (running_sm.get(id) || 0) - value);
        }
    }
    for (let i = 0; i < _INCR_STATIC_IDS.length; i++) {
        const id = _INCR_STATIC_IDS[i];
        const v = item_sm.get(id);
        if (v) running_sm.set(id, (running_sm.get(id) || 0) - v);
    }
}

/**
 * Initialize a running statMap from level + fixed items (locked equips, tomes, weapon).
 * This is the base that free items are incrementally added to/removed from during search.
 */
function _init_running_statmap(level, fixed_item_sms) {
    const must_ids = [
        "eMdPct","eMdRaw","eSdPct","eSdRaw","eDamPct","eDamRaw","eDamAddMin","eDamAddMax",
        "tMdPct","tMdRaw","tSdPct","tSdRaw","tDamPct","tDamRaw","tDamAddMin","tDamAddMax",
        "wMdPct","wMdRaw","wSdPct","wSdRaw","wDamPct","wDamRaw","wDamAddMin","wDamAddMax",
        "fMdPct","fMdRaw","fSdPct","fSdRaw","fDamPct","fDamRaw","fDamAddMin","fDamAddMax",
        "aMdPct","aMdRaw","aSdPct","aSdRaw","aDamPct","aDamRaw","aDamAddMin","aDamAddMax",
        "nMdPct","nMdRaw","nSdPct","nSdRaw","nDamPct","nDamRaw","nDamAddMin","nDamAddMax",
        "mdPct","mdRaw","sdPct","sdRaw","damPct","damRaw","damAddMin","damAddMax",
        "rMdPct","rMdRaw","rSdPct","rSdRaw","rDamPct","rDamRaw","rDamAddMin","rDamAddMax",
        "healPct","critDamPct"
    ];
    const sm = new Map();
    for (const id of _INCR_STATIC_IDS) sm.set(id, 0);
    for (const id of must_ids) sm.set(id, 0);
    sm.set("hp", levelToHPBase(level));
    sm.set("agiDef", 90);
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
function _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets_map, all_equip_sms, target) {
    let sm;
    if (target) {
        sm = target;
        sm.clear();
        for (const [k, v] of running_sm) sm.set(k, v);
    } else {
        sm = new Map(running_sm);
    }

    // Apply set bonuses (non-SP bonuses only; SP bonuses are in total_sp)
    for (const [setName, count] of activeSetCounts) {
        const setData = sets_map.get(setName);
        if (!setData) continue;
        const bonus = setData.bonuses[count - 1];
        if (!bonus) continue;
        for (const id in bonus) {
            if (skp_order.includes(id)) continue;
            sm.set(id, (sm.get(id) || 0) + bonus[id]);
        }
    }

    // Multiplier maps
    sm.set('damMult', new Map());
    sm.set('defMult', new Map());
    sm.get('damMult').set('tome', sm.get('damMobs') || 0);
    sm.get('defMult').set('tome', sm.get('defMobs') || 0);

    // Major IDs (rebuilt at leaf — rare, so not tracked incrementally)
    const major_ids = new Set();
    for (const item_sm of all_equip_sms) {
        const mids = item_sm.get("majorIds");
        if (mids) for (const mid of mids) major_ids.add(mid);
    }
    sm.set("activeMajorIDs", major_ids);

    sm.set("poisonPct", 0);
    sm.set("healMult", new Map());
    sm.get('healMult').set('item', sm.get('healPct') || 0);
    sm.set("atkSpd", weapon_sm.get("atkSpd"));

    return sm;
}

// getBaseSpellCost and getSpellCost moved to shared_game_stats.js
