// ── Item priority scoring & dominance pruning ───────────────────────────────
//
// Extracted from solver_search.js for maintainability.
// Loaded before solver_search.js — all symbols are plain globals consumed there.

// Debug toggles: SOLVER_DEBUG_PRIORITY, SOLVER_DEBUG_DOMINANCE
// (defined in js/solver/debug_toggles.js)

// Stats that are computed from the full build (not direct item stats) —
// excluded from constraint weights and dominance check_stats.
const _INDIRECT_CONSTRAINT_STATS = new Set([
    'ehp', 'ehp_no_agi', 'total_hp', 'ehpr', 'hpr',
    'finalSpellCost1', 'finalSpellCost2', 'finalSpellCost3', 'finalSpellCost4',
]);

// ── Item stat helpers ────────────────────────────────────────────────────────

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

    // When mana sustainability is required (combo_time set, downtime not allowed),
    // implicitly prioritize mana regen and mana steal so the search visits items
    // that help sustain the combo earlier.  These are priority-only hints — they
    // must NOT feed into dominance pruning (an item with lower mr can still be
    // optimal if it wins on damage).
    if (snap.combo_time && !snap.allow_downtime) {
        weights._priority_only = new Map();
        weights._priority_only.set('mr', 0.5);
        if (has_melee) weights._priority_only.set('ms', 0.5);
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
        // Only ge constraints on direct stats (not computed — too indirect)
        if (op !== 'ge' || _INDIRECT_CONSTRAINT_STATS.has(stat) || value <= 0) continue;
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
    // Include priority-only weights (e.g. mr/ms for mana sustainability)
    if (dmg_weights._priority_only) {
        for (const [stat, w] of dmg_weights._priority_only) {
            const v = _item_stat_val(item_sm, stat);
            if (v > 0) score += v * w;
        }
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
function _prioritize_pools(pools, dmg_weights, constraint_weights) {

    if (SOLVER_DEBUG_PRIORITY) {
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

        if (SOLVER_DEBUG_PRIORITY) {
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

// ── Dominance stat classification ─────────────────────────────────────────────

/**
 * Conservative mana deficit estimate for dominance pruning decisions.
 *
 * Assumes 0 mr, 0 ms, 0 int, 0 maxMana from equipment (worst case) so that
 * when this says "mana is fine", it truly is — even with the weakest items.
 * Uses base spell costs without int reduction (overestimates cost = safe).
 *
 * Returns true when the combo's mana budget is tight enough that mr/ms
 * should be considered in dominance pruning.
 */
function _estimate_mana_tight(snap) {
    if (snap.hp_casting) return false;          // Blood Pact: spells paid with HP
    const combo_time = snap.combo_time ?? 0;
    if (!combo_time) return false;              // No combo timing → no mana gate

    const start_mana = 100;                     // base mana pool, no item/int bonus
    const base_regen = (BASE_MANA_REGEN / 5) * combo_time;  // 25/5 * time
    const flat_mana = snap.flat_mana ?? 0;

    // Sum base spell costs (no int reduction = overestimates cost)
    let mana_cost = 0;
    for (const { qty, spell, mana_excl, recast_penalty_per_cast } of (snap.parsed_combo ?? [])) {
        if (mana_excl || !spell || spell.cost == null) continue;
        mana_cost += spell.cost * qty;
        if (recast_penalty_per_cast) mana_cost += recast_penalty_per_cast * qty;
    }

    const end_mana = start_mana - mana_cost + base_regen + flat_mana;

    if (snap.allow_downtime) {
        return end_mana < 0;                    // net negative → need mr/ms
    } else {
        return (start_mana - end_mana) > 5;     // deficit > 5 → not sustainable
    }
}

/**
 * Classify which stats are "higher-is-better" vs "lower-is-better" for
 * dominance pruning.  Returns { higher: Set<string>, lower: Set<string> }.
 *
 * Sources:
 *  - dmg_weights keys → higher
 *  - ge restrictions (direct) → higher
 *  - le restrictions (direct) → lower
 *  - Spell cost stats when mana matters → lower
 *  - mr (and ms/atkTier for melee) when mana estimate is tight → higher
 *
 * Conflicts (stat in both sets) are removed from both (non-monotonic → unsafe).
 * atkTier is removed when melee DPS and mana-steal/life-steal directions conflict.
 */
function _build_dominance_stats(snap, dmg_weights, restrictions) {
    const higher = new Set(dmg_weights.keys());
    const lower = new Set();

    for (const { stat, op } of (restrictions.stat_thresholds ?? [])) {
        if (_INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        if (op === 'ge') higher.add(stat);
        else if (op === 'le') lower.add(stat);
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

    // mr/ms enter dominance only when the mana estimate shows a real deficit
    // (and not under Blood Pact where spells are HP-cast).
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

    // atkTier special case: if combo has melee rows AND mana is tight or
    // life-steal is constrained, lower atkTier = more hits = more sustain,
    // conflicting with higher atkTier = faster DPS. Remove from both.
    const ls_constraint = (restrictions.stat_thresholds ?? []).some(t => t.stat === 'ls' && t.op === 'ge');
    if (has_melee && (mana_tight || ls_constraint)) {
        higher.delete('atkTier');
        lower.delete('atkTier');
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
        _item_stat_val, _build_dominance_stats, _prune_dominated_items,
        _INDIRECT_CONSTRAINT_STATS,
    };
}
