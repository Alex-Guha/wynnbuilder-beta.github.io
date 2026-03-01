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
    const builder_url = window.location.origin + SITE_BASE + '/builder/' + hash;
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
 * Sets the active roll mode and syncs the dropdown UI.
 */
function setRollMode(mode) {
    current_roll_mode = mode;
    const sel = document.getElementById('roll-mode-select');
    if (sel) sel.value = mode;

    // Re-evaluate all item nodes so Build picks up the new rolled values.
    if (typeof solver_equip_input_nodes !== 'undefined') {
        for (const node of solver_equip_input_nodes) {
            node.mark_dirty().update();
        }
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
    if (!input || !input.value) return;             // empty slot — nothing to toggle

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
    _write_sfree_url();

    // Update visuals on the slot row
    const dropdown = document.getElementById(eq + '-dropdown');
    if (dropdown) {
        dropdown.classList.remove('slot-locked', 'slot-solver');
        dropdown.classList.add(is_free ? 'slot-locked' : 'slot-solver');
    }
    const lockEl = document.getElementById(eq + '-lock');
    if (lockEl) {
        const now_free = !is_free;
        lockEl.innerHTML = now_free ? UNLOCK_SVG : LOCK_SVG;
        lockEl.classList.toggle('solver-lock-free', now_free);
        lockEl.title = now_free ? 'Slot free \u2014 solver will search (click to lock)' :
            'Slot locked \u2014 solver will keep this item (click to unlock)';
    }
    _schedule_auto_dir_update(true);
}

// ── Reset ─────────────────────────────────────────────────────────────────────

/**
 * Clears all solver inputs back to defaults and triggers a graph update.
 */
function resetSolverFields() {
    for (const i of equipment_inputs) setValue(i, "");
    for (const i of powder_inputs) setValue(i, "");
    for (const i of tomeInputs) setValue(i, "");
    for (const i of aspectInputs) setValue(i, "");
    for (const i of aspectTierInputs) setValue(i, "");

    // Reset boost buttons
    for (const [key] of damageMultipliers) {
        const btn = document.getElementById(key + "-boost");
        if (btn) btn.classList.remove("toggleOn");
    }

    // Reset Allow Downtime toggle
    const downtime_btn = document.getElementById('combo-downtime-btn');
    if (downtime_btn) downtime_btn.classList.remove('toggleOn');

    setValue("level-choice", String(MAX_PLAYER_LEVEL));
    setRollMode(ROLL_MODES.MAX);

    // Re-propagate graph to clear displays
    if (solver_equip_input_nodes.length) {
        for (const node of solver_equip_input_nodes) {
            node.mark_dirty().update();
        }
    }
    if (typeof solver_boosts_node !== 'undefined') {
        solver_boosts_node.mark_dirty().update();
    }

    // Reset restriction panel to defaults
    _auto_disabled_dirs.clear();
    _dir_user_overrides.clear();
    for (const sp of ['str', 'dex', 'int', 'def', 'agi']) {
        const btn = document.getElementById('dir-' + sp);
        if (btn) btn.classList.add('toggleOn');
    }
    const lvl_min_inp = document.getElementById('restr-lvl-min');
    if (lvl_min_inp) lvl_min_inp.value = '';
    const lvl_max_inp = document.getElementById('restr-lvl-max');
    if (lvl_max_inp) lvl_max_inp.value = String(MAX_PLAYER_LEVEL);
    const no_maj_btn = document.getElementById('restr-no-major-id');
    if (no_maj_btn) no_maj_btn.classList.remove('toggleOn');
    const guild_sel = document.getElementById('restr-guild-tome');
    if (guild_sel) guild_sel.value = '0';
    const restr_container = document.getElementById('restriction-rows');
    if (restr_container) restr_container.innerHTML = '';

    // Flush restriction URL params immediately (synchronous, no debounce)
    _do_restrictions_url_update();

    location.hash = "";
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

    // Restore roll mode and combo from URL query params (solver-specific; not in the binary hash).
    const urlParams = new URLSearchParams(window.location.search);
    const urlRoll = urlParams.get('roll');
    if (urlRoll && Object.values(ROLL_MODES).includes(urlRoll)) {
        current_roll_mode = urlRoll;
        const sel = document.getElementById('roll-mode-select');
        if (sel) sel.value = urlRoll;
    }

    // ── Restore restriction panel state from URL params ───────────────────────

    // Build direction: re-disable any SP types listed in 'dir'
    const urlDir = urlParams.get('dir');
    if (urlDir) {
        for (const sp of urlDir.split(',')) {
            const trimmed = sp.trim();
            const btn = document.getElementById('dir-' + trimmed);
            if (btn) btn.classList.remove('toggleOn');
            _dir_user_overrides.add(trimmed); // treat URL-persisted as user choice
        }
    }

    // Level range
    const urlLvlMin = urlParams.get('lvlmin');
    if (urlLvlMin) {
        const inp = document.getElementById('restr-lvl-min');
        if (inp) inp.value = urlLvlMin;
    }
    const urlLvlMax = urlParams.get('lvlmax');
    if (urlLvlMax) {
        const inp = document.getElementById('restr-lvl-max');
        if (inp) inp.value = urlLvlMax;
    }

    // No Major ID
    if (urlParams.get('nomaj') === '1') {
        const btn = document.getElementById('restr-no-major-id');
        if (btn) btn.classList.add('toggleOn');
    }

    // Guild tome
    const urlGtome = urlParams.get('gtome');
    if (urlGtome) {
        const sel = document.getElementById('restr-guild-tome');
        if (sel) sel.value = urlGtome;
    }

    // Stat threshold rows
    const urlRestr = urlParams.get('restr');
    if (urlRestr) {
        for (const entry of urlRestr.split('|')) {
            const parts = entry.split(':');
            if (parts.length < 3) continue;
            const stat_key = parts[0];
            const op = parts[1];
            const value = parts.slice(2).join(':');
            const stat_obj = RESTRICTION_STATS.find(s => s.key === stat_key);
            if (!stat_obj) continue;
            const row = restriction_add_row();
            if (!row) continue;
            const stat_input = row.querySelector('.restr-stat-input');
            const op_select = row.querySelector('select');
            const val_input = row.querySelector('input[type="number"]');
            if (stat_input) {
                stat_input.value = stat_obj.label;
                stat_input.dataset.statKey = stat_key;
            }
            if (op_select && (op === 'ge' || op === 'le')) op_select.value = op;
            if (val_input) val_input.value = value;
        }
    }

    // Wire static restriction inputs so URL stays in sync as user edits them
    const restr_lvl_min = document.getElementById('restr-lvl-min');
    if (restr_lvl_min) restr_lvl_min.addEventListener('input', _schedule_restrictions_url_update);
    const restr_lvl_max = document.getElementById('restr-lvl-max');
    if (restr_lvl_max) restr_lvl_max.addEventListener('input', _schedule_restrictions_url_update);
    const restr_guild_tome = document.getElementById('restr-guild-tome');
    if (restr_guild_tome) restr_guild_tome.addEventListener('change', _schedule_restrictions_url_update);

    // Restore solver-free slot mask from ?sfree=N param.
    // This lets a reloaded page know which slots were filled by the solver (free targets)
    // vs manually entered (locked) when the URL was shared or bookmarked.
    const urlSfree = parseInt(urlParams.get('sfree') ?? '0', 10);
    if (urlSfree) {
        _solver_free_mask = urlSfree;
        for (let i = 0; i < 8; i++) {
            if (urlSfree & (1 << i)) {
                const input = document.getElementById(equipment_fields[i] + '-choice');
                if (input) input.dataset.solverFilled = 'true';
            }
        }
    }

    // When the user manually edits an equipment slot, revert it to locked.
    // This handles both solver-filled and user-toggled-free slots.
    for (let i = 0; i < 8; i++) {
        const input = document.getElementById(equipment_fields[i] + '-choice');
        if (!input) continue;
        input.addEventListener('change', () => {
            if (_solver_filling_ui) return;   // triggered by _fill_build_into_ui — keep flag
            _solver_sp_override = null;       // manual edit — revert to normal SP display
            input.dataset.solverFilled = 'false';
            _solver_free_mask &= ~(1 << i);
            _write_sfree_url();
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

    try {
        init_autocomplete();
    } catch (e) {
        console.error("[solver] init_autocomplete failed:", e, e.stack);
    }

    solver_graph_init();

    // Auto-disable build directions for SP types with negative net provision
    // across locked items.  Runs after graph init so item nodes have values.
    auto_update_build_directions();

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

    // Restore combo time field from URL (must be before combo node update so mana display is correct).
    const urlCtime = urlParams.get('ctime');
    if (urlCtime) {
        const time_inp = document.getElementById('combo-time');
        if (time_inp) time_inp.value = urlCtime;
    }

    // Restore Allow Downtime toggle.
    if (urlParams.get('dtime') === '1') {
        const btn = document.getElementById('combo-downtime-btn');
        if (btn) btn.classList.add('toggleOn');
    }

    // Restore combo rows from URL query param (async: may be compressed).
    const urlCombo = urlParams.get('combo');
    if (urlCombo && typeof combo_decode_from_url !== 'undefined' && solver_combo_total_node) {
        try {
            const text = await combo_decode_from_url(urlCombo);
            const data = combo_text_to_data(text);
            if (data.length > 0) {
                solver_combo_total_node._write_rows_from_data(data);
                solver_combo_total_node.mark_dirty().update();
            }
        } catch (e) { console.warn('[solver] combo URL restore failed:', e); }
    }
}

window.onerror = function (message, source, lineno, colno, error) {
    const errBox = document.getElementById('err-box');
    const stackBox = document.getElementById('stack-box');
    if (errBox) errBox.textContent = message;
    if (stackBox) stackBox.textContent = error ? error.stack : "";
};

// Entry point — runs after all loaders complete
window.addEventListener('load', init);
