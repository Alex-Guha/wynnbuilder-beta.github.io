/*
 * Non exhaustive list of dependencies (add them here if you see them!)
 *
 * js/game/build_utils.js:skp_order
 * js/data/load_item.js:sets
 * js/game/game_rules.js:SP_PER_ATTR_CAP
 */


/**
 * Calculate equipment required skillpoints using bitmask DP for cascade activation.
 *
 * Under cascade mechanics, an item's SP bonus only activates once ALL of its
 * requirements are met by assigned SP + bonuses from already-activated items.
 * The DP finds the activation ordering that minimizes total assigned SP.
 *
 * @param {Map[]} equipment  - equipment statMaps (armor/acc/tomes)
 * @param {Map}   weapon     - weapon statMap
 * @param {number} sp_budget - max total assignable SP (default Infinity = no limit)
 * @param {Map|null} scratch_set_counts - reusable Map for set counting (optional)
 * @param {Object|null} scratch_sp - reusable arrays to eliminate per-call allocations (optional).
 *                                   Caller must .slice() return arrays before caching.
 * @returns {Array|null} [best_skillpoints, final_skillpoints, best_total, set_counts],
 *                       or null if sp_budget is exceeded or any single attr > SP_PER_ATTR_CAP.
 */
function calculate_skillpoints(equipment, weapon, sp_budget = Infinity, scratch_set_counts = null, scratch_sp = null) {
    let no_bonus_items;
    let assign;
    let final_skillpoints;
    let free_bonus;
    let max_passive_req;
    let ord_items;
    let ord_reqs;
    let ord_skp;
    let post_floor;
    let running_bonus;
    let best_assign;
    let save_stack;

    if (scratch_sp) {
        no_bonus_items = scratch_sp.no_bonus;
        no_bonus_items[0] = weapon;
        scratch_sp._no_bonus_len = 1;
        assign = scratch_sp.assign;
        final_skillpoints = scratch_sp.final;
        free_bonus = scratch_sp.free_bonus;
        max_passive_req = scratch_sp.max_passive_req;
        ord_items = scratch_sp.ord_items;
        ord_reqs = scratch_sp.ord_reqs;
        ord_skp = scratch_sp.ord_skp;
        post_floor = scratch_sp.post_floor;
        running_bonus = scratch_sp.running_bonus;
        best_assign = scratch_sp.best_assign;
        save_stack = scratch_sp.save_stack;
        for (let i = 0; i < 5; i++) {
            assign[i] = 0;
            free_bonus[i] = 0;
            max_passive_req[i] = 0;
        }
    } else {
        no_bonus_items = [weapon];
        assign = [0, 0, 0, 0, 0];
        free_bonus = [0, 0, 0, 0, 0];
        max_passive_req = [0, 0, 0, 0, 0];
        ord_items = new Array(9);
        ord_reqs = new Array(9);
        ord_skp = new Array(9);
        post_floor = [0, 0, 0, 0, 0];
        running_bonus = [0, 0, 0, 0, 0];
        best_assign = [0, 0, 0, 0, 0];
        save_stack = new Array(45);
    }

    // ── Phase 1: Classify items ─────────────────────────────────────────────

    let set_counts;
    if (scratch_set_counts) {
        set_counts = scratch_set_counts;
        set_counts.clear();
    } else {
        set_counts = new Map();
    }

    let k = 0; // number of ordering items

    for (const item of equipment) {
        const is_crafted = item.get('crafted');
        const req = item.get('reqs');
        const skp = item.get('skillpoints');

        // Track set membership (non-crafted only)
        if (!is_crafted) {
            const set_name = item.get('set');
            if (set_name) {
                if (!set_counts.get(set_name)) {
                    set_counts.set(set_name, 0);
                }
                set_counts.set(set_name, set_counts.get(set_name) + 1);
            }
        }

        if (is_crafted) {
            // Crafted items: always passive, SP added unconditionally at end
            if (scratch_sp) {
                no_bonus_items[scratch_sp._no_bonus_len++] = item;
            } else {
                no_bonus_items.push(item);
            }
            // Track passive requirements
            for (let i = 0; i < 5; i++) {
                if (req[i] > max_passive_req[i]) max_passive_req[i] = req[i];
            }
        } else {
            let has_req = false;
            let has_skp = false;
            for (let i = 0; i < 5; i++) {
                if (req[i] > 0) has_req = true;
                if (skp[i] !== 0) has_skp = true;
            }

            if (has_req && has_skp) {
                // Ordering item: DP candidate
                ord_items[k] = item;
                ord_reqs[k] = req;
                ord_skp[k] = skp;
                k++;
            } else if (!has_req) {
                // Free item: no requirements, add SP to free pool immediately
                for (let i = 0; i < 5; i++) free_bonus[i] += skp[i];
            } else {
                // Passive item: has reqs but no SP bonus
                for (let i = 0; i < 5; i++) {
                    if (req[i] > max_passive_req[i]) max_passive_req[i] = req[i];
                }
            }
        }
    }

    // Weapon: always passive (requirements checked, SP added to final)
    const wep_req = weapon.get('reqs');
    for (let i = 0; i < 5; i++) {
        if (wep_req[i] > max_passive_req[i]) max_passive_req[i] = wep_req[i];
    }

    // Set bonuses: treated as free (always available)
    for (const [set_name, count] of set_counts) {
        const bonus = sets.get(set_name).bonuses[count - 1];
        for (const i in skp_order) {
            free_bonus[i] += (bonus[skp_order[i]] || 0);
        }
    }

    // ── Phase 2: Trivial fast path (k == 0) ─────────────────────────────────

    if (k === 0) {
        let total_assigned = 0;
        for (let i = 0; i < 5; i++) {
            if (max_passive_req[i] === 0) continue;
            const need = max_passive_req[i] - free_bonus[i];
            if (need > 0) {
                if (need > SP_PER_ATTR_CAP) return null;
                assign[i] = need;
                total_assigned += need;
                if (total_assigned > sp_budget) return null;
            }
        }

        if (scratch_sp) {
            for (let i = 0; i < 5; i++) final_skillpoints[i] = assign[i] + free_bonus[i];
        } else {
            final_skillpoints = [
                assign[0] + free_bonus[0], assign[1] + free_bonus[1],
                assign[2] + free_bonus[2], assign[3] + free_bonus[3],
                assign[4] + free_bonus[4],
            ];
        }
        // Add weapon + crafted SP to final
        const nb_len = scratch_sp ? scratch_sp._no_bonus_len : no_bonus_items.length;
        for (let n = 0; n < nb_len; n++) {
            const skp = no_bonus_items[n].get('skillpoints');
            for (let i = 0; i < 5; i++) final_skillpoints[i] += skp[i];
        }

        return [assign, final_skillpoints, total_assigned, set_counts];
    }

    // ── Phase 3: Precompute post_floor + backtracking search ──────────────

    // Total ordering bonus across all ordering items
    const total_ord_bonus = [0, 0, 0, 0, 0];
    for (let n = 0; n < k; n++) {
        for (let i = 0; i < 5; i++) total_ord_bonus[i] += ord_skp[n][i];
    }

    // post_floor[j] = minimum final assign[j] after all items activated.
    // Enforces both passive requirements and the bootstrap constraint:
    //   For each ordering item n: assign[j] + free_bonus[j] + total_ord_bonus[j] - skp_n[j] >= req_n[j]
    //   => assign[j] >= req_n[j] + skp_n[j] - free_bonus[j] - total_ord_bonus[j]
    for (let j = 0; j < 5; j++) {
        let floor_j = 0;
        // Passive requirement floor
        if (max_passive_req[j] > 0) {
            floor_j = max_passive_req[j] - free_bonus[j] - total_ord_bonus[j];
        }
        // Bootstrap (self-exclusion) constraint per ordering item
        for (let n = 0; n < k; n++) {
            if (ord_reqs[n][j] > 0) {
                const bs = ord_reqs[n][j] + ord_skp[n][j] - free_bonus[j] - total_ord_bonus[j];
                if (bs > floor_j) floor_j = bs;
            }
        }
        if (floor_j < 0) floor_j = 0;
        post_floor[j] = floor_j;
    }

    // Early reject if post_floor alone exceeds caps/budget
    let lb_total = 0;
    for (let j = 0; j < 5; j++) {
        if (post_floor[j] > SP_PER_ATTR_CAP) return null;
        lb_total += post_floor[j];
    }
    if (lb_total > sp_budget) return null;

    // Backtracking search over activation orderings
    for (let i = 0; i < 5; i++) { running_bonus[i] = 0; assign[i] = 0; }
    let best_total = Infinity;

    function _bt(depth, used, running_total) {
        if (depth === k) {
            // Apply post_floor constraints at leaf
            let ft = running_total;
            for (let j = 0; j < 5; j++) {
                if (post_floor[j] > assign[j]) ft += post_floor[j] - assign[j];
            }
            if (ft < best_total) {
                best_total = ft;
                for (let j = 0; j < 5; j++) {
                    best_assign[j] = post_floor[j] > assign[j] ? post_floor[j] : assign[j];
                }
            }
            return;
        }

        for (let n = 0; n < k; n++) {
            if (used & (1 << n)) continue;

            const req_n = ord_reqs[n];
            const skp_n = ord_skp[n];
            const save_off = depth * 5;

            // Save assign
            for (let j = 0; j < 5; j++) save_stack[save_off + j] = assign[j];

            // Bump assign to meet this item's activation requirements
            let new_total = running_total;
            let cap_ok = true;
            for (let j = 0; j < 5; j++) {
                if (req_n[j] > 0) {
                    const demand = req_n[j] - free_bonus[j] - running_bonus[j];
                    if (demand > assign[j]) {
                        if (demand > SP_PER_ATTR_CAP) { cap_ok = false; break; }
                        new_total += demand - assign[j];
                        assign[j] = demand;
                    }
                }
            }

            if (cap_ok) {
                // Lower-bound pruning: current total + remaining post_floor gaps
                let lb = new_total;
                for (let j = 0; j < 5; j++) {
                    if (post_floor[j] > assign[j]) lb += post_floor[j] - assign[j];
                }
                if (lb < best_total) {
                    for (let j = 0; j < 5; j++) running_bonus[j] += skp_n[j];
                    _bt(depth + 1, used | (1 << n), new_total);
                    for (let j = 0; j < 5; j++) running_bonus[j] -= skp_n[j];
                }
            }

            // Restore assign
            for (let j = 0; j < 5; j++) assign[j] = save_stack[save_off + j];
        }
    }

    _bt(0, 0, 0);

    if (best_total === Infinity) return null;

    // ── Phase 4: Finalization ───────────────────────────────────────────────

    for (let i = 0; i < 5; i++) assign[i] = best_assign[i];

    // Cap + budget check
    let total_assigned = 0;
    for (let i = 0; i < 5; i++) {
        if (assign[i] > SP_PER_ATTR_CAP) return null;
        total_assigned += assign[i];
        if (total_assigned > sp_budget) return null;
    }

    // Final SP = assign + free_bonus + total_ordering_bonus
    if (scratch_sp) {
        for (let i = 0; i < 5; i++) {
            final_skillpoints[i] = assign[i] + free_bonus[i] + total_ord_bonus[i];
        }
    } else {
        final_skillpoints = [0, 0, 0, 0, 0];
        for (let i = 0; i < 5; i++) {
            final_skillpoints[i] = assign[i] + free_bonus[i] + total_ord_bonus[i];
        }
    }

    // Add weapon + crafted SP to final
    const nb_len = scratch_sp ? scratch_sp._no_bonus_len : no_bonus_items.length;
    for (let n = 0; n < nb_len; n++) {
        const skp = no_bonus_items[n].get('skillpoints');
        for (let i = 0; i < 5; i++) final_skillpoints[i] += skp[i];
    }

    return [assign, final_skillpoints, total_assigned, set_counts];
}
