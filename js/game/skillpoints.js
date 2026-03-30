/*
 * Non exhaustive list of dependencies (add them here if you see them!)
 *
 * js/build_utils.js:skp_order
 * js/load_item.js:sets
 */


function inplace_vadd5(target, delta) {
    for (let i = 0; i < 5; ++i) {
        target[i] += delta[i];
    }
}

function pull_req(req_skillpoints, item, is_bonus_item) {
    const req = item.get('reqs');
    const skp = is_bonus_item ? item.get('skillpoints') : null;
    for (let i = 0; i < 5; ++i) {
        const eff = (skp && req[i] > 0) ? req[i] + skp[i] : req[i];
        if (eff > req_skillpoints[i]) {
            req_skillpoints[i] = eff;
        }
    }
}

/**
 * Calculate equipment required skillpoints.
 *
 * @param {Map[]} equipment  - equipment statMaps (armor/acc/tomes)
 * @param {Map}   weapon     - weapon statMap
 * @param {number} sp_budget - max total assignable SP (default Infinity = no limit)
 * @param {Map|null} scratch_set_counts - reusable Map for set counting (optional)
 * @param {Object|null} scratch_sp - reusable arrays {bonus, req, assign, final, no_bonus}
 *                                   to eliminate per-call allocations (optional).
 *                                   Caller must .slice() return arrays before caching.
 * @returns {Array|null} [best_skillpoints, final_skillpoints, best_total, set_counts],
 *                       or null if sp_budget is exceeded or any single attr > SP_PER_ATTR_CAP.
 */
function calculate_skillpoints(equipment, weapon, sp_budget = Infinity, scratch_set_counts = null, scratch_sp = null) {
    let no_bonus_items;
    let bonus_skillpoints;
    let req_skillpoints;
    let assign;
    let final_skillpoints;

    if (scratch_sp) {
        no_bonus_items = scratch_sp.no_bonus;
        no_bonus_items[0] = weapon;
        scratch_sp._no_bonus_len = 1;
        bonus_skillpoints = scratch_sp.bonus;
        req_skillpoints = scratch_sp.req;
        assign = scratch_sp.assign;
        final_skillpoints = scratch_sp.final;
        for (let i = 0; i < 5; i++) {
            bonus_skillpoints[i] = 0;
            req_skillpoints[i] = 0;
            assign[i] = 0;
        }
    } else {
        no_bonus_items = [weapon];
        bonus_skillpoints = [0, 0, 0, 0, 0];
        req_skillpoints = [0, 0, 0, 0, 0];
        assign = [0, 0, 0, 0, 0];
    }

    let set_counts;
    if (scratch_set_counts) {
        set_counts = scratch_set_counts;
        set_counts.clear();
    } else {
        set_counts = new Map();
    }
    for (const item of equipment) {
        if (item.get("crafted")) {
            if (scratch_sp) {
                no_bonus_items[scratch_sp._no_bonus_len++] = item;
            } else {
                no_bonus_items.push(item);
            }
            pull_req(req_skillpoints, item, false);
        }
        // Add skillpoints, and record set bonuses
        else {
            inplace_vadd5(bonus_skillpoints, item.get("skillpoints"));
            const set_name = item.get("set");
            if (set_name) {
                if (!set_counts.get(set_name)) {
                    set_counts.set(set_name, 0);
                }
                set_counts.set(set_name, set_counts.get(set_name) + 1);
            }
            pull_req(req_skillpoints, item, true);
        }
    }
    pull_req(req_skillpoints, weapon, false);

    let total_assigned = 0;
    for (let i = 0; i < 5; ++i) {
        if(req_skillpoints[i] == 0)
            continue; // no need to assign if req is 0 anyway

        if (req_skillpoints[i] > bonus_skillpoints[i]) {
            const delta = req_skillpoints[i] - bonus_skillpoints[i];
            if (delta > SP_PER_ATTR_CAP) return null;
            assign[i] = delta;
            total_assigned += delta;
            if (total_assigned > sp_budget) return null;
        }
    }

    if (scratch_sp) {
        // Reuse final array: copy assign then add bonus
        for (let i = 0; i < 5; i++) final_skillpoints[i] = assign[i];
    } else {
        final_skillpoints = assign.slice();
    }
    inplace_vadd5(final_skillpoints, bonus_skillpoints);
    const nb_len = scratch_sp ? scratch_sp._no_bonus_len : no_bonus_items.length;
    for (let i = 0; i < nb_len; i++) {
        inplace_vadd5(final_skillpoints, no_bonus_items[i].get('skillpoints'));
    }
    for (const [set_name, count] of set_counts) {
        const bonus = sets.get(set_name).bonuses[count - 1];
        for (const i in skp_order) {
            const delta = (bonus[skp_order[i]] || 0);
            final_skillpoints[i] += delta;
        }
    }

    return [assign, final_skillpoints, total_assigned, set_counts];
}

