// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WORKER HELPERS
// Worker-only code that cannot be shared with the main thread.
//
// Dependencies (loaded via importScripts before this file):
//   - utils.js:       zip2, round_near, clamp, rawToPct, rawToPctUncapped, etc.
//   - build_utils.js: merge_stat, skp_order, skp_elements, skillPointsToPercentage,
//                     skillpoint_final_mult, reversedIDs, levelToHPBase
//   - skillpoints.js: calculate_skillpoints
//   - damage_calc.js: calculateSpellDamage
//   - shared_game_stats.js: damageMultipliers, specialNames, radiance_affected,
//                           getDefenseStats
//   - solver_pure.js: computeSpellDisplayAvg, find_all_matching_boosts,
//                     apply_combo_row_boosts,
//                     apply_spell_prop_overrides, spell_has_heal,
//                     computeSpellHealingTotal, _deep_clone_statmap, _merge_into,
//                     _apply_radiance_scale, _solver_sp_calc
// ══════════════════════════════════════════════════════════════════════════════

// ── From game/build.js ───────────────────────────────────────────────────────

const classDefenseMultipliers = new Map([
    ["relik", 0.60], ["bow", 0.70], ["wand", 0.80], ["dagger", 1.0], ["spear", 1.0]
]);

// ── From game/atree.js (worker-specific serialized version) ─────────────────

function atree_translate(atree_merged, v) {
    if (typeof v === 'string') {
        const [id_str, propname] = v.split('.');
        return atree_merged.get(parseInt(id_str)).properties[propname];
    }
    return v;
}

/**
 * Worker-safe version of atree_scaling.compute_func (atree.js:707-808).
 * Reads serialized button/slider state instead of DOM elements.
 *
 * @param {Map} atree_merged
 * @param {Map} pre_scale_stats
 * @param {Map<string, boolean>} button_states  - toggle name → on/off
 * @param {Map<string, number>}  slider_states  - slider name → integer value
 * @returns {[Map, Map]} [atree_edit, ret_effects]
 */
function worker_atree_scaling(atree_merged, pre_scale_stats, button_states, slider_states) {
    // Shallow-clone each ability, deep-copying only `properties` (the only
    // object mutated during scaling).  Replaces the previous structuredClone
    // which was the dominant cost in the solver hot-path (~10ms → <1ms).
    const atree_edit = new Map();
    for (const [abil_id, abil] of atree_merged.entries()) {
        atree_edit.set(abil_id, { ...abil, properties: { ...(abil.properties ?? {}) } });
    }
    let ret_effects = new Map();

    function apply_bonus(bonus_info, value) {
        const { type, name, abil = null, mult = false } = bonus_info;
        if (type === 'stat') {
            merge_stat(ret_effects, name, atree_translate(atree_merged, value));
        } else if (type === 'prop') {
            const merge_abil = atree_edit.get(abil);
            if (merge_abil) {
                if (mult) merge_abil.properties[name] *= atree_translate(atree_edit, value);
                else      merge_abil.properties[name] += atree_translate(atree_edit, value);
            }
        }
    }

    for (const [abil_id, abil] of atree_merged.entries()) {
        if (abil.effects.length == 0) continue;

        for (const effect of abil.effects) {
            switch (effect.type) {
            case 'raw_stat':
                if (effect.toggle) {
                    if (!button_states.get(effect.toggle)) continue;
                    for (const bonus of effect.bonuses) apply_bonus(bonus, bonus.value);
                } else {
                    for (const bonus of effect.bonuses) {
                        if (bonus.type === 'stat') continue;
                        apply_bonus(bonus, bonus.value);
                    }
                }
                continue;
            case 'stat_scaling': {
                let total = 0;
                const { slider = false, scaling = [0], behavior = "merge" } = effect;
                let { positive = true, round = true } = effect;
                if (slider) {
                    if (behavior == "modify" && !slider_states.has(effect.slider_name)) continue;
                    const slider_val = slider_states.get(effect.slider_name) ?? 0;
                    if (effect.multiplicative) {
                        total = (((100 + atree_translate(atree_merged, scaling[0])) / 100) ** slider_val - 1) * 100;
                    } else {
                        total = slider_val * atree_translate(atree_merged, scaling[0]);
                    }
                    round = false;
                    positive = false;
                } else {
                    for (const [_scaling, input] of zip2(scaling, effect.inputs)) {
                        if (input.type === 'stat') {
                            total += (pre_scale_stats.get(input.name) || 0) * atree_translate(atree_merged, _scaling);
                        } else if (input.type === 'prop') {
                            const merge_abil = atree_edit.get(input.abil);
                            if (merge_abil) total += merge_abil.properties[input.name] * atree_translate(atree_merged, _scaling);
                        }
                    }
                }
                if ('output' in effect) {
                    if (round) total = Math.floor(round_near(total));
                    if (positive && total < 0) total = 0;
                    if ('max' in effect) {
                        let effect_max = atree_translate(atree_merged, effect.max);
                        if (effect_max > 0 && total > effect_max) total = effect.max;
                        if (effect_max < 0 && total < effect_max) total = effect.max;
                    }
                    if (Array.isArray(effect.output)) {
                        for (const output of effect.output) apply_bonus(output, total);
                    } else {
                        apply_bonus(effect.output, total);
                    }
                }
                continue;
            }
            }
        }
    }
    return [atree_edit, ret_effects];
}

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
function _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets_map, all_equip_sms) {
    const sm = new Map(running_sm);

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

// ── Spell cost helpers (worker null-safe versions of display.js) ─────────────

function getBaseSpellCost(stats, spell) {
    const int_reduction = skillPointsToPercentage(stats.get('int') ?? 0) * skillpoint_final_mult[2];
    let cost = spell.cost * (1 - int_reduction);
    cost += (stats.get('spRaw' + spell.base_spell) ?? 0);
    return cost * (1 + (stats.get('spPct' + spell.base_spell) ?? 0) / 100);
}

function getSpellCost(stats, spell) {
    const final_pct = stats.get('spPct' + spell.base_spell + 'Final') ?? 0;
    return Math.max(1, getBaseSpellCost(stats, spell) * (1 + final_pct / 100));
}
