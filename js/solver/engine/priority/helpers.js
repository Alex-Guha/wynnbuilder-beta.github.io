// ── Priority helpers — shared utilities, constants, mana estimators ─────────
//
// Loaded before the rest of the priority/ files — all symbols are plain
// globals consumed across sensitivity.js, priority.js, dominance.js.
//
// Dependencies (loaded before this file):
//   - pure/engine.js:    INDIRECT_CONSTRAINT_STATS, eval_indirect_stat
//   - pure/simulate.js:  (mana balance uses BASE_MANA_REGEN, MANA_TICK_SECONDS,
//                        baseDamageMultiplier, attackSpeeds — defined upstream)
//   - build_utils.js:    skillPointsToPercentage

// Scaling fractions for constraint/mana bonuses relative to max sensitivity weight.
const _CONSTRAINT_WEIGHT_FRACTION = 1.0;
// Floor on the `scale` factor in direct-constraint bonuses so that a satisfied
// constraint still exerts a small push in the relieving direction — otherwise
// nothing protects the slack from being eroded by items that hurt the stat.
const _CONSTRAINT_SATISFIED_FLOOR = 0.1;
const _MANA_WEIGHT_FRACTION = 3;
const _MANA_RATIO_EXPONENT = 0.5;

// Dampening factor for SP provision sensitivities.
// Item SP provisions don't translate 1:1 to actual allocated SP — they reduce
// requirement burden indirectly, and the freed budget may not all be allocated.
const _SP_SENSITIVITY_DAMPEN = 0.4;

// Scale factor for SP feasibility bonus.  Multiplied against
// max_abs × pressure × (per-index demand share) to produce per-unit
// SP sensitivity.  Higher → SP-providing items compete more strongly
// with damage items when SP budget is tight.
const _SP_FEASIBILITY_SCALE = 3;


// Stats that are computed from the full build (not direct item stats) —
// excluded from constraint weights and dominance check_stats.
// Shared constant from pure/engine.js: INDIRECT_CONSTRAINT_STATS
const _INDIRECT_CONSTRAINT_STATS = INDIRECT_CONSTRAINT_STATS;

// Mapping from indirect constraint stats to the direct item stats that contribute to them.
const _INDIRECT_CONTRIBUTORS = {
    ehp: ['hpBonus', 'hp'],
    ehp_no_agi: ['hpBonus', 'hp'],
    total_hp: ['hpBonus', 'hp'],
    hpr: ['hprRaw', 'hprPct'],
    ehpr: ['hpBonus', 'hprRaw', 'hprPct', 'hp'],
    // TODO 'finalSpellCost1', 'finalSpellCost2', 'finalSpellCost3', 'finalSpellCost4',
};

// Dampening for indirect constraint sensitivity — indirect stats are noisier
// (non-linear EHP formula, def% interaction) so we reduce their weight.
const _INDIRECT_SENS_SCALE = 0.5;

// Mapping from indirect stats to SP indices that affect them via skillPointsToPercentage.
// def (3) and agi (4) affect EHP/EHPR through defense% and agility% in getDefenseStats.
const _INDIRECT_SP_CONTRIBUTORS = {
    ehp: [3, 4],       // def%, agi%
    ehp_no_agi: [3],   // def% only (agi excluded by definition)
    ehpr: [3, 4],      // def%, agi%
    // total_hp, hpr: not affected by SP
};

// eval_indirect_stat() — shared from pure/engine.js
// Local alias for underscore-prefixed call sites.
const _eval_indirect_stat = eval_indirect_stat;

// ── Item stat helpers ────────────────────────────────────────────────────────

/**
 * Read a stat's contribution from an item statMap.
 * Checks maxRolls first (rolled stats), then falls back to direct properties (static stats).
 */
function _item_stat_val(item_sm, stat) {
    const v = item_sm.get('maxRolls')?.get(stat);
    return v !== undefined ? v : (item_sm.get(stat) ?? 0);
}

// ── Perturbation constants (used by sensitivity + dominance) ────────────────

// Minimal statMap for empty equipment slots — has the fields calculate_skillpoints needs.
const _NONE_EQUIP_SM = new Map([
    ['skillpoints', [0, 0, 0, 0, 0]],
    ['reqs', [0, 0, 0, 0, 0]],
    ['set', null],
    ['NONE', true],
]);

// Stats that can be perturbed on combo_base directly (fast-tier: additive after
// atree scaling, so perturbing combo_base is equivalent to perturbing the item).
const _PERTURBABLE_STATS = [
    // Generic damage
    'sdPct', 'sdRaw', 'mdPct', 'mdRaw', 'damPct', 'damRaw', 'critDamPct',
    // Per-element (5 × 6)
    ...['e', 't', 'w', 'f', 'a'].flatMap(e => [
        e + 'DamPct', e + 'DamRaw', e + 'SdPct', e + 'SdRaw', e + 'MdPct', e + 'MdRaw',
    ]),
    // Rainbow
    'rSdPct', 'rSdRaw', 'rMdPct', 'rMdRaw', 'rDamPct', 'rDamRaw',
    // Attack
    'atkTier',
    // Defense
    'hpBonus', 'hp', 'eDef', 'tDef', 'wDef', 'fDef', 'aDef', 'hprRaw', 'hprPct',
    // Mana
    'mr', 'ms', 'maxMana',
    // Spell costs
    'spPct1', 'spPct2', 'spPct3', 'spPct4', 'spRaw1', 'spRaw2', 'spRaw3', 'spRaw4',
    // Utility
    'spd', 'poison', 'lb', 'xpb', 'healPct', 'ls',
    // Neutral damage
    'nDamPct', 'nDamRaw', 'nSdPct', 'nSdRaw', 'nMdPct', 'nMdRaw',
    // Gathering / range
    'gXp', 'gSpd', 'mainAttackRange',
];

// Default delta values when fewer than 3 items in pools have a stat.
const _DEFAULT_DELTAS = {
    sdPct: 25, sdRaw: 150, mdPct: 25, mdRaw: 150,
    damPct: 20, damRaw: 100, critDamPct: 30,
    eDamPct: 20, tDamPct: 20, wDamPct: 20, fDamPct: 20, aDamPct: 20,
    eDamRaw: 100, tDamRaw: 100, wDamRaw: 100, fDamRaw: 100, aDamRaw: 100,
    eSdPct: 20, tSdPct: 20, wSdPct: 20, fSdPct: 20, aSdPct: 20,
    eSdRaw: 100, tSdRaw: 100, wSdRaw: 100, fSdRaw: 100, aSdRaw: 100,
    eMdPct: 20, tMdPct: 20, wMdPct: 20, fMdPct: 20, aMdPct: 20,
    eMdRaw: 100, tMdRaw: 100, wMdRaw: 100, fMdRaw: 100, aMdRaw: 100,
    rSdPct: 15, rSdRaw: 80, rMdPct: 15, rMdRaw: 80,
    rDamPct: 15, rDamRaw: 80,
    hpBonus: 500, hp: 1000, hprRaw: 50, hprPct: 20,
    eDef: 50, tDef: 50, wDef: 50, fDef: 50, aDef: 50,
    mr: 15, ms: 10, maxMana: 5,
    spPct1: 20, spPct2: 20, spPct3: 20, spPct4: 20,
    spRaw1: 5, spRaw2: 5, spRaw3: 5, spRaw4: 5,
    atkTier: 1,
    spd: 20, poison: 3000, lb: 30, xpb: 20, healPct: 20, ls: 100,
    nDamPct: 20, nDamRaw: 100, nSdPct: 20, nSdRaw: 100, nMdPct: 20, nMdRaw: 100,
    gXp: 20, gSpd: 20, mainAttackRange: 20,
    sp: 5
};

// ── Mana balance estimators (shared by sensitivity + dominance) ─────────────

/**
 * Estimate mana balance from locked items + combo, mirroring worker's
 * simulate_combo_mana_fast (pure/simulate.js).  Returns an object with mana budget
 * breakdown, or null when no mana gate applies (Blood Pact / no combo_time).
 *
 * When combo_base is null/undefined, falls back to worst-case assumptions
 * (0 mr/ms/int/maxMana from equipment) so dominance pruning with legacy
 * weights remains conservative.
 */
function _estimate_mana_balance(snap, combo_base) {
    if (snap.hp_casting) return null;
    const combo_time = snap.combo_time ?? 0;
    if (!combo_time) return null;

    // Start mana: 100 + int bonus + maxMana (matching worker pure/simulate.js)
    const int_mana = combo_base
        ? Math.floor(skillPointsToPercentage(combo_base.get('int') ?? 0) * 100)
        : 0;
    const item_mana = combo_base ? (combo_base.get('maxMana') ?? 0) : 0;
    const start_mana = 100 + int_mana + item_mana;
    const max_mana = start_mana;

    // MR regen (matching worker pure/simulate.js)
    const mr = combo_base ? (combo_base.get('mr') ?? 0) : 0;
    const mr_per_sec = (mr + BASE_MANA_REGEN) / MANA_TICK_SECONDS;
    const regen_mana = mr_per_sec * combo_time;

    // MS contribution: estimate mana steal from melee-scaling hits
    const ms = combo_base ? (combo_base.get('ms') ?? 0) : 0;
    let ms_mana = 0;
    if (ms !== 0 && combo_base) {
        let adjAtkSpd = attackSpeeds.indexOf(combo_base.get('atkSpd'))
            + (combo_base.get('atkTier') ?? 0);
        adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
        const ms_per_hit = ms / 3 / baseDamageMultiplier[adjAtkSpd];

        for (const { sim_qty, spell, mana_excl } of (snap.parsed_combo ?? [])) {
            if (mana_excl || !spell) continue;
            if (spell.scaling === 'melee') {
                ms_mana += ms_per_hit * Math.round(sim_qty);
            }
        }
    }

    // Total spell costs (base costs, no int reduction — overestimates = safe)
    let total_cost = 0;
    for (const { sim_qty, spell, mana_excl, recast_penalty_per_cast } of (snap.parsed_combo ?? [])) {
        if (mana_excl || !spell || spell.cost == null) continue;
        total_cost += spell.cost * sim_qty;
        if (recast_penalty_per_cast) total_cost += recast_penalty_per_cast * sim_qty;
    }

    const end_mana = Math.min(max_mana, start_mana - total_cost + regen_mana + ms_mana);

    return { start_mana, max_mana, end_mana, total_cost, regen_mana, ms_mana };
}

/**
 * Returns true when the combo's mana budget is tight enough that mr/ms
 * should be considered in priority weighting and dominance pruning.
 *
 * When combo_base is provided, uses locked items' mr/ms/int/maxMana for an
 * accurate estimate.  When absent, falls back to worst-case (0 equipment
 * contribution) — conservative for dominance, since "mana is tight" ⇒ more
 * stats enter the dominance set, never fewer.
 */
function _estimate_mana_tight(snap, combo_base) {
    const bal = _estimate_mana_balance(snap, combo_base);
    if (!bal) return false;

    if (snap.allow_downtime) {
        return bal.end_mana < 0;                // net negative → need mr/ms
    } else {
        return (bal.start_mana - bal.end_mana) > 5;  // deficit > 5 → not sustainable
    }
}

// Test exports (Node.js only)
if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        _item_stat_val,
        _INDIRECT_CONSTRAINT_STATS,
    };
}
