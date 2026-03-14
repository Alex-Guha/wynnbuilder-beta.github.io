/**
 * Solver-specific constants.
 * Shared slot/field definitions are in ../shared_constants.js (loaded first).
 */

// ── Lock toggle SVG icons ───────────────────────────────────────────────────

const LOCK_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 6V4a3 3 0 0 0-6 0v2H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1zM7 4a1 1 0 0 1 2 0v2H7V4z"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 4a3 3 0 0 0-6 0H7a1 1 0 0 1 2 0v2H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4z"/></svg>';

// ── Encoding limits (derived from binary URL format bit widths) ──────────────
// These caps prevent silent truncation when values are encoded into the URL hash.
// Mirror of the bit widths in encodeSolverParams() / decodeSolverParams()
// in build_encode.js / build_decode.js — keep them in sync.

/** 26-bit signed 2's complement: ±33,554,431 (size class 3, rarely used) */
const RESTR_VALUE_MAX = 33554431;
const RESTR_VALUE_MIN = -33554431;

/** 10-bit unsigned: combo time in seconds */
const CTIME_MAX = 1023;

/** 10-bit signed: flat mana per cycle */
const FLAT_MANA_MIN = -512;
const FLAT_MANA_MAX = 511;

/** 7-bit unsigned: combo row quantity */
const COMBO_QTY_MAX = 127;

/** 7-bit unsigned: boost slider value */
const BOOST_SLIDER_MAX = 127;

/** Max rows for restrictions / blacklist (4-bit count = 0-15) */
const MAX_RESTRICTION_ROWS = 15;
/** Max combo rows (8-bit count = 0-255) */
const MAX_COMBO_ROWS = 255;
const MAX_BLACKLIST_ROWS = 15;

// ── Spell recast penalty ──────────────────────────────────────────────────────

/** Mana penalty per consecutive recast of the same spell (+5 per recast). */
const RECAST_MANA_PENALTY = 5;

/**
 * Internal spell ID for the "Mana Reset" pseudo-spell.
 * Represents a timeout / pause that resets the recast counter.
 */
const MANA_RESET_SPELL_ID = -2000;

/** Reserved 7-bit node ID for Mana Reset in binary URL encoding. */
const MANA_RESET_NODE_ID = 126;

/**
 * Internal spell ID for the "Cancel Bak'al's Grasp" pseudo-spell.
 * Ends corruption state; if Exhilarate is taken, heals 30% of corruption bar.
 */
const CANCEL_BAKALS_SPELL_ID = -2001;

/** Reserved 7-bit node ID for Cancel Bak'al's Grasp in binary URL encoding. */
const CANCEL_BAKALS_NODE_ID = 119;

// ── Solver-specific constants ────────────────────────────────────────────────

/**
 * Roll percentage (0-100) controlling which value in the rolled ID range is
 * used when evaluating items during the solve.
 *   100 → use maxRolls  (matches WynnBuilder default)
 *    85 → minRolls + 0.85 * (maxRolls - minRolls) (solver default)
 *    50 → (minRolls + maxRolls) / 2
 *     0 → use minRolls
 */
const ROLL_DEFAULT = 85;

/** Per-group default roll percentages. */
const ROLL_GROUP_DEFAULTS = { damage: 85, mana: 100, healing: 85, misc: 85 };

/** Ordered list of roll group keys (used for encoding/iteration). */
const ROLL_GROUP_ORDER = ['damage', 'mana', 'healing', 'misc'];

/** Display labels for each roll group. */
const ROLL_GROUP_LABELS = { damage: 'Damage', mana: 'Mana', healing: 'Healing', misc: 'Misc' };

/**
 * Mapping from stat key → roll group name.
 * Stats not listed here fall into 'misc'.
 */
const ROLL_STAT_GROUP = (() => {
    const m = {};
    // Damage stats
    for (const k of [
        'sdPct', 'mdPct', 'sdRaw', 'mdRaw', 'damPct', 'damRaw', 'critDamPct', 'poison', 'atkTier',
        'nDamPct', 'nDamRaw', 'rDamPct', 'rDamRaw',
    ]) m[k] = 'damage';
    for (const e of ['e', 't', 'w', 'f', 'a']) {
        m[e + 'DamPct'] = 'damage'; m[e + 'DamRaw'] = 'damage';
        m[e + 'SdPct'] = 'damage'; m[e + 'SdRaw'] = 'damage';
        m[e + 'MdPct'] = 'damage'; m[e + 'MdRaw'] = 'damage';
        m[e + 'DamAddMin'] = 'damage'; m[e + 'DamAddMax'] = 'damage';
    }
    for (const e of ['n', 'r', '']) {
        m[e + 'DamAddMin'] = 'damage'; m[e + 'DamAddMax'] = 'damage';
    }
    for (const e of ['n', 'r']) {
        m[e + 'SdPct'] = 'damage'; m[e + 'SdRaw'] = 'damage';
        m[e + 'MdPct'] = 'damage'; m[e + 'MdRaw'] = 'damage';
    }
    // Mana stats
    for (const k of [
        'mr', 'ms', 'maxMana',
        'spPct1', 'spPct2', 'spPct3', 'spPct4',
        'spRaw1', 'spRaw2', 'spRaw3', 'spRaw4',
        'spPct1Final', 'spPct2Final', 'spPct3Final', 'spPct4Final',
    ]) m[k] = 'mana';
    // Healing stats
    for (const k of ['hprPct', 'hprRaw', 'healPct', 'ls', 'hpBonus']) m[k] = 'healing';
    return m;
})();

/** Look up the roll group for a given stat key. */
function _get_roll_group(statKey) {
    return ROLL_STAT_GROUP[statKey] || 'misc';
}

/**
 * Per-group roll mode. Each key is a group name, value is 0-100.
 * Replaces the old scalar `current_roll_mode`.
 */
let current_roll_mode = { ...ROLL_GROUP_DEFAULTS };

/** Returns true if all roll groups match their defaults. */
function isRollDefault() {
    for (const g of ROLL_GROUP_ORDER) {
        if (current_roll_mode[g] !== ROLL_GROUP_DEFAULTS[g]) return false;
    }
    return true;
}

/** Returns true if all groups share the same value. */
function _isRollUniform() {
    const v = current_roll_mode[ROLL_GROUP_ORDER[0]];
    return ROLL_GROUP_ORDER.every(g => current_roll_mode[g] === v);
}

/**
 * Returns display text for the roll mode input.
 * "Default" when at defaults, "N%" when uniform non-default, "Custom" otherwise.
 */
function rollDisplayText() {
    if (isRollDefault()) return 'Default';
    if (_isRollUniform()) return current_roll_mode.damage + '%';
    return 'Custom';
}

/** Returns true if ALL groups are >= 100 (i.e. no rolling needed). */
function _allRollsMax() {
    return ROLL_GROUP_ORDER.every(g => current_roll_mode[g] >= 100);
}

/**
 * Stats available for use in restriction threshold rows.
 * Each entry: { key: <statMap key>, label: <display name> }
 * Ordered by category for readability in the autocomplete list.
 *
 * WARNING: The order of entries in this array is LOAD-BEARING for URL encoding.
 * Solver URLs encode restriction stats by their index in this array.
 * NEVER reorder or remove existing entries — only append new ones at the end.
 * Reordering requires a solver URL version bump.
 */
const RESTRICTION_STATS = [
    // ── Health / Sustain ────────────────────────────────────────────────
    { key: 'ehp', label: 'Effective HP' },          // derived — computed during solver eval
    { key: 'ehp_no_agi', label: 'Effective HP (No Agi)' }, // derived — EHP without agility dodge
    { key: 'ehpr', label: 'Effective HPR' },         // derived — computed during solver eval
    { key: 'hpr', label: 'HP Regen' },              // derived — hprRaw + hprPct combined
    { key: 'total_hp', label: 'Total HP' },              // derived — hp + hpBonus
    { key: 'hprRaw', label: 'Health Regen Raw' },
    { key: 'hprPct', label: 'Health Regen %' },
    { key: 'healPct', label: 'Heal Effectiveness %' },
    { key: 'ls', label: 'Life Steal' },
    // ── Mana ────────────────────────────────────────────────────────────
    { key: 'mr', label: 'Mana Regen' },
    { key: 'ms', label: 'Mana Steal' },
    // ── Skill Points ────────────────────────────────────────────────────
    { key: 'str', label: 'Strength' },
    { key: 'dex', label: 'Dexterity' },
    { key: 'int', label: 'Intelligence' },
    { key: 'def', label: 'Defense' },
    { key: 'agi', label: 'Agility' },
    // ── Damage (generic) ────────────────────────────────────────────────
    { key: 'sdRaw', label: 'Spell Damage Raw' },
    { key: 'sdPct', label: 'Spell Damage %' },
    { key: 'mdRaw', label: 'Melee Damage Raw' },
    { key: 'mdPct', label: 'Melee Damage %' },
    { key: 'damRaw', label: 'Damage Raw' },
    { key: 'damPct', label: 'Damage %' },
    { key: 'critDamPct', label: 'Crit Damage %' },
    // ── Elemental Damage % ──────────────────────────────────────────────
    { key: 'eDamPct', label: 'Earth Damage %' },
    { key: 'tDamPct', label: 'Thunder Damage %' },
    { key: 'wDamPct', label: 'Water Damage %' },
    { key: 'fDamPct', label: 'Fire Damage %' },
    { key: 'aDamPct', label: 'Air Damage %' },
    // ── Elemental Damage Raw ────────────────────────────────────────────
    { key: 'eDamRaw', label: 'Earth Damage Raw' },
    { key: 'tDamRaw', label: 'Thunder Damage Raw' },
    { key: 'wDamRaw', label: 'Water Damage Raw' },
    { key: 'fDamRaw', label: 'Fire Damage Raw' },
    { key: 'aDamRaw', label: 'Air Damage Raw' },
    // ── Elemental Spell Damage ──────────────────────────────────────────
    { key: 'eSdPct', label: 'Earth Spell Damage %' },
    { key: 'tSdPct', label: 'Thunder Spell Damage %' },
    { key: 'wSdPct', label: 'Water Spell Damage %' },
    { key: 'fSdPct', label: 'Fire Spell Damage %' },
    { key: 'aSdPct', label: 'Air Spell Damage %' },
    { key: 'eSdRaw', label: 'Earth Spell Damage Raw' },
    { key: 'tSdRaw', label: 'Thunder Spell Damage Raw' },
    { key: 'wSdRaw', label: 'Water Spell Damage Raw' },
    { key: 'fSdRaw', label: 'Fire Spell Damage Raw' },
    { key: 'aSdRaw', label: 'Air Spell Damage Raw' },
    // ── Elemental Melee Damage ──────────────────────────────────────────
    { key: 'eMdPct', label: 'Earth Melee Damage %' },
    { key: 'tMdPct', label: 'Thunder Melee Damage %' },
    { key: 'wMdPct', label: 'Water Melee Damage %' },
    { key: 'fMdPct', label: 'Fire Melee Damage %' },
    { key: 'aMdPct', label: 'Air Melee Damage %' },
    { key: 'eMdRaw', label: 'Earth Melee Damage Raw' },
    { key: 'tMdRaw', label: 'Thunder Melee Damage Raw' },
    { key: 'wMdRaw', label: 'Water Melee Damage Raw' },
    { key: 'fMdRaw', label: 'Fire Melee Damage Raw' },
    { key: 'aMdRaw', label: 'Air Melee Damage Raw' },
    // ── Rainbow Damage ──────────────────────────────────────────────────
    { key: 'rDamPct', label: 'Elemental Damage %' },
    { key: 'rDamRaw', label: 'Elemental Damage Raw' },
    { key: 'rSdRaw', label: 'Elemental Spell Damage Raw' },
    { key: 'rSdPct', label: 'Elemental Spell Damage %' },
    { key: 'rMdPct', label: 'Elemental Melee Damage %' },
    { key: 'rMdRaw', label: 'Elemental Melee Damage Raw' },
    // ── Spell Costs ─────────────────────────────────────────────────────
    { key: 'spRaw1', label: '1st Spell Cost Raw' },
    { key: 'spRaw2', label: '2nd Spell Cost Raw' },
    { key: 'spRaw3', label: '3rd Spell Cost Raw' },
    { key: 'spRaw4', label: '4th Spell Cost Raw' },
    { key: 'spPct1', label: '1st Spell Cost %' },
    { key: 'spPct2', label: '2nd Spell Cost %' },
    { key: 'spPct3', label: '3rd Spell Cost %' },
    { key: 'spPct4', label: '4th Spell Cost %' },
    // ── Movement ────────────────────────────────────────────────────────
    { key: 'spd', label: 'Walk Speed Bonus' },
    { key: 'atkTier', label: 'Attack Speed Bonus' },
    // ── Other Combat ────────────────────────────────────────────────────
    { key: 'poison', label: 'Poison' },
    { key: 'thorns', label: 'Thorns' },
    { key: 'expd', label: 'Exploding' },
    { key: 'ref', label: 'Reflection' },
    { key: 'spRegen', label: 'Soul Point Regen' },
    { key: 'eSteal', label: 'Stealing' },
    { key: 'sprint', label: 'Sprint Bonus' },
    { key: 'sprintReg', label: 'Sprint Regen Bonus' },
    { key: 'jh', label: 'Jump Height' },
    { key: 'kb', label: 'Knockback' },
    { key: 'weakenEnemy', label: 'Weaken Enemy' },
    { key: 'slowEnemy', label: 'Slow Enemy' },
    // ── Loot / XP ───────────────────────────────────────────────────────
    { key: 'lb', label: 'Loot Bonus' },
    { key: 'lq', label: 'Loot Quality' },
    { key: 'xpb', label: 'XP Bonus' },
    // ── Final Spell Costs (computed — depends on int, spRaw, spPct, atree) ──
    { key: 'finalSpellCost1', label: '1st Spell Cost (Final)' },
    { key: 'finalSpellCost2', label: '2nd Spell Cost (Final)' },
    { key: 'finalSpellCost3', label: '3rd Spell Cost (Final)' },
    { key: 'finalSpellCost4', label: '4th Spell Cost (Final)' },
];

/**
 * Returns the effective rolled value for a stat given the current roll percentage.
 * @param {number} minVal
 * @param {number} maxVal
 * @param {string} [statKey] - stat identifier to look up the roll group (optional; defaults to 'misc')
 * @returns {number}
 */
function getRolledValue(minVal, maxVal, statKey) {
    const pct = current_roll_mode[_get_roll_group(statKey)] ?? current_roll_mode.misc ?? 100;
    if (pct >= 100) return maxVal;
    if (pct <= 0) return minVal;
    return Math.round(minVal + (pct / 100) * (maxVal - minVal));
}
