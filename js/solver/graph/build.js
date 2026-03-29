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
            if (assignEl) { assignEl.children[0].textContent = 'Assign: 0'; assignEl.children[1].textContent = ''; }
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
                if (assignEl) {
                    assignEl.children[0].textContent = `Assign: ${req}`;
                    assignEl.children[1].textContent = extra > 0 ? `(+${extra})` : '';
                }
            } else {
                if (totalEl)  totalEl.textContent  = build.total_skillpoints[i];
                if (assignEl) { assignEl.children[0].textContent = 'Assign: ' + build.base_skillpoints[i]; assignEl.children[1].textContent = ''; }
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
            let total  = has_override ? ov.assigned_sp : build.assigned_skillpoints;
            // Rainbow guild tome injects a synthetic [1,1,1,1,1] item whose +5 SP
            // count as *bonus* (not assigned).  For display consistency with Standard
            // tome (which inflates assigned SP by 4, showing "Remaining: -4"), add
            // the synthetic tome's +5 so Rainbow shows "Remaining: -5".
            const gt_idx = tome_fields.indexOf('guildTome1');
            const gt_val = (gt_idx >= 0) ? solver_item_final_nodes[9 + gt_idx]?.value : null;
            if (!gt_val || gt_val.statMap.has('NONE')) {
                const gtome_mode = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;
                if (gtome_mode === 2) total += 5;
            }
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
 */
function _do_solver_hash_update() {
    const build_b64 = _last_build_b64;
    if (!build_b64) return;

    const params = _collect_solver_params();

    try {
        const solver_b64 = encodeSolverParams(params);
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
    // Roll mode (per-group)
    const roll_groups = { ...current_roll_mode };

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

    // Calculate Mana toggle (default: ON = mana enabled)
    const mana_disabled = !(document.getElementById('combo-mana-btn')?.classList.contains('toggleOn') ?? true);

    // Allow Downtime
    const dtime = document.getElementById('combo-downtime-btn')?.classList.contains('toggleOn') ?? false;

    // Get atree_merged for spell/boost mapping
    const atree_mg = (typeof atree_merge !== 'undefined' && atree_merge) ? atree_merge.value : null;

    // Restrictions: structured [{stat_index, op, value}]
    const restrictions = [];
    for (const row of (document.getElementById('restriction-rows')?.children ?? [])) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select  = row.querySelector('select');
        const val_input  = row.querySelector('.restr-value-input');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key = stat_input.dataset?.statKey;
        const value    = val_input.value.trim();
        if (!stat_key || !value) continue;
        const stat_index = RESTRICTION_STATS.findIndex(s => s.key === stat_key);
        if (stat_index < 0) continue;
        restrictions.push({
            stat_index,
            op: op_select.value === 'le' ? 1 : 0,
            value: parseInt(value) || 0,
        });
    }

    // Combo rows: structured [{spell_node_id, qty, mana_excl, dmg_excl, boosts}]
    const combo_rows = [];
    if (typeof solver_combo_total_node !== 'undefined' && solver_combo_total_node) {
        for (const row of document.querySelectorAll('#combo-selection-rows .combo-row')) {
            const qty_raw = parseFloat(row.querySelector('.combo-row-qty')?.value) || 0;
            const spell_id = parseInt(row.querySelector('.combo-row-spell')?.value);
            if (isNaN(spell_id)) continue;

            const spell_node_id = spell_to_node_id(spell_id);

            const mana_excl = row.querySelector('.combo-mana-toggle')
                ?.classList.contains('mana-excluded') ?? false;
            const dmg_excl = row.querySelector('.combo-dmg-toggle')
                ?.classList.contains('dmg-excluded') ?? false;

            // Collect boosts
            const boosts = [];
            for (const btn of row.querySelectorAll('.combo-row-boost-toggle.toggleOn')) {
                const name = btn.dataset.boostName;
                if (!name) continue;
                const ref = boost_to_node_ref(name, atree_mg);
                boosts.push({ node_id: ref.node_id, effect_pos: ref.effect_pos, has_value: false, value: 0 });
            }
            for (const inp of row.querySelectorAll('.combo-row-boost-slider')) {
                if (inp.dataset.auto === 'true') continue;  // auto-filled values recompute on load
                const val = parseFloat(inp.value) || 0;
                if (val <= 0) continue;
                const name = inp.dataset.boostName;
                if (!name) continue;
                const ref = boost_to_node_ref(name, atree_mg);
                boosts.push({ node_id: ref.node_id, effect_pos: ref.effect_pos, has_value: true, value: Math.round(val) });
            }
            for (const inp of row.querySelectorAll('.combo-row-boost-calc')) {
                if (inp.dataset.auto === 'true') continue;  // auto-filled values recompute on load
                const val = parseFloat(inp.value) || 0;
                if (val <= 0) continue;
                const name = inp.dataset.boostName;
                if (!name) continue;
                const ref = boost_to_node_ref(name, atree_mg);
                boosts.push({ node_id: ref.node_id, effect_pos: ref.effect_pos, has_value: true, value: Math.round(val * 10) });
            }

            // DPS hits: read from the hits input in the boost area.
            const hits_inp = row.querySelector('.combo-row-hits');
            let has_hits = !!hits_inp;
            let hits = has_hits ? (parseFloat(hits_inp.value) || 0) : 0;

            // qty is stored as a 7-bit integer in the binary URL format.
            // When qty has a fractional part and no hits field is already
            // in use, stash the full fractional qty in the hits field so
            // it survives URL round-tripping.
            const qty = Math.round(qty_raw);
            if (!has_hits && qty_raw !== qty) {
                has_hits = true;
                hits = qty_raw;
            }

            // Per-row timing: only encode when delay was manually set.
            // Auto delays are build-dependent and recomputed on restore.
            let cast_time, delay;
            const spell = solver_combo_total_node._spell_map_cache?.get(spell_id);
            const is_cast_spell = spell && spell.cost != null
                && spell_id !== 0 && spell_id !== MANA_RESET_SPELL_ID
                && ![...STATE_CANCEL_IDS.values()].includes(spell_id);
            const is_melee = spell_id === 0;
            if (is_cast_spell) {
                const dl_inp = row.querySelector('.combo-row-delay');
                if (dl_inp?.dataset.auto === 'false') {
                    const ct_inp = row.querySelector('.combo-row-cast-time');
                    cast_time = ct_inp ? parseFloat(ct_inp.value) : SPELL_CAST_TIME;
                    delay = parseFloat(dl_inp.value);
                }
            } else if (is_melee) {
                const dl_inp = row.querySelector('.combo-row-delay');
                if (dl_inp?.dataset.auto === 'false') {
                    cast_time = 0;
                    delay = parseFloat(dl_inp.value) || SPELL_CAST_DELAY;
                }
            }

            combo_rows.push({ spell_node_id, qty, mana_excl, dmg_excl, has_hits, hits, boosts, cast_time, delay });
        }
    }

    // Blacklist: item IDs
    const blacklist_ids = [];
    for (const row of (document.getElementById('blacklist-rows')?.children ?? [])) {
        if (!row.id?.startsWith('bl-row-')) continue;
        const input = row.querySelector('.bl-item-input');
        const name = input?.value.trim();
        if (!name || !itemMap.has(name)) continue;
        const item = itemMap.get(name);
        if (item && item.id !== undefined) {
            blacklist_ids.push(item.id);
        }
    }

    return { roll_groups, sfree, dir_enabled, lvl_min, lvl_max, nomaj, gtome, dtime, mana_disabled,
             restrictions, combo_rows, blacklist_ids };
}
