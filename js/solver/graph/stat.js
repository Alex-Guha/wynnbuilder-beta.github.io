/**
 * Solver computation graph: stat aggregation and display nodes.
 *
 * Pure constants and functions (damageMultipliers, specialNames, radiance_affected,
 * getDefenseStats) are defined in shared_game_stats.js which loads before this file.
 */

// AggregateStatsNode, PlayerClassNode are defined in shared_graph_nodes.js

/**
 * Extracts build.statMap into a plain Map for the stat aggregation pipeline.
 * Returns an empty Map when no build exists.
 *
 * Signature: SolverBuildStatExtractNode(build: Build) => StatMap
 */
class SolverBuildStatExtractNode extends ComputeNode {
    constructor() { super('solver-build-stat-extract'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');
        if (!build) return new Map();
        const stats = new Map(build.statMap);
        // Overwrite item-only skill-point values with the final totals
        // (items + assigned), mirroring AggregateEditableIDNode in builder_graph.js.
        // When solver has greedy-allocated extra SP, use those values so the
        // damage/mana pipeline matches the solver's scoring.
        const sp = (_solver_sp_override?.total_sp) ?? build.total_skillpoints;
        for (const [idx, name] of skp_order.entries()) {
            stats.set(name, sp[idx]);
        }
        const weaponType = build.weapon.statMap.get('type');
        if (weaponType) {
            stats.set('classDef', classDefenseMultipliers.get(weaponType) || 1.0);
        }
        return stats;
    }
}

/**
 * Renders a concise stat summary into a parent element: Total HP, Effective HP,
 * HP Regen, Mana Regen, Mana Steal / per hit, and Life Steal / per hit.
 * Elemental defenses and defense% are intentionally excluded.
 */
function displaySolverSummary(parent_id, stats) {
    const parent = document.getElementById(parent_id);
    if (!parent) return;
    parent.innerHTML = '';
    if (!stats || stats.size === 0) return;

    function row(label, value, labelCls) {
        const div = document.createElement('div');
        div.className = 'row';
        const l = document.createElement('div');
        l.className = 'col text-start' + (labelCls ? ' ' + labelCls : '');
        l.textContent = label;
        const v = document.createElement('div');
        v.className = 'col text-end';
        v.textContent = String(value);
        div.append(l, v);
        return div;
    }

    const defStats = getDefenseStats(stats);
    // defStats: [totalHp, [ehp_agi, ehp_noagi], totalHpr, [ehpr…], [def%, agi%], [eledefs…]]
    parent.append(
        row('Total HP:', Math.round(parseFloat(defStats[0])), 'Health'),
        row('Effective HP:', Math.round(parseFloat(defStats[1][0]))),
        row('HP Regen (Final):', Math.round(parseFloat(defStats[2])), 'Health'),
        Object.assign(document.createElement('hr'), { className: 'row my-2' }),
    );

    const mr = stats.get('mr') ?? 0;
    parent.append(row('Total Mana Regen:', (mr + BASE_MANA_REGEN) + '/5s', 'wDam'));

    const ms = stats.get('ms') ?? 0;
    if (ms) {
        parent.append(row('Mana Steal:', ms + '/3s', 'wDam'));
        const adjAtkSpd = Math.min(6, Math.max(0,
            attackSpeeds.indexOf(stats.get('atkSpd')) + (stats.get('atkTier') ?? 0)));
        const mph = Math.round(ms / 3.0 / baseDamageMultiplier[adjAtkSpd] * 10) / 10;
        parent.append(row('\u279C Mana per hit:', mph, 'wDam'));
    }

    const maxMana = stats.get('maxMana') ?? 0;
    const int_mana = Math.floor(skillPointsToPercentage(stats.get('int') ?? 0) * 100);
    parent.append(row('Total Mana:', 100 + maxMana + int_mana, 'wDam'));

    const ls = stats.get('ls') ?? 0;
    if (ls) {
        parent.append(row('Life Steal:', ls + '/3s', 'Health'));
        const adjAtkSpd = Math.min(6, Math.max(0,
            attackSpeeds.indexOf(stats.get('atkSpd')) + (stats.get('atkTier') ?? 0)));
        const lph = Math.round(ls / 3.0 / baseDamageMultiplier[adjAtkSpd]);
        parent.append(row('\u279C Life per hit:', lph, 'Health'));
    }
}

/**
 * Calls displayBuildStats to populate the Summary and Detailed stat columns.
 * Clears the display when no build is present.
 *
 * Signature: SolverBuildDisplayNode(build: Build, stats: StatMap) => null
 */
class SolverBuildDisplayNode extends ComputeNode {
    constructor() { super('solver-build-display'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');
        const stats = input_map.get('stats');
        if (!build) {
            setHTML('summary-stats', '');
            setHTML('detailed-stats', '');
            return null;
        }
        displaySolverSummary('summary-stats', stats || new Map());
        displayBuildStats('detailed-stats', build, build_detailed_display_commands, stats || new Map());
        return null;
    }
}

// ── Module-level boost / radiance / armor-powder nodes ────────────────────────
// These read DOM state directly; created here so the update_* handlers can
// reference them before solver_graph_init() runs.

// compute_boosts and compute_radiance are defined in shared_graph_nodes.js

let solver_boosts_node = new (class extends ComputeNode {
    constructor() { super('solver-boost-input'); }
    compute_func(_input_map) { return compute_boosts(); }
})().update();

// Raid reward buffs — mirrors the builder's raid_buff_node. Reads the toggle
// state of the raid buff buttons (notg-1 .. wtp-3) and sums the active buffs
// into a flat additive statMap (raid_buff_map lives in shared_constants.js).
const RAID_IDS = ['notg', 'nol', 'tcc', 'tna', 'wtp'];
let solver_raid_buff_node = new (class extends ComputeNode {
    constructor() { super('solver-raid-buff-input'); }
    compute_func(_input_map) {
        let statMap = new Map();
        let toggledBuffs = [];
        for (const raid of RAID_IDS) {
            for (let i = 1; i <= 3; i++) {
                let tier = document.getElementById(raid + "-" + i);
                if (!tier) continue;
                for (let buff of tier.children) {
                    if (buff.classList.contains("toggleOn")) { toggledBuffs.push(buff.id); }
                }
            }
        }
        for (const buff of toggledBuffs) {
            const effs = raid_buff_map.get(buff);
            if (!effs) continue;
            for (const [stat, val] of effs) {
                statMap.set(stat, val + (statMap.get(stat) ?? 0));
            }
        }
        return statMap;
    }
})().update();

let solver_radiance_node = new (class extends ComputeNode {
    constructor() { super('solver-radiance-node'); this.fail_cb = true; }
    compute_func(input_map) {
        return compute_radiance(input_map.get('stats'));
    }
})();


// ── Boost button handlers ─────────────────────────────────────────────────────

function update_boosts(buttonId) {
    toggleButton(buttonId);
    solver_boosts_node.mark_dirty().update();
}

// Mirrors the builder's updateRaidBuffs: buffs must come from a single raid, but
// up to one per tier (3 total). Toggling a buff on clears the other buffs in its
// own tier and every buff belonging to other raids — leaving this raid's other
// tiers untouched.
function updateRaidBuffs(raid, tier, buttonId) {
    let elem = document.getElementById(buttonId);
    if (elem.classList.contains("toggleOn")) {
        elem.classList.remove("toggleOn");
    } else {
        // Clear the other buffs in this same tier (only one per tier).
        let raid_tier = document.getElementById(raid + "-" + tier);
        if (raid_tier) {
            for (let buff of raid_tier.children) {
                if (buff.classList.contains("toggleOn")) { buff.classList.remove("toggleOn"); }
            }
        }
        // Clear every buff from other raids (buffs must all share one raid).
        for (const r of RAID_IDS) {
            if (r === raid) continue;
            for (let i = 1; i <= 3; i++) {
                let other_tier = document.getElementById(r + "-" + i);
                if (!other_tier) continue;
                for (let buff of other_tier.children) {
                    if (buff.classList.contains("toggleOn")) { buff.classList.remove("toggleOn"); }
                }
            }
        }
        elem.classList.add("toggleOn");
    }
    solver_raid_buff_node.mark_dirty().update();
}

function update_radiance(input) {
    toggleButton(input + '-boost');
    solver_radiance_node.mark_dirty().update();
}

// togglePowderSpecialButton is defined in shared_graph_nodes.js
function updatePowderSpecials(buttonId) {
    togglePowderSpecialButton(buttonId);
}
