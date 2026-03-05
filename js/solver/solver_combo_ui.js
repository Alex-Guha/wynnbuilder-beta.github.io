// ── Combo row boost highlight ─────────────────────────────────────────────────

/** Reflect whether any boost is active on a combo row's Boosts button. */
function _update_boost_btn_highlight(row) {
    const btn = row.querySelector('.combo-boost-menu-btn');
    if (!btn) return;
    const any_toggle = row.querySelector('.combo-row-boost-toggle.toggleOn') !== null;
    const any_slider = [...row.querySelectorAll('.combo-row-boost-slider')]
        .some(inp => (parseFloat(inp.value) || 0) > 0);
    btn.classList.toggle('toggleOn', any_toggle || any_slider);
}

// ── Combo row builder ─────────────────────────────────────────────────────────

function _build_selection_row(qty_val, pending_spell, pending_boosts, pending_mana_excl, pending_dmg_excl) {
    const row = document.createElement('div');
    row.className = 'combo-row d-flex gap-2 align-items-center';
    if (pending_spell     !== undefined) row.dataset.pendingSpell    = pending_spell;
    if (pending_boosts    !== undefined) row.dataset.pendingBoosts   = pending_boosts;
    if (pending_mana_excl)               row.dataset.pendingManaExcl = '1';
    if (pending_dmg_excl)                row.dataset.pendingDmgExcl  = '1';

    const rm_btn = document.createElement('button');
    rm_btn.className   = 'btn btn-sm btn-outline-danger flex-shrink-0';
    rm_btn.textContent = '×';
    rm_btn.title       = 'Remove row';
    rm_btn.addEventListener('click', () => combo_remove_row(rm_btn));

    const qty_inp = document.createElement('input');
    qty_inp.type      = 'number';
    qty_inp.className = 'combo-row-input combo-row-qty flex-shrink-0';
    qty_inp.value     = String(qty_val);
    qty_inp.min       = '0';
    qty_inp.max       = '999';
    qty_inp.style.cssText = 'width:3em; text-align:center;';
    qty_inp.addEventListener('input', () => {
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const spell_sel = document.createElement('select');
    spell_sel.className = 'form-select form-select-sm text-light bg-dark combo-row-spell';
    spell_sel.innerHTML = '<option value="">— Select Attack —</option>';
    spell_sel.addEventListener('change', () => {
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const boost_wrap = document.createElement('div');
    boost_wrap.className = 'combo-boost-btn-wrap position-relative';

    const boost_btn = document.createElement('button');
    boost_btn.className   = 'btn btn-sm btn-outline-secondary combo-boost-menu-btn';
    boost_btn.textContent = 'Boosts \u25be';
    boost_btn.addEventListener('click', (e) => {
        e.stopPropagation();
        combo_toggle_boost_popup(boost_btn);
    });

    const popup = document.createElement('div');
    // NOTE: Do NOT add Bootstrap's position-absolute class here — its `!important`
    // would prevent JS from upgrading to position:fixed for full-column-width display.
    // Absolute positioning defaults come from .boost-popup in solver-wide.css.
    popup.className   = 'boost-popup combo-row-boosts bg-dark border border-secondary rounded p-2';
    popup.style.display = 'none';

    boost_wrap.append(boost_btn, popup);

    const mana_btn = document.createElement('button');
    mana_btn.type      = 'button';
    mana_btn.className = 'combo-mana-toggle flex-shrink-0';
    mana_btn.title     = 'Include ability in mana calculation';
    mana_btn.addEventListener('click', () => {
        mana_btn.classList.toggle('mana-excluded');
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    const dmg_btn = document.createElement('button');
    dmg_btn.type      = 'button';
    dmg_btn.className = 'combo-dmg-toggle flex-shrink-0';
    dmg_btn.title     = 'Include ability in damage total';
    dmg_btn.addEventListener('click', () => {
        dmg_btn.classList.toggle('dmg-excluded');
        if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
    });

    // Damage display with hoverable/clickable breakdown popup.
    const dmg_wrap = document.createElement('div');
    dmg_wrap.className = 'combo-row-damage-wrap';
    const dmg_span = document.createElement('span');
    dmg_span.className   = 'combo-row-damage Damage text-nowrap small ms-1';
    dmg_span.textContent = '';
    const heal_span = document.createElement('span');
    heal_span.className      = 'combo-row-heal text-success text-nowrap small ms-1';
    heal_span.textContent    = '';
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

    // Wrap toggles + damage in a group so they always move to line 2 together
    // when the row wraps, instead of splitting across lines.
    const toggles_wrap = document.createElement('div');
    toggles_wrap.className = 'combo-row-toggles-wrap';
    toggles_wrap.append(mana_btn, dmg_btn, dmg_wrap);

    row.append(rm_btn, qty_inp, spell_sel, boost_wrap, toggles_wrap);
    return row;
}

// ── Combo UI helpers (called from inline onclick in index.html) ───────────────

function combo_add_row() {
    const container = document.getElementById('combo-selection-rows');
    if (!container) return;
    container.appendChild(_build_selection_row(1));
    if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
}

function combo_toggle_boost_popup(btn) {
    const popup = btn.parentElement.querySelector('.boost-popup');
    if (!popup) return;
    const showing = popup.style.display !== 'none';
    // Hide all popups and clear any fixed-position inline overrides.
    document.querySelectorAll('.boost-popup').forEach(p => {
        p.style.display  = 'none';
        p.style.position = '';
        p.style.top      = '';
        p.style.right    = '';
        p.style.left     = '';
        p.style.width    = '';
        p.style.maxWidth = '';
    });
    if (!showing) {
        // Try to span the full combo column using fixed positioning.
        // Use right-anchor so the popup never extends past the column's right edge.
        const btn_rect  = btn.getBoundingClientRect();
        const combo_col = btn.closest('.solver-combo-column');
        if (combo_col) {
            const col_rect = combo_col.getBoundingClientRect();
            const vw = document.documentElement.clientWidth;
            popup.style.position = 'fixed';
            popup.style.top      = (btn_rect.bottom + 4) + 'px';
            popup.style.right    = (vw - col_rect.right) + 'px';
            popup.style.left     = 'auto';
            popup.style.width    = col_rect.width + 'px';
        }
        popup.style.display = 'block';
    }
}

// Close boost popups when clicking outside (needed for mobile bottom-sheet UX).
document.addEventListener('click', (e) => {
    if (e.target.closest('.boost-popup') || e.target.closest('.combo-boost-menu-btn')) return;
    document.querySelectorAll('.boost-popup').forEach(p => {
        if (p.style.display === 'none') return;
        p.style.display  = 'none';
        p.style.position = '';
        p.style.top      = '';
        p.style.right    = '';
        p.style.left     = '';
        p.style.width    = '';
        p.style.maxWidth = '';
    });
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
