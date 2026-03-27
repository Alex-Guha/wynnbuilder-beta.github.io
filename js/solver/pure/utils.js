// ══════════════════════════════════════════════════════════════════════════════
// SOLVER PURE — Atree scaling, StatMap manipulation, Combo timing
// Shared between the solver main thread (<script> tag) and the Web Worker
// (importScripts). NO DOM access, NO window/document/navigator references.
//
// pure/ dependencies: (none)
// External dependencies (must be loaded before this file):
//   - utils.js:            zip2, round_near
//   - build_utils.js:      merge_stat, skp_order, reversedIDs,
//                           attackSpeeds, baseDamageMultiplier
//   - game_rules.js:       SPELL_CAST_DELAY
//   - shared_game_stats.js: radiance_affected
// ══════════════════════════════════════════════════════════════════════════════

// ── Atree helpers ───────────────────────────────────────────────────────────

/**
 * Parse out "parametrized entries".
 * Format: ability_id.propname
 */
function atree_translate(atree_merged, v) {
    if (typeof v === 'string') {
        const [id_str, propname] = v.split('.');
        return atree_merged.get(parseInt(id_str)).properties[propname];
    }
    return v;
}

/**
 * Pure atree scaling computation shared by main thread and worker.
 * Takes serialized button/slider state instead of DOM elements.
 *
 * @param {Map} atree_merged
 * @param {Map} pre_scale_stats
 * @param {Map<string, boolean>} button_states  - toggle name → on/off
 * @param {Map<string, number>}  slider_states  - slider name → integer value
 * @returns {[Map, Map]} [atree_edit, ret_effects]
 */
function atree_compute_scaling(atree_merged, pre_scale_stats, button_states, slider_states, scratch) {
    // Shallow-clone each ability, deep-copying only `properties` (the only
    // object mutated during scaling).
    let atree_edit, ret_effects;
    if (scratch) {
        atree_edit = scratch.atree_edit; atree_edit.clear();
        ret_effects = scratch.ret_effects; ret_effects.clear();
    } else {
        atree_edit = new Map();
        ret_effects = new Map();
    }
    for (const [abil_id, abil] of atree_merged.entries()) {
        atree_edit.set(abil_id, { ...abil, properties: { ...(abil.properties ?? {}) } });
    }

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
                const { slider = false, scaling = [0], behavior = "merge", multiplicative = false, requirement = 0 } = effect;
                let { positive = true, round = true } = effect;
                if (slider) {
                    if (behavior == "modify" && !slider_states.has(effect.slider_name)) continue;
                    const slider_val = slider_states.get(effect.slider_name) ?? 0;
                    if (requirement > slider_val) continue;
                    const input_value = slider_val - requirement;
                    if (multiplicative) {
                        total = (((100 + atree_translate(atree_merged, scaling[0])) / 100) ** input_value - 1) * 100;
                    } else {
                        total = input_value * atree_translate(atree_merged, scaling[0]);
                    }
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

// ── Worker search helpers ────────────────────────────────────────────────────

function _deep_clone_statmap(sm) {
    const ret = new Map(sm);
    for (const k of ['damMult', 'defMult', 'healMult']) {
        const v = sm.get(k);
        if (v instanceof Map) ret.set(k, new Map(v));
    }
    return ret;
}

/**
 * Clone a statmap into a pre-allocated target Map (zero allocation for the outer Map).
 * When nested_targets is provided ({damMult, defMult, healMult} Maps), nested Maps
 * are also cloned into pre-allocated targets, eliminating all Map allocations.
 */
function _deep_clone_statmap_into(target, sm, nested_targets) {
    target.clear();
    for (const [k, v] of sm) {
        if (v instanceof Map) {
            const nt = nested_targets?.[k];
            if (nt) {
                nt.clear();
                for (const [mk, mv] of v) nt.set(mk, mv);
                target.set(k, nt);
            } else {
                target.set(k, new Map(v));
            }
        } else {
            target.set(k, v);
        }
    }
    return target;
}

function _merge_into(target, source) {
    if (!source) return;
    for (const [k, v] of source) {
        if (v instanceof Map) {
            for (const [mk, mv] of v) merge_stat(target, k + '.' + mk, mv);
        } else {
            merge_stat(target, k, v);
        }
    }
}

function _apply_radiance_scale(statMap, boost) {
    if (boost === 1) return statMap;
    const ret = new Map(statMap);
    for (const id of radiance_affected) {
        const val = ret.get(id) || 0;
        if (reversedIDs.includes(id)) {
            if (val < 0) ret.set(id, Math.floor(val * boost));
        } else {
            if (val > 0) ret.set(id, Math.floor(val * boost));
        }
    }
    return ret;
}

/** In-place radiance scaling (no allocation). */
function _apply_radiance_scale_inplace(statMap, boost) {
    if (boost === 1) return;
    for (const id of radiance_affected) {
        const val = statMap.get(id) || 0;
        if (reversedIDs.includes(id)) {
            if (val < 0) statMap.set(id, Math.floor(val * boost));
        } else {
            if (val > 0) statMap.set(id, Math.floor(val * boost));
        }
    }
}

// _solver_sp_calc removed — replaced by calculate_skillpoints(equipment, weapon, sp_budget)
// in skillpoints.js, which now supports an optional sp_budget parameter.

// ── Combo timing helpers ────────────────────────────────────────────────────

/**
 * Compute wall-clock time delta for a single cast (melee or spell) and the
 * resulting melee cooldown.  Shared by cycle-time display, full mana+HP sim,
 * and fast mana sim so the timing model is defined in exactly one place.
 *
 * @param {boolean} is_melee  - true when the row is a melee attack (base_spell 0)
 * @param {boolean} is_spell  - true when the row has a mana cost
 * @param {number} melee_cd   - remaining melee cooldown before this cast
 * @param {number} melee_period - attack-speed-based melee cooldown (1/dmgMult)
 * @param {number} cast_time  - spell cast time (0 for melee)
 * @param {number} delay      - post-action delay
 * @returns {{ wall_dt: number, melee_cd: number }}
 */
function compute_wall_dt(is_melee, is_spell, melee_cd, melee_period, cast_time, delay) {
    if (is_melee) {
        return { wall_dt: melee_cd + delay, melee_cd: Math.max(0, melee_period - delay) };
    }
    if (is_spell) {
        const spell_dt = cast_time + delay;
        return { wall_dt: spell_dt, melee_cd: Math.max(0, melee_cd - spell_dt) };
    }
    return { wall_dt: 0, melee_cd };
}

/**
 * Compute effective melee hit count for a "Melee Time" row.
 * @param {number} qty_seconds - Duration in seconds
 * @param {Map} base_stats - Build stats (needs atkSpd, atkTier)
 * @param {number} [delay=SPELL_CAST_DELAY] - Post-hit delay
 * @returns {number} Effective hit count (fractional)
 */
function compute_melee_time_hits(qty_seconds, base_stats, delay) {
    let adjAtkSpd = attackSpeeds.indexOf(base_stats.get('atkSpd'))
        + (base_stats.get('atkTier') ?? 0);
    adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
    const melee_period = 1 / baseDamageMultiplier[adjAtkSpd];
    return qty_seconds / Math.max(melee_period, delay ?? SPELL_CAST_DELAY);
}
