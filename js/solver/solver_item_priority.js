// ── Item priority scoring & dominance pruning ───────────────────────────────
//
// Extracted from solver_search.js for maintainability.
// Loaded before solver_search.js — all symbols are plain globals consumed there.

// Set to true to log priority scores and pool ordering to the console.
const _SOLVER_DEBUG_PRIORITY = false;

// ── Item stat helpers ────────────────────────────────────────────────────────

const _WEAPON_ELEM = { spear: 'e', wand: 'w', bow: 'a', dagger: 't', relik: 'f' };

/**
 * Read a stat's contribution from an item statMap.
 * Checks maxRolls first (rolled stats), then falls back to direct properties (static stats).
 */
function _item_stat_val(item_sm, stat) {
    const v = item_sm.get('maxRolls')?.get(stat);
    return v !== undefined ? v : (item_sm.get(stat) ?? 0);
}

// ── Weight builders ──────────────────────────────────────────────────────────

/**
 * Build damage sensitivity weights based on weapon type and combo spell types.
 * Returns a Map of stat → priority weight.
 *
 * Logic:
 *  - All-damage generics (damPct/damRaw/critDamPct) always receive weight.
 *  - sdPct/sdRaw receive weight when the combo has any spell-scaling rows.
 *  - mdPct/mdRaw/atkTier receive weight when the combo has melee-scaling rows.
 *  - Weapon-element elemental stats receive extra weight because neutral weapon
 *    base damage converts to the weapon's element.
 *  - For non-damage scoring targets (ehp, healing, etc.), only generic utility
 *    stats are weighted; damage stats are skipped.
 */
// TODO This requires extensive testing and tuning.
function _build_dmg_weights(snap) {
    const weights = new Map();
    const add = (stat, w) => weights.set(stat, (weights.get(stat) ?? 0) + w);

    const target = snap.scoring_target ?? 'combo_damage';

    if (target === 'total_healing') {
        // Healing builds: weight heal-relevant stats
        add('healPct', 1.0);
        add('hpBonus', 0.01); // raw HP also scales heals via power
        return weights;
    }

    if (target === 'ehp') {
        // EHP builds: weight defensive stats
        add('hpBonus', 0.01);
        add('hprRaw', 0.1);
        return weights;
    }

    if (target === 'spd' || target === 'poison' ||
        target === 'lb' || target === 'xpb') {
        // Simple scalar targets: weight the target stat directly
        add(target, 1.0);
        return weights;
    }

    // combo_damage (default): analyse combo spell types and weapon element
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

    // All elemental damage stats — include every element for dominance correctness.
    // An item superior in any element must never be pruned, regardless of weapon type.
    // Using equal weights; weapon-element boosting is omitted to avoid type-detection bugs.
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

    return weights;
}

/**
 * Build constraint relevance weights from restriction stat thresholds.
 * Returns an array of {stat, per_unit} where per_unit is the priority points
 * awarded per unit of that stat on an item.
 */
function _build_constraint_weights(restrictions) {
    const weights = [];
    for (const { stat, op, value } of restrictions.stat_thresholds ?? []) {
        // Only ge constraints on direct stats (not computed ehp/ehp_no_agi/total_hp/ehpr/hpr — too indirect)
        if (op !== 'ge' || stat === 'ehp' || stat === 'ehp_no_agi' || stat === 'total_hp' || stat === 'ehpr' || stat === 'hpr' || value <= 0) continue;
        // A full threshold's worth of this stat on one item ≈ 25 priority points
        weights.push({ stat, per_unit: 25 / value });
    }
    return weights;
}

// ── Priority scoring ─────────────────────────────────────────────────────────

/**
 * Score an item's priority. Higher score → iterated earlier.
 */
function _score_item_priority(item_sm, dmg_weights, constraint_weights) {
    let score = 0;
    for (const [stat, w] of dmg_weights) {
        const v = _item_stat_val(item_sm, stat);
        if (v > 0) score += v * w;
    }
    for (const { stat, per_unit } of constraint_weights) {
        const v = _item_stat_val(item_sm, stat);
        if (v > 0) score += Math.min(v * per_unit, 25); // cap at 25 pts per constraint
    }
    return score;
}

/**
 * Sort each pool so high-priority items come first, NONE items come last.
 *
 * Moving NONE to the end means level-0 enumeration visits only real items,
 * so the first complete builds found are likely to be strong ones. This
 * makes interim UI updates much more useful without changing search correctness.
 */
function _prioritize_pools(pools, snap, restrictions) {
    const dmg_weights = _build_dmg_weights(snap);
    const constraint_weights = _build_constraint_weights(restrictions);

    if (_SOLVER_DEBUG_PRIORITY) {
        console.log('[solver] damage weights:', Object.fromEntries(dmg_weights));
        if (constraint_weights.length > 0) {
            console.log('[solver] constraint weights:', constraint_weights.map(c => `${c.stat}: ${c.per_unit.toFixed(4)}/unit`));
        }
    }

    for (const [slot, pool] of Object.entries(pools)) {
        const none_bucket = [];
        const real_bucket = [];
        for (const item of pool) {
            (item.statMap.has('NONE') ? none_bucket : real_bucket).push(item);
        }

        real_bucket.sort((a, b) =>
            _score_item_priority(b.statMap, dmg_weights, constraint_weights) -
            _score_item_priority(a.statMap, dmg_weights, constraint_weights)
        );

        if (_SOLVER_DEBUG_PRIORITY) {
            console.log(`[solver] priority order for ${slot} (${real_bucket.length} items):`);
            for (let i = 0; i < Math.min(real_bucket.length, 20); i++) {
                const it = real_bucket[i];
                const name = it.statMap.get('displayName') ?? it.statMap.get('name') ?? '?';
                const score = _score_item_priority(it.statMap, dmg_weights, constraint_weights);
                console.log(`  #${i + 1}: ${name} (score: ${score.toFixed(1)})`);
            }
            if (real_bucket.length > 20) {
                const last = real_bucket[real_bucket.length - 1];
                const last_name = last.statMap.get('displayName') ?? last.statMap.get('name') ?? '?';
                const last_score = _score_item_priority(last.statMap, dmg_weights, constraint_weights);
                console.log(`  ... ${real_bucket.length - 20} more ... last: ${last_name} (score: ${last_score.toFixed(1)})`);
            }
        }

        pool.length = 0;
        for (const it of real_bucket) pool.push(it);
        for (const it of none_bucket) pool.push(it);
    }
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
function _prune_dominated_items(pools, snap, restrictions) {
    const dmg_weights = _build_dmg_weights(snap);

    // Stats to compare: all scoring-relevant stats + stat-threshold stats
    // (threshold constraints are ge-only, so higher is always at least as good).
    const check_stats = [...dmg_weights.keys()];
    for (const { stat, op } of (restrictions.stat_thresholds ?? [])) {
        if (op === 'ge' && stat !== 'ehp' && stat !== 'ehp_no_agi' && stat !== 'total_hp' && stat !== 'ehpr' && stat !== 'hpr' && !check_stats.includes(stat)) {
            check_stats.push(stat);
        }
    }

    let total_pruned = 0;

    for (const pool of Object.values(pools)) {
        // Separate NONE items (never pruned) from real items
        const real = [];
        const none_bucket = [];
        for (const item of pool) {
            (item.statMap.has('NONE') ? none_bucket : real).push(item);
        }
        if (real.length < 2) continue;

        const dominated = new Array(real.length).fill(false);

        for (let i = 0; i < real.length; i++) {
            if (dominated[i]) continue;
            const a_sm = real[i].statMap;
            const a_reqs = a_sm.get('reqs') ?? [0, 0, 0, 0, 0];
            const a_skp = a_sm.get('skillpoints') ?? [0, 0, 0, 0, 0];

            for (let j = 0; j < real.length; j++) {
                if (i === j || dominated[j]) continue;
                const b_sm = real[j].statMap;

                // 1. Scoring stats: A must be >= B on every stat
                let ok = true;
                for (const stat of check_stats) {
                    if (_item_stat_val(a_sm, stat) < _item_stat_val(b_sm, stat)) {
                        ok = false; break;
                    }
                }
                if (!ok) continue;

                // 2. SP requirements: A.reqs[i] <= B.reqs[i] for all i
                const b_reqs = b_sm.get('reqs') ?? [0, 0, 0, 0, 0];
                for (let k = 0; k < 5; k++) {
                    if ((a_reqs[k] ?? 0) > (b_reqs[k] ?? 0)) { ok = false; break; }
                }
                if (!ok) continue;

                // 3. SP provisions: A.skillpoints[i] >= B.skillpoints[i] for all i
                const b_skp = b_sm.get('skillpoints') ?? [0, 0, 0, 0, 0];
                for (let k = 0; k < 5; k++) {
                    if ((a_skp[k] ?? 0) < (b_skp[k] ?? 0)) { ok = false; break; }
                }
                if (!ok) continue;

                dominated[j] = true;
            }
        }

        const pruned_count = dominated.filter(Boolean).length;
        total_pruned += pruned_count;

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
