// ══════════════════════════════════════════════════════════════════════════════
// SOLVER PURE FUNCTIONS
// Shared between the solver main thread (<script> tag) and the Web Worker
// (importScripts). NO DOM access, NO window/document/navigator references.
//
// Dependencies (must be loaded before this file):
//   - utils.js:            zip2, rawToPct, rawToPctUncapped
//   - build_utils.js:      merge_stat, skp_order, skp_elements, reversedIDs
//   - damage_calc.js:      calculateSpellDamage
//   - shared_game_stats.js: damageMultipliers, specialNames, radiance_affected,
//                           getDefenseStats
//   - powders.js:           powderSpecialStats
// ══════════════════════════════════════════════════════════════════════════════

// damageMultipliers, specialNames, radiance_affected, getDefenseStats
// are defined in shared_game_stats.js (loaded before this file, or via
// importScripts in the Web Worker).

// ── Spell damage helpers ─────────────────────────────────────────────────────

/**
 * Shared spell part evaluator used by both computeSpellDisplayAvg and
 * computeSpellDisplayFull.  Recursively evaluates all parts of a spell,
 * returning the array of evaluated results.
 *
 * When `detailed` is true, damage results include per-element breakdowns
 * (damages_results, multiplied_conversions) for the popup display.
 */
function _eval_spell_parts(stats, weapon, spell, detailed) {
    const use_speed = spell.use_atkspd !== false;
    const use_spell = (spell.scaling ?? 'spell') === 'spell';
    const spell_result_map = new Map();
    for (const part of spell.parts) {
        spell_result_map.set(part.name, { type: 'need_eval', store_part: part });
    }

    function eval_part(part_name) {
        const dat = spell_result_map.get(part_name);
        if (!dat || dat.type !== 'need_eval') return dat;
        const part    = dat.store_part;
        const part_id = spell.base_spell + '.' + part.name;
        let result;

        if ('multipliers' in part) {
            const use_str       = part.use_str !== false;
            const ignored_mults = part.ignored_mults || [];
            const raw = calculateSpellDamage(
                stats, weapon, part.multipliers, use_spell, !use_speed,
                part_id, !use_str, ignored_mults);
            result = { type: 'damage', normal_total: raw[0], crit_total: raw[1] };
            if (detailed) {
                result.damages_results        = raw[2]; // per-element [norm_min, norm_max, crit_min, crit_max]
                result.multiplied_conversions = raw[3]; // effective % per element after mults
            }
        } else if ('power' in part) {
            const mult_map = stats.get('healMult');
            let heal_mult = 1;
            for (const [k, v] of mult_map.entries()) {
                if (!k.includes(':') || k.split(':')[1] === part_id) heal_mult *= (1 + v / 100);
            }
            result = { type: 'heal', heal_amount: part.power * getDefenseStats(stats)[0] * heal_mult };
        } else {
            result = { type: null, normal_total: [0, 0], crit_total: [0, 0], heal_amount: 0 };
            for (const [sub_name, hits] of Object.entries(part.hits)) {
                const sub = eval_part(sub_name);
                if (!sub) continue;
                if (!result.type) result.type = sub.type;
                if (sub.type === 'damage') {
                    result.normal_total[0] += sub.normal_total[0] * hits;
                    result.normal_total[1] += sub.normal_total[1] * hits;
                    result.crit_total[0]   += sub.crit_total[0]   * hits;
                    result.crit_total[1]   += sub.crit_total[1]   * hits;
                } else if (sub.type === 'heal') {
                    result.heal_amount += sub.heal_amount * hits;
                }
            }
        }
        result.name    = part.name;
        result.display = part.display !== false;
        spell_result_map.set(part_name, result);
        return result;
    }

    return { all_results: spell.parts.map(p => eval_part(p.name)), use_spell };
}

/**
 * Find the primary display result from evaluated spell parts.
 * Returns the result matching spell.display, or the last displayed damage part.
 */
function _find_display_result(spell, all_results) {
    let display_result = spell.display
        ? all_results.find(r => r?.name === spell.display)
        : null;
    if (!display_result) {
        display_result = [...all_results].reverse().find(r => r?.display && r?.type === 'damage');
    }
    return display_result;
}

/**
 * Computes the average damage per cast of a spell's primary display part,
 * weighted by crit chance. Returns 0 for non-damage spells.
 */
function computeSpellDisplayAvg(stats, weapon, spell, crit_chance) {
    const { all_results } = _eval_spell_parts(stats, weapon, spell, false);
    const display_result = _find_display_result(spell, all_results);
    if (!display_result || display_result.type !== 'damage') return 0;

    const non_crit_avg = (display_result.normal_total[0] + display_result.normal_total[1]) / 2;
    const crit_avg     = (display_result.crit_total[0]   + display_result.crit_total[1])   / 2;
    return (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;
}

/**
 * Like computeSpellDisplayAvg but returns {avg, non_crit_avg, crit_avg} for
 * use in the per-spell damage breakdown popup.
 * Returns null when the spell has no damage parts.
 */
function computeSpellDisplayFull(stats, weapon, spell, crit_chance) {
    const { all_results, use_spell } = _eval_spell_parts(stats, weapon, spell, true);
    const display_result = _find_display_result(spell, all_results);
    if (!display_result || display_result.type !== 'damage') return null;

    const non_crit_avg = (display_result.normal_total[0] + display_result.normal_total[1]) / 2;
    const crit_avg     = (display_result.crit_total[0]   + display_result.crit_total[1])   / 2;
    const avg          = (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;

    // Collect all display parts for the detailed breakdown popup.
    const parts_data = all_results
        .filter(r => r?.display && r?.type === 'damage')
        .map(r => ({
            name:         r.name,
            multipliers:  r.multiplied_conversions ?? null, // [n,e,t,w,f,a] effective %
            normal_min:   r.damages_results ? r.damages_results.map(d => d[0]) : null,
            normal_max:   r.damages_results ? r.damages_results.map(d => d[1]) : null,
            crit_min:     r.damages_results ? r.damages_results.map(d => d[2]) : null,
            crit_max:     r.damages_results ? r.damages_results.map(d => d[3]) : null,
            normal_total: r.normal_total,
            crit_total:   r.crit_total,
            is_spell:     use_spell,
        }));

    return {
        avg, non_crit_avg, crit_avg,
        spell_name: spell.name,
        has_cost:   'cost' in spell,
        parts:      parts_data,
    };
}

/**
 * Return true if a spell has at least one damage-type part (directly or via hits).
 */
function spell_has_damage(spell) {
    const by_name = new Map((spell.parts ?? []).map(p => [p.name, p]));
    function part_dmg(p) {
        if ('multipliers' in p) return true;
        if ('hits' in p) return Object.keys(p.hits).some(n => { const s = by_name.get(n); return s && part_dmg(s); });
        return false;
    }
    return (spell.parts ?? []).some(part_dmg);
}

/**
 * Return true if a spell has at least one heal-type part (directly or via hits).
 */
function spell_has_heal(spell) {
    const by_name = new Map((spell.parts ?? []).map(p => [p.name, p]));
    function part_heal(p) {
        if ('power' in p) return true;
        if ('hits' in p) return Object.keys(p.hits).some(n => { const s = by_name.get(n); return s && part_heal(s); });
        return false;
    }
    return (spell.parts ?? []).some(part_heal);
}

/**
 * Return true if a spell's display part is a DPS aggregate (name equals or ends with "DPS").
 */
function spell_is_dps(spell) {
    if (!spell || !spell.display) return false;
    return spell.display === 'DPS' || spell.display.endsWith(' DPS');
}

/**
 * For a DPS spell that has a Total/Max aggregate part, return
 * { per_hit_name, max_hits } describing the leaf damage part and
 * the maximum number of hits derived from the total/max part's hit chain.
 *
 * Returns null when:
 *  - The spell is not a DPS spell.
 *  - No Total/Max aggregate part exists (e.g. Jasmine Bloom) — the spell
 *    should keep its DPS display and the user uses the qty field instead.
 */
function compute_dps_spell_hits_info(spell) {
    if (!spell_is_dps(spell)) return null;

    const by_name = new Map(spell.parts.map(p => [p.name, p]));

    // Leaf: the first part with raw damage multipliers.
    const leaf = spell.parts.find(p => 'multipliers' in p);
    if (!leaf) return null;

    const dps_part = by_name.get(spell.display);
    if (!dps_part || !('hits' in dps_part)) return null;

    // Look for a "Total …" / "Max …" part that is NOT the DPS part itself.
    let total_part = spell.parts.find(p =>
        p !== dps_part && 'hits' in p && /\b(Total|Max)\b/i.test(p.name)
    );

    // Fallback: a part whose hits reference the DPS part by name.
    if (!total_part) {
        total_part = spell.parts.find(p =>
            p !== dps_part && 'hits' in p && (dps_part.name in (p.hits || {}))
        );
    }

    // No total/max discoverable — caller should fall back to DPS display.
    if (!total_part) return null;

    // Walk the hit chain from `start` down to the leaf, multiplying counts.
    function count_hits_to_leaf(part_name) {
        if (part_name === leaf.name) return 1;
        const p = by_name.get(part_name);
        if (!p || !('hits' in p)) return 0;
        let total = 0;
        for (const [sub, count] of Object.entries(p.hits)) {
            total += count * count_hits_to_leaf(sub);
        }
        return total;
    }

    const max_hits = count_hits_to_leaf(total_part.name);
    if (max_hits <= 0) return null;

    return { per_hit_name: leaf.name, max_hits };
}

/**
 * Compute the total healing output of a spell for a given stat context.
 * Mirrors computeSpellDisplayAvg but sums heal parts instead of damage parts.
 * Returns 0 when the spell has no heal parts.
 */
function computeSpellHealingTotal(stats, spell) {
    const spell_result_map = new Map();
    for (const part of spell.parts) {
        spell_result_map.set(part.name, { type: 'need_eval', store_part: part });
    }
    function eval_part(part_name) {
        const dat = spell_result_map.get(part_name);
        if (!dat || dat.type !== 'need_eval') return dat;
        const part    = dat.store_part;
        const part_id = spell.base_spell + '.' + part.name;
        let result;
        if ('power' in part) {
            const mult_map = stats.get('healMult');
            let heal_mult = 1;
            for (const [k, v] of mult_map.entries()) {
                if (!k.includes(':') || k.split(':')[1] === part_id) heal_mult *= (1 + v / 100);
            }
            result = { type: 'heal', heal_amount: part.power * getDefenseStats(stats)[0] * heal_mult };
        } else if ('multipliers' in part) {
            result = { type: 'damage', heal_amount: 0 };
        } else {
            result = { type: null, heal_amount: 0 };
            for (const [sub_name, hits] of Object.entries(part.hits ?? {})) {
                const sub = eval_part(sub_name);
                if (!sub) continue;
                if (!result.type) result.type = sub.type;
                result.heal_amount += (sub.heal_amount ?? 0) * hits;
            }
        }
        result.name = part.name;
        spell_result_map.set(part_name, result);
        return result;
    }
    const all = spell.parts.map(p => eval_part(p.name));
    return all.reduce((sum, r) => sum + (r?.heal_amount ?? 0), 0);
}

// ── Combo boost application ──────────────────────────────────────────────────

/**
 * Find all registry entries that apply for a given boost token name.
 * Rules:
 *  - Exact name match (case-insensitive, stripping leading "Activate ").
 *  - Alias match.
 *  - If is_pct=true, ALSO find sliders that CONTAIN the name (for "Enkindled 100%" → "Enkindled Percent").
 *
 * Returns [{entry, effective_value}] where effective_value is 1 for toggles
 * and token.value for sliders.
 */
function find_all_matching_boosts(token_name, token_value, is_pct, registry) {
    const name_lower = token_name.toLowerCase().trim();
    const results = [];

    for (const entry of registry) {
        const ename     = entry.name.toLowerCase();
        const aliases_l = (entry.aliases ?? []).map(a => a.toLowerCase());

        const exact_match = ename === name_lower
                         || ename === 'activate ' + name_lower
                         || aliases_l.includes(name_lower);

        if (entry.type === 'toggle') {
            if (exact_match) results.push({ entry, effective_value: 1 });
        } else if (entry.type === 'calculated') {
            // Calculated boost (e.g. Blood Pact): the token value IS the final
            // percentage, applied as a direct override to the stat_bonuses value.
            // effective_value is set so that value * effective_value = token_value.
            if (exact_match && is_pct) {
                const base_val = entry.stat_bonuses[0]?.value || 1;
                results.push({ entry, effective_value: token_value / base_val });
            }
        } else {
            // slider
            if (exact_match) {
                results.push({ entry, effective_value: token_value });
            } else if (is_pct && (ename.includes(name_lower) || ename.startsWith(name_lower))) {
                // "Enkindled 100%" also activates "Enkindled Percent" slider.
                results.push({ entry, effective_value: token_value });
            }
        }
    }
    return results;
}

/**
 * Apply per-row boost tokens to a clone of base_stats.
 * Returns { stats: modified_stats, prop_overrides: Map<'abilId.prop', value> }.
 */
function apply_combo_row_boosts(base_stats, boost_tokens, registry, scratch) {
    let stats, damMult, defMult;
    if (scratch) {
        // Reuse pre-allocated Maps (zero allocation for the outer + nested Maps)
        stats = scratch.stats;   stats.clear();
        for (const [k, v] of base_stats) stats.set(k, v);
        damMult = scratch.damMult; damMult.clear();
        const dm = base_stats.get('damMult');
        if (dm) for (const [k, v] of dm) damMult.set(k, v);
        defMult = scratch.defMult; defMult.clear();
        const dfm = base_stats.get('defMult');
        if (dfm) for (const [k, v] of dfm) defMult.set(k, v);
    } else {
        // Allocating path (main thread / non-worker callers)
        stats   = new Map(base_stats);
        damMult = new Map(base_stats.get('damMult') ?? []);
        defMult = new Map(base_stats.get('defMult') ?? []);
    }
    stats.set('damMult', damMult);
    stats.set('defMult', defMult);

    const prop_overrides = scratch?.prop_overrides ?? new Map();
    if (scratch?.prop_overrides) prop_overrides.clear();

    for (const { name, value, is_pct } of boost_tokens) {
        const matches = find_all_matching_boosts(name, value, !!is_pct, registry);
        for (const { entry, effective_value } of matches) {
            for (const b of entry.stat_bonuses) {
                const contrib = b.value * effective_value;
                if (b.key.startsWith('damMult.')) {
                    const key = b.key.substring(8);
                    // Potion and Vulnerability use max semantics (matching merge_stat).
                    // These represent non-stacking party buffs where only the highest applies.
                    if (b.mode === 'max' || key === 'Potion' || key === 'Vulnerability') {
                        damMult.set(key, Math.max(damMult.get(key) ?? 0, contrib));
                    } else {
                        damMult.set(key, (damMult.get(key) ?? 0) + contrib);
                    }
                } else if (b.key.startsWith('defMult.')) {
                    const key = b.key.substring(8);
                    if (b.mode === 'max' || key === 'Potion' || key === 'Vulnerability') {
                        defMult.set(key, Math.max(defMult.get(key) ?? 0, contrib));
                    } else {
                        defMult.set(key, (defMult.get(key) ?? 0) + contrib);
                    }
                } else {
                    // Direct stats Map entry (e.g. "nConvBase:4.Winded Damage", "sdPct", …)
                    if (b.mode === 'max') {
                        stats.set(b.key, Math.max(stats.get(b.key) ?? 0, contrib));
                    } else {
                        stats.set(b.key, (stats.get(b.key) ?? 0) + contrib);
                    }
                }
            }
            for (const p of entry.prop_bonuses) {
                const contrib = (p.value_per_unit ?? 1) * effective_value;
                const existing = prop_overrides.get(p.ref) ?? { replace: null, add: 0 };
                if (p.mode === 'add') {
                    existing.add += contrib;
                } else {
                    existing.replace = (existing.replace ?? 0) + contrib;
                }
                prop_overrides.set(p.ref, existing);
            }
        }
    }
    return { stats, prop_overrides };
}

/**
 * Clone a spell and override already-resolved hit-count values using prop_overrides.
 * Looks up the original (unresolved) string references inside atree_merged's
 * replace_spell effects to know WHICH hits to patch.
 */
function apply_spell_prop_overrides(spell, prop_overrides, atree_merged) {
    if (!prop_overrides || prop_overrides.size === 0) return spell;
    if (!atree_merged) return spell;

    // Build map of original (unresolved) hit string refs from the atree.
    const orig_part_hits = new Map();  // partName → {subName → original_string_or_num}
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'replace_spell' || effect.base_spell !== spell.base_spell) continue;
            for (const part of (effect.parts ?? [])) {
                if ('hits' in part) orig_part_hits.set(part.name, part.hits);
            }
        }
    }
    if (orig_part_hits.size === 0) return spell;

    // Check if any string reference is in our overrides.
    let needs_clone = false;
    outer: for (const [, orig_hits] of orig_part_hits) {
        for (const orig_val of Object.values(orig_hits)) {
            if (typeof orig_val === 'string' && prop_overrides.has(orig_val)) {
                needs_clone = true;
                break outer;
            }
        }
    }
    if (!needs_clone) return spell;

    const clone = structuredClone(spell);
    for (const part of clone.parts) {
        if (!('hits' in part)) continue;
        const orig_hits = orig_part_hits.get(part.name);
        if (!orig_hits) continue;
        for (const sub_name of Object.keys(part.hits)) {
            const orig_val = orig_hits[sub_name];
            if (typeof orig_val === 'string' && prop_overrides.has(orig_val)) {
                const ov = prop_overrides.get(orig_val);
                if (ov.replace != null) {
                    part.hits[sub_name] = ov.replace + ov.add;
                } else {
                    part.hits[sub_name] += ov.add;
                }
            }
        }
    }
    return clone;
}

// ── Boost relevance filtering ────────────────────────────────────────────────

const _DAMAGE_STATS = new Set();
const _SPELL_STATS = new Set();
const _MELEE_STATS = new Set();
for (const e of ['n', 'e', 't', 'w', 'f', 'a']) {
    _DAMAGE_STATS.add(e + 'DamPct').add(e + 'DamRaw').add(e + 'DamAddMin').add(e + 'DamAddMax');
    _SPELL_STATS.add(e + 'SdPct').add(e + 'SdRaw');
    _MELEE_STATS.add(e + 'MdPct').add(e + 'MdRaw');
}
_DAMAGE_STATS.add('damPct').add('damRaw').add('rDamPct').add('rDamRaw');
_SPELL_STATS.add('sdPct').add('sdRaw').add('rSdPct').add('rSdRaw');
_MELEE_STATS.add('mdPct').add('mdRaw').add('rMdPct').add('rMdRaw');
const _HEAL_STATS = new Set(['hp', 'hpBonus']);
const _IRRELEVANT_STATS = new Set(['spd', 'ls', 'mr', 'ms', 'lb', 'lq', 'xpb', 'gSpd', 'gXp',
    'hprRaw', 'hprPct', 'ref', 'thorns', 'expd', 'spRegen', 'eSteal', 'sprint', 'sprintReg']);

function is_boost_relevant(entry, spell) {
    if (!spell) return true;  // no spell selected = show all

    const has_damage = spell.parts.some(p => 'multipliers' in p || 'hits' in p);
    const has_heal = spell.parts.some(p => 'power' in p || 'hits' in p);

    const use_spell = (spell.scaling ?? 'spell') === 'spell';

    const part_ids = new Set();
    for (const part of spell.parts) {
        part_ids.add(spell.base_spell + '.' + part.name);
    }

    for (const b of entry.stat_bonuses) {
        if (_is_stat_relevant(b.key, has_damage, has_heal, use_spell, part_ids)) return true;
    }

    if (entry.prop_target_spells && entry.prop_target_spells.has(spell.base_spell)) return true;

    return false;
}

function _is_stat_relevant(key, has_damage, has_heal, use_spell, part_ids) {
    if (key.startsWith('damMult.')) {
        if (!has_damage) return false;
        const sub = key.substring(8);
        if (sub.includes(':')) {
            const part_id = sub.split(':')[1];
            return part_ids.has(part_id);
        }
        if (sub.includes(';')) {
            const qualifier = sub.split(';')[1];
            if (qualifier === 'm') return !use_spell;
        }
        return true;
    }

    if (key.startsWith('healMult.')) {
        if (!has_heal) return false;
        const sub = key.substring(9);
        if (sub.includes(':')) {
            const part_id = sub.split(':')[1];
            return part_ids.has(part_id);
        }
        return true;
    }

    if (key.startsWith('defMult.')) return false;

    if (key.includes('ConvBase')) {
        if (!has_damage) return false;
        if (key.includes(':')) {
            const part_id = key.split(':').slice(1).join(':');
            return part_ids.has(part_id);
        }
        return true;
    }

    if (_DAMAGE_STATS.has(key) || key === 'critDamPct') return has_damage;
    if (_SPELL_STATS.has(key)) return has_damage && use_spell;
    if (_MELEE_STATS.has(key)) return has_damage && !use_spell;
    if (_HEAL_STATS.has(key)) return has_heal;
    if (_IRRELEVANT_STATS.has(key)) return false;

    // Unknown key — conservatively show
    return true;
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

/**
 * Combined SP feasibility check + full calculation for the solver.
 * Replaces the separate _sp_prefilter() + calculate_skillpoints() pair
 * with a single pass, eliminating redundant iteration and tightening the
 * rejection logic.
 *
 * Key improvements over the old _sp_prefilter:
 *  - Uses raw requirements for all items, matching calculate_skillpoints'
 *    simplified pull_req() (no apply_bonus parameter).
 *  - Excludes weapon provisions from the bonus pool (weapon SP doesn't
 *    reduce the assignment in the real calculation).
 *  - Includes an early budget reject mid-loop for fast failure.
 *
 * Returns null if total_assigned > sp_budget (reject).
 * Returns [assign, final_skillpoints, total_assigned, set_counts] on success.
 *
 * @param {Map[]} equip_sms  - equipment statMaps (8 armor/acc + guild tome)
 * @param {Map}   weapon_sm  - weapon statMap
 * @param {number} sp_budget - max assignable SP (200/204/205)
 */
function _solver_sp_calc(equip_sms, weapon_sm, sp_budget) {
    // Phase 1: Accumulate bonus skillpoints, effective requirements, and set counts.
    const bonus_sp = [0, 0, 0, 0, 0];
    const max_req = [0, 0, 0, 0, 0];
    const set_counts = new Map();

    for (const sm of equip_sms) {
        const skp = sm.get('skillpoints');
        const req = sm.get('reqs');
        const is_crafted = sm.get('crafted');

        if (!is_crafted) {
            for (let i = 0; i < 5; i++) bonus_sp[i] += skp[i];
            const set_name = sm.get('set');
            if (set_name) set_counts.set(set_name, (set_counts.get(set_name) ?? 0) + 1);
        }

        // Raw requirements for all items (matching simplified pull_req)
        for (let i = 0; i < 5; i++) {
            if (req[i] > max_req[i]) max_req[i] = req[i];
        }
    }

    // Weapon: raw requirements, not added to bonus_sp
    const wep_req = weapon_sm.get('reqs');
    for (let i = 0; i < 5; i++) {
        if (wep_req[i] > max_req[i]) max_req[i] = wep_req[i];
    }

    // Phase 2: Compute assignment with early budget check.
    const assign = [0, 0, 0, 0, 0];
    let total_assigned = 0;
    for (let i = 0; i < 5; i++) {
        if (max_req[i] === 0) continue;
        if (max_req[i] > bonus_sp[i]) {
            const delta = max_req[i] - bonus_sp[i];
            if (delta > SP_PER_ATTR_CAP) return null;
            assign[i] = delta;
            total_assigned += delta;
            if (total_assigned > sp_budget) return null;
        }
    }

    // Phase 3: Compute final skillpoints.
    const final_sp = assign.slice();
    for (let i = 0; i < 5; i++) final_sp[i] += bonus_sp[i];

    // Add provisions from crafted items and weapon (excluded from bonus_sp)
    for (const sm of equip_sms) {
        if (sm.get('crafted')) {
            const skp = sm.get('skillpoints');
            for (let i = 0; i < 5; i++) final_sp[i] += skp[i];
        }
    }
    const wep_skp = weapon_sm.get('skillpoints');
    for (let i = 0; i < 5; i++) final_sp[i] += wep_skp[i];

    // Add set bonuses to final skillpoints
    for (const [set_name, count] of set_counts) {
        const set_data = sets.get(set_name);
        if (!set_data) continue;
        const bonus = set_data.bonuses[count - 1];
        if (!bonus) continue;
        for (let i = 0; i < 5; i++) {
            final_sp[i] += (bonus[skp_order[i]] || 0);
        }
    }

    return [assign, final_sp, total_assigned, set_counts];
}
