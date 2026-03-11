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

function pull_req(req_skillpoints, item) {
    const req = item.get('reqs');
    for (let i = 0; i < 5; ++i) {
        if (req[i] > req_skillpoints[i]) {
            req_skillpoints[i] = req[i];
        }
    }
}

function calculate_skillpoints(equipment, weapon) {
    // Calculate equipment required skillpoints.
    // Return value: [best_skillpoints, final_skillpoints, best_total, set_info];
    let no_bonus_items = [weapon];

    let bonus_skillpoints = [0, 0, 0, 0, 0];
    let req_skillpoints = [0, 0, 0, 0, 0];
    let set_counts = new Map();
    for (const item of equipment) {
        if (item.get("crafted")) {
            no_bonus_items.push(item);
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
        }
        pull_req(req_skillpoints, item);
    }
    pull_req(req_skillpoints, weapon);

    let assign = [0, 0, 0, 0, 0];
    let total_assigned = 0;
    for (let i = 0; i < 5; ++i) {
        if(req_skillpoints[i] == 0)
            continue; // no need to assign if req is 0 anyway

        if (req_skillpoints[i] > bonus_skillpoints[i]) {
            const delta = req_skillpoints[i] - bonus_skillpoints[i];
            assign[i] = delta;
            total_assigned += delta;
        }
    }
    let final_skillpoints = assign.slice();
    inplace_vadd5(final_skillpoints, bonus_skillpoints);
    for (const item of no_bonus_items) {
        inplace_vadd5(final_skillpoints, item.get('skillpoints'));
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

