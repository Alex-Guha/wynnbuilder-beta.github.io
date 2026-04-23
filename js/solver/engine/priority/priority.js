// ── Priority — item scoring + pool sorting ──────────────────────────────────
//
// Dependencies (loaded before this file):
//   - priority/helpers.js:  _item_stat_val
//   - build_utils.js:       skp_order
//
// Debug toggles: SOLVER_DEBUG_PRIORITY (defined in js/solver/debug_toggles.js)

/**
 * Score an item's priority. Higher score → iterated earlier.
 * With sensitivity weights, negative stats with positive weights correctly
 * reduce score (no v > 0 guard on main weights).
 */
function _score_item_priority(item_sm, dmg_weights) {
    let score = 0;
    for (const [stat, w] of dmg_weights) {
        score += _item_stat_val(item_sm, stat) * w;
    }
    // SP provision bonus
    const skp = item_sm.get('skillpoints');
    if (skp && dmg_weights._sp_sensitivities) {
        for (let i = 0; i < 5; i++) {
            if (skp[i]) score += skp[i] * dmg_weights._sp_sensitivities[i];
        }
    }
    // Priority-only (mana sustainability) — take max with main weight, not sum.
    // If both systems value a stat in the same direction, use the larger magnitude;
    // the main-loop iteration already contributed main_w, so add only the excess.
    if (dmg_weights._priority_only) {
        for (const [stat, prio_w] of dmg_weights._priority_only) {
            const main_w = dmg_weights.get(stat) ?? 0;
            if (main_w !== 0 && (prio_w > 0) === (main_w > 0)) {
                const extra = Math.abs(prio_w) - Math.abs(main_w);
                if (extra > 0) score += _item_stat_val(item_sm, stat) * extra * Math.sign(prio_w);
            } else {
                score += _item_stat_val(item_sm, stat) * prio_w;
            }
        }
    }
    // Asymmetric constraint bonuses.
    if (dmg_weights._pos_bonuses) {
        for (const [stat, w] of dmg_weights._pos_bonuses) {
            const v = _item_stat_val(item_sm, stat);
            if (v > 0) score += v * w;
        }
    }
    if (dmg_weights._neg_bonuses) {
        for (const [stat, w] of dmg_weights._neg_bonuses) {
            const v = _item_stat_val(item_sm, stat);
            if (v < 0) score += v * w;
        }
    }
    return score;
}

/**
 * Sort each pool so high-priority items come first, NONE items come last.
 */
function _prioritize_pools(pools, dmg_weights) {

    if (SOLVER_DEBUG_PRIORITY) {
        // Build combined effective weights matching _score_item_priority logic
        const effective = {};
        for (const [stat, w] of dmg_weights) {
            effective[stat] = w;
        }
        if (dmg_weights._priority_only) {
            for (const [stat, w] of dmg_weights._priority_only) {
                effective[stat] = (effective[stat] ?? 0) + w;
            }
        }
        // Sort by absolute value descending for readability
        const sorted = Object.entries(effective).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log('[solver] effective priority weights:', Object.fromEntries(sorted));
        if (dmg_weights._pos_bonuses?.size) {
            console.log('[solver] pos-only bonuses:', Object.fromEntries(dmg_weights._pos_bonuses));
        }
        if (dmg_weights._neg_bonuses?.size) {
            console.log('[solver] neg-only bonuses:', Object.fromEntries(dmg_weights._neg_bonuses));
        }
        if (dmg_weights._sp_sensitivities) {
            console.log('[solver] SP sensitivities:', dmg_weights._sp_sensitivities.map((s, i) =>
                `${skp_order[i]}: ${s.toFixed(4)}`));
        }
    }

    for (const [slot, pool] of Object.entries(pools)) {
        const none_bucket = [];
        const real_bucket = [];
        for (const item of pool) {
            (item.statMap.has('NONE') ? none_bucket : real_bucket).push(item);
        }

        real_bucket.sort((a, b) =>
            _score_item_priority(b.statMap, dmg_weights) -
            _score_item_priority(a.statMap, dmg_weights)
        );

        if (SOLVER_DEBUG_PRIORITY) {
            console.log(`[solver] priority order for ${slot} (${real_bucket.length} items):`);
            for (let i = 0; i < Math.min(real_bucket.length, 20); i++) {
                const it = real_bucket[i];
                const name = it.statMap.get('displayName') ?? it.statMap.get('name') ?? '?';
                const score = _score_item_priority(it.statMap, dmg_weights);
                console.log(`  #${i + 1}: ${name} (score: ${score.toFixed(1)})`);
            }
            if (real_bucket.length > 20) {
                const last = real_bucket[real_bucket.length - 1];
                const last_name = last.statMap.get('displayName') ?? last.statMap.get('name') ?? '?';
                const last_score = _score_item_priority(last.statMap, dmg_weights);
                console.log(`  ... ${real_bucket.length - 20} more ... last: ${last_name} (score: ${last_score.toFixed(1)})`);
            }
        }

        pool.length = 0;
        for (const it of real_bucket) pool.push(it);
        for (const it of none_bucket) pool.push(it);
    }
}
