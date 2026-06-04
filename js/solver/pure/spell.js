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
        const part = dat.store_part;
        const part_id = spell.base_spell + '.' + part.name;
        let result;

        if ('multipliers' in part) {
            const use_str = part.use_str !== false;
            const ignored_mults = part.ignored_mults || [];
            const raw = calculateSpellDamage(
                stats, weapon, part.multipliers, use_spell, !use_speed,
                part_id, !use_str, ignored_mults);
            result = { type: 'damage', normal_total: raw[0], crit_total: raw[1] };
            if (detailed) {
                result.damages_results = raw[2]; // per-element [norm_min, norm_max, crit_min, crit_max]
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
                    result.crit_total[0] += sub.crit_total[0] * hits;
                    result.crit_total[1] += sub.crit_total[1] * hits;
                } else if (sub.type === 'heal') {
                    result.heal_amount += sub.heal_amount * hits;
                }
            }
        }
        result.name = part.name;
        result.display = part.display !== false;
        spell_result_map.set(part_name, result);
        return result;
    }

    return { all_results: spell.parts.map(p => eval_part(p.name)), use_spell };
}

/**
 * Collect names of parts that are referenced by any other part's `hits` map.
 * Parts not in this set are "roots" — they aren't consumed by another aggregation.
 */
function _collect_referenced_part_names(spell) {
    const refs = new Set();
    for (const p of spell.parts ?? []) {
        if ('hits' in p) for (const n of Object.keys(p.hits)) refs.add(n);
    }
    return refs;
}

/**
 * Whether a part transitively produces damage (multipliers or hits → damage).
 */
function _part_produces_damage(part, by_name, seen = new Set()) {
    if (!part || seen.has(part.name)) return false;
    seen.add(part.name);
    if ('multipliers' in part) return true;
    if ('hits' in part) return Object.keys(part.hits).some(n => _part_produces_damage(by_name.get(n), by_name, seen));
    return false;
}

/**
 * Name of the DPS root: a root damage part whose name is "DPS" or ends with " DPS".
 * Used to split DPS damage from sibling flat damage (e.g. Totemic Smash, Puppet
 * Explosion) when spell.display has been overridden by an atree effect.
 */
function _find_dps_root_name(spell) {
    if (!spell?.parts) return null;
    const referenced = _collect_referenced_part_names(spell);
    const by_name = new Map(spell.parts.map(p => [p.name, p]));
    for (const p of spell.parts) {
        if (p.display === false) continue;
        if (referenced.has(p.name)) continue;
        if (p.name !== 'DPS' && !p.name.endsWith(' DPS')) continue;
        if (!_part_produces_damage(p, by_name)) continue;
        return p.name;
    }
    return null;
}

/**
 * Name of the DPS display root for case-2 DPS spells (no separate Total/Max
 * aggregator, e.g. Totem / Puppet Master). Prefers spell.display when it points
 * to a root damage part, else falls back to the structural DPS root.
 *
 * For case-1 spells (Zenith/Meteor-style), the chain root is total_part.name
 * returned by compute_dps_spell_hits_info — callers should use that.
 */
function _find_dps_display_root(spell) {
    if (!spell?.parts) return null;
    const by_name = new Map(spell.parts.map(p => [p.name, p]));
    const referenced = _collect_referenced_part_names(spell);
    if (spell.display) {
        const p = by_name.get(spell.display);
        if (p && !referenced.has(p.name) && _part_produces_damage(p, by_name)) {
            return spell.display;
        }
    }
    return _find_dps_root_name(spell);
}

/**
 * Find the primary display result from evaluated spell parts.
 * Priority: explicit spell.display (if damage) → DPS root (Regen override case)
 * → last displayed damage part.
 */
function _find_display_result(spell, all_results) {
    let display_result = spell.display
        ? all_results.find(r => r?.name === spell.display)
        : null;
    if (!display_result || display_result.type !== 'damage') {
        // spell.display was overridden to a non-damage part (e.g. Regeneration
        // sets Totem's display to "Heal Rate"). Prefer the structural DPS root,
        // else fall back to the last displayed damage part.
        const dps_name = _find_dps_root_name(spell);
        display_result = (dps_name && all_results.find(r => r?.name === dps_name))
            ?? [...all_results].reverse().find(r => r?.display && r?.type === 'damage');
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
    const crit_avg = (display_result.crit_total[0] + display_result.crit_total[1]) / 2;
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
    const crit_avg = (display_result.crit_total[0] + display_result.crit_total[1]) / 2;
    const avg = (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;

    // Collect all display parts for the detailed breakdown popup.
    const parts_data = all_results
        .filter(r => r?.display && r?.type === 'damage')
        .map(r => ({
            name: r.name,
            multipliers: r.multiplied_conversions ?? null, // [n,e,t,w,f,a] effective %
            normal_min: r.damages_results ? r.damages_results.map(d => d[0]) : null,
            normal_max: r.damages_results ? r.damages_results.map(d => d[1]) : null,
            crit_min: r.damages_results ? r.damages_results.map(d => d[2]) : null,
            crit_max: r.damages_results ? r.damages_results.map(d => d[3]) : null,
            normal_total: r.normal_total,
            crit_total: r.crit_total,
            is_spell: use_spell,
        }));

    return {
        avg, non_crit_avg, crit_avg,
        spell_name: spell.name,
        has_cost: 'cost' in spell,
        parts: parts_data,
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
 * Return true if a spell is a DPS spell. Detects structurally (any displayed
 * damage root whose name is "DPS" or ends with " DPS"), so it still returns
 * true when atree effects override spell.display to a non-damage label
 * (e.g. Regeneration sets Totem's display to "Heal Rate").
 *
 * Exception: when spell.display explicitly names a displayed damage part that
 * is NOT itself DPS-named, the author has chosen a total-damage headline, so
 * the spell is treated as non-DPS even if it carries an independent sibling
 * "… DPS" part (e.g. Arrow Storm / Arrow Shield "Total Damage"). The structural
 * fallback only kicks in when display is absent or points to a non-damage part.
 */
function spell_is_dps(spell) {
    if (!spell) return false;
    if (spell.display === 'DPS' || spell.display?.endsWith?.(' DPS')) return true;
    if (spell.display && spell.parts) {
        const by_name = new Map(spell.parts.map(p => [p.name, p]));
        const dp = by_name.get(spell.display);
        if (dp && dp.display !== false && _part_produces_damage(dp, by_name)) return false;
    }
    return _find_dps_root_name(spell) !== null;
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

    // Prefer the DPS part identified by spell.display; fall back to the
    // structural DPS root when display has been overridden (e.g. Regeneration).
    const dps_name = (spell.display && by_name.has(spell.display))
        ? spell.display : _find_dps_root_name(spell);
    const dps_part = dps_name ? by_name.get(dps_name) : null;
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

    return { per_hit_name: leaf.name, max_hits, dps_chain_root: total_part.name };
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
        const part = dat.store_part;
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

/**
 * Sum the crit-weighted damage of all "flat" root damage parts — displayed
 * damage parts not referenced by any other part's hits chain, excluding the
 * DPS chain root (which is already counted in per_cast). Used for DPS spells
 * with sibling one-shot damage added by atree nodes — e.g. Totem + Totemic
 * Smash adds "Smash Damage", Puppet Master + Exploding Puppets adds "Puppet
 * Explosion" — where the flat damage should contribute to the total but not
 * scale with qty (which represents DPS duration for these spells).
 */
function computeSpellFlatDamage(stats, weapon, spell, crit_chance, exclude_root_name) {
    const { all_results } = _eval_spell_parts(stats, weapon, spell, false);
    const referenced = _collect_referenced_part_names(spell);
    let total = 0;
    for (const r of all_results) {
        if (!r || r.type !== 'damage' || !r.display) continue;
        if (r.name === exclude_root_name) continue;
        if (referenced.has(r.name)) continue;
        const non_crit_avg = (r.normal_total[0] + r.normal_total[1]) / 2;
        const crit_avg = (r.crit_total[0] + r.crit_total[1]) / 2;
        total += (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;
    }
    return total;
}
