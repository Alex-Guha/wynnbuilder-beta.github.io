// ══════════════════════════════════════════════════════════════════════════════
// SOLVER PURE — Spell damage helpers
// Shared between the solver main thread (<script> tag) and the Web Worker
// (importScripts). NO DOM access, NO window/document/navigator references.
//
// pure/ dependencies: (none)
// External dependencies (must be loaded before this file):
//   - damage_calc.js:      calculateSpellDamage
//   - shared_game_stats.js: getDefenseStats
// ══════════════════════════════════════════════════════════════════════════════

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
        } else if ('max_hp_heal_pct' in part) {
            const mult_map = stats.get('healMult');
            let heal_mult = 1;
            for (const [k, v] of mult_map.entries()) {
                if (!k.includes(':') || k.split(':')[1] === part_id) heal_mult *= (1 + v / 100);
            }
            result = { type: 'heal', heal_amount: part.max_hp_heal_pct * getDefenseStats(stats)[0] * heal_mult };
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
        if ('max_hp_heal_pct' in p) return true;
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
        if ('max_hp_heal_pct' in part) {
            const mult_map = stats.get('healMult');
            let heal_mult = 1;
            for (const [k, v] of mult_map.entries()) {
                if (!k.includes(':') || k.split(':')[1] === part_id) heal_mult *= (1 + v / 100);
            }
            result = { type: 'heal', heal_amount: part.max_hp_heal_pct * getDefenseStats(stats)[0] * heal_mult };
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
