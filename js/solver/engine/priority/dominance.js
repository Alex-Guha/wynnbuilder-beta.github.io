// ── Dominance — classification + pruning ────────────────────────────────────
//
// Classifies scoring-relevant stats into higher-is-better / lower-is-better
// sets based on sensitivity weights and restrictions, then prunes items
// that are strictly dominated in any build.
//
// Dependencies (loaded before this file):
//   - priority/helpers.js:  _item_stat_val, _PERTURBABLE_STATS,
//                           _DEFAULT_DELTAS, _INDIRECT_CONSTRAINT_STATS,
//                           _estimate_mana_tight
//
// Debug toggles: SOLVER_DEBUG_SENSITIVITY, SOLVER_DEBUG_DOMINANCE
// (defined in js/solver/debug_toggles.js)

// ── Dominance stat classification ─────────────────────────────────────────────

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

    // Compute threshold from max per-item impact (sensitivity × delta).
    // Using impact prevents stats with tiny deltas (atkTier) from inflating
    // the threshold and excluding damage stats from dominance checks.
    const _deltas = dmg_weights._deltas;
    let max_impact = 0;
    for (const [stat, w] of dmg_weights) {
        const d = (_deltas?.get(stat)) ?? _DEFAULT_DELTAS[stat] ?? 1;
        const impact = Math.abs(w) * d;
        if (impact > max_impact) max_impact = impact;
    }
    const threshold = max_impact * 0.005;

    // Classify by per-item impact sign
    for (const [stat, w] of dmg_weights) {
        const d = (_deltas?.get(stat)) ?? _DEFAULT_DELTAS[stat] ?? 1;
        if (w * d > threshold) higher.add(stat);
        else if (w * d < -threshold) lower.add(stat);
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
        _build_dominance_stats,
        _prune_dominated_items,
    };
}
