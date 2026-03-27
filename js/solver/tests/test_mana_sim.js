// Tests for simulate_combo_mana_fast / simulate_combo_mana_hp divergence.
// Verifies that the fast (allocation-light) and full simulation produce
// identical mana results for non-Blood-Pact inputs.
// Run: node js/solver/tests/test_mana_sim.js

'use strict';

const { createSandbox, TestRunner } = require('./harness');

const ctx = createSandbox();
const t = new TestRunner('Mana Simulation Divergence');

const simulate_combo_mana_hp = ctx.simulate_combo_mana_hp;
const simulate_combo_mana_fast = ctx.simulate_combo_mana_fast;

// DEFAULT_HEALTH_CONFIG is a const in pure/simulate.js and not accessible from outside
// the VM sandbox, so we replicate it here for the test.
const DEFAULT_HEALTH_CONFIG = Object.freeze({
    hp_casting: false, health_cost: 0, damage_boost: null,
    buff_states: [], exit_triggers: [],
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeStats(overrides = {}) {
    const defaults = {
        mr: 0, ms: 0, maxMana: 0, int: 0,
        hp: 1000, hpBonus: 0, hprRaw: 0, hprPct: 0,
        atkSpd: 'NORMAL', atkTier: 0,
    };
    const merged = { ...defaults, ...overrides };
    return new Map(Object.entries(merged));
}

function makeSpell(name, cost, opts = {}) {
    return {
        name,
        cost,
        base_spell: opts.base_spell ?? 1,
        scaling: opts.scaling ?? 'spell',
        mana_derived_from: opts.mana_derived_from ?? undefined,
        hp_cost: opts.hp_cost ?? 0,
    };
}

function makeRow(qty, spell, opts = {}) {
    return {
        qty,
        spell,
        boost_tokens: opts.boost_tokens ?? [],
        mana_excl: opts.mana_excl ?? false,
        pseudo: opts.pseudo ?? null,
        recast_penalty_per_cast: opts.recast_penalty_per_cast ?? 0,
    };
}

function assertManaMatch(label, rows, stats, has_trans) {
    const registry = [];
    const hc = DEFAULT_HEALTH_CONFIG;
    const full = simulate_combo_mana_hp(rows, stats, hc, has_trans, registry);
    const fast = simulate_combo_mana_fast(rows, stats, hc, has_trans, registry);

    const eps = 1e-9;
    t.assert(Math.abs(full.start_mana - fast.start_mana) < eps,
        `${label}: start_mana mismatch: full=${full.start_mana}, fast=${fast.start_mana}`);
    t.assert(Math.abs(full.end_mana - fast.end_mana) < eps,
        `${label}: end_mana mismatch: full=${full.end_mana}, fast=${fast.end_mana}`);
    t.assert(Math.abs(full.max_mana - fast.max_mana) < eps,
        `${label}: max_mana mismatch: full=${full.max_mana}, fast=${fast.max_mana}`);

    const full_hp_warn = full.row_results.some(r => r.hp_warning);
    t.assert(full_hp_warn === fast.has_hp_warning,
        `${label}: hp_warning mismatch: full=${full_hp_warn}, fast=${fast.has_hp_warning}`);
}

// ── Test cases ───────────────────────────────────────────────────────────────

// 1. Basic: 3 spells, no melee, no transcendence
{
    const stats = makeStats({ mr: 10, int: 50 });
    const rows = [
        makeRow(2, makeSpell('Spell 1', 30, { base_spell: 1 })),
        makeRow(1, makeSpell('Spell 2', 45, { base_spell: 2 })),
    ];
    assertManaMatch('Basic 3 spells', rows, stats, false);
}

// 2. Melee + mana steal
{
    const stats = makeStats({ mr: 5, ms: 12, int: 30, atkSpd: 'FAST' });
    const rows = [
        makeRow(1, makeSpell('Spell 1', 25, { base_spell: 1 })),
        makeRow(3, makeSpell('Melee', null, { base_spell: 0, scaling: 'melee', mana_derived_from: 0 })),
        makeRow(1, makeSpell('Spell 2', 40, { base_spell: 2 })),
    ];
    assertManaMatch('Melee + mana steal', rows, stats, false);
}

// 3. Transcendence: has_transcendence=true
{
    const stats = makeStats({ mr: 8, int: 40 });
    const rows = [
        makeRow(3, makeSpell('Spell 1', 50, { base_spell: 1 })),
        makeRow(2, makeSpell('Spell 2', 35, { base_spell: 2 })),
    ];
    assertManaMatch('Transcendence', rows, stats, true);
}

// 4. Add Flat Mana pseudo-spell: injects mana mid-combo
{
    const stats = makeStats({ mr: 5, int: 20 });
    const rows = [
        makeRow(2, makeSpell('Spell 1', 40, { base_spell: 1 })),
        makeRow(15, null, { pseudo: 'add_flat_mana' }),
        makeRow(1, makeSpell('Spell 2', 30, { base_spell: 2 })),
    ];
    assertManaMatch('Add Flat Mana', rows, stats, false);
}

// 5. High regen: mr/ms values that would exceed mana cap mid-combo
{
    const stats = makeStats({ mr: 200, ms: 50, int: 80, maxMana: 20, atkSpd: 'SUPER_FAST' });
    const rows = [
        makeRow(1, makeSpell('Spell 1', 10, { base_spell: 1 })),
        makeRow(5, makeSpell('Melee', null, { base_spell: 0, scaling: 'melee', mana_derived_from: 0 })),
        makeRow(1, makeSpell('Spell 2', 10, { base_spell: 2 })),
    ];
    assertManaMatch('High regen (mana cap)', rows, stats, false);
}

// 6. Edge: empty combo (no rows)
{
    const stats = makeStats({ mr: 10, int: 50 });
    assertManaMatch('Empty combo', [], stats, false);
}

// 7. Transcendence castability gate: spell cost > mana but < mana after 0.75
//    Should trigger mana warning because castability is checked before reduction.
{
    // Starting mana = 100 (base) + 0 (maxMana) + 0 (int) = 100.
    // Spell cost = 120. adj_cost = 90 (with transcendence).
    // 100 < 120 → not castable → mana warning, even though 100 >= 90 would pass old logic.
    const stats = makeStats({ mr: 0, int: 0 });
    const rows = [
        makeRow(1, makeSpell('Expensive Spell', 120, { base_spell: 1 })),
    ];
    const registry = [];
    const hc = DEFAULT_HEALTH_CONFIG;
    const full = simulate_combo_mana_hp(rows, stats, hc, true, registry, undefined, 0);
    const fast = simulate_combo_mana_fast(rows, stats, hc, true, registry, undefined, 0);

    const full_mana_warn = full.row_results.some(r => r.mana_warning);
    t.assert(full_mana_warn,
        'Transcendence gate (full): should warn when mana < effective_cost');
    t.assert(fast.has_mana_warning,
        'Transcendence gate (fast): should warn when mana < effective_cost');
}

// ── Summary ──────────────────────────────────────────────────────────────────
t.summary();
