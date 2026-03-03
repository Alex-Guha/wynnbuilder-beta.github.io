// Set by solver_search.js when filling a solver result into the UI.
// SolverSKPNode reads this to show "Assign: X (+Y)" with greedy extra SP.
// Cleared when the user manually edits items (non-solver change).
let _solver_sp_override = null;

// BuildAssembleNode is defined in shared_graph_nodes.js

/**
 * Reads SP assignment results from the assembled Build and updates the read-only
 * skill-point display in the solver page.
 *
 * Signature: SolverSKPNode(build: Build) => null
 */
class SolverSKPNode extends ComputeNode {
    constructor() { super('solver-skillpoints'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');

        const skp_names = ["Strength", "Dexterity", "Intelligence", "Defense", "Agility"];

        // Clear display
        for (const skp of skp_order) {
            const totalEl  = document.getElementById(skp + '-skp-total');
            const assignEl = document.getElementById(skp + '-skp-assign');
            const warnEl   = document.getElementById(skp + '-warnings');
            if (totalEl)  totalEl.textContent  = '—';
            if (assignEl) assignEl.textContent = 'Assign: 0';
            if (warnEl)   warnEl.textContent   = '';
        }
        const summaryBox = document.getElementById('summary-box');
        const errBox     = document.getElementById('err-box');
        if (summaryBox) summaryBox.textContent = '';
        if (errBox)     errBox.textContent     = '';

        if (!build) return null;

        // When solver has filled this build, use its greedy SP allocation data.
        const ov = _solver_sp_override;
        const has_override = ov && ov.base_sp && ov.total_sp;

        for (const [i, skp] of skp_order.entries()) {
            const totalEl  = document.getElementById(skp + '-skp-total');
            const assignEl = document.getElementById(skp + '-skp-assign');
            const assigned = has_override ? ov.base_sp[i] : build.base_skillpoints[i];

            if (has_override) {
                if (totalEl)  totalEl.textContent = ov.total_sp[i];
                const req   = build.base_skillpoints[i];
                const extra = ov.base_sp[i] - req;
                if (assignEl) assignEl.textContent = extra > 0
                    ? `Assign: ${req} (+${extra})`
                    : `Assign: ${req}`;
            } else {
                if (totalEl)  totalEl.textContent  = build.total_skillpoints[i];
                if (assignEl) assignEl.textContent = 'Assign: ' + build.base_skillpoints[i];
            }

            // Per-attribute overflow warning (matches builder behaviour)
            const warnEl = document.getElementById(skp + '-warnings');
            if (warnEl && assigned > SP_PER_ATTR_CAP) {
                const p = document.createElement('p');
                p.classList.add('warning', 'small-text');
                p.textContent = `Cannot assign ${assigned} skillpoints in ${skp_names[i]} manually.`;
                warnEl.appendChild(p);
            }
        }

        if (summaryBox) {
            const total  = has_override ? ov.assigned_sp : build.assigned_skillpoints;
            const budget = levelToSkillPoints(build.level);
            const rem    = budget - total;
            const p = document.createElement('p');
            p.classList.add('scaled-font', 'my-0');
            const span = document.createElement('b');
            span.classList.add(rem < 0 ? 'negative' : 'positive');
            span.textContent = String(rem);
            p.append('Assigned ', Object.assign(document.createElement('b'), {textContent: String(total)}),
                      ' skill points. Remaining: ', span);
            summaryBox.appendChild(p);
        }

        return null;
    }
}

// ── Graph initialisation ──────────────────────────────────────────────────────

// none_items indices (from load_item.js, populated during item loading):
//   0: helmet  1: chestplate  2: leggings  3: boots
//   4: ring1   5: ring2       6: bracelet  7: necklace  8: weapon (dagger)
const _NONE_ITEM_IDX = {
    helmet: 0, chestplate: 1, leggings: 2, boots: 3,
    ring1: 4, ring2: 5, bracelet: 6, necklace: 7, weapon: 8,
};

// none_tomes indices (from load_tome.js):
//   0: weaponTome  1: armorTome  2: guildTome  3: lootrunTome
//   4: gatherXpTome  5: dungeonXpTome  6: mobXpTome
const _NONE_TOME_KEY = {
    weaponTome1: 0, weaponTome2: 0,
    armorTome1:  1, armorTome2:  1, armorTome3:  1, armorTome4: 1,
    guildTome1:  2,
    lootrunTome1:  3,
    gatherXpTome1: 4, gatherXpTome2: 4,
    dungeonXpTome1: 5, dungeonXpTome2: 5,
    mobXpTome1: 6, mobXpTome2: 6,
};

/**
 * Encodes the current build state into the compact binary format used by WynnBuilder.
 * Greedy-allocated SP are obtained from the build-stats graph input (which reads
 * _solver_sp_override in SolverBuildStatExtractNode), ensuring the encode node
 * always uses the same SP values as the stats display pipeline.
 *
 * Signature: SolverBuildEncodeNode(build, build-stats, atree, atree-state, aspects,
 *                                   helmet-powder…weapon-powder) => EncodingBitVector | null
 */
class SolverBuildEncodeNode extends ComputeNode {
    constructor() { super('solver-encode'); this.fail_cb = true; }

    compute_func(input_map) {
        const build = input_map.get('build');
        const atree = input_map.get('atree');
        if (!build || !atree) return null;

        const atree_state = input_map.get('atree-state');
        const aspects     = input_map.get('aspects') || [];
        const powders = [
            input_map.get('helmet-powder')    || [],
            input_map.get('chestplate-powder') || [],
            input_map.get('leggings-powder')   || [],
            input_map.get('boots-powder')      || [],
            input_map.get('weapon-powder')     || [],
        ];

        // Read SP from the build-stats pipeline (SolverBuildStatExtractNode),
        // which already applies _solver_sp_override when greedy SP were allocated.
        // This keeps encoding in sync with the displayed stats — no separate
        // global variable read needed here.
        const build_stats = input_map.get('build-stats');
        const skillpoints = build_stats
            ? skp_order.map(name => build_stats.get(name))
            : build.total_skillpoints.slice();

        // Ensure version is set (may be absent when page loaded without a hash).
        if (typeof wynn_version_id === 'undefined' || wynn_version_id === null) {
            wynn_version_id = WYNN_VERSION_LATEST;
        }

        try {
            return encodeBuild(build, powders, skillpoints, atree, atree_state, aspects);
        } catch (e) {
            console.warn('[solver] encodeBuild failed:', e);
            return null;
        }
    }
}

/**
 * Pushes the encoded build + solver params to the browser URL hash.
 * Format: #<build_b64>_<solver_b64>
 *
 * When the build changes, caches the build b64 and fires an async hash update
 * that encodes all solver params alongside the build hash.
 *
 * Signature: SolverURLUpdateNode(build-str: EncodingBitVector | null) => null
 */
class SolverURLUpdateNode extends ComputeNode {
    constructor() { super('solver-url-update'); this.fail_cb = true; }

    compute_func(input_map) {
        const build_str = input_map.get('build-str');
        if (!build_str) {
            _last_build_b64 = '';
            window.history.replaceState(null, '', location.pathname);
            return null;
        }
        _last_build_b64 = build_str.toB64();
        // Fire-and-forget async: encodes solver params + writes full hash.
        _do_solver_hash_update();
        return null;
    }
}

// ── Unified solver URL hash updater ──────────────────────────────────────────

/** Cached build Base64 string, set by SolverURLUpdateNode. */
let _last_build_b64 = '';

/** Debounce timer for non-build solver hash updates. */
let _solver_hash_timer = null;

/**
 * Debounced: schedules a solver hash update 300 ms from now.
 * Called by restriction, combo, sfree, and roll-mode change handlers.
 */
function _schedule_solver_hash_update() {
    clearTimeout(_solver_hash_timer);
    _solver_hash_timer = setTimeout(_do_solver_hash_update, 300);
}

/**
 * Reads ALL solver state from the DOM, encodes it via encodeSolverParams(),
 * and writes the full URL hash: #<build_b64>_<solver_b64>.
 * Replaces the separate _do_restrictions_url_update, _do_combo_url_update,
 * _write_sfree_url, and roll-mode query-param logic.
 */
async function _do_solver_hash_update() {
    const build_b64 = _last_build_b64;
    if (!build_b64) return;

    const params = _collect_solver_params();

    try {
        const solver_b64 = await encodeSolverParams(params);
        const full_hash = build_b64 + SOLVER_HASH_SEP + solver_b64;
        window.history.replaceState(null, '', location.pathname + '#' + full_hash);
    } catch (e) {
        console.warn('[solver] hash update failed:', e);
        // Fallback: write build hash only
        window.history.replaceState(null, '', location.pathname + '#' + build_b64);
    }
}

/**
 * Collects all solver-specific state from the DOM into a params object
 * suitable for encodeSolverParams().
 */
function _collect_solver_params() {
    // Roll mode
    const roll = current_roll_mode;

    // sfree mask
    const sfree = typeof _solver_free_mask !== 'undefined' ? _solver_free_mask : 0;

    // Build direction (enabled bitmask: bit0=str, bit1=dex, ..., bit4=agi)
    const sp_keys = ['str', 'dex', 'int', 'def', 'agi'];
    let dir_enabled = 0;
    for (let i = 0; i < 5; i++) {
        const btn = document.getElementById('dir-' + sp_keys[i]);
        if (btn && btn.classList.contains('toggleOn')) dir_enabled |= (1 << i);
    }

    // Level range
    const lvl_min = parseInt(document.getElementById('restr-lvl-min')?.value) || 1;
    const lvl_max = parseInt(document.getElementById('restr-lvl-max')?.value) || MAX_PLAYER_LEVEL;

    // No Major ID
    const nomaj = document.getElementById('restr-no-major-id')?.classList.contains('toggleOn') ?? false;

    // Guild tome
    const gtome = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;

    // Combo time
    const ctime = parseInt(document.getElementById('combo-time')?.value) || 0;

    // Allow Downtime
    const dtime = document.getElementById('combo-downtime-btn')?.classList.contains('toggleOn') ?? false;

    // Restrictions text (pipe-separated key:op:value)
    const entries = [];
    for (const row of (document.getElementById('restriction-rows')?.children ?? [])) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select  = row.querySelector('select');
        const val_input  = row.querySelector('input[type="number"]');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key = stat_input.dataset?.statKey;
        const value    = val_input.value.trim();
        if (!stat_key || !value) continue;
        entries.push(stat_key + ':' + op_select.value + ':' + value);
    }
    const restrictions_text = entries.join('|');

    // Combo text
    let combo_text = '';
    if (typeof solver_combo_total_node !== 'undefined' && solver_combo_total_node) {
        const data = solver_combo_total_node._read_rows_as_data();
        if (data.length > 0) combo_text = combo_data_to_text(data);
    }

    return { roll, sfree, dir_enabled, lvl_min, lvl_max, nomaj, gtome, dtime, ctime,
             restrictions_text, combo_text };
}
