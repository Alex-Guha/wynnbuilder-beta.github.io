// ── Combo data serialization ──────────────────────────────────────────────────

/** Serialize [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl, hits}] to multi-line text. */
function combo_data_to_text(data) {
    return data.map(({ qty, spell_name, boost_tokens_text, mana_excl, dmg_excl, hits }) => {
        let line = qty + ' | ' + spell_name + ' | ' + boost_tokens_text;
        if (mana_excl || dmg_excl || hits !== undefined) line += ' | ' + (mana_excl ? '1' : '0');
        if (dmg_excl || hits !== undefined) line += ' | ' + (dmg_excl ? '1' : '0');
        if (hits !== undefined) line += ' | ' + hits;
        return line;
    }).join('\n');
}

/** Parse multi-line text to [{qty, spell_name, boost_tokens_text, mana_excl, dmg_excl, hits}]. */
function combo_text_to_data(text) {
    const result = [];
    for (const raw of text.split('\n')) {
        const line = raw.trim();
        if (!line || line.startsWith('#')) continue;
        const parts = line.split('|');
        const qty             = Math.max(0, parseFloat(parts[0]?.trim()) || 1);
        const spell_name      = (parts[1] ?? '').trim();
        if (!spell_name) continue;
        const boost_tokens_text = (parts[2] ?? '').trim();
        const mana_excl = (parts[3] ?? '').trim() === '1';
        const dmg_excl  = (parts[4] ?? '').trim() === '1';
        const hits_str  = (parts[5] ?? '').trim();
        const hits      = hits_str ? parseFloat(hits_str) : undefined;
        result.push({ qty, spell_name, boost_tokens_text, mana_excl, dmg_excl, hits: (hits != null && !isNaN(hits)) ? hits : undefined });
    }
    return result;
}

// URL encoding/decoding of combo data is now handled by encodeSolverParams /
// decodeSolverParams in build_encode.js / build_decode.js.

// ── Spell / boost ↔ binary node ID mapping (for URL encoding) ────────────────

/**
 * Reserved IDs in the 7-bit spell field.
 * Melee now encodes as base_spell 0 directly; 120 is kept for backwards compat
 * decoding only. Powder specials use fixed IDs 121-125.
 */
const _RESERVED_SPELL_IDS = {
    MELEE: 120,  // legacy — only used in decoder for old URLs
};

/** Map powder special ps_idx to reserved spell node ID. */
const _PS_IDX_TO_NODE = new Map([[0, 121], [1, 122], [2, 123], [3, 124], [4, 125]]);
/** Reverse: reserved node ID to ps_idx. */
const _NODE_TO_PS_IDX = new Map([..._PS_IDX_TO_NODE].map(([k, v]) => [v, k]));

/**
 * Map spell dropdown value to a 7-bit ID for binary encoding.
 * Regular spells encode as their base_spell directly (0-119).
 * Powder specials encode as reserved IDs (121-125).
 * @param {number} base_spell_id - From sel.value (0+ for spells, negative for powder)
 * @returns {number} base_spell or reserved ID
 */
function spell_to_node_id(base_spell_id) {
    // Pseudo-spells
    if (base_spell_id === MANA_RESET_SPELL_ID) return MANA_RESET_NODE_ID;
    if (base_spell_id === CANCEL_BAKALS_SPELL_ID) return CANCEL_BAKALS_NODE_ID;

    // Powder specials: -1000 - ps_idx → reserved ID
    if (base_spell_id < 0) {
        const ps_idx = -(base_spell_id + 1000);  // -1000→0, -1001→1, -1003→3
        return _PS_IDX_TO_NODE.get(ps_idx) ?? 120;
    }

    // Regular spells: encode the base_spell directly.
    // The old approach of mapping to atree node_id was lossy when replacement
    // abilities (e.g. Bamboozle→Multihit) merge their effects into the same
    // atree node, causing the decoder to pick the wrong replace_spell effect.
    return base_spell_id;
}

/**
 * Map encoded spell ID back to spell name for decoding.
 * @param {number} node_id - base_spell value or reserved ID (powder/melee)
 * @param {Map} atree_merged - Merged ability tree
 * @returns {string} spell name (matching what appears in dropdown text)
 */
function node_id_to_spell_name(node_id, atree_merged) {
    // Pseudo-spells
    if (node_id === MANA_RESET_NODE_ID) return 'Mana Reset';
    if (node_id === CANCEL_BAKALS_NODE_ID) return "Cancel Bak'al's Grasp";

    // Reserved powder specials
    if (_NODE_TO_PS_IDX.has(node_id)) {
        const ps_idx = _NODE_TO_PS_IDX.get(node_id);
        const names = ['Quake', 'Chain Lightning', 'Curse', 'Courage', 'Wind Prison'];
        return names[ps_idx] ?? 'Powder Special';
    }

    // Treat as base_spell: scan atree for the LAST replace_spell with this base_spell
    // (matches atree_collect_spells logic where the last replace_spell wins).
    const base_spell = (node_id === _RESERVED_SPELL_IDS.MELEE) ? 0 : node_id;
    if (atree_merged) {
        let last_name = null;
        for (const [, abil] of atree_merged) {
            for (const effect of abil.effects) {
                if (effect.type === 'replace_spell' && effect.base_spell === base_spell) {
                    last_name = effect.name ?? abil.display_name ?? '';
                }
            }
        }
        if (last_name !== null) return last_name;
    }
    if (base_spell === 0) return 'Melee';
    return '';
}

/**
 * Map encoded spell ID back to the dropdown <select> value.
 * @param {number} node_id - base_spell value or reserved ID (powder/melee)
 * @returns {string|null} dropdown value string, or null if not found
 */
function node_id_to_spell_value(node_id) {
    // Pseudo-spells
    if (node_id === MANA_RESET_NODE_ID) return String(MANA_RESET_SPELL_ID);
    if (node_id === CANCEL_BAKALS_NODE_ID) return String(CANCEL_BAKALS_SPELL_ID);

    // Reserved melee → base_spell 0
    if (node_id === _RESERVED_SPELL_IDS.MELEE) return '0';

    // Reserved powder specials → -1000 - ps_idx
    if (_NODE_TO_PS_IDX.has(node_id)) {
        return String(-1000 - _NODE_TO_PS_IDX.get(node_id));
    }

    // The encoded value IS the base_spell, which IS the dropdown value.
    return String(node_id);
}

/**
 * Reserved node IDs for powder boosts (used in boost node_id field).
 * 120=Curse weapon buff, 121=Courage weapon buff, 122=Wind Prison weapon buff,
 * 123=Rage armor slider, 124=Kill Streak armor slider,
 * 125=Concentration armor slider, 126=Endurance armor slider, 127=Dodge armor slider.
 */
const _POWDER_BOOST_NAMES = new Map([
    [120, 'Curse'],
    [121, 'Courage'],
    [122, 'Wind Prison'],
    [123, 'Rage'],
    [124, 'Kill Streak'],
    [125, 'Concentration'],
    [126, 'Endurance'],
    [127, 'Dodge'],
]);
const _POWDER_BOOST_IDS = new Map([..._POWDER_BOOST_NAMES].map(([k, v]) => [v, k]));

/**
 * Map boost name to (node_id, effect_pos) for encoding.
 * @param {string} boost_name
 * @param {Map} atree_merged
 * @returns {{node_id: number, effect_pos: number}}
 */
function boost_to_node_ref(boost_name, atree_merged) {
    // Check powder boosts first
    if (_POWDER_BOOST_IDS.has(boost_name)) {
        return { node_id: _POWDER_BOOST_IDS.get(boost_name), effect_pos: 0 };
    }

    // Scan atree for toggle/slider effects matching this boost name
    if (atree_merged) {
        for (const [abil_id, abil] of atree_merged) {
            let effect_pos = 0;
            for (const effect of abil.effects) {
                if (effect.type === 'raw_stat' && effect.toggle) {
                    if (effect.toggle === boost_name) {
                        return { node_id: abil_id, effect_pos };
                    }
                    effect_pos++;
                } else if (effect.type === 'stat_scaling' && effect.slider === true && effect.slider_name) {
                    if (effect.slider_name === boost_name) {
                        return { node_id: abil_id, effect_pos };
                    }
                    effect_pos++;
                }
            }
        }
    }

    console.warn('[solver] boost_to_node_ref: unknown boost name:', boost_name);
    return { node_id: 0, effect_pos: 0 };
}

/**
 * Map (node_id, effect_pos) to boost name for decoding.
 * @param {number} node_id
 * @param {number} effect_pos
 * @param {Map} atree_merged
 * @returns {{name: string, is_calc: boolean}} boost name and whether it's a calculated boost
 */
function node_ref_to_boost_info(node_id, effect_pos, atree_merged) {
    // Check powder boosts
    if (_POWDER_BOOST_NAMES.has(node_id)) {
        return { name: _POWDER_BOOST_NAMES.get(node_id), is_calc: false };
    }

    // Look up atree node
    if (atree_merged && atree_merged.has(node_id)) {
        const abil = atree_merged.get(node_id);
        let pos = 0;
        for (const effect of abil.effects) {
            if (effect.type === 'raw_stat' && effect.toggle) {
                if (pos === effect_pos) {
                    const is_calc = abil.properties?.health_cost != null;
                    return { name: effect.toggle, is_calc };
                }
                pos++;
            } else if (effect.type === 'stat_scaling' && effect.slider === true && effect.slider_name) {
                if (pos === effect_pos) return { name: effect.slider_name, is_calc: false };
                pos++;
            }
        }
    }

    console.warn('[solver] node_ref_to_boost_info: unknown node_id/effect_pos:', node_id, effect_pos);
    return { name: '', is_calc: false };
}

/** Convenience wrapper — returns just the boost name string. */
function node_ref_to_boost_name(node_id, effect_pos, atree_merged) {
    return node_ref_to_boost_info(node_id, effect_pos, atree_merged).name;
}

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
