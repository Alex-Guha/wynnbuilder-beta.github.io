// ── Numeric suffix parsing (k = ×1000, m = ×1000000) ────────────────────────

/**
 * Parses a numeric string that may end with 'k' (×1,000) or 'm' (×1,000,000).
 * Returns NaN if the string is not a valid number (after stripping the suffix).
 */
function _parse_suffixed_number(raw) {
    raw = raw.trim().toLowerCase();
    if (raw === '') return NaN;
    let multiplier = 1;
    if (raw.endsWith('m')) { multiplier = 1_000_000; raw = raw.slice(0, -1); }
    else if (raw.endsWith('k')) { multiplier = 1_000; raw = raw.slice(0, -1); }
    const num = parseFloat(raw);
    return isNaN(num) ? NaN : num * multiplier;
}

/**
 * On blur, resolves k/m suffixes in a text input to their full numeric value.
 */
function _wire_suffix_parse(input) {
    const resolve = () => {
        const raw = input.value.trim().toLowerCase();
        if (!raw) return;
        if (raw.endsWith('k') || raw.endsWith('m')) {
            const num = _parse_suffixed_number(raw);
            if (!isNaN(num)) input.value = num;
        }
    };
    input.addEventListener('blur', resolve);
    input.addEventListener('change', resolve);
}

// ── Encoding-limit input validation ──────────────────────────────────────────

/**
 * Clamps a numeric input's value to [min_val, max_val] on blur.
 * If the value was capped, adds a warning class + tooltip; otherwise removes it.
 * Also enforces the cap eagerly on 'input' events so the user sees it immediately.
 */
function _wire_encoding_cap(input, min_val, max_val) {
    // Set native HTML min/max so the browser's built-in validation stays in sync
    // with the JS constants (single source of truth in constants.js).
    if (input.type === 'number') {
        input.min = String(min_val);
        input.max = String(max_val);
    }
    const enforce = () => {
        const raw = input.value.trim();
        if (raw === '') { input.classList.remove('encoding-capped'); input.title = ''; return; }
        const num = parseFloat(raw);
        if (isNaN(num)) return;
        // Read limits from DOM attributes so callers can update them dynamically.
        const cur_max = parseFloat(input.max);
        const cur_min = parseFloat(input.min);
        if (num > cur_max) {
            input.value = cur_max;
            input.classList.add('encoding-capped');
            input.title = `Capped at ${cur_max.toLocaleString()} (encoding limit)`;
        } else if (num < cur_min) {
            input.value = cur_min;
            input.classList.add('encoding-capped');
            input.title = `Capped at ${cur_min.toLocaleString()} (encoding limit)`;
        } else {
            input.classList.remove('encoding-capped');
            input.title = '';
        }
    };
    input.addEventListener('change', enforce);
    input.addEventListener('blur', enforce);
}

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
    _schedule_solver_hash_update();
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
            // Re-enable if currently disabled (covers both auto-disabled and
            // previously user-disabled directions whose overrides were cleared).
            if (!btn.classList.contains('toggleOn')) {
                btn.classList.add('toggleOn');
                _auto_disabled_dirs.delete(sp);
                changed = true;
            }
        }
    }

    if (changed) _schedule_solver_hash_update();
}

/**
 * Toggles the No-Major-ID filter button and schedules a URL update.
 */
function toggle_no_major_id() {
    const btn = document.getElementById('restr-no-major-id');
    if (btn) btn.classList.toggle('toggleOn');
    _schedule_solver_hash_update();
}

let _restriction_row_counter = 0;

/**
 * Appends a new stat threshold row to the restrictions panel.
 */
function restriction_add_row() {
    const container = document.getElementById('restriction-rows');
    if (!container) return null;
    if (container.querySelectorAll('[id^="restr-row-"]').length >= MAX_RESTRICTION_ROWS) {
        _flash_row_limit_warning(container, 'restriction');
        return null;
    }
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
        <input type="text" inputmode="decimal" class="combo-row-input restr-value-input"
               placeholder="0" style="width:4.5em; text-align:center; flex-shrink:0;">
    `;
    container.appendChild(row);
    _init_restriction_stat_autocomplete('restr-stat-' + idx);
    // Clamp value input to encoding limits (±8,388,607)
    const val_input = row.querySelector('.restr-value-input');
    if (val_input) {
        _wire_suffix_parse(val_input);       // resolve k/m before clamping
        _wire_encoding_cap(val_input, RESTR_VALUE_MIN, RESTR_VALUE_MAX);
    }
    // Wire all inputs for URL persistence + contradiction validation
    for (const inp of row.querySelectorAll('input, select')) {
        inp.addEventListener('change', () => { _schedule_solver_hash_update(); _validate_restriction_contradictions(); });
        inp.addEventListener('input', () => { _schedule_solver_hash_update(); _validate_restriction_contradictions(); });
    }
    return row;
}

/**
 * Removes a restriction row when the × button is clicked.
 */
function restriction_remove_row(btn) {
    const row = btn.closest('[id^="restr-row-"]');
    if (row) row.remove();
    _schedule_solver_hash_update();
    _validate_restriction_contradictions();
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
                list.style.top = (rect.bottom + window.scrollY) + 'px';
                list.style.left = rect.x + 'px';
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

    const lvl_min = parseInt(document.getElementById('restr-lvl-min')?.value) || 1;
    const lvl_max = parseInt(document.getElementById('restr-lvl-max')?.value) || MAX_PLAYER_LEVEL;
    const no_major_id = document.getElementById('restr-no-major-id')?.classList.contains('toggleOn') ?? false;
    const guild_tome = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;

    const stat_thresholds = [];
    for (const row of (document.getElementById('restriction-rows')?.children ?? [])) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select = row.querySelector('select');
        const val_input = row.querySelector('.restr-value-input');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key = stat_input.dataset?.statKey || null;
        const stat_label = stat_input.value.trim();
        const value = parseFloat(val_input.value);
        if ((!stat_key && !stat_label) || isNaN(value)) continue;
        stat_thresholds.push({
            stat: stat_key || stat_label,
            op: op_select.value,   // 'ge' (≥) or 'le' (≤)
            value,
        });
    }

    return { build_dir, lvl_min, lvl_max, no_major_id, guild_tome, stat_thresholds };
}

// ── Item Blacklist ──────────────────────────────────────────────────────────

let _blacklist_row_counter = 0;
let _all_item_names = null; // cached on first use

/**
 * Lazily builds and caches the list of all non-deprecated item display names
 * for the blacklist autocomplete dropdown.
 */
function _get_all_item_names() {
    if (_all_item_names) return _all_item_names;
    const names = [];
    const types = ['helmet', 'chestplate', 'leggings', 'boots',
        'ring', 'bracelet', 'necklace',
        'dagger', 'wand', 'bow', 'relik', 'spear'];
    for (const type of types) {
        for (const name of (itemLists.get(type) ?? [])) {
            const obj = itemMap.get(name);
            if (!obj) continue;
            if (obj.restrict === 'DEPRECATED') continue;
            if (obj.name?.startsWith('No ')) continue;
            names.push(name);
        }
    }
    _all_item_names = names;
    return names;
}

/**
 * Appends a new blacklist row to the restrictions panel.
 */
function blacklist_add_row() {
    const container = document.getElementById('blacklist-rows');
    if (!container) return null;
    if (container.querySelectorAll('[id^="bl-row-"]').length >= MAX_BLACKLIST_ROWS) {
        _flash_row_limit_warning(container, 'blacklist');
        return null;
    }
    const idx = ++_blacklist_row_counter;
    const row = document.createElement('div');
    row.id = 'bl-row-' + idx;
    row.className = 'combo-row d-flex align-items-center gap-1';
    row.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary px-1"
                style="min-width:1.6em; font-size:0.8em; flex-shrink:0;"
                onclick="blacklist_remove_row(this)" title="Remove from blacklist">×</button>
        <input class="combo-row-input flex-grow-1 bl-item-input restr-stat-input"
               id="bl-item-${idx}"
               placeholder="Item..." autocomplete="off" style="min-width:0;">
    `;
    container.appendChild(row);
    _init_blacklist_autocomplete('bl-item-' + idx);
    for (const inp of row.querySelectorAll('input')) {
        inp.addEventListener('change', _schedule_solver_hash_update);
        inp.addEventListener('input', _schedule_solver_hash_update);
    }
    return row;
}

/**
 * Removes a blacklist row when the × button is clicked.
 */
function blacklist_remove_row(btn) {
    const row = btn.closest('[id^="bl-row-"]');
    if (row) row.remove();
    _schedule_solver_hash_update();
}

/**
 * Sets up autoComplete.js on a blacklist item input field.
 */
function _init_blacklist_autocomplete(input_id) {
    const names = _get_all_item_names();
    new autoComplete({
        data: { src: names },
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
                list.style.top = (rect.bottom + window.scrollY) + 'px';
                list.style.left = rect.x + 'px';
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
            element: (item, data) => {
                const obj = itemMap.get(data.value);
                if (obj) item.classList.add(obj.tier);
            },
        },
        events: {
            input: {
                selection: (event) => {
                    if (event.detail.selection.value) {
                        event.target.value = event.detail.selection.value;
                    }
                    event.target.dispatchEvent(new Event('change'));
                },
            },
        },
    });
}

/**
 * Returns the current blacklist as a Set of item display names.
 */
function get_blacklist() {
    const result = new Set();
    for (const row of (document.getElementById('blacklist-rows')?.children ?? [])) {
        if (!row.id?.startsWith('bl-row-')) continue;
        const input = row.querySelector('.bl-item-input');
        if (!input) continue;
        const name = input.value.trim();
        if (name && itemMap.has(name)) result.add(name);
    }
    return result;
}

/**
 * Briefly shows a warning message when the user tries to add more rows
 * than the encoding format supports.
 */
function _flash_row_limit_warning(container, type) {
    // Avoid duplicate warnings
    if (container.querySelector('.encoding-limit-msg')) return;
    const msg = document.createElement('div');
    msg.className = 'encoding-limit-msg small text-warning px-1';
    msg.textContent = `Maximum ${type === 'blacklist' ? MAX_BLACKLIST_ROWS : MAX_RESTRICTION_ROWS} ${type} rows (URL encoding limit).`;
    container.appendChild(msg);
    setTimeout(() => msg.remove(), 3000);
}

// ── Contradictory constraint detection ────────────────────────────────────────
//
// Scans all restriction rows and highlights value inputs with a red border when
// the same stat has a ge floor > le cap (impossible to satisfy), or when a
// constraint is impossible given the stat's natural bounds.

// Stats with a known minimum value that the game engine enforces.
// A "le" constraint below this minimum is impossible to satisfy.
const _STAT_NATURAL_MIN = {
    finalSpellCost1: 1, finalSpellCost2: 1, finalSpellCost3: 1, finalSpellCost4: 1,
    total_hp: 5,
};

function _validate_restriction_contradictions() {
    const container = document.getElementById('restriction-rows');
    if (!container) return;

    // Collect all rows grouped by stat key: { stat_key: [{op, value, val_input}] }
    const by_stat = new Map();
    for (const row of container.children) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const stat_input = row.querySelector('.restr-stat-input');
        const op_select = row.querySelector('select');
        const val_input = row.querySelector('.restr-value-input');
        if (!stat_input || !op_select || !val_input) continue;
        const stat_key = stat_input.dataset?.statKey;
        if (!stat_key) continue;
        const value = parseFloat(val_input.value);
        if (isNaN(value)) continue;
        if (!by_stat.has(stat_key)) by_stat.set(stat_key, []);
        by_stat.get(stat_key).push({ op: op_select.value, value, val_input });
    }

    // For each stat, find the tightest ge floor and le cap.
    // Also incorporate natural minimum bounds for stats that have them.
    // If floor > cap, mark all involved value inputs as contradictory.
    const contradictory_inputs = new Map(); // val_input -> tooltip message
    for (const [stat_key, entries] of by_stat) {
        let max_ge = -Infinity, min_le = Infinity;
        const ge_entries = [], le_entries = [];
        for (const e of entries) {
            if (e.op === 'ge') { ge_entries.push(e); if (e.value > max_ge) max_ge = e.value; }
            if (e.op === 'le') { le_entries.push(e); if (e.value < min_le) min_le = e.value; }
        }

        // Check against natural minimum bounds
        const nat_min = _STAT_NATURAL_MIN[stat_key];
        if (nat_min != null) {
            if (min_le < nat_min) {
                for (const e of le_entries) {
                    if (e.value < nat_min)
                        contradictory_inputs.set(e.val_input,
                            `Impossible: this stat is always ≥ ${nat_min}`);
                }
            }
            // Use natural min as implicit ge floor for cross-constraint check
            if (nat_min > max_ge) max_ge = nat_min;
        }

        if (max_ge > min_le) {
            const msg = nat_min != null && max_ge === nat_min
                ? `Impossible: this stat is always ≥ ${nat_min}`
                : 'Contradictory: floor exceeds cap for this stat';
            for (const e of ge_entries) {
                if (!contradictory_inputs.has(e.val_input))
                    contradictory_inputs.set(e.val_input, msg);
            }
            for (const e of le_entries) {
                if (!contradictory_inputs.has(e.val_input))
                    contradictory_inputs.set(e.val_input, msg);
            }
        }
    }

    // Apply/remove the CSS class on all value inputs
    for (const row of container.children) {
        if (!row.id?.startsWith('restr-row-')) continue;
        const val_input = row.querySelector('.restr-value-input');
        if (!val_input) continue;
        const msg = contradictory_inputs.get(val_input);
        if (msg) {
            val_input.classList.add('restr-contradictory');
            val_input.title = msg;
        } else {
            val_input.classList.remove('restr-contradictory');
            if (val_input.title.startsWith('Contradictory:') || val_input.title.startsWith('Impossible:'))
                val_input.title = '';
        }
    }
}

// Restriction URL persistence is now handled by the unified solver hash updater
// in solver_graph_build.js (_schedule_solver_hash_update / _do_solver_hash_update).

// ── Custom weight target rows ────────────────────────────────────────────────

const CUSTOM_WEIGHT_TARGETS = [
    { key: 'combo_damage', label: 'Combo Damage' },
    { key: 'ehp', label: 'Effective HP' },
    { key: 'ehpr', label: 'Effective HPR' },
    { key: 'total_healing', label: 'Total Healing' },
    { key: 'spd', label: 'Walk Speed' },
    { key: 'poison', label: 'Poison' },
    { key: 'lb', label: 'Loot Bonus' },
    { key: 'xpb', label: 'XP Bonus' },
];

let _custom_weight_row_counter = 0;

/**
 * Show/hide the custom weight section based on the solver target dropdown.
 */
function solver_target_changed() {
    const target = document.getElementById('solver-target')?.value;
    const section = document.getElementById('custom-weight-section');
    if (section) section.style.display = target === 'custom' ? '' : 'none';
}

function _cw_round_weight(e) {
    const v = parseFloat(e.target.value);
    if (!isFinite(v)) return;
    const rounded = Math.round(v);
    if (rounded !== v) e.target.value = rounded;
}

/**
 * Appends a new custom weight row: × | target dropdown | weight input.
 */
function custom_weight_add_row() {
    const container = document.getElementById('custom-weight-rows');
    if (!container) return null;
    const idx = ++_custom_weight_row_counter;
    const row = document.createElement('div');
    row.id = 'cw-row-' + idx;
    row.className = 'combo-row d-flex align-items-center gap-1';

    const options_html = CUSTOM_WEIGHT_TARGETS.map(
        t => `<option value="${t.key}">${t.label}</option>`
    ).join('');

    row.innerHTML = `
        <button class="btn btn-sm btn-outline-secondary px-1"
                style="min-width:1.6em; font-size:0.8em; flex-shrink:0;"
                onclick="custom_weight_remove_row(this)" title="Remove weight">×</button>
        <select class="solver-select form-select form-select-sm flex-grow-1 cw-target-select"
                id="cw-target-${idx}" style="min-width:0; flex: 1 1 0 !important;">
            ${options_html}
        </select>
        <input type="text" inputmode="decimal" class="combo-row-input cw-weight-input"
               id="cw-weight-${idx}"
               placeholder="weight" style="width:4.5em; text-align:center; flex-shrink:0;">
    `;
    container.appendChild(row);
    const inp = row.querySelector('.cw-weight-input');
    inp.addEventListener('blur', _cw_round_weight);
    return row;
}

/**
 * Removes a custom weight row when the × button is clicked.
 */
function custom_weight_remove_row(btn) {
    const row = btn.closest('[id^="cw-row-"]');
    if (row) row.remove();
}

/**
 * Read all custom weight rows from DOM.
 * @returns {Array<{target: string, weight: number}>} filtered (no zero/NaN weights)
 */
function read_custom_weights() {
    const container = document.getElementById('custom-weight-rows');
    if (!container) return [];
    const rows = container.querySelectorAll('[id^="cw-row-"]');
    const weights = [];
    for (const row of rows) {
        const sel = row.querySelector('.cw-target-select');
        const inp = row.querySelector('.cw-weight-input');
        if (!sel || !inp) continue;
        const target = sel.value;
        const weight = parseFloat(inp.value);
        if (!target || !isFinite(weight) || weight === 0) continue;
        weights.push({ target, weight });
    }
    return weights;
}
