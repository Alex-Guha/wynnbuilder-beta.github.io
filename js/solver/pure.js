// ══════════════════════════════════════════════════════════════════════════════
// SOLVER PURE FUNCTIONS
// Shared between the solver main thread (<script> tag) and the Web Worker
// (importScripts). NO DOM access, NO window/document/navigator references.
//
// Dependencies (must be loaded before this file):
//   - utils.js:            zip2, rawToPct, rawToPctUncapped
//   - build_utils.js:      merge_stat, skp_order, skp_elements, reversedIDs,
//                           attackSpeeds, baseDamageMultiplier,
//                           skillPointsToPercentage
//   - game_rules.js:       HIDDEN_BASE_HPR, HPR_TICK_SECONDS, MANA_TICK_SECONDS,
//                           BASE_MANA_REGEN, SPELL_CAST_TIME, SPELL_CAST_DELAY
//   - damage_calc.js:      calculateSpellDamage
//   - shared_game_stats.js: damageMultipliers, specialNames, radiance_affected,
//                           getDefenseStats, getBaseSpellCost, getSpellCost
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
                let contrib = (p.value_per_unit ?? 1) * effective_value;
                // Apply output cap (mirrors atree_compute_scaling's max logic).
                if (p.max != null) {
                    if (p.max > 0 && contrib > p.max) contrib = p.max;
                    else if (p.max < 0 && contrib < p.max) contrib = p.max;
                }
                const existing = prop_overrides.get(p.ref) ?? { replace: null, add: 0, base: p.base ?? 0 };
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
    // Also collect hit refs from add_spell_prop effects (e.g. Meteor Shower, Shrapnel Bomb).
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'add_spell_prop' || effect.base_spell !== spell.base_spell) continue;
            if (effect.target_part && 'hits' in effect) {
                const existing = orig_part_hits.get(effect.target_part);
                if (existing) {
                    orig_part_hits.set(effect.target_part, { ...existing, ...effect.hits });
                } else {
                    orig_part_hits.set(effect.target_part, effect.hits);
                }
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
                    part.hits[sub_name] = (ov.base ?? 0) + ov.replace + ov.add;
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

// ── Combo mana/HP simulation ────────────────────────────────────────────────

/**
 * Pure mana+HP simulation kernel for Blood Pact / Bak'al's Grasp / Corruption.
 * Shared by both main thread and worker. DOM-free.
 *
 * Tracks mana state, HP pool, blood pact bonus, corruption accumulation,
 * Exhilarate heal on Cancel Bak'al, HP regen ticks, and mana steal.
 *
 * @param {Object[]} rows - Pre-parsed combo rows. Each row:
 *   { qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast }
 *   pseudo: null | 'cancel_bakals' | 'mana_reset'
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

    // State
    let mana = start_mana;
    let hp = max_hp;
    let corrupted = false;
    let corruption_pct = 0;
    let elapsed_time = 0;

    const row_results = [];
    const spell_costs = [];
    let total_mana_cost = 0;
    let melee_hits = 0;
    let recast_penalty_total = 0;

    for (const row of rows) {
        const { qty, spell, boost_tokens, mana_excl, pseudo, recast_penalty_per_cast = 0 } = row;

        // Cancel Bak'al's Grasp pseudo-spell
        if (pseudo === 'cancel_bakals') {
            if (!mana_excl && corrupted) {
                // Exhilarate heal: heal % of corruption bar as max hp
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
        if (pseudo === 'mana_reset') {
            row_results.push({ blood_pact_bonus: 0, corruption_pct: 0, hp_warning: false });
            continue;
        }

        if (qty <= 0 || !spell) {
            row_results.push({ blood_pact_bonus: 0, corruption_pct, hp_warning: false });
            continue;
        }

        // Mana-excluded rows: skip cost/regen tracking entirely
        if (mana_excl) {
            if (spell.scaling === 'melee') melee_hits += qty;
            row_results.push({ blood_pact_bonus: 0, corruption_pct, hp_warning: false });
            continue;
        }

        // Get spell cost using boosted stats (matching main thread behavior)
        const { stats: row_stats } = apply_combo_row_boosts(base_stats, boost_tokens, boost_registry, scratch_row);
        const cost_per = spell.cost != null ? getSpellCost(row_stats, spell) : 0;
        const is_spell = spell.cost != null;
        const is_melee_scaling = spell.scaling === 'melee';
        const recast_base = spell.mana_derived_from ?? spell.base_spell;
        const is_melee = recast_base === 0;

        if (is_melee_scaling) melee_hits += qty;
        recast_penalty_total += recast_penalty_per_cast * qty;

        let row_blood_total = 0;
        let row_blood_casts = 0;
        let hp_warning = false;
        let row_mana_cost = 0;

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
                        hp = Math.min(max_hp, hp + hpr_tick * (cur_ticks - prev_ticks));
                    }
                }
            }

            // Mana steal from melee hits
            if (is_melee_scaling && ms_per_hit > 0) {
                mana = Math.min(max_mana, mana + ms_per_hit);
            }

            // Spell cost payment
            if (is_spell) {
                const effective_cost = cost_per + recast_penalty_per_cast;
                let adj_cost = effective_cost;
                if (has_transcendence) adj_cost *= 0.75;

                if (mana >= adj_cost) {
                    mana -= adj_cost;
                } else {
                    // Blood Pact: pay remaining from health
                    const remaining_mana = Math.max(0, mana);
                    const health_mana = adj_cost - remaining_mana;
                    mana = 0;
                    const blood_ratio = health_mana / adj_cost;

                    // Health cost
                    const hp_cost = health_mana * health_cost_pct * max_hp / 100;
                    if (hp < hp_cost) hp_warning = true;
                    hp -= hp_cost;

                    // Track corruption from health costs while corrupted
                    if (corrupted) {
                        corruption_pct = Math.min(100, corruption_pct + hp_cost / max_hp * 100);
                    }

                    row_blood_total += health_config.damage_boost_min +
                        (health_config.damage_boost_max - health_config.damage_boost_min) * blood_ratio;
                    row_blood_casts++;
                }

                row_mana_cost += adj_cost;

                // Corruption system: War Scream (base_spell 4) activates corruption
                if (health_config.corruption.active && spell.base_spell === 4 && !corrupted) {
                    corrupted = true;
                    corruption_pct = 0;
                }
            }
        }

        const avg_blood_bonus = row_blood_casts > 0 ? row_blood_total / row_blood_casts : 0;
        total_mana_cost += row_mana_cost;
        if (is_spell) {
            spell_costs.push({ name: spell.name, qty, cost: cost_per, recast_penalty: recast_penalty_per_cast * qty });
        }

        row_results.push({ blood_pact_bonus: avg_blood_bonus, corruption_pct, hp_warning });
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

// ── Combo damage totals ─────────────────────────────────────────────────────

/**
 * Pure combo damage totals computation shared by main thread and worker.
 * Iterates combo rows, applies per-row boost tokens, computes spell damage
 * and healing for each row.
 *
 * @param {Map} base_stats - Aggregated build statMap
 * @param {Map} weapon_sm - Weapon statMap
 * @param {Object[]} parsed_rows - Each row:
 *   { qty, spell, boost_tokens, dmg_excl, dps_per_hit_name, dps_hits, pseudo }
 * @param {number} crit_chance - Crit chance (from dex skill percentage)
 * @param {Object[]} registry - Boost registry
 * @param {Map} atree_merged - Merged ability tree
 * @param {Object} [opts] - { detailed: bool, scratch_row: Map|null }
 *   detailed=false → computeSpellDisplayAvg (fast, worker)
 *   detailed=true  → computeSpellDisplayFull (main thread popups)
 * @returns {Object} { total_damage, total_healing, per_row[] }
 *   per_row: { damage, healing, full_display, spell_cost }
 */
function compute_combo_damage_totals(base_stats, weapon_sm, parsed_rows, crit_chance, registry, atree_merged, opts) {
    const { detailed = false, scratch_row = null, debug = false, debug_label = '[PAGE]' } = opts || {};
    let total_damage = 0;
    let total_healing = 0;
    const per_row = [];

    if (debug) {
        const _ds = (sm) => {
            const keys = ['hp','hpBonus','str','dex','int','def','agi',
                'sdPct','sdRaw','mdPct','mdRaw','damPct','damRaw',
                'rSdPct','rSdRaw','rMdPct','rMdRaw','rDamPct','rDamRaw',
                'mr','ms','maxMana','critDamPct','atkSpd','atkTier',
                'spPct1','spPct2','spPct3','spPct4','spRaw1','spRaw2','spRaw3','spRaw4'];
            const o = {};
            for (const k of keys) { const v = sm.get(k); if (v != null && v !== 0) o[k] = v; }
            const dm = sm.get('damMult');
            if (dm?.size) o.damMult = Object.fromEntries(dm);
            const dfm = sm.get('defMult');
            if (dfm?.size) o.defMult = Object.fromEntries(dfm);
            return o;
        };
        const _ws = (sm) => {
            const o = {};
            for (const e of ['n','e','t','w','f','a']) {
                const v = sm.get(e + 'Dam_');
                if (v) o[e + 'Dam_'] = v;
            }
            o.atkSpd = sm.get('atkSpd');
            return o;
        };
        console.log('[COMBO-DEBUG]' + debug_label + ' base_stats:', JSON.stringify(_ds(base_stats)));
        console.log('[COMBO-DEBUG]' + debug_label + ' weapon:', JSON.stringify(_ws(weapon_sm)));
        console.log('[COMBO-DEBUG]' + debug_label + ' crit_chance:', crit_chance, 'detailed:', detailed);
    }

    for (let _row_idx = 0; _row_idx < parsed_rows.length; _row_idx++) {
        const row = parsed_rows[_row_idx];
        const { qty, spell, boost_tokens, dmg_excl, pseudo } = row;

        if (!spell || qty <= 0 || pseudo) {
            per_row.push({ damage: 0, healing: 0, full_display: null, spell_cost: null, dps_info: null });
            if (debug && pseudo) console.log('[COMBO-DEBUG]' + debug_label + ' row', _row_idx, '(pseudo:', pseudo + ')');
            continue;
        }

        const { stats, prop_overrides } =
            apply_combo_row_boosts(base_stats, boost_tokens, registry, scratch_row);
        const mod_spell = apply_spell_prop_overrides(spell, prop_overrides, atree_merged);

        // DPS spell detection: use pre-set fields or auto-detect from mod_spell
        let eff_dps_name = row.dps_per_hit_name ?? null;
        let eff_dps_hits = row.dps_hits ?? 0;
        let dps_info = null;
        if (!eff_dps_name) {
            dps_info = compute_dps_spell_hits_info(mod_spell);
            if (dps_info) {
                eff_dps_name = dps_info.per_hit_name;
                eff_dps_hits = row.dps_hits_override ?? dps_info.max_hits;
            }
        }

        let per_cast, full_display = null;
        if (detailed) {
            let full;
            if (eff_dps_name) {
                const per_hit_spell = { ...mod_spell, display: eff_dps_name };
                full = computeSpellDisplayFull(stats, weapon_sm, per_hit_spell, crit_chance);
                per_cast = full ? full.avg * eff_dps_hits : 0;
            } else {
                full = computeSpellDisplayFull(stats, weapon_sm, mod_spell, crit_chance);
                per_cast = full ? full.avg : 0;
            }
            full_display = full;
        } else {
            if (eff_dps_name) {
                const per_hit_spell = { ...mod_spell, display: eff_dps_name };
                per_cast = computeSpellDisplayAvg(stats, weapon_sm, per_hit_spell, crit_chance) * eff_dps_hits;
            } else {
                per_cast = computeSpellDisplayAvg(stats, weapon_sm, mod_spell, crit_chance);
            }
        }

        const row_damage = dmg_excl ? 0 : per_cast * qty;
        const heal_per_cast = computeSpellHealingTotal(stats, mod_spell);
        const row_healing = heal_per_cast * qty;

        if (debug) {
            const _bt = boost_tokens?.map(t => `${t.name}=${t.value}${t.is_pct?'%':''}`) ?? [];
            const _po = prop_overrides.size ? Object.fromEntries([...prop_overrides].map(([k,v]) => [k, `replace=${v.replace} add=${v.add}`])) : null;
            // Log key boosted stat deltas vs base
            const _deltas = {};
            for (const k of ['sdPct','sdRaw','mdPct','mdRaw','damPct','damRaw','critDamPct',
                             'rSdPct','rSdRaw','rMdPct','rMdRaw','rDamPct','rDamRaw']) {
                const sv = stats.get(k) ?? 0, bv = base_stats.get(k) ?? 0;
                if (sv !== bv) _deltas[k] = `${bv}→${sv}`;
            }
            const sdm = stats.get('damMult'), bdm = base_stats.get('damMult');
            if (sdm) for (const [k,v] of sdm) {
                const bv = bdm?.get(k) ?? 0;
                if (v !== bv) _deltas['damMult.' + k] = `${bv}→${v}`;
            }
            console.log('[COMBO-DEBUG]' + debug_label + ' row', _row_idx, JSON.stringify({
                spell: spell.name, qty, dmg_excl: dmg_excl || undefined,
                boosts: _bt.length ? _bt : undefined,
                prop_overrides: _po,
                stat_deltas: Object.keys(_deltas).length ? _deltas : undefined,
                dps: eff_dps_name ? { name: eff_dps_name, hits: eff_dps_hits, preset: !!row.dps_per_hit_name } : undefined,
                per_cast: Math.round(per_cast),
                row_damage: Math.round(row_damage),
            }));
        }

        total_damage += row_damage;
        total_healing += row_healing;

        // Spell cost (for popup display)
        const spell_cost = (detailed && mod_spell.cost != null)
            ? getSpellCost(stats, mod_spell) : null;

        per_row.push({ damage: per_cast, healing: heal_per_cast, full_display, spell_cost, dps_info });
    }

    if (debug) {
        console.log('[COMBO-DEBUG]' + debug_label + ' TOTAL damage:', Math.round(total_damage), 'healing:', Math.round(total_healing));
    }

    return { total_damage, total_healing, per_row };
}
