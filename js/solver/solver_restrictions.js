// ── Restrictions ──────────────────────────────────────────────────────────────

/**
 * Toggles a build-direction SP type on/off.
 * When off, items requiring that SP type will be excluded by the Phase 6 solver.
 */
function toggle_build_dir(sp) {
    const btn = document.getElementById('dir-' + sp);
    if (btn) btn.classList.toggle('toggleOn');
    // User has explicitly chosen — remove from auto tracking so the auto-check
    // no longer controls this direction.
    _auto_disabled_dirs.delete(sp);
    _dir_user_overrides.add(sp);
    _schedule_restrictions_url_update();
}

// ── Auto build-direction ─────────────────────────────────────────────────────

/**
 * SP types currently auto-disabled based on locked-item analysis.
 * Cleared when the user manually toggles a direction or resets the solver.
 */
const _auto_disabled_dirs = new Set();

/**
 * SP types where the user has manually toggled after the auto-check acted.
 * Once a direction is in this set the auto logic will not touch it again
 * (until a solver reset).
 */
const _dir_user_overrides = new Set();

let _auto_dir_timer = null;

/**
 * Debounced trigger for auto_update_build_directions (150 ms).
 * Passing reset_overrides = true clears user overrides so every direction
 * is re-evaluated from scratch (used when items change).
 */
function _schedule_auto_dir_update(reset_overrides = false) {
    if (reset_overrides) _dir_user_overrides.clear();
    clearTimeout(_auto_dir_timer);
    _auto_dir_timer = setTimeout(auto_update_build_directions, 150);
}

/**
 * Examines locked items + weapon to auto-toggle build-direction buttons.
 * If the net skillpoint provision for an SP type is negative across all locked
 * equipment, that direction is auto-disabled (items requiring it are excluded
 * from the search pool).  Directions the user has manually toggled are never
 * touched.
 */
function auto_update_build_directions() {
    const sp_sums = [0, 0, 0, 0, 0];
    let has_locked = false;

    // Weapon (index 8, always locked)
    if (typeof solver_item_final_nodes !== 'undefined' && solver_item_final_nodes[8]) {
        const weapon = solver_item_final_nodes[8].value;
        if (weapon && !weapon.statMap.has('NONE')) {
            has_locked = true;
            const skp = weapon.statMap.get('skillpoints') ?? [0, 0, 0, 0, 0];
            for (let i = 0; i < 5; i++) sp_sums[i] += skp[i] ?? 0;
        }
    }

    // Locked armor / accessory items (indices 0-7)
    if (typeof solver_item_final_nodes !== 'undefined') {
        for (let i = 0; i < 8; i++) {
            const node = solver_item_final_nodes[i];
            const item = node?.value;
            if (!item || item.statMap.has('NONE')) continue;
            const input = document.getElementById(equipment_fields[i] + '-choice');
            if (input?.dataset.solverFilled === 'true') continue; // free slot
            has_locked = true;
            const skp = item.statMap.get('skillpoints') ?? [0, 0, 0, 0, 0];
            for (let j = 0; j < 5; j++) sp_sums[j] += skp[j] ?? 0;
        }
    }

    if (!has_locked) return; // nothing to base decisions on

    const sp_keys = ['str', 'dex', 'int', 'def', 'agi'];
    let changed = false;
    for (let i = 0; i < 5; i++) {
        const sp = sp_keys[i];
        if (_dir_user_overrides.has(sp)) continue; // user took manual control

        const btn = document.getElementById('dir-' + sp);
        if (!btn) continue;

        if (sp_sums[i] < 0) {
            // Auto-disable if currently enabled
            if (btn.classList.contains('toggleOn')) {
                btn.classList.remove('toggleOn');
                _auto_disabled_dirs.add(sp);
                changed = true;
            }
        } else {
            // Re-enable only if we previously auto-disabled it
            if (_auto_disabled_dirs.has(sp)) {
                btn.classList.add('toggleOn');
                _auto_disabled_dirs.delete(sp);
                changed = true;
            }
        }
    }

    if (changed) _schedule_restrictions_url_update();
}

/**
 * Toggles the No-Major-ID filter button and schedules a URL update.
 */
function toggle_no_major_id() {
    const btn = document.getElementById('restr-no-major-id');
    if (btn) btn.classList.toggle('toggleOn');
    _schedule_restrictions_url_update();
}

let _restriction_row_counter = 0;

/**
 * Appends a new stat threshold row to the restrictions panel.
 */
function restriction_add_row() {
    const container = document.getElementById('restriction-rows');
    if (!container) return null;
    const idx = ++_restriction_row_counter;
    const row = document.createElement('div');
    row.id = 'restr-row-' + idx;
    row.className = 'combo-row d-flex align-items-center gap-1';
    row.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary px-1"
                style="min-width:1.6em; font-size:0.8em; flex-shrink:0;"
                onclick="restriction_remove_row(this)" title="Remove restriction">×</button>
        <input class="combo-row-input flex-grow-1 restr-stat-input"
               id="restr-stat-${idx}"
               placeholder="Stat..." autocomplete="off" style="min-width:0;">
        <select class="solver-select form-select form-select-sm"
                style="width:3.5em; flex-shrink:0; padding-left:0.3rem; padding-right:1.25rem;">
            <option value="ge">≥</option>
            <option value="le">≤</option>
        </select>
        <input type="number" class="combo-row-input"
               placeholder="0" style="width:4.5em; text-align:center; flex-shrink:0;">
    `;
    container.appendChild(row);
    _init_restriction_stat_autocomplete('restr-stat-' + idx);
    // Wire all inputs for URL persistence
    for (const inp of row.querySelectorAll('input, select')) {
        inp.addEventListener('change', _schedule_restrictions_url_update);
        inp.addEventListener('input',  _schedule_restrictions_url_update);
    }
    return row;
}

/**
 * Removes a restriction row when the × button is clicked.
 */
function restriction_remove_row(btn) {
    const row = btn.closest('[id^="restr-row-"]');
    if (row) row.remove();
    _schedule_restrictions_url_update();
}

/**
 * Sets up autoComplete.js on a stat restriction input field.
 * Searches by display label; stores the matching stat key in dataset.statKey.
 */
function _init_restriction_stat_autocomplete(input_id) {
    new autoComplete({
        data: { src: RESTRICTION_STATS.map(s => s.label) },
        selector: '#' + input_id,
        wrapper: false,
        resultsList: {
            maxResults: 60,
            tabSelect: true,
            noResults: true,
            class: 'search-box dark-7 rounded-bottom px-2 fw-bold dark-shadow-sm',
            element: (list, data) => {
                const inp = document.getElementById(input_id);
                if (!inp) return;
                const rect = inp.getBoundingClientRect();
                list.style.top   = (rect.bottom + window.scrollY) + 'px';
                list.style.left  = rect.x + 'px';
                list.style.width = Math.max(rect.width, 200) + 'px';
                if (!data.results.length) {
                    const msg = document.createElement('li');
                    msg.classList.add('scaled-font');
                    msg.textContent = 'No results found!';
                    list.prepend(msg);
                }
            },
        },
        resultItem: {
            class: 'scaled-font search-item',
            selected: 'dark-5',
        },
        events: {
            input: {
                selection: (event) => {
                    const val = event.detail.selection.value;
                    if (val) {
                        event.target.value = val;
                        const stat = RESTRICTION_STATS.find(s => s.label === val);
                        if (stat) event.target.dataset.statKey = stat.key;
                    }
                    event.target.dispatchEvent(new Event('change'));
                },
            },
        },
    });
}

/**
 * Returns the current restriction state as a plain object.
 * Called by the Phase 6 solver core when initiating a search.
 *
 * @returns {{
 *   build_dir: Object<string, boolean>,
 *   lvl_min: number,
 *   lvl_max: number,
 *   no_major_id: boolean,
 *   guild_tome: number,   // 0 = off, 1 = standard (+4 SP), 2 = rare (+5 SP)
 *   stat_thresholds: Array<{stat: string, op: string, value: number}>
 * }}
 */
function get_restrictions() {
    const build_dir = {};
    for (const sp of ['str', 'dex', 'int', 'def', 'agi']) {
        const btn = document.getElementById('dir-' + sp);
        build_dir[sp] = btn ? btn.classList.contains('toggleOn') : true;
    }

    const lvl_min    = parseInt(document.getElementById('restr-lvl-min')?.value) || 1;
    const lvl_max    = parseInt(document.getElementById('restr-lvl-max')?.value) || MAX_PLAYER_LEVEL;
    const no_major_id = document.getElementById('restr-no-major-id')?.classList.contains('toggleOn') ?? false;
    const guild_tome  = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;

    const stat_thresholds = [];
    for (const row of (document.getElementById('restriction-rows')?.children ?? [])) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select  = row.querySelector('select');
        const val_input  = row.querySelector('input[type="number"]');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key   = stat_input.dataset?.statKey || null;
        const stat_label = stat_input.value.trim();
        const value      = parseFloat(val_input.value);
        if ((!stat_key && !stat_label) || isNaN(value)) continue;
        stat_thresholds.push({
            stat:  stat_key || stat_label,
            op:    op_select.value,   // 'ge' (≥) or 'le' (≤)
            value,
        });
    }

    return { build_dir, lvl_min, lvl_max, no_major_id, guild_tome, stat_thresholds };
}

// ── Restrictions URL persistence ──────────────────────────────────────────────

let _restrictions_url_timer = null;

/** Debounced: schedules a restriction URL update 300 ms from now. */
function _schedule_restrictions_url_update() {
    clearTimeout(_restrictions_url_timer);
    _restrictions_url_timer = setTimeout(_do_restrictions_url_update, 300);
}

/**
 * Encodes the current restriction panel state into URL query params and calls
 * replaceState so the browser URL reflects the full solver configuration.
 *
 * Encoding:
 *   dir    = comma-separated disabled SP types  (omitted when all enabled)
 *   lvlmin = min item level                     (omitted when 1 / empty)
 *   lvlmax = max item level                     (omitted when MAX_PLAYER_LEVEL / empty)
 *   nomaj  = '1' when No-Major-ID is active     (omitted otherwise)
 *   gtome  = '1' or '2'                         (omitted when Off / 0)
 *   restr  = pipe-separated key:op:value rows   (omitted when none)
 */
function _do_restrictions_url_update() {
    const url = new URL(window.location.href);

    // Build direction — store only disabled types
    const disabled_dirs = [];
    for (const sp of ['str', 'dex', 'int', 'def', 'agi']) {
        const btn = document.getElementById('dir-' + sp);
        if (btn && !btn.classList.contains('toggleOn')) disabled_dirs.push(sp);
    }
    if (disabled_dirs.length > 0) {
        url.searchParams.set('dir', disabled_dirs.join(','));
    } else {
        url.searchParams.delete('dir');
    }

    // Level range
    const lvl_min_raw = document.getElementById('restr-lvl-min')?.value?.trim() ?? '';
    const lvl_max_raw = document.getElementById('restr-lvl-max')?.value?.trim() ?? '';
    if (lvl_min_raw && lvl_min_raw !== '1') {
        url.searchParams.set('lvlmin', lvl_min_raw);
    } else {
        url.searchParams.delete('lvlmin');
    }
    if (lvl_max_raw && lvl_max_raw !== String(MAX_PLAYER_LEVEL)) {
        url.searchParams.set('lvlmax', lvl_max_raw);
    } else {
        url.searchParams.delete('lvlmax');
    }

    // No Major ID toggle
    const no_maj = document.getElementById('restr-no-major-id')?.classList.contains('toggleOn') ?? false;
    if (no_maj) {
        url.searchParams.set('nomaj', '1');
    } else {
        url.searchParams.delete('nomaj');
    }

    // Guild tome
    const gtome_val = document.getElementById('restr-guild-tome')?.value ?? '0';
    if (gtome_val !== '0') {
        url.searchParams.set('gtome', gtome_val);
    } else {
        url.searchParams.delete('gtome');
    }

    // Stat threshold rows
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
    if (entries.length > 0) {
        url.searchParams.set('restr', entries.join('|'));
    } else {
        url.searchParams.delete('restr');
    }

    window.history.replaceState(null, '', url.toString());
}
