// ── Combo row boost highlight ─────────────────────────────────────────────────

/** Reflect whether any boost is active on a combo row's Boosts button. */
function _update_boost_btn_highlight(row) {
    const btn = row.querySelector('.combo-boost-menu-btn');
    if (!btn) return;
    const any_toggle = row.querySelector('.combo-row-boost-toggle.toggleOn') !== null;
    const any_slider = [...row.querySelectorAll('.combo-row-boost-slider')]
        .some(inp => (parseFloat(inp.value) || 0) > 0);
    const any_calc = [...row.querySelectorAll('.combo-row-boost-calc')]
        .some(inp => (parseFloat(inp.value) || 0) > 0);
    // Highlight when DPS hits is customized (differs from max).
    const hits_inp = row.querySelector('.combo-row-hits');
    const any_hits = hits_inp && hits_inp.value !== hits_inp.max;
    btn.classList.toggle('toggleOn', any_toggle || any_slider || any_calc || !!any_hits);
}

// ── Combo row builder ─────────────────────────────────────────────────────────

function _build_selection_row(qty_val, pending_spell, pending_boosts, pending_mana_excl, pending_dmg_excl, pending_spell_value, pending_cast_time, pending_delay, pending_melee_cd) {
    const row = document.createElement('div');
    row.className = 'combo-row d-flex gap-2 align-items-center';
    if (pending_spell !== undefined) row.dataset.pendingSpell = pending_spell;
    if (pending_spell_value != null) row.dataset.pendingSpellValue = pending_spell_value;
    if (pending_boosts !== undefined) row.dataset.pendingBoosts = pending_boosts;
    if (pending_mana_excl) row.dataset.pendingManaExcl = '1';
    if (pending_dmg_excl) row.dataset.pendingDmgExcl = '1';

    const rm_btn = document.createElement('button');
    rm_btn.className = 'btn btn-sm btn-outline-danger flex-shrink-0';
    rm_btn.textContent = '×';
    rm_btn.title = 'Remove row';
    rm_btn.addEventListener('click', () => combo_remove_row(rm_btn));

    const qty_inp = document.createElement('input');
    qty_inp.type = 'number';
    qty_inp.className = 'combo-row-input combo-row-qty flex-shrink-0';
    qty_inp.value = String(qty_val);
    qty_inp.step = 'any';
    qty_inp.style.cssText = 'width:3em; text-align:center;';
    _wire_encoding_cap(qty_inp, 0, COMBO_QTY_MAX);
    // Override min after _wire_encoding_cap: Add Flat Mana allows negative qty.
    const is_flat_mana_init = parseInt(pending_spell_value) === ADD_FLAT_MANA_SPELL_ID;
    if (is_flat_mana_init) qty_inp.min = String(-COMBO_QTY_MAX);
    qty_inp.addEventListener('input', () => {
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const spell_sel = document.createElement('select');
    spell_sel.className = 'form-select form-select-sm text-light bg-dark combo-row-spell';
    spell_sel.innerHTML = '<option value="">— Select Attack —</option>';
    spell_sel.addEventListener('change', () => {
        // Add Flat Mana allows negative qty (mana drain); others don't.
        const is_flat_mana = parseInt(spell_sel.value) === ADD_FLAT_MANA_SPELL_ID;
        qty_inp.min = is_flat_mana ? String(-COMBO_QTY_MAX) : '0';
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    // Timing button + popup (advanced-only, between spell select and boosts).
    const timing_wrap = document.createElement('div');
    timing_wrap.className = 'combo-timing-btn-wrap position-relative';
    if (!combo_is_advanced()) timing_wrap.style.display = 'none';

    const timing_btn = document.createElement('button');
    timing_btn.className = 'btn btn-sm btn-outline-secondary combo-timing-menu-btn';
    timing_btn.innerHTML = CLOCK_SVG;
    timing_btn.title = 'Cast timing overrides';
    timing_btn.addEventListener('click', (e) => {
        e.stopPropagation();
        combo_toggle_timing_popup(timing_btn);
    });

    const timing_popup = document.createElement('div');
    timing_popup.className = 'timing-popup bg-dark border border-secondary rounded p-2';
    timing_popup.style.display = 'none';
    _build_timing_popup_content(timing_popup, pending_cast_time, pending_delay);

    timing_wrap.append(timing_btn, timing_popup);

    const boost_wrap = document.createElement('div');
    boost_wrap.className = 'combo-boost-btn-wrap position-relative';

    const boost_btn = document.createElement('button');
    boost_btn.className = 'btn btn-sm btn-outline-secondary combo-boost-menu-btn';
    boost_btn.textContent = 'Boosts \u25be';
    boost_btn.addEventListener('click', (e) => {
        e.stopPropagation();
        combo_toggle_boost_popup(boost_btn);
    });

    const popup = document.createElement('div');
    // NOTE: Do NOT add Bootstrap's position-absolute class here — its `!important`
    // would prevent JS from upgrading to position:fixed for full-column-width display.
    // Absolute positioning defaults come from .boost-popup in solver-wide.css.
    popup.className = 'boost-popup combo-row-boosts bg-dark border border-secondary rounded p-2';
    popup.style.display = 'none';

    boost_wrap.append(boost_btn, popup);

    const mana_btn = document.createElement('button');
    mana_btn.type = 'button';
    mana_btn.className = 'combo-mana-toggle flex-shrink-0';
    mana_btn.title = 'Include ability in mana calculation';
    mana_btn.addEventListener('click', () => {
        mana_btn.classList.toggle('mana-excluded');
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const dmg_btn = document.createElement('button');
    dmg_btn.type = 'button';
    dmg_btn.className = 'combo-dmg-toggle flex-shrink-0';
    dmg_btn.title = 'Include ability in damage total';
    dmg_btn.addEventListener('click', () => {
        dmg_btn.classList.toggle('dmg-excluded');
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    // Damage display with hoverable/clickable breakdown popup.
    const dmg_wrap = document.createElement('div');
    dmg_wrap.className = 'combo-row-damage-wrap';
    const dmg_span = document.createElement('span');
    dmg_span.className = 'combo-row-damage Damage text-nowrap small ms-1';
    dmg_span.textContent = '';
    const heal_span = document.createElement('span');
    heal_span.className = 'combo-row-heal text-success text-nowrap small ms-1';
    heal_span.textContent = '';
    heal_span.style.visibility = 'hidden';
    const dmg_popup = document.createElement('div');
    dmg_popup.className = 'combo-dmg-popup text-light';
    dmg_wrap.append(heal_span, dmg_span, dmg_popup);
    // Reposition popup above or below the row depending on available viewport space,
    // and constrain its max-height so it never overflows the viewport.
    const _update_dmg_popup_pos = () => {
        const rect = dmg_wrap.getBoundingClientRect();
        const vh = window.innerHeight;
        const below = rect.top < 400;
        dmg_wrap.classList.toggle('popup-below', below);
        const available = below ? (vh - rect.bottom - 8) : (rect.top - 8);
        dmg_popup.style.maxHeight = Math.max(100, available) + 'px';
    };
    dmg_wrap.addEventListener('mouseenter', _update_dmg_popup_pos);
    dmg_wrap.addEventListener('click', (e) => {
        e.stopPropagation();
        _update_dmg_popup_pos();
        dmg_wrap.classList.toggle('popup-locked');
    });

    // Drag-and-drop reordering within the selection-mode rows container.
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
        e.dataTransfer.effectAllowed = 'move';
        e.dataTransfer.setData('text/plain', ''); // Firefox requires this
        row.classList.add('dragging');
        row._drag_source = true;
    });
    row.addEventListener('dragend', () => {
        row.classList.remove('dragging');
        row._drag_source = false;
        document.querySelectorAll('.combo-row.drag-over-top')
            .forEach(r => r.classList.remove('drag-over-top'));
    });
    row.addEventListener('dragover', (e) => {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'move';
        const dragging = document.querySelector('.combo-row.dragging');
        if (!dragging || dragging === row) return;
        document.querySelectorAll('.combo-row.drag-over-top')
            .forEach(r => r.classList.remove('drag-over-top'));
        row.classList.add('drag-over-top');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over-top'));
    row.addEventListener('drop', (e) => {
        e.preventDefault();
        row.classList.remove('drag-over-top');
        const dragging = document.querySelector('.combo-row.dragging');
        if (!dragging || dragging === row) return;
        const container = row.parentElement;
        if (container) container.insertBefore(dragging, row);
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    // Hidden timing inputs (per-row cast time & delay overrides).
    const ct_inp = document.createElement('input');
    ct_inp.type = 'hidden';
    ct_inp.className = 'combo-row-cast-time';
    ct_inp.value = (pending_cast_time != null) ? String(pending_cast_time) : '';
    ct_inp.dataset.auto = (pending_cast_time == null) ? 'true' : 'false';

    const dl_inp = document.createElement('input');
    dl_inp.type = 'hidden';
    dl_inp.className = 'combo-row-delay';
    dl_inp.value = (pending_delay != null) ? String(pending_delay) : '';
    dl_inp.dataset.auto = (pending_delay == null) ? 'true' : 'false';

    const mcd_inp = document.createElement('input');
    mcd_inp.type = 'hidden';
    mcd_inp.className = 'combo-row-melee-cd';
    mcd_inp.value = (pending_melee_cd != null) ? String(pending_melee_cd) : '';
    mcd_inp.dataset.auto = (pending_melee_cd == null) ? 'true' : 'false';

    // Wrap toggles + damage in a group so they always move to line 2 together
    // when the row wraps, instead of splitting across lines.
    const toggles_wrap = document.createElement('div');
    toggles_wrap.className = 'combo-row-toggles-wrap';
    toggles_wrap.append(mana_btn, dmg_btn, dmg_wrap);

    row.append(rm_btn, qty_inp, spell_sel, timing_wrap, boost_wrap, toggles_wrap, ct_inp, dl_inp, mcd_inp);
    return row;
}

// ── Combo UI helpers (called from inline onclick in index.html) ───────────────

function combo_add_row() {
    const container = document.getElementById('combo-selection-rows');
    if (!container) return;
    if (container.querySelectorAll('.combo-row').length >= MAX_COMBO_ROWS) {
        _flash_row_limit_warning(container, 'combo');
        return;
    }
    container.appendChild(_build_selection_row(1));
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_toggle_boost_popup(btn) {
    const popup = btn.parentElement.querySelector('.boost-popup');
    if (!popup) return;
    const showing = popup.style.display !== 'none';
    // Hide all popups and clear any fixed-position inline overrides.
    document.querySelectorAll('.boost-popup').forEach(p => {
        p.style.display = 'none';
        p.style.position = '';
        p.style.top = '';
        p.style.right = '';
        p.style.left = '';
        p.style.width = '';
        p.style.maxWidth = '';
    });
    if (!showing) {
        // Try to span the full combo column using fixed positioning.
        // Use right-anchor so the popup never extends past the column's right edge.
        const btn_rect = btn.getBoundingClientRect();
        const combo_col = btn.closest('.solver-combo-column');
        if (combo_col) {
            const col_rect = combo_col.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            popup.style.position = 'fixed';
            popup.style.top = (btn_rect.bottom + 4) + 'px';
            popup.style.right = (vw - col_rect.right) + 'px';
            popup.style.left = 'auto';
            popup.style.width = col_rect.width + 'px';
        }
        popup.style.display = 'block';
    }
}

// Close boost popups when clicking outside (needed for mobile bottom-sheet UX).
document.addEventListener('click', (e) => {
    if (e.target.closest('.boost-popup') || e.target.closest('.combo-boost-menu-btn')) return;
    document.querySelectorAll('.boost-popup').forEach(p => {
        if (p.style.display === 'none') return;
        p.style.display = 'none';
        p.style.position = '';
        p.style.top = '';
        p.style.right = '';
        p.style.left = '';
        p.style.width = '';
        p.style.maxWidth = '';
    });
});

// ── Timing popup (cast time / delay overrides) ───────────────────────────────

/** Build the inner content of a timing popup (two labeled number inputs). */
function _build_timing_popup_content(popup, cast_time, delay) {
    popup.innerHTML = '';
    const make_field = (label, cls, val, def, is_auto) => {
        const wrap = document.createElement('div');
        wrap.className = 'd-flex align-items-center gap-1 m-1';
        const lbl = document.createElement('span');
        lbl.className = 'text-secondary small text-nowrap';
        lbl.textContent = label;
        const inp = document.createElement('input');
        inp.type = 'number';
        inp.className = 'combo-row-input ' + cls;
        inp.style.cssText = 'width:4.5em; text-align:center;';
        if (is_auto) {
            inp.value = '';
            inp.placeholder = String(def);
        } else {
            inp.value = String(val);
        }
        inp.step = '0.01';
        inp.min = '0';
        const unit = document.createElement('span');
        unit.className = 'text-secondary small';
        unit.textContent = 's';
        inp.addEventListener('input', () => {
            // Sync to hidden input on the row.
            const row = popup.closest('.combo-row');
            if (!row) return;
            const hidden = row.querySelector(cls === 'timing-cast-time' ? '.combo-row-cast-time' : '.combo-row-delay');
            if (hidden) {
                hidden.value = inp.value;
                hidden.dataset.auto = 'false';
            }
            _update_timing_btn_highlight(row);
            if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
        });
        inp.addEventListener('blur', () => {
            if (inp.value !== '' && !isNaN(parseFloat(inp.value))) return;
            // Empty/invalid → restore auto mode; _refresh_selection_timing will fill defaults.
            const row = popup.closest('.combo-row');
            if (!row) return;
            const hidden = row.querySelector(cls === 'timing-cast-time' ? '.combo-row-cast-time' : '.combo-row-delay');
            inp.value = '';
            if (hidden) { hidden.value = ''; hidden.dataset.auto = 'true'; }
            _update_timing_btn_highlight(row);
            if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
        });
        wrap.append(lbl, inp, unit);
        return wrap;
    };
    popup.appendChild(make_field('Cast Time', 'timing-cast-time', cast_time, SPELL_CAST_TIME, cast_time == null));
    popup.appendChild(make_field('Cast Delay', 'timing-cast-delay', delay, SPELL_CAST_DELAY, delay == null));

    // Melee Cooldown override field (visible only for melee/powder-special rows).
    const mcd_wrap = document.createElement('div');
    mcd_wrap.className = 'align-items-center gap-1 m-1 timing-melee-cd-wrap';
    mcd_wrap.style.display = 'none';
    const mcd_lbl = document.createElement('span');
    mcd_lbl.className = 'text-secondary small text-nowrap';
    mcd_lbl.textContent = 'Cooldown';
    const mcd_inp = document.createElement('input');
    mcd_inp.type = 'number';
    mcd_inp.className = 'combo-row-input timing-melee-cd';
    mcd_inp.style.cssText = 'width:4.5em; text-align:center;';
    mcd_inp.step = '0.001';
    mcd_inp.min = '0';
    mcd_inp.value = '';
    const mcd_unit = document.createElement('span');
    mcd_unit.className = 'text-secondary small';
    mcd_unit.textContent = 's';
    mcd_inp.addEventListener('input', () => {
        const row = popup.closest('.combo-row');
        if (!row) return;
        const hidden = row.querySelector('.combo-row-melee-cd');
        if (hidden) {
            hidden.value = mcd_inp.value;
            hidden.dataset.auto = 'false';
        }
        _update_timing_btn_highlight(row);
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });
    mcd_inp.addEventListener('blur', () => {
        if (mcd_inp.value !== '' && !isNaN(parseFloat(mcd_inp.value))) return;
        const row = popup.closest('.combo-row');
        if (!row) return;
        const hidden = row.querySelector('.combo-row-melee-cd');
        if (hidden) { hidden.value = ''; hidden.dataset.auto = 'true'; }
        mcd_inp.value = '';
        _update_timing_btn_highlight(row);
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });
    mcd_wrap.append(mcd_lbl, mcd_inp, mcd_unit);
    popup.appendChild(mcd_wrap);
}

/** Highlight timing button when values differ from defaults. */
function _update_timing_btn_highlight(row) {
    const btn = row.querySelector('.combo-timing-menu-btn');
    if (!btn) return;
    const ct_auto = row.querySelector('.combo-row-cast-time')?.dataset.auto !== 'false';
    const dl_auto = row.querySelector('.combo-row-delay')?.dataset.auto !== 'false';
    const mcd_auto = row.querySelector('.combo-row-melee-cd')?.dataset.auto !== 'false';
    const custom = !ct_auto || !dl_auto || !mcd_auto;
    btn.classList.toggle('toggleOn', custom);
}

function combo_toggle_timing_popup(btn) {
    const popup = btn.parentElement.querySelector('.timing-popup');
    if (!popup) return;
    const showing = popup.style.display !== 'none';
    // Hide all timing popups.
    _close_all_timing_popups();
    if (!showing) {
        popup.style.display = 'block';
    }
}

function _close_all_timing_popups() {
    document.querySelectorAll('.timing-popup').forEach(p => p.style.display = 'none');
}

// Close timing popups when clicking outside.
document.addEventListener('click', (e) => {
    if (e.target.closest('.timing-popup') || e.target.closest('.combo-timing-menu-btn')) return;
    _close_all_timing_popups();
});

function combo_remove_row(btn) {
    btn.closest('.combo-row')?.remove();
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_toggle_downtime() {
    const btn = document.getElementById('combo-downtime-btn');
    if (!btn) return;
    btn.classList.toggle('toggleOn');
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_toggle_mana() {
    const btn = document.getElementById('combo-mana-btn');
    if (!btn) return;
    btn.classList.toggle('toggleOn');
    const mana_row = document.getElementById('combo-mana-row');
    if (mana_row) mana_row.style.display = btn.classList.contains('toggleOn') ? 'flex' : 'none';
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    _schedule_solver_hash_update();
}

function combo_toggle_advanced() {
    const btn = document.getElementById('combo-adv-btn');
    if (!btn) return;
    btn.classList.toggle('toggleOn');
    const adv = btn.classList.contains('toggleOn');
    // Show/hide timing buttons on existing rows.
    document.querySelectorAll('.combo-timing-btn-wrap').forEach(w => {
        w.style.display = adv ? '' : 'none';
    });
    // Re-run graph so _refresh_selection_spells shows/hides Melee Time / Mana Reset options
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_is_advanced() {
    return document.getElementById('combo-adv-btn')?.classList.contains('toggleOn') ?? false;
}

function solver_toggle_advanced() {
    const btn = document.getElementById('solver-advanced-btn');
    if (!btn) return;
    btn.classList.toggle('toggleOn');
    _display_priority_weights();
}

function solver_is_advanced() {
    return document.getElementById('solver-advanced-btn')?.classList.contains('toggleOn') ?? false;
}

/**
 * Info overlay entries.  Each has either `id` (getElementById) or `cls`
 * (querySelector on first combo row).  `text` is the short summary shown
 * in the legend row; `detail` is the longer description shown on expand.
 * `pos` controls badge placement: 'over' (default) or 'above'.
 * `hiddenCheck` (optional): function returning true when the element is
 * not currently visible — badge is skipped and legend notes it.
 */
const _INFO_ENTRIES = [
    {
        id: 'helmet-dropdown', text: 'Lock an item to keep it fixed during solving',
        detail: 'You can also hover over the icon to see item details (desktop), and click the item to display it at the bottom of the screen.'
    },
    { id: 'roll-mode-input', text: 'Set roll % per stat group (damage, mana, …)' },
    {
        cls: 'combo-row-qty', text: 'Number of sequential spell casts',
        detail: 'Fractional entry is allowed. If the spell is dps, this is the number of seconds, with decimals allowed. This will count spells as separate casts for mana purposes, factoring in the cost ramp.'
    },
    {
        cls: 'combo-row-spell', text: 'Which event occurs in this combo step',
        detail: 'This includes melee attacks, active spells, passive spells, really any damage-dealing action as well as Mana Reset and state changes.'
    },
    {
        cls: 'combo-boost-menu-btn', text: 'Per-row damage boosts / overrides',
        detail: 'Be very deliberate with how you enter your combo and per-spell boosts, they are very powerful and can easily lead to unrealistic results if used incorrectly. Certain hits-based spells like Crepuscular Ray require multiple spell entries with different hit counts experiencing different boosts.'
    },
    {
        cls: 'combo-mana-toggle', text: 'Exclude this row from mana calculation', pos: 'above',
        detail: 'Completely removes the row from all mana considerations.'
    },
    {
        cls: 'combo-dmg-toggle', text: 'Exclude this row from damage calculation', pos: 'above',
        detail: 'Completely removes the row from all damage considerations.'
    },
    {
        id: 'combo-mana-btn', text: 'Toggle mana calculation on/off',
        detail: 'When enabled, mana feasibility is checked for the combo cycle. Cycle time is auto-computed from the spell sequence. When disabled, the solver ignores mana entirely.'
    },
    {
        id: 'combo-cycle-time-display', text: 'Auto-calculated cycle time',
        detail: 'Computed from the spell sequence: sum of cast times and delays. Mana-excluded rows are not counted.',
        hiddenCheck: () => !document.getElementById('combo-mana-btn')?.classList.contains('toggleOn')
    },
    {
        id: 'combo-downtime-btn', text: 'Allow mana regen between cycles',
        detail: 'When disabled, the solver ensures ending mana >= starting mana - 5 (sustainable). When enabled, the solver ensures ending mana >= 0 (allows regen during downtime).',
        hiddenCheck: () => !document.getElementById('combo-mana-btn')?.classList.contains('toggleOn')
    },
    {
        id: 'combo-copy-btn', text: 'Export combo config to clipboard',
        detail: 'Exports the current combo as plaintext. Very powerful, allows for easy large-scale combo manipulation in a text editor.'
    },
    {
        id: 'combo-adv-btn', text: 'Toggle advanced combo options',
        detail: 'Shows additional per-row controls for fine-tuning combo behaviour. Adds a few options to the attack menu, and displays a cast time / delay menu.'
    },
    {
        id: 'combo-paste-btn', text: 'Import combo config from clipboard'
    },
    {
        id: 'combo-mana-display', text: 'Hover for detailed mana breakdown',
        hiddenCheck: () => !document.getElementById('combo-mana-btn')?.classList.contains('toggleOn')
    },
    {
        id: 'filters-title', text: 'Item filtering options',
        detail: 'These can be used to limit the items the solver has to search through.'
    },
    {
        id: 'dir-str', text: 'Toggle which item SP to consider',
        detail: 'Disable these to exclude any items that require that skillpoint type. Used to limit the pool of items to search through.'
    },
    {
        id: 'restriction-add-btn', text: 'Add stat threshold constraints',
        detail: 'These set requirements for the build to have. For example, HP Regen >= 0 is generally recommended. Effective HP (no agi) is another common requirement.'
    },
    {
        id: 'solver-thread-count', text: 'Number of parallel worker threads',
        detail: 'If you cannot set this higher than ~8-12, searches may take significant time.'
    },
];

/** Resolve an _INFO_ENTRIES element to its DOM node. */
function _info_resolve_el(entry, firstRow) {
    if (entry.id) return document.getElementById(entry.id);
    if (entry.cls && firstRow) return firstRow.querySelector('.' + entry.cls);
    return null;
}

function _info_overlay_open() {
    const overlay = document.getElementById('solver-info-overlay');
    if (!overlay) return;

    // Ensure at least one combo row exists
    const rows = document.getElementById('combo-selection-rows');
    if (rows && rows.children.length === 0) combo_add_row();
    const firstRow = rows?.querySelector('.combo-row');

    const isInline = window.innerWidth < 1200;

    // Badge layer — absolute so badges scroll with the page
    const badgeLayer = document.createElement('div');
    badgeLayer.id = 'solver-info-badge-layer';
    badgeLayer.style.cssText = 'position:absolute;top:0;left:0;width:100%;height:0;z-index:10001;pointer-events:none;';

    // Legend panel
    const legend = document.createElement('div');
    legend.className = 'solver-info-legend';
    legend.style.pointerEvents = 'auto';
    legend.onclick = e => e.stopPropagation();

    let num = 0;
    for (const entry of _INFO_ENTRIES) {
        const el = _info_resolve_el(entry, firstRow);
        if (!el) continue;
        num++;

        const isHidden = entry.hiddenCheck?.() ?? false;

        if (!isHidden) {
            // Highlight the element
            el.classList.add('solver-info-highlight');

            // Place numbered badge (document-relative coords)
            const rect = el.getBoundingClientRect();
            const sx = window.scrollX, sy = window.scrollY;
            const badge = document.createElement('div');
            badge.className = 'solver-info-badge';
            badge.textContent = num;
            const pos = (isInline ? 'over' : entry.pos) || 'over';
            if (pos === 'above') {
                badge.style.left = (rect.left + sx + rect.width / 2 - 10) + 'px';
                badge.style.top = (rect.top + sy - 24) + 'px';
            } else {
                badge.style.left = (rect.right + sx - 14) + 'px';
                badge.style.top = (rect.top + sy - 6) + 'px';
            }
            badgeLayer.appendChild(badge);
        }

        // Legend row (always present)
        const row = document.createElement('div');
        row.className = 'solver-info-legend-entry';
        row.onclick = () => row.classList.toggle('expanded');

        const inlineBadge = document.createElement('span');
        inlineBadge.className = 'solver-info-badge-inline';
        inlineBadge.textContent = num;

        const textWrap = document.createElement('div');

        const summary = document.createElement('span');
        summary.className = 'solver-info-legend-summary';
        summary.textContent = entry.text;
        textWrap.appendChild(summary);

        if (isHidden) {
            const note = document.createElement('span');
            note.className = 'solver-info-legend-hidden-note';
            note.textContent = ' (currently hidden)';
            textWrap.appendChild(note);
        }

        if (entry.detail) {
            const detail = document.createElement('div');
            detail.className = 'solver-info-legend-detail';
            detail.textContent = entry.detail;
            textWrap.appendChild(detail);
        }

        row.appendChild(inlineBadge);
        row.appendChild(textWrap);
        legend.appendChild(row);
    }

    // Place legend: inline (< 1200px) or inside badge layer (fixed, >= 1200px)
    if (isInline) {
        const anchor = document.getElementById('solver-info-legend-anchor');
        if (anchor) {
            anchor.appendChild(legend);
        } else {
            badgeLayer.appendChild(legend);
        }
    } else {
        badgeLayer.appendChild(legend);
    }

    document.body.appendChild(badgeLayer);
    overlay.style.display = '';

    // Lock legend height to its collapsed size so expanding a row scrolls
    // instead of growing the box.
    requestAnimationFrame(() => {
        const h = legend.getBoundingClientRect().height;
        if (h > 0) {
            legend.style.height = h + 'px';
            legend.style.maxHeight = h + 'px';
        }
    });
}

function _info_overlay_close() {
    const overlay = document.getElementById('solver-info-overlay');
    if (overlay) overlay.style.display = 'none';

    // Remove badge layer from body
    const layer = document.getElementById('solver-info-badge-layer');
    if (layer) layer.remove();

    // Remove inline legend from anchor (< 1200px path)
    const anchor = document.getElementById('solver-info-legend-anchor');
    if (anchor) anchor.innerHTML = '';

    // Remove highlights
    document.querySelectorAll('.solver-info-highlight').forEach(el => {
        el.classList.remove('solver-info-highlight');
    });
}

function solver_toggle_info_overlay() {
    const overlay = document.getElementById('solver-info-overlay');
    if (!overlay) return;
    if (overlay.style.display === 'none') {
        _info_overlay_open();
    } else {
        _info_overlay_close();
    }
}

function solver_close_info_overlay() {
    _info_overlay_close();
}
