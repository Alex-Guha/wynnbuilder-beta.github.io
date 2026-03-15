/**
 * Shared game-stat constants and pure functions used by both the Builder and
 * Solver pages (and the solver Web Worker via importScripts).
 *
 * This file is DOM-free — no document/window/navigator references.
 *
 * Dependencies (must be loaded before this file):
 *   - utils.js:       rawToPct, rawToPctUncapped
 *   - build_utils.js: skp_elements, skillPointsToPercentage, skillpoint_final_mult,
 *                      reversedIDs
 */

// ── Class defense multipliers ────────────────────────────────────────────────

const classDefenseMultipliers = new Map([
    ["relik", 0.60], ["bow", 0.70], ["wand", 0.80], ["dagger", 1.0], ["spear", 1.0]
]);

// ── Boost button multipliers ─────────────────────────────────────────────────

const damageMultipliers = new Map([
    ["totem",          0.20],
    ["warscream",      0.00],
    ["emboldeningcry", 0.00],
    ["fortitude",      0.40],
    ["radiance",       0.00],
    ["eldritchcall",   0.00],
    ["divinehonor",    0.00],
]);

// ── Powder special names ─────────────────────────────────────────────────────

const specialNames = ["Quake", "Chain Lightning", "Curse", "Courage", "Wind Prison"];

// ── Stats scaled by Radiance / Divine Honor ──────────────────────────────────

const radiance_affected = [
    "fDef","wDef","aDef","tDef","eDef","hprPct","mr","sdPct","mdPct","ls","ms",
    "ref","thorns","expd","spd","atkTier","poison","hpBonus","spRegen","eSteal",
    "hprRaw","sdRaw","mdRaw","fDamPct","wDamPct","aDamPct","tDamPct","eDamPct",
    "fDefPct","wDefPct","aDefPct","tDefPct","eDefPct","fixID","category",
    "spPct1","spRaw1","spPct2","spRaw2","spPct3","spRaw3","spPct4","spRaw4",
    "rSdRaw","sprint","sprintReg","jh",
    "eMdPct","eMdRaw","eSdPct","eSdRaw","eDamRaw",
    "tMdPct","tMdRaw","tSdPct","tSdRaw","tDamRaw",
    "wMdPct","wMdRaw","wSdPct","wSdRaw","wDamRaw",
    "fMdPct","fMdRaw","fSdPct","fSdRaw","fDamRaw",
    "aMdPct","aMdRaw","aSdPct","aSdRaw","aDamRaw",
    "nMdPct","nMdRaw","nSdPct","nSdRaw","nDamPct","nDamRaw",
    "damPct","damRaw",
    "rMdPct","rMdRaw","rSdPct","rDamPct","rDamRaw",
    "critDamPct","healPct","kb","weakenEnemy","slowEnemy","rDefPct",
];

// ── Spell cost calculation ───────────────────────────────────────────────────

function getBaseSpellCost(stats, spell) {
    const bs = spell.mana_derived_from ?? spell.base_spell;
    const int_reduction = skillPointsToPercentage(stats.get('int') ?? 0) * skillpoint_final_mult[2];
    let cost = spell.cost * (1 - int_reduction);
    cost += (stats.get('spRaw' + bs) ?? 0);
    return cost * (1 + (stats.get('spPct' + bs) ?? 0) / 100);
}

function getSpellCost(stats, spell) {
    const bs = spell.mana_derived_from ?? spell.base_spell;
    const final_pct = stats.get('spPct' + bs + 'Final') ?? 0;
    return Math.max(1, getBaseSpellCost(stats, spell) * (1 + final_pct / 100));
}

// ── Defense stat calculation ─────────────────────────────────────────────────

/**
 * Get all defensive stats for a build.
 * Returns [totalHp, [ehp w/agi, ehp w/o agi], totalHpr, [ehpr w/agi, ehpr w/o agi],
 *          [def%, agi%], [edef, tdef, wdef, fdef, adef]]
 */
function getDefenseStats(stats) {
    let defenseStats = [];
    let def_pct = skillPointsToPercentage(stats.get('def')) * skillpoint_final_mult[3];
    let agi_pct = skillPointsToPercentage(stats.get('agi')) * skillpoint_final_mult[4];
    // total hp
    let totalHp = stats.get("hp") + stats.get("hpBonus");
    if (totalHp < 5) totalHp = 5;
    defenseStats.push(totalHp);
    // EHP
    let ehp = [totalHp, totalHp];
    let defMult = (2 - stats.get("classDef"));
    for (const [, v] of stats.get("defMult").entries()) {
        defMult *= (1 - v/100);
    }
    let agi_reduction = (100 - stats.get("agiDef")) / 100;
    ehp[0] = ehp[0] / (agi_reduction*agi_pct + (1-agi_pct) * (1-def_pct));
    ehp[0] /= defMult;
    ehp[1] /= (1-def_pct) * defMult;
    defenseStats.push(ehp);
    // HPR
    let totalHpr = rawToPct(stats.get("hprRaw"), stats.get("hprPct")/100.);
    defenseStats.push(totalHpr);
    // EHPR
    let ehpr = [totalHpr, totalHpr];
    ehpr[0] = ehpr[0] / (agi_reduction*agi_pct + (1-agi_pct) * (1-def_pct));
    ehpr[0] /= defMult;
    ehpr[1] /= (1-def_pct) * defMult;
    defenseStats.push(ehpr);
    // skp stats
    defenseStats.push([def_pct*100, agi_pct*100]);
    // elemental defenses
    let eledefs = [0, 0, 0, 0, 0];
    for (const i in skp_elements) {
        eledefs[i] = rawToPctUncapped(stats.get(skp_elements[i] + "Def"), (stats.get(skp_elements[i] + "DefPct") + stats.get("rDefPct"))/100.);
    }
    defenseStats.push(eledefs);
    return defenseStats;
}
