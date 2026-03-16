// ── Copy build to WynnBuilder ─────────────────────────────────────────────────

/**
 * Copies a WynnBuilder URL for the current build to the clipboard.
 * The solver and builder share the same binary hash format, so we just
 * swap /solver/ for /builder/ in the path.
 */
function copy_build_to_wynnbuilder() {
    const hash = window.location.hash;
    if (!hash || hash === '#' || hash.length <= 1) {
        const btn = document.getElementById('copy-to-builder-btn');
        if (btn) {
            const orig = btn.textContent;
            btn.textContent = 'No build!';
            setTimeout(() => { btn.textContent = orig; }, 1500);
        }
        return;
    }
    // Strip solver section after '_' separator — builder doesn't need it.
    let build_hash = hash;
    const sep = hash.indexOf(SOLVER_HASH_SEP);
    if (sep >= 0) build_hash = hash.substring(0, sep);
    const builder_url = window.location.origin + SITE_BASE + '/builder/' + build_hash;
    navigator.clipboard.writeText(builder_url)
        .then(() => {
            const btn = document.getElementById('copy-to-builder-btn');
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = orig; }, 1500);
            }
        })
        .catch(() => {
            prompt('Copy this WynnBuilder URL:', builder_url);
        });
}

// ── Copy solver URL ───────────────────────────────────────────────────────────

/**
 * Copies the current WynnSolver URL (with hash) to the clipboard.
 */
function copy_solver_url() {
    const url = window.location.href;
    const btn = document.getElementById('copy-solver-url-btn');
    navigator.clipboard.writeText(url)
        .then(() => {
            if (btn) {
                const orig = btn.textContent;
                btn.textContent = 'Copied!';
                setTimeout(() => { btn.textContent = orig; }, 1500);
            }
        })
        .catch(() => {
            prompt('Copy this WynnSolver URL:', url);
        });
}

// ── Roll mode selection ───────────────────────────────────────────────────────

/**
 * Syncs the main roll input display and all popup sub-inputs
 * to match the current_roll_mode object.
 */
function _syncRollUI() {
    const inp = document.getElementById('roll-mode-input');
    if (inp && document.activeElement !== inp) inp.value = rollDisplayText();
    // Sync popup sub-inputs
    for (const g of ROLL_GROUP_ORDER) {
        const sub = document.getElementById('roll-group-' + g);
        if (sub && document.activeElement !== sub) sub.value = current_roll_mode[g];
    }
    // Sync "All" input: show value if uniform, clear otherwise
    const allInp = document.getElementById('roll-group-all');
    if (allInp && document.activeElement !== allInp) {
        allInp.value = _isRollUniform() ? current_roll_mode.damage : '';
    }
}

/** Whether roll values have been edited since last graph recomputation. */
let _roll_dirty = false;

/**
 * Flushes pending roll changes: re-evaluates item nodes and updates URL.
 * Called when the popup closes, or when the main input is committed (blur/Enter).
 */
function _flushRollChanges() {
    if (!_roll_dirty) return;
    _roll_dirty = false;
    if (typeof solver_equip_input_nodes !== 'undefined') {
        for (const node of solver_equip_input_nodes) node.mark_dirty();
        for (const node of solver_equip_input_nodes) node.update();
    }
    _schedule_solver_hash_update();
}

/**
 * Updates current_roll_mode values and syncs UI text (cheap).
 * The expensive graph recomputation is deferred until _flushRollChanges().
 */
function _rollModeChanged() {
    _roll_dirty = true;
    _syncRollUI();
}

/**
 * Sets ALL roll groups to the same percentage (0-100).
 * Called when the user types a number into the main input or the "All" sub-input.
 */
function setRollMode(pct) {
    pct = Math.max(0, Math.min(100, parseInt(pct) || 0));
    for (const g of ROLL_GROUP_ORDER) current_roll_mode[g] = pct;
    _rollModeChanged();
}

/**
 * Sets a single roll group's percentage (0-100).
 */
function setRollGroupMode(group, pct) {
    pct = Math.max(0, Math.min(100, parseInt(pct) || 0));
    current_roll_mode[group] = pct;
    _rollModeChanged();
}

// ── Roll group popup ─────────────────────────────────────────────────────────

let _roll_popup_open = false;

function toggleRollGroupPopup() {
    const popup = document.getElementById('roll-group-popup');
    if (!popup) return;
    if (_roll_popup_open) {
        // Closing — flush any pending changes
        _closeRollGroupPopup();
        return;
    }
    _roll_popup_open = true;
    popup.style.display = '';
    _syncRollUI();
}

function _closeRollGroupPopup() {
    if (!_roll_popup_open) return;
    _roll_popup_open = false;
    const popup = document.getElementById('roll-group-popup');
    if (popup) popup.style.display = 'none';
    _syncRollUI();
    _flushRollChanges();
}

// Close popup on click outside or Escape
document.addEventListener('mousedown', (e) => {
    if (!_roll_popup_open) return;
    const popup = document.getElementById('roll-group-popup');
    const inp = document.getElementById('roll-mode-input');
    if (popup && !popup.contains(e.target) && e.target !== inp) {
        _closeRollGroupPopup();
    }
});
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && _roll_popup_open) _closeRollGroupPopup();
});

/**
 * Focus handler for the main roll input.
 * Clears "Default"/"Custom" so user can type a number.
 */
function rollInputFocus(el) {
    const txt = el.value;
    if (txt === 'Default' || txt === 'Custom') {
        el.value = '';
    } else {
        el.value = txt.replace('%', '');
    }
}

/**
 * Blur handler for the main roll input.
 * If a number was entered, set all groups and flush immediately.
 * Otherwise revert to display text.
 */
function rollInputBlur(el) {
    const val = el.value.trim();
    if (val !== '' && !isNaN(parseInt(val))) {
        setRollMode(val);
        _flushRollChanges();
    } else {
        el.value = rollDisplayText();
    }
}

// ── Exclusive panel toggle (Tomes / Ability Tree / Aspects) ──────────────────

const SOLVER_PANELS = ["tomes-dropdown", "atree-dropdown", "aspects-dropdown"];
const SOLVER_PANEL_BTNS = {
    "tomes-dropdown": "toggle-tomes",
    "atree-dropdown": "toggle-atree",
    "aspects-dropdown": "toggle-aspects",
};

/**
 * Ensures the given panel is shown (no toggle) and hides the others.
 * Used by shared code (e.g. atree.js) that needs to guarantee a panel is open.
 */
function ensureSolverPanel(panelId) {
    for (const p of SOLVER_PANELS) {
        const el = document.getElementById(p);
        if (el) el.style.display = "none";
        const btn = document.getElementById(SOLVER_PANEL_BTNS[p]);
        if (btn) btn.classList.remove("selected-btn");
    }
    const panel = document.getElementById(panelId);
    if (panel) panel.style.display = "";
    const btn = document.getElementById(SOLVER_PANEL_BTNS[panelId]);
    if (btn) btn.classList.add("selected-btn");
}

/**
 * Shows the given panel and hides the others. Clicking the same panel's button
 * a second time collapses it (toggle behaviour).
 */
function showExclusivePanel(panelId) {
    const panel = document.getElementById(panelId);
    const isVisible = panel && panel.style.display !== "none";

    // Collapse all panels and deactivate all buttons
    for (const p of SOLVER_PANELS) {
        const el = document.getElementById(p);
        if (el) el.style.display = "none";
        const btn = document.getElementById(SOLVER_PANEL_BTNS[p]);
        if (btn) btn.classList.remove("selected-btn");
    }

    // Open requested panel (unless it was already open — toggle off)
    if (!isVisible) {
        if (panel) panel.style.display = "";
        const btn = document.getElementById(SOLVER_PANEL_BTNS[panelId]);
        if (btn) btn.classList.add("selected-btn");
    }
}

// ── Tooltip toggle ────────────────────────────────────────────────────────────

/**
 * Toggles the visibility of an item tooltip div.
 * Called when the user clicks on an equipment slot row.
 */
function toggleItemTooltip(tooltip_id) {
    const el = document.getElementById(tooltip_id);
    if (!el) return;
    // Only show if it has content (empty after slot cleared)
    if (!el.innerHTML) return;
    // Use 'flex' to preserve Bootstrap row layout inside the tooltip (col children need a flex parent).
    const was_visible = el.style.display !== 'none' && el.style.display !== '';
    el.style.display = was_visible ? 'none' : 'flex';
    // Persist the slot highlight while the tooltip is visible.
    const eq = tooltip_id.replace('-tooltip', '');
    const dropdown = document.getElementById(eq + '-dropdown');
    if (dropdown) {
        dropdown.classList.toggle('slot-selected', !was_visible);
    }
}


// ── Slot lock toggle ─────────────────────────────────────────────────────────

/**
 * Toggles a filled equipment slot between locked (solver skips) and free
 * (solver searches).  Called when the user clicks the lock icon.
 * @param {number} i  Slot index into equipment_fields (0-7, weapon excluded).
 */
function toggleSlotLock(i) {
    const eq = equipment_fields[i];
    const input = document.getElementById(eq + '-choice');
    if (!input) return;

    const is_free = input.dataset.solverFilled === 'true';
    if (is_free) {
        // free → locked
        input.dataset.solverFilled = 'false';
        _solver_free_mask &= ~(1 << i);
    } else {
        // locked → free
        input.dataset.solverFilled = 'true';
        _solver_free_mask |= (1 << i);
    }
    _schedule_solver_hash_update();

    const now_free = !is_free;
    const has_item = !!input.value;

    // Update visuals on the slot row
    const dropdown = document.getElementById(eq + '-dropdown');
    if (dropdown) {
        dropdown.classList.remove('slot-locked', 'slot-solver', 'slot-unlocked');
        if (has_item) {
            dropdown.classList.add(now_free ? 'slot-solver' : 'slot-locked');
        } else {
            dropdown.classList.add(now_free ? 'slot-unlocked' : 'slot-locked');
        }
    }
    const lockEl = document.getElementById(eq + '-lock');
    if (lockEl) {
        lockEl.innerHTML = now_free ? UNLOCK_SVG : LOCK_SVG;
        lockEl.classList.toggle('solver-lock-free', now_free);
        lockEl.title = now_free
            ? 'Slot free \u2014 solver will search (click to lock)'
            : has_item
                ? 'Slot locked \u2014 solver will keep this item (click to unlock)'
                : 'Slot locked \u2014 solver will keep empty (click to unlock)';
    }
    _schedule_auto_dir_update(true);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

/**
 * Clears all solver inputs back to defaults and triggers a graph update.
 */
function resetSolverFields() {
    // Navigate to the bare page URL — a full reload guarantees every field,
    // graph node, atree, combo row, and display is back to its default state.
    window.location.href = window.location.pathname;
}

// ── Initialisation helpers ────────────────────────────────────────────────────

/** Restore solver-specific URL params (restrictions, rolls, directions, etc.). */
function _restore_from_url(solver_params) {
    if (!solver_params) return;

    // Roll groups (per-group roll percentages)
    if (solver_params.roll_groups) {
        Object.assign(current_roll_mode, solver_params.roll_groups);
        _syncRollUI();
    }

    // Build direction: disable any SP types not set in the bitmask
    const sp_keys = ['str', 'dex', 'int', 'def', 'agi'];
    const dir = solver_params.dir_enabled;
    if (dir !== undefined) {
        for (let i = 0; i < 5; i++) {
            if (!(dir & (1 << i))) {
                const btn = document.getElementById('dir-' + sp_keys[i]);
                if (btn) btn.classList.remove('toggleOn');
                _dir_user_overrides.add(sp_keys[i]);
            }
        }
    }

    // Level range
    if (solver_params.lvl_min && solver_params.lvl_min !== 1) {
        const inp = document.getElementById('restr-lvl-min');
        if (inp) inp.value = solver_params.lvl_min;
    }
    if (solver_params.lvl_max && solver_params.lvl_max !== MAX_PLAYER_LEVEL) {
        const inp = document.getElementById('restr-lvl-max');
        if (inp) inp.value = solver_params.lvl_max;
    }

    // No Major ID
    if (solver_params.nomaj) {
        const btn = document.getElementById('restr-no-major-id');
        if (btn) btn.classList.add('toggleOn');
    }

    // Guild tome
    if (solver_params.gtome) {
        const sel = document.getElementById('restr-guild-tome');
        if (sel) sel.value = String(solver_params.gtome);
    }

    // Stat threshold rows (binary: structured array of {stat_index, op, value})
    if (solver_params.restrictions && solver_params.restrictions.length > 0) {
        for (const r of solver_params.restrictions) {
            const stat_obj = RESTRICTION_STATS[r.stat_index];
            if (!stat_obj) continue;
            const row = restriction_add_row();
            if (!row) continue;
            const stat_input = row.querySelector('.restr-stat-input');
            const op_select = row.querySelector('select');
            const val_input = row.querySelector('.restr-value-input');
            if (stat_input) {
                stat_input.value = stat_obj.label;
                stat_input.dataset.statKey = stat_obj.key;
            }
            if (op_select) op_select.value = r.op === 1 ? 'le' : 'ge';
            if (val_input) val_input.value = r.value;
        }
    }

    // Blacklist rows (binary: array of item IDs)
    if (solver_params.blacklist_ids && solver_params.blacklist_ids.length > 0) {
        for (let item_id of solver_params.blacklist_ids) {
            // Follow redirectMap if this ID was remapped to a new one
            if (typeof redirectMap !== 'undefined' && redirectMap && redirectMap.has(item_id)) {
                item_id = redirectMap.get(item_id);
            }
            const name = idMap.get(item_id);
            if (!name || !itemMap.has(name)) continue;
            const row = blacklist_add_row();
            if (!row) continue;
            const input = row.querySelector('.bl-item-input');
            if (input) input.value = name;
        }
    }

    // Solver-free slot mask (explicit from URL — sets dataset for the default block below)
    if (solver_params.sfree !== undefined) {
        for (let i = 0; i < 8; i++) {
            const input = document.getElementById(equipment_fields[i] + '-choice');
            if (!input) continue;
            input.dataset.solverFilled = (solver_params.sfree & (1 << i)) ? 'true' : 'false';
        }
    }
}

/** Wire all event listeners for restriction inputs, equipment slots, tooltips, and locks. */
function _wire_event_listeners() {
    // Wire static restriction inputs so URL stays in sync as user edits them
    const restr_lvl_min = document.getElementById('restr-lvl-min');
    if (restr_lvl_min) restr_lvl_min.addEventListener('input', _schedule_solver_hash_update);
    const restr_lvl_max = document.getElementById('restr-lvl-max');
    if (restr_lvl_max) restr_lvl_max.addEventListener('input', _schedule_solver_hash_update);
    const restr_guild_tome = document.getElementById('restr-guild-tome');
    if (restr_guild_tome) restr_guild_tome.addEventListener('change', _schedule_solver_hash_update);

    // When the user manually edits an equipment slot, update its lock state.
    // Entering an item → locked (solver keeps it).
    // Clearing an item → free (solver will search this slot).
    for (let i = 0; i < 8; i++) {
        const input = document.getElementById(equipment_fields[i] + '-choice');
        if (!input) continue;
        input.addEventListener('change', () => {
            if (_solver_filling_ui) return;   // triggered by _fill_build_into_ui — keep flag
            _solver_sp_override = null;       // manual edit — revert to normal SP display
            if (input.value) {
                // Item entered — lock it
                input.dataset.solverFilled = 'false';
                _solver_free_mask &= ~(1 << i);
            } else {
                // Item cleared — default to free so solver will search
                input.dataset.solverFilled = 'true';
                _solver_free_mask |= (1 << i);
            }
            _schedule_solver_hash_update();
            _schedule_auto_dir_update(true);
        });
    }

    // Wire copy-to-builder button (belt-and-suspenders alongside HTML onclick).
    const _copy_btn = document.getElementById('copy-to-builder-btn');
    if (_copy_btn) _copy_btn.addEventListener('click', copy_build_to_wynnbuilder);

    // Wire tooltip click listeners on each equipment slot row
    for (const eq of equipment_keys) {
        const dropdown = document.getElementById(eq + '-dropdown');
        if (dropdown) {
            dropdown.addEventListener('click', () => toggleItemTooltip(eq + '-tooltip'));
        }
    }

    // Wire hover popups on item icons (desktop only)
    initItemHoverPopups(equipment_keys);
    initItemHoverPopups(tome_fields);

    // Wire lock toggle click listeners on each equipment slot (not weapon)
    for (let i = 0; i < 8; i++) {
        const eq = equipment_fields[i];
        const lockEl = document.getElementById(eq + '-lock');
        if (!lockEl) continue;
        lockEl.innerHTML = LOCK_SVG;   // default icon (hidden until slot is filled)
        lockEl.addEventListener('click', (e) => {
            e.stopPropagation();       // don't trigger tooltip toggle on the row
            toggleSlotLock(i);
        });
    }
}

/** Restore ability tree, skill points, and combo rows from URL state. */
function _restore_atree_and_combo(decoded_sp, solver_params) {
    // Restore ability tree from URL hash (mirrors builder_graph.js post-decode logic).
    // atree_data is set by decodeHash(); atree_node.value is set once the weapon populates
    // the class, which happens synchronously during solver_graph_init()'s update() cascade.
    //
    // atree_data is either a BitVector (same-version) or an Array of node IDs
    // (cross-version upgrade — decodeHash decoded bits against old tree structure).
    if (atree_data !== null && atree_node.value !== null) {
        if (atree_data.length > 0) {
            try {
                let active_nodes;
                if (Array.isArray(atree_data)) {
                    // Cross-version: match by ability ID
                    const id_set = new Set(atree_data);
                    active_nodes = atree_node.value.filter(n => id_set.has(n.ability.id));
                } else {
                    // Same version: positional BitVector decode
                    active_nodes = decodeAtree(atree_node.value, atree_data);
                }
                const state = atree_state_node.value;
                for (const node of active_nodes) {
                    atree_set_state(state.get(node.ability.id), true);
                }
                atree_state_node.mark_dirty().update();
            } catch (e) {
                console.error("[solver] Failed to decode atree:", e);
            }
        }
    }

    // Restore any manually-assigned skill points from the URL hash.
    // decodeHash() returns non-null when SP were encoded as ASSIGNED (e.g.,
    // greedy allocation from a previous solver search).  Merge the decoded
    // values with auto-calculated SP and set _solver_sp_override so the stat
    // pipeline and URL encoding preserve them across page reloads.
    if (decoded_sp && solver_build_node?.value) {
        const build = solver_build_node.value;
        const total_sp = decoded_sp.map((v, i) =>
            v !== null ? v : build.total_skillpoints[i]
        );
        const has_extra = total_sp.some((v, i) => v !== build.total_skillpoints[i]);
        if (has_extra) {
            const base_sp = build.base_skillpoints.map((v, i) =>
                v + (total_sp[i] - build.total_skillpoints[i])
            );
            _solver_sp_override = {
                base_sp,
                total_sp,
                assigned_sp: base_sp.reduce((a, b) => a + b, 0),
            };
            solver_build_node.mark_dirty(2).update();
        }
    }

    // Restore combo time, downtime toggle, and combo rows from solver params.
    if (solver_params) {
        if (solver_params.ctime) {
            const time_inp = document.getElementById('combo-time');
            if (time_inp) {
                time_inp.value = solver_params.ctime;
                time_inp.dataset.auto = 'false';  // URL-provided = manual
            }
        }

        if (solver_params.dtime) {
            const btn = document.getElementById('combo-downtime-btn');
            if (btn) btn.classList.add('toggleOn');
        }

        if (solver_params.flat_mana) {
            const inp = document.getElementById('flat-mana-input');
            if (inp) inp.value = solver_params.flat_mana;
        }

        if (solver_params.combo_rows && solver_params.combo_rows.length > 0 && solver_combo_total_node) {
            try {
                // atree_merge.value is available at this point (solver_graph_init ran,
                // atree was restored above).
                const atree_mg = (typeof atree_merge !== 'undefined' && atree_merge) ? atree_merge.value : null;

                const data = solver_params.combo_rows.map(r => {
                    const spell_name = node_id_to_spell_name(r.spell_node_id, atree_mg);
                    const spell_value = node_id_to_spell_value(r.spell_node_id);
                    const boost_parts = r.boosts.map(b => {
                        const name = node_ref_to_boost_name(b.node_id, b.effect_pos, atree_mg);
                        return b.has_value ? name + ' ' + b.value : name;
                    });
                    return {
                        qty: r.qty,
                        spell_name,
                        spell_value,
                        boost_tokens_text: boost_parts.join(', '),
                        mana_excl: r.mana_excl,
                        dmg_excl: r.dmg_excl,
                        hits: r.has_hits ? r.hits : undefined,
                    };
                });
                if (data.length > 0) {
                    solver_combo_total_node._write_rows_from_data(data);
                    solver_combo_total_node.mark_dirty().update();
                }
            } catch (e) { console.warn('[solver] combo restore failed:', e); }
        }
    }
}

// ── Initialisation ────────────────────────────────────────────────────────────

async function init() {

    // Disable thread count options that exceed the browser-reported logical CPU count.
    const hw = navigator.hardwareConcurrency;
    if (hw) {
        const tsel = document.getElementById('solver-thread-count');
        if (tsel) {
            for (const opt of tsel.options) {
                if (opt.value !== 'auto' && parseInt(opt.value) > hw) {
                    opt.disabled = true;
                    opt.title = `Your CPU reports ${hw} logical cores`;
                }
            }
        }
    }

    // decodeHash() loads all game data (items, tomes, aspects, atree, encoding constants)
    // and, when a URL hash is present, populates all input fields from the encoded build.
    let decoded_sp = null;
    try {
        decoded_sp = await decodeHash();
    } catch (e) {
        console.error("[solver] decodeHash failed:", e);
        return;
    }

    // Decode solver params from URL hash (after the '_' separator).
    const full_hash = window.location.hash.slice(1);
    const sep_idx = full_hash.indexOf(SOLVER_HASH_SEP);
    let solver_params = null;
    if (sep_idx >= 0) {
        try {
            solver_params = decodeSolverParams(full_hash.substring(sep_idx + 1));
        } catch (e) {
            console.warn('[solver] decodeSolverParams failed:', e);
        }
    }

    _restore_from_url(solver_params);

    // Default lock state for slots not set by URL: filled → locked, empty → free
    _solver_free_mask = 0;
    for (let i = 0; i < 8; i++) {
        const input = document.getElementById(equipment_fields[i] + '-choice');
        if (!input) continue;
        if (input.dataset.solverFilled === undefined || input.dataset.solverFilled === '') {
            if (input.value) {
                input.dataset.solverFilled = 'false';
            } else {
                input.dataset.solverFilled = 'true';
            }
        }
        if (input.dataset.solverFilled === 'true') _solver_free_mask |= (1 << i);
    }

    _wire_event_listeners();

    try {
        init_autocomplete();
    } catch (e) {
        console.error("[solver] init_autocomplete failed:", e, e.stack);
    }

    solver_graph_init();

    // Auto-disable build directions for SP types with negative net provision
    // across locked items.  Runs after graph init so item nodes have values.
    auto_update_build_directions();

    _restore_atree_and_combo(decoded_sp, solver_params);
}

window.onerror = function (message, source, lineno, colno, error) {
    const errBox = document.getElementById('err-box');
    const stackBox = document.getElementById('stack-box');
    if (errBox) errBox.textContent = message;
    if (stackBox) stackBox.textContent = error ? error.stack : "";
};

// Entry point — runs after all loaders complete
window.addEventListener('load', init);
