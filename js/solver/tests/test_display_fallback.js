// ══════════════════════════════════════════════════════════════════════════════
// DISPLAY FALLBACK TEST
//
// Regression test for the bug where atree nodes like Regeneration override a
// damage spell's `display` field to a non-damage part name (e.g. "Heal Rate"),
// causing computeSpellDisplayAvg to return 0 damage.
//
// Fix: _find_display_result falls back to the last displayed damage part when
// the explicit display target is not a damage part.
//
// Run: node js/solver/tests/test_display_fallback.js
// Requires Node.js >= 18.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { createSandbox, loadGameData, TestRunner } = require('./harness');
const vm = require('vm');

const ctx = createSandbox();
loadGameData(ctx);
const t = new TestRunner('Display Fallback');

// ── Build a minimal stats map sufficient for calculateSpellDamage ────────────

function makeStats() {
    const stats = new Map();
    // Zero everything the damage pipeline reads.
    for (const k of ['str','dex','int','def','agi',
                     'sdPct','sdRaw','mdPct','mdRaw','damPct','damRaw','critDamPct',
                     'rSdPct','rSdRaw','rMdPct','rMdRaw','rDamPct','rDamRaw',
                     'hp','hpBonus','hprRaw','hprPct','classDef','defMultiplier',
                     'poison','spd','ls']) {
        stats.set(k, 0);
    }
    for (const e of ['n','e','t','w','f','a']) {
        stats.set(e + 'DamPct', 0); stats.set(e + 'DamRaw', 0);
        stats.set(e + 'SdPct', 0);  stats.set(e + 'SdRaw', 0);
        stats.set(e + 'MdPct', 0);  stats.set(e + 'MdRaw', 0);
        stats.set(e + 'DamAddMin', 0); stats.set(e + 'DamAddMax', 0);
    }
    stats.set('hp', 5000);
    stats.set('damMult',  new Map());
    stats.set('defMult',  new Map());
    stats.set('healMult', new Map());
    stats.set('poison',   0);
    stats.set('classDef', 1);
    stats.set('defMultiplier', 1);
    return stats;
}

function makeWeapon() {
    const w = new Map();
    w.set('nDam_', [100, 200]);
    for (const e of ['e','t','w','f','a']) w.set(e + 'Dam_', [0, 0]);
    w.set('atkSpd', 'NORMAL');
    w.set('type', 'relik');
    // damage_present_key — which elements the weapon itself contributes.
    // [neutral, e, t, w, f, a]
    w.set('damagePresent', [true, false, false, false, false, false]);
    return w;
}

// ── Totem spell post-Regeneration (display overridden to "Heal Rate") ────────
//
// Mirrors the shape produced by js/game/atree.js:906-998 when Totem + Regeneration
// are allocated: "Heal Tick" is appended as a new heal part, and spell.display
// is overwritten from "Tick DPS" to "Heal Rate".

function makeTotemWithRegeneration() {
    return {
        name: 'Totem',
        base_spell: 1,
        cost: 30,
        display: 'Heal Rate',  // ← overridden by Regeneration
        scaling: 'spell',
        parts: [
            { name: 'Tick Damage',         multipliers: [6, 0, 0, 0, 0, 6] },
            { name: 'Tick DPS (Per Totem)', hits: { 'Tick Damage': 2.5 } },
            { name: 'Heal Rate (Per Totem)', hits: { 'Heal Tick': 2.5 } },
            { name: 'Tick DPS',             hits: { 'Tick DPS (Per Totem)': 1 } },
            { name: 'Heal Rate',            hits: { 'Heal Rate (Per Totem)': 1 } },
            { name: 'Heal Tick', max_hp_heal_pct: 0.01 },  // ← added by Regeneration
        ],
    };
}

function makeTotemBaseline() {
    const s = makeTotemWithRegeneration();
    s.display = 'Tick DPS';
    s.parts = s.parts.filter(p => p.name !== 'Heal Tick');
    return s;
}

function makePureHealSpell() {
    return {
        name: 'PureHeal', base_spell: 99, display: 'Heal',
        scaling: 'spell',
        parts: [
            { name: 'Heal Tick', max_hp_heal_pct: 0.05 },
            { name: 'Heal',      hits: { 'Heal Tick': 3 } },
        ],
    };
}

// ── Totem + Totemic Smash variants (add "Smash Damage" flat part) ────────────

function makeTotemWithSmash() {
    const s = makeTotemBaseline();
    s.parts.push({ name: 'Smash Damage', multipliers: [120, 0, 0, 0, 30, 0] });
    return s;
}

function makeTotemWithSmashAndRegen() {
    const s = makeTotemWithRegeneration();
    s.parts.push({ name: 'Smash Damage', multipliers: [120, 0, 0, 0, 30, 0] });
    return s;
}

// ── Puppet Master + Exploding Puppets (add "Puppet Explosion" flat part) ─────

function makePuppetMaster() {
    return {
        name: 'Puppet Damage',
        base_spell: 6,
        display: 'Total Puppet DPS',
        scaling: 'spell',
        parts: [
            { name: 'Puppet Hit',       multipliers: [16, 2, 0, 0, 0, 2] },
            { name: 'Puppet DPS',       hits: { 'Puppet Hit': 2 } },
            { name: 'Total Puppet DPS', hits: { 'Puppet DPS': 3 } },
        ],
    };
}

function makePuppetMasterWithExplosion() {
    const s = makePuppetMaster();
    s.parts.push({ name: 'Puppet Explosion', multipliers: [150, 0, 0, 0, 50, 0] });
    return s;
}

// Post-per-puppet-fix shape: Puppet Explosion is a hits-chain wrapper over the
// per-puppet leaf; apply_spell_prop_overrides has resolved the hit count to
// num_explosion_puppets (default 3).
function makePuppetMasterWithExplosionPerPuppet(numExplosionPuppets, hideLeaf = false) {
    const s = makePuppetMaster();
    const leaf = { name: 'Puppet Explosion Per Puppet', multipliers: [150, 0, 0, 0, 50, 0] };
    if (hideLeaf) leaf.display = false;
    s.parts.push(leaf);
    s.parts.push({ name: 'Puppet Explosion', hits: { 'Puppet Explosion Per Puppet': numExplosionPuppets } });
    return s;
}

// ── Invoke computeSpellDisplayAvg inside the sandbox ─────────────────────────

function spellDisplayAvg(spell, stats, weapon, crit_chance) {
    ctx.__spell = spell;
    ctx.__stats = stats;
    ctx.__weapon = weapon;
    ctx.__cc = crit_chance;
    const r = vm.runInContext(
        'computeSpellDisplayAvg(__stats, __weapon, __spell, __cc)', ctx);
    delete ctx.__spell; delete ctx.__stats; delete ctx.__weapon; delete ctx.__cc;
    return r;
}

// ── Invoke compute_combo_damage_totals with a single row (qty=1, no boosts) ──

function comboTotals(spell, stats, weapon, crit_chance, qty, detailed = false) {
    const rows = [{ qty, spell, boost_tokens: [], dmg_excl: false, pseudo: null }];
    ctx.__stats = stats;
    ctx.__weapon = weapon;
    ctx.__rows = rows;
    ctx.__cc = crit_chance;
    ctx.__opts = { detailed };
    const r = vm.runInContext(
        'compute_combo_damage_totals(__stats, __weapon, __rows, __cc, [], new Map(), __opts)',
        ctx);
    delete ctx.__stats; delete ctx.__weapon; delete ctx.__rows; delete ctx.__cc; delete ctx.__opts;
    return r;
}

function spellIsDps(spell) {
    ctx.__s = spell;
    const r = vm.runInContext('spell_is_dps(__s)', ctx);
    delete ctx.__s;
    return r;
}

// ── Assertions ───────────────────────────────────────────────────────────────

const stats  = makeStats();
const weapon = makeWeapon();

const totemRegen     = makeTotemWithRegeneration();
const totemBaseline  = makeTotemBaseline();
const pureHeal       = makePureHealSpell();

const dmgBaseline = spellDisplayAvg(totemBaseline, stats, weapon, 0);
const dmgRegen    = spellDisplayAvg(totemRegen,    stats, weapon, 0);
const dmgPureHeal = spellDisplayAvg(pureHeal,      stats, weapon, 0);

t.assertGe(dmgBaseline, 1, 'Totem (no Regeneration): display="Tick DPS" → non-zero damage');
t.assertGe(dmgRegen,    1, 'Totem + Regeneration: display="Heal Rate" → falls back to damage part, non-zero');
t.assertClose(dmgRegen, dmgBaseline, 1e-9,
    'Totem + Regeneration damage equals baseline Totem damage (Heal Tick adds heal, not damage)');
t.assert(dmgPureHeal === 0,
    `Pure heal spell returns 0 damage (got ${dmgPureHeal})`);

// ── DPS structural detection (spell_is_dps) ──────────────────────────────────

t.assert(spellIsDps(totemBaseline) === true,
    'spell_is_dps: Totem baseline (display="Tick DPS") → true');
t.assert(spellIsDps(totemRegen) === true,
    'spell_is_dps: Totem + Regen (display="Heal Rate") → still true via structural detection');
t.assert(spellIsDps(pureHeal) === false,
    'spell_is_dps: pure heal spell → false');

// ── Combo damage totals: flat damage must count; Regen must not change it ───

const QTY = 30;  // simulate 30s totem duration
const baselineTotals = comboTotals(totemBaseline,       stats, weapon, 0, QTY);
const regenTotals    = comboTotals(totemRegen,          stats, weapon, 0, QTY);
const smashTotals    = comboTotals(makeTotemWithSmash(), stats, weapon, 0, QTY);
const smashRegenTotals = comboTotals(makeTotemWithSmashAndRegen(), stats, weapon, 0, QTY);

// Toggling Regeneration must not change damage totals (Regen is healing only).
t.assertClose(regenTotals.total_damage, baselineTotals.total_damage, 1e-9,
    'Totem: toggling Regeneration does not change total_damage');
t.assertClose(smashRegenTotals.total_damage, smashTotals.total_damage, 1e-9,
    'Totem + Totemic Smash: toggling Regeneration does not change total_damage');

// Adding Totemic Smash must strictly increase damage (flat part now contributes).
t.assertGe(smashTotals.total_damage, baselineTotals.total_damage + 1,
    'Totem + Totemic Smash: Smash Damage contributes to total (was previously dropped)');

// Flat damage should equal one cast of Smash (not qty-scaled).
// baseline_per_row.damage is the DPS value; smash row adds flat_per_cast once.
const prBase  = baselineTotals.per_row[0];
const prSmash = smashTotals.per_row[0];
t.assertClose(prSmash.damage, prBase.damage, 1e-9,
    'Totemic Smash: per_row.damage (DPS display) matches baseline (flat not qty-scaled into DPS)');
t.assertGe(prSmash.flat_damage, 1,
    'Totemic Smash: per_row.flat_damage is non-zero');
t.assertClose(smashTotals.total_damage - baselineTotals.total_damage,
    prSmash.flat_damage, 1e-9,
    'Totemic Smash: flat_damage added once (not qty-scaled)');

// Puppet Master + Exploding Puppets — same pattern.
const puppetTotals = comboTotals(makePuppetMaster(),              stats, weapon, 0, QTY);
const puppetExpTotals = comboTotals(makePuppetMasterWithExplosion(), stats, weapon, 0, QTY);
t.assertGe(puppetExpTotals.total_damage, puppetTotals.total_damage + 1,
    'Puppet Master + Exploding Puppets: Puppet Explosion contributes to total');
t.assertClose(puppetExpTotals.total_damage - puppetTotals.total_damage,
    puppetExpTotals.per_row[0].flat_damage, 1e-9,
    'Exploding Puppets: Puppet Explosion added once (not qty-scaled)');

// Per-puppet Puppet Explosion (post-fix shape): the hits-chain wrapper scales
// the per-puppet leaf by num_explosion_puppets. With 3 puppets the flat damage
// should be exactly 3× the single-puppet case.
const pe1 = comboTotals(makePuppetMasterWithExplosionPerPuppet(1), stats, weapon, 0, QTY);
const pe3 = comboTotals(makePuppetMasterWithExplosionPerPuppet(3), stats, weapon, 0, QTY);
t.assertClose(pe3.per_row[0].flat_damage, 3 * pe1.per_row[0].flat_damage, 1e-9,
    'Puppet Explosion: hits={Per Puppet: 3} yields 3× single-puppet flat damage');
// The raw multiplier shape (pre-fix) should match the 1-puppet case exactly
// (both represent a single explosion, no per-puppet scaling).
t.assertClose(pe1.per_row[0].flat_damage, puppetExpTotals.per_row[0].flat_damage, 1e-9,
    'Puppet Explosion: per-puppet wrapper (n=1) matches raw-multipliers shape');
// DPS display value must not change when the explosion wrapper is introduced.
t.assertClose(pe3.per_row[0].damage, puppetTotals.per_row[0].damage, 1e-9,
    'Puppet Explosion wrapper does not alter Total Puppet DPS display');

// With the per-puppet leaf marked hidden (matching the atree hide:true flag),
// the wrapper still contributes the same flat damage but the leaf is excluded
// from any display-filtered list (full_display.parts).
const peHide3 = comboTotals(makePuppetMasterWithExplosionPerPuppet(3, true), stats, weapon, 0, QTY, true);
t.assertClose(peHide3.per_row[0].flat_damage, pe3.per_row[0].flat_damage, 1e-9,
    'Hiding Per Puppet leaf does not change flat damage (wrapper is still the root)');
const hidePartNames = peHide3.per_row[0].full_display?.parts.map(p => p.name) ?? [];
t.assert(!hidePartNames.includes('Puppet Explosion Per Puppet'),
    `Hidden leaf is absent from full_display.parts (got: ${hidePartNames.join(', ')})`);
t.assert(hidePartNames.includes('Puppet Explosion'),
    'Puppet Explosion wrapper is still present in full_display.parts');

// ── combo_only slider fallback in atree_compute_scaling ─────────────────────

function runAtreeScaling(atree_merged) {
    ctx.__am = atree_merged;
    const r = vm.runInContext(
        'atree_compute_scaling(__am, new Map(), new Map(), new Map())', ctx);
    delete ctx.__am;
    return r;
}

// combo_only slider with no DOM state should fall back to slider_default.
const atreeComboOnly = new Map([[32, {
    display_name: 'Exploding Puppets',
    properties: { aoe: 3, num_explosion_puppets: 0 },
    effects: [
        { type: 'stat_scaling', slider: true, combo_only: true,
          slider_name: 'Puppets at Explosion', slider_default: 3,
          output: [{ type: 'prop', abil: 32, name: 'num_explosion_puppets' }],
          scaling: [1] },
    ],
}]]);
const [atreeEditCombo] = runAtreeScaling(atreeComboOnly);
t.assert(atreeEditCombo.get(32).properties.num_explosion_puppets === 3,
    `combo_only slider falls back to slider_default=3 on builder (got ${atreeEditCombo.get(32).properties.num_explosion_puppets})`);

// Regression: non-combo_only slider with no DOM state still resolves to 0.
const atreeNormal = new Map([[21, {
    display_name: 'Puppet Master',
    properties: { num_puppets: 0 },
    effects: [
        { type: 'stat_scaling', slider: true,
          slider_name: 'Active Puppets', slider_default: 3,
          output: [{ type: 'prop', abil: 21, name: 'num_puppets' }],
          scaling: [1] },
    ],
}]]);
const [atreeEditNormal] = runAtreeScaling(atreeNormal);
t.assert(atreeEditNormal.get(21).properties.num_puppets === 0,
    `non-combo_only slider with no DOM stays at 0 (regression check, got ${atreeEditNormal.get(21).properties.num_puppets})`);

const summary = t.summary();
if (require.main === module) {
    if (summary.fail > 0) process.exit(1);
}
