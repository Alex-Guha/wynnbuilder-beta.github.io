// ── Combo data serialization ──────────────────────────────────────────────────

/** Serialize [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}] to multi-line text. */
function combo_data_to_text(data) {
    return data.map(({ qty, spell_name, boost_tokens_text, mana_excl, dmg_excl }) => {
        let line = qty + ' | ' + spell_name + ' | ' + boost_tokens_text;
        if (mana_excl || dmg_excl) line += ' | ' + (mana_excl ? '1' : '0');
        if (dmg_excl) line += ' | 1';
        return line;
    }).join('\n');
}

/** Parse multi-line text to [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl}]. */
function combo_text_to_data(text) {
    const result = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|');
        const qty             = Math.max(0, parseInt(parts[0]?.trim()) || 1);
        const spell_name      = (parts[1] ?? '').trim();
        if (!spell_name) continue;
        const boost_tokens_text = (parts[2] ?? '').trim();
        const mana_excl = (parts[3] ?? '').trim() === '1';
        const dmg_excl  = (parts[4] ?? '').trim() === '1';
        result.push({ qty, spell_name, boost_tokens_text, mana_excl, dmg_excl });
    }
    return result;
}

// URL encoding/decoding of combo data is now handled by encodeSolverParams /
// decodeSolverParams in build_encode.js / build_decode.js.

// ── Clipboard export / import ─────────────────────────────────────────────────

/** Copy combo to clipboard as text. */
function combo_export() {
    if (!solver_combo_total_node) return;
    const text = combo_data_to_text(solver_combo_total_node._read_rows_as_data());
    if (!text.trim()) return;
    navigator.clipboard.writeText(text).catch(e => console.warn('[solver] combo export failed:', e));
}

/** Paste combo from clipboard into the current mode. */
async function combo_import() {
    try {
        const text = await navigator.clipboard.readText();
        const data = combo_text_to_data(text);
        if (!data.length || !solver_combo_total_node) return;
        solver_combo_total_node._write_rows_from_data(data);
        solver_combo_total_node.mark_dirty().update();
    } catch(e) { console.warn('[solver] combo import failed:', e); }
}
