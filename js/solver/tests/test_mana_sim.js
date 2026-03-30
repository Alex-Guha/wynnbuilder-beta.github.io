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
        recast_penalties: opts.recast_penalties ?? null,
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

// 2b. Melee + NEGATIVE mana steal (items with ms < 0 drain mana per hit)
{
    const stats = makeStats({ mr: 5, ms: -24, int: 30, atkSpd: 'FAST' });
    const rows = [
        makeRow(1, makeSpell('Spell 1', 25, { base_spell: 1 })),
        makeRow(3, makeSpell('Melee', null, { base_spell: 0, scaling: 'melee', mana_derived_from: 0 })),
        makeRow(1, makeSpell('Spell 2', 40, { base_spell: 2 })),
    ];
    assertManaMatch('Melee + negative mana steal', rows, stats, false);
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

// ── Vanish / Manic Edge tests ────────────────────────────────────────────────

// Helper: create a health_config with Vanish buff_state (optionally with Manic Edge)
function makeVanishConfig(opts = {}) {
    const bs = {
        state_name: 'Vanished',
        activate_on: { spell: 2 },  // base_spell 2 = Dash
        deactivate: 'next_action',
        slider_name: 'Mana Lost',
        suppress_healing: true,
        suppress_mana_regen: true,
        drain_pct_per_second: opts.mana_drain ? { mana: 5 } : null,
        compute_delay: opts.mana_drain ?? false,
        apply_to_next: opts.mana_drain ?? false,
        duration: 5,
        value_cap: opts.value_cap ?? 26,
        spell_rate_field: null,
        spell_flat_field: null,
    };
    return {
        hp_casting: false, health_cost: 0, damage_boost: null,
        buff_states: [bs], exit_triggers: [],
    };
}

function assertManaMatchHC(label, rows, stats, hc, has_trans) {
    const registry = [];
    const full = simulate_combo_mana_hp(rows, stats, hc, has_trans, registry);
    const fast = simulate_combo_mana_fast(rows, stats, hc, has_trans, registry);

    const eps = 1e-6;
    t.assert(Math.abs(full.end_mana - fast.end_mana) < eps,
        `${label}: end_mana mismatch: full=${full.end_mana}, fast=${fast.end_mana}`);
    t.assert(Math.abs(full.total_mana_drain - fast.total_mana_drain) < eps,
        `${label}: total_mana_drain mismatch: full=${full.total_mana_drain}, fast=${fast.total_mana_drain}`);
    return full;
}

// 8. Vanish mana suppression — mana regen stops between Dash and next spell
{
    const stats = makeStats({ mr: 10, int: 0 });
    const hc = makeVanishConfig({ mana_drain: false });
    const dashSpell = makeSpell('Dash', 25, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 30, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(1, attackSpell),
    ];

    const full = assertManaMatchHC('Vanish mana suppression', rows, stats, hc, false);
    // Mana regen should have been suppressed between Dash and Attack.
    // Without vanish: start=100, pay 25 → 75, regen during gap, pay 30.
    // With vanish: start=100, pay 25 (activates Vanished), NO regen during gap, pay 30 → 45.
    // The exact end_mana depends on timing, but should be less than without suppression.
    const fullNoVanish = simulate_combo_mana_hp(rows, stats, DEFAULT_HEALTH_CONFIG, false, []);
    t.assert(full.end_mana < fullNoVanish.end_mana,
        `Vanish suppression: mana should be lower with vanish (${full.end_mana}) than without (${fullNoVanish.end_mana})`);
}

// 9. Manic Edge drain — one-shot drain at activation; state_values tracked via apply_to_next
{
    const stats = makeStats({ mr: 0, int: 0 });  // start_mana = 100, no regen
    const hc = makeVanishConfig({ mana_drain: true });  // value_cap=26, drain=5%/s, duration=5
    const dashSpell = makeSpell('Dash', 10, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 10, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(1, attackSpell),
    ];

    const full = assertManaMatchHC('Manic Edge drain', rows, stats, hc, false);
    // After paying Dash (10), mana=90. Vanished activates with compute_delay:
    //   drain_rate = 5/100 * 100 = 5/sec, target = min(26, 90) = 26
    //   drain_time = 26/5 = 5.2s, capped to duration=5 → drain_time=5
    //   actual_drain = min(26, 5*5) = 25, state_value = min(26, 25) = 25
    // Dash row should report computed_delay ≈ 5.0
    const dash_result = full.row_results[0];
    t.assert(Math.abs(dash_result.computed_delay - 5.0) < 0.01,
        `Manic Edge: computed_delay should be ~5.0, got ${dash_result.computed_delay}`);
    // Attack row deactivates Vanished; state_values should show the apply_to_next value (25)
    const attack_result = full.row_results[1];
    t.assert(attack_result.state_values.Vanished != null,
        'Manic Edge: state_values.Vanished should be tracked');
    t.assert(Math.abs(attack_result.state_values.Vanished - 25) < 0.01,
        `Manic Edge: state_values.Vanished should be ~25, got ${attack_result.state_values.Vanished}`);
}

// 10. Duration cap — drain capped by duration, same math as test 9
{
    const stats = makeStats({ mr: 0, int: 0, atkSpd: 'SLOW' });
    const hc = makeVanishConfig({ mana_drain: true });  // value_cap=26, duration=5
    const dashSpell = makeSpell('Dash', 5, { base_spell: 2 });
    const meleeSpell = makeSpell('Melee', null, { base_spell: 0, scaling: 'melee', mana_derived_from: 0 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(10, meleeSpell),
    ];

    const full = assertManaMatchHC('Duration cap', rows, stats, hc, false);
    // After Dash cost (5), mana=95. compute_drain_override:
    //   drain_rate = 5/100*100 = 5/sec, target = min(26, 95) = 26
    //   drain_time = 26/5 = 5.2s, capped to 5 → actual_drain = min(26, 25) = 25
    const dash_result = full.row_results[0];
    t.assert(Math.abs(dash_result.computed_delay - 5.0) < 0.01,
        `Duration cap: computed_delay should be ~5.0, got ${dash_result.computed_delay}`);
}

// 11. No Vanish — no buff_state, no effect (baseline sanity)
{
    const stats = makeStats({ mr: 10, int: 0 });
    const dashSpell = makeSpell('Dash', 25, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 30, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(1, attackSpell),
    ];
    // With DEFAULT_HEALTH_CONFIG (no buff_states), should behave normally
    assertManaMatch('No Vanish baseline', rows, stats, false);
}

// 12. value_cap — state_value capped at 26 even with large mana pool
{
    const stats = makeStats({ mr: 0, int: 0, maxMana: 900 });  // start_mana = 1000
    const hc = makeVanishConfig({ mana_drain: true, value_cap: 26 });
    const dashSpell = makeSpell('Dash', 5, { base_spell: 2 });
    const meleeSpell = makeSpell('Melee', null, { base_spell: 0, scaling: 'melee', mana_derived_from: 0 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(20, meleeSpell),
    ];

    const full = assertManaMatchHC('value_cap', rows, stats, hc, false);
    // After Dash cost (5), mana=995. compute_drain_override:
    //   drain_rate = 5/100*1000 = 50/sec, target = min(26, 995) = 26
    //   drain_time = 26/50 = 0.52s (< duration 5), actual_drain = 26
    const dash_result = full.row_results[0];
    t.assert(Math.abs(dash_result.computed_delay - 0.52) < 0.01,
        `value_cap: computed_delay should be ~0.52, got ${dash_result.computed_delay}`);
    // Melee row deactivates Vanished; state_value should be exactly 26
    const meleeResult = full.row_results[1];
    t.assert(meleeResult.state_values.Vanished === 26,
        `value_cap: state_values.Vanished should be 26, got ${meleeResult.state_values.Vanished}`);
}

// 13. computed_delay reported in row_results for activating row
{
    const stats = makeStats({ mr: 0, int: 0 });
    const hc = makeVanishConfig({ mana_drain: true });
    const dashSpell = makeSpell('Dash', 10, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 10, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(1, attackSpell),
    ];

    const registry = [];
    const full = simulate_combo_mana_hp(rows, stats, hc, false, registry);
    t.assert(full.row_results[0].computed_delay != null,
        'computed_delay: should be non-null on activating row');
    t.assert(full.row_results[1].computed_delay == null,
        'computed_delay: should be null on non-activating row');
}

// 14. Low mana — drain and delay scale down when mana < value_cap
{
    // start_mana = 100, Dash costs 90 → mana after cost = 10
    const stats = makeStats({ mr: 0, int: 0 });
    const hc = makeVanishConfig({ mana_drain: true });  // value_cap=26
    const dashSpell = makeSpell('Dash', 90, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 5, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(1, attackSpell),
    ];

    const full = assertManaMatchHC('Low mana drain', rows, stats, hc, false);
    // After Dash cost (90), mana=10. compute_drain_override:
    //   target = min(26, 10) = 10, drain_rate = 5/sec
    //   drain_time = 10/5 = 2.0s (< duration 5), actual_drain = 10
    const dash_result = full.row_results[0];
    t.assert(Math.abs(dash_result.computed_delay - 2.0) < 0.01,
        `Low mana: computed_delay should be ~2.0, got ${dash_result.computed_delay}`);
    const attack_result = full.row_results[1];
    t.assert(Math.abs(attack_result.state_values.Vanished - 10) < 0.01,
        `Low mana: state_values.Vanished should be ~10, got ${attack_result.state_values.Vanished}`);
}

// 15. Full/fast mana agreement with drain override
{
    const stats = makeStats({ mr: 5, int: 20 });
    const hc = makeVanishConfig({ mana_drain: true });
    const dashSpell = makeSpell('Dash', 15, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 20, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(2, attackSpell),
    ];
    assertManaMatchHC('Drain override full/fast agreement', rows, stats, hc, false);
}

// 16. total_mana_drain tracking — verify drain is returned and mana accounting holds
{
    const stats = makeStats({ mr: 0, int: 0 });  // start_mana = 100, no regen
    const hc = makeVanishConfig({ mana_drain: true });  // compute_delay drain, value_cap=26
    const dashSpell = makeSpell('Dash', 10, { base_spell: 2 });
    const attackSpell = makeSpell('Attack', 10, { base_spell: 1 });
    const rows = [
        makeRow(1, dashSpell),
        makeRow(1, attackSpell),
    ];

    const registry = [];
    const full = simulate_combo_mana_hp(rows, stats, hc, false, registry);
    const fast = simulate_combo_mana_fast(rows, stats, hc, false, registry);

    // total_mana_drain should be > 0 (Manic Edge drains mana on activation)
    t.assert(full.total_mana_drain > 0,
        `Drain tracking (full): total_mana_drain should be > 0, got ${full.total_mana_drain}`);
    t.assert(fast.total_mana_drain > 0,
        `Drain tracking (fast): total_mana_drain should be > 0, got ${fast.total_mana_drain}`);

    // Full/fast agreement
    t.assert(Math.abs(full.total_mana_drain - fast.total_mana_drain) < 1e-6,
        `Drain tracking: full/fast mismatch: full=${full.total_mana_drain}, fast=${fast.total_mana_drain}`);

    // Mana accounting: start - costs - drain + regen + steal ≈ end (no regen/steal here)
    const expected_end = full.start_mana - full.total_mana_cost - full.total_mana_drain;
    t.assert(Math.abs(full.end_mana - expected_end) < 1,
        `Drain tracking: mana accounting: start(${full.start_mana}) - cost(${full.total_mana_cost}) - drain(${full.total_mana_drain}) = ${expected_end}, but end_mana=${full.end_mana}`);
}

// 17. No drain — total_mana_drain should be 0 for builds without drain mechanics
{
    const stats = makeStats({ mr: 10, int: 0 });
    const rows = [
        makeRow(2, makeSpell('Spell 1', 30, { base_spell: 1 })),
    ];
    const registry = [];
    const full = simulate_combo_mana_hp(rows, stats, DEFAULT_HEALTH_CONFIG, false, registry);
    const fast = simulate_combo_mana_fast(rows, stats, DEFAULT_HEALTH_CONFIG, false, registry);

    t.assert(full.total_mana_drain === 0,
        `No drain (full): total_mana_drain should be 0, got ${full.total_mana_drain}`);
    t.assert(fast.total_mana_drain === 0,
        `No drain (fast): total_mana_drain should be 0, got ${fast.total_mana_drain}`);
}

// ── Recast penalty + spell cost clamp interaction ───────────────────────────

const compute_recast_penalties = ctx.compute_recast_penalties;

// 18. High cost reduction absorbs recast penalty: max(1, base + penalty) = 1
{
    // spRaw1 = -200 makes unclamped cost deeply negative.
    // 3 consecutive casts: penalties [0, 0, 5]. All should clamp to 1.
    const stats = makeStats({ spRaw1: -200 });
    const spell = makeSpell('Cheap Spell', 30, { base_spell: 1 });
    const rows = [
        makeRow(3, spell, { recast_penalties: [0, 0, 5], recast_penalty_per_cast: 5/3 }),
    ];
    const registry = [];
    const hc = DEFAULT_HEALTH_CONFIG;
    const full = simulate_combo_mana_hp(rows, stats, hc, false, registry);
    const fast = simulate_combo_mana_fast(rows, stats, hc, false, registry);

    // Each cast should cost max(1, 30-200+penalty) = 1, total_mana_cost = 3
    t.assert(Math.abs(full.total_mana_cost - 3) < 1e-6,
        `Recast absorbed (full): total_mana_cost should be 3, got ${full.total_mana_cost}`);
    // Full/fast agreement
    t.assert(Math.abs(full.end_mana - fast.end_mana) < 1e-6,
        `Recast absorbed: full/fast end_mana mismatch: full=${full.end_mana}, fast=${fast.end_mana}`);
    // recast_penalty_total should be 0 (penalty fully absorbed by clamp)
    t.assert(full.recast_penalty_total === 0,
        `Recast absorbed: recast_penalty_total should be 0, got ${full.recast_penalty_total}`);
}

// 19. No cost reduction: recast penalty adds to cost normally
{
    const stats = makeStats();
    const spell = makeSpell('Spell', 20, { base_spell: 1 });
    // 3 casts: penalties [0, 0, 5]
    const rows = [
        makeRow(3, spell, { recast_penalties: [0, 0, 5], recast_penalty_per_cast: 5/3 }),
    ];
    const registry = [];
    const hc = DEFAULT_HEALTH_CONFIG;
    const full = simulate_combo_mana_hp(rows, stats, hc, false, registry);
    const fast = simulate_combo_mana_fast(rows, stats, hc, false, registry);

    // Costs: 20 + 20 + max(1, 20+5) = 20 + 20 + 25 = 65
    t.assert(Math.abs(full.total_mana_cost - 65) < 1e-6,
        `Recast normal (full): total_mana_cost should be 65, got ${full.total_mana_cost}`);
    t.assert(Math.abs(full.end_mana - fast.end_mana) < 1e-6,
        `Recast normal: full/fast end_mana mismatch: full=${full.end_mana}, fast=${fast.end_mana}`);
    t.assert(Math.abs(full.recast_penalty_total - 5) < 1e-6,
        `Recast normal: recast_penalty_total should be 5, got ${full.recast_penalty_total}`);
}

// 20. Partial absorption: cost reduction partially absorbs penalty
{
    // spRaw1 = -18 → unclamped = 30-18 = 12 (base cost above clamp)
    // Penalties [0, 0, 5]: costs = 12, 12, max(1, 12+5)=17. Total = 41.
    const stats = makeStats({ spRaw1: -18 });
    const spell = makeSpell('Spell', 30, { base_spell: 1 });
    const rows = [
        makeRow(3, spell, { recast_penalties: [0, 0, 5], recast_penalty_per_cast: 5/3 }),
    ];
    const registry = [];
    const hc = DEFAULT_HEALTH_CONFIG;
    const full = simulate_combo_mana_hp(rows, stats, hc, false, registry);
    const fast = simulate_combo_mana_fast(rows, stats, hc, false, registry);

    t.assert(Math.abs(full.total_mana_cost - 41) < 1e-6,
        `Recast partial (full): total_mana_cost should be 41, got ${full.total_mana_cost}`);
    t.assert(Math.abs(full.end_mana - fast.end_mana) < 1e-6,
        `Recast partial: full/fast end_mana mismatch: full=${full.end_mana}, fast=${fast.end_mana}`);
}

// 21. compute_recast_penalties outputs per-cast arrays
{
    const spell = makeSpell('Spell', 20, { base_spell: 1 });
    const rows = [
        { sim_qty: 4, spell, mana_excl: false, pseudo: null },
    ];
    compute_recast_penalties(rows);
    const p = rows[0].recast_penalties;
    t.assert(Array.isArray(p) && p.length === 4,
        `Per-cast array: should be array of length 4, got ${JSON.stringify(p)}`);
    // First 2 free, then 5, 10
    t.assert(p[0] === 0 && p[1] === 0 && p[2] === 5 && p[3] === 10,
        `Per-cast array: expected [0,0,5,10], got [${p}]`);
    // Average should still be set
    t.assert(Math.abs(rows[0].recast_penalty_per_cast - 15/4) < 1e-9,
        `Per-cast average: expected ${15/4}, got ${rows[0].recast_penalty_per_cast}`);
}

// ── Summary ──────────────────────────────────────────────────────────────────
t.summary();
