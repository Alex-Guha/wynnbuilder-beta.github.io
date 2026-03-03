/**
 * Solver-specific constants.
 * Shared slot/field definitions are in ../shared_constants.js (loaded first).
 */

const SOLVER_VERSION = "0.1.0";

// ── Lock toggle SVG icons ───────────────────────────────────────────────────

const LOCK_SVG   = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 6V4a3 3 0 0 0-6 0v2H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1zM7 4a1 1 0 0 1 2 0v2H7V4z"/></svg>';
const UNLOCK_SVG = '<svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor"><path d="M11 4a3 3 0 0 0-6 0H7a1 1 0 0 1 2 0v2H4a1 1 0 0 0-1 1v7a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V7a1 1 0 0 0-1-1h-1V4z"/></svg>';

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

let current_roll_mode = ROLL_DEFAULT;

/**
 * Stats available for use in restriction threshold rows.
 * Each entry: { key: <statMap key>, label: <display name> }
 * Ordered by category for readability in the autocomplete list.
 */
const RESTRICTION_STATS = [
    // ── Health / Sustain ────────────────────────────────────────────────
    { key: 'ehp',        label: 'Effective HP' },   // derived — computed during solver eval
    { key: 'hpBonus',    label: 'HP Bonus' },
    { key: 'hprRaw',     label: 'Health Regen' },
    { key: 'hprPct',     label: 'Health Regen %' },
    { key: 'healPct',    label: 'Heal Effectiveness %' },
    { key: 'ls',         label: 'Life Steal' },
    // ── Mana ────────────────────────────────────────────────────────────
    { key: 'mr',         label: 'Mana Regen' },
    { key: 'ms',         label: 'Mana Steal' },
    // ── Skill Points ────────────────────────────────────────────────────
    { key: 'str',        label: 'Strength' },
    { key: 'dex',        label: 'Dexterity' },
    { key: 'int',        label: 'Intelligence' },
    { key: 'def',        label: 'Defense' },
    { key: 'agi',        label: 'Agility' },
    // ── Damage (generic) ────────────────────────────────────────────────
    { key: 'sdRaw',      label: 'Spell Damage Raw' },
    { key: 'sdPct',      label: 'Spell Damage %' },
    { key: 'mdRaw',      label: 'Melee Damage Raw' },
    { key: 'mdPct',      label: 'Melee Damage %' },
    { key: 'damRaw',     label: 'Damage Raw' },
    { key: 'damPct',     label: 'Damage %' },
    { key: 'critDamPct', label: 'Crit Damage %' },
    // ── Elemental Damage % ──────────────────────────────────────────────
    { key: 'eDamPct',    label: 'Earth Damage %' },
    { key: 'tDamPct',    label: 'Thunder Damage %' },
    { key: 'wDamPct',    label: 'Water Damage %' },
    { key: 'fDamPct',    label: 'Fire Damage %' },
    { key: 'aDamPct',    label: 'Air Damage %' },
    // ── Elemental Damage Raw ────────────────────────────────────────────
    { key: 'eDamRaw',    label: 'Earth Damage Raw' },
    { key: 'tDamRaw',    label: 'Thunder Damage Raw' },
    { key: 'wDamRaw',    label: 'Water Damage Raw' },
    { key: 'fDamRaw',    label: 'Fire Damage Raw' },
    { key: 'aDamRaw',    label: 'Air Damage Raw' },
    // ── Elemental Spell Damage ──────────────────────────────────────────
    { key: 'eSdPct',     label: 'Earth Spell Damage %' },
    { key: 'tSdPct',     label: 'Thunder Spell Damage %' },
    { key: 'wSdPct',     label: 'Water Spell Damage %' },
    { key: 'fSdPct',     label: 'Fire Spell Damage %' },
    { key: 'aSdPct',     label: 'Air Spell Damage %' },
    { key: 'eSdRaw',     label: 'Earth Spell Damage Raw' },
    { key: 'tSdRaw',     label: 'Thunder Spell Damage Raw' },
    { key: 'wSdRaw',     label: 'Water Spell Damage Raw' },
    { key: 'fSdRaw',     label: 'Fire Spell Damage Raw' },
    { key: 'aSdRaw',     label: 'Air Spell Damage Raw' },
    // ── Elemental Melee Damage ──────────────────────────────────────────
    { key: 'eMdPct',     label: 'Earth Melee Damage %' },
    { key: 'tMdPct',     label: 'Thunder Melee Damage %' },
    { key: 'wMdPct',     label: 'Water Melee Damage %' },
    { key: 'fMdPct',     label: 'Fire Melee Damage %' },
    { key: 'aMdPct',     label: 'Air Melee Damage %' },
    { key: 'eMdRaw',     label: 'Earth Melee Damage Raw' },
    { key: 'tMdRaw',     label: 'Thunder Melee Damage Raw' },
    { key: 'wMdRaw',     label: 'Water Melee Damage Raw' },
    { key: 'fMdRaw',     label: 'Fire Melee Damage Raw' },
    { key: 'aMdRaw',     label: 'Air Melee Damage Raw' },
    // ── Rainbow Damage ──────────────────────────────────────────────────
    { key: 'rDamPct',    label: 'Elemental Damage %' },
    { key: 'rDamRaw',    label: 'Elemental Damage Raw' },
    { key: 'rSdRaw',     label: 'Elemental Spell Damage Raw' },
    { key: 'rSdPct',     label: 'Elemental Spell Damage %' },
    { key: 'rMdPct',     label: 'Elemental Melee Damage %' },
    { key: 'rMdRaw',     label: 'Elemental Melee Damage Raw' },
    // ── Spell Costs ─────────────────────────────────────────────────────
    { key: 'spRaw1',     label: '1st Spell Cost Raw' },
    { key: 'spRaw2',     label: '2nd Spell Cost Raw' },
    { key: 'spRaw3',     label: '3rd Spell Cost Raw' },
    { key: 'spRaw4',     label: '4th Spell Cost Raw' },
    { key: 'spPct1',     label: '1st Spell Cost %' },
    { key: 'spPct2',     label: '2nd Spell Cost %' },
    { key: 'spPct3',     label: '3rd Spell Cost %' },
    { key: 'spPct4',     label: '4th Spell Cost %' },
    // ── Movement ────────────────────────────────────────────────────────
    { key: 'spd',        label: 'Walk Speed Bonus' },
    { key: 'atkTier',    label: 'Attack Speed Bonus' },
    // ── Other Combat ────────────────────────────────────────────────────
    { key: 'poison',     label: 'Poison' },
    { key: 'thorns',     label: 'Thorns' },
    { key: 'expd',       label: 'Exploding' },
    { key: 'ref',        label: 'Reflection' },
    { key: 'spRegen',    label: 'Soul Point Regen' },
    { key: 'eSteal',     label: 'Stealing' },
    { key: 'sprint',     label: 'Sprint Bonus' },
    { key: 'sprintReg',  label: 'Sprint Regen Bonus' },
    { key: 'jh',         label: 'Jump Height' },
    { key: 'kb',          label: 'Knockback' },
    { key: 'weakenEnemy', label: 'Weaken Enemy' },
    { key: 'slowEnemy',   label: 'Slow Enemy' },
    // ── Loot / XP ───────────────────────────────────────────────────────
    { key: 'lb',          label: 'Loot Bonus' },
    { key: 'lq',          label: 'Loot Quality' },
    { key: 'xpb',         label: 'XP Bonus' },
];

/**
 * Returns the effective rolled value for a stat given the current roll percentage.
 * @param {number} minVal
 * @param {number} maxVal
 * @returns {number}
 */
function getRolledValue(minVal, maxVal) {
    if (current_roll_mode >= 100) return maxVal;
    if (current_roll_mode <= 0) return minVal;
    return Math.round(minVal + (current_roll_mode / 100) * (maxVal - minVal));
}
