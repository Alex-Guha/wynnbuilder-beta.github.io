// Tests for bidirectional dominance pruning.
// Run: node js/solver/tests/test_dominance.js

const {
    _item_stat_val, _build_dominance_stats, _prune_dominated_items,
    _INDIRECT_CONSTRAINT_STATS,
} = require('../engine/item_priority.js');

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeItem(stats, reqs = [0,0,0,0,0], skillpoints = [0,0,0,0,0]) {
    const maxRolls = new Map(Object.entries(stats));
    const sm = new Map();
    sm.set('maxRolls', maxRolls);
    sm.set('reqs', reqs);
    sm.set('skillpoints', skillpoints);
    return { statMap: sm };
}

function makeNoneItem() {
    const sm = new Map();
    sm.set('NONE', true);
    sm.set('reqs', [0,0,0,0,0]);
    sm.set('skillpoints', [0,0,0,0,0]);
    sm.set('maxRolls', new Map());
    return { statMap: sm };
}

let _pass = 0, _fail = 0;
function assert(cond, msg) {
    if (cond) { _pass++; }
    else { _fail++; console.error('FAIL:', msg); }
}

function assertSetEqual(actual, expected, msg) {
    const a = [...actual].sort();
    const e = [...expected].sort();
    assert(a.length === e.length && a.every((v, i) => v === e[i]),
        `${msg} — got [${a}], expected [${e}]`);
}

// ── _prune_dominated_items tests ─────────────────────────────────────────────

// Test 1: Higher-only (regression test for current behavior)
{
    const A = makeItem({ damPct: 20, sdPct: 10 });
    const B = makeItem({ damPct: 15, sdPct: 5 });   // dominated by A
    const C = makeItem({ damPct: 10, sdPct: 15 });   // not dominated (sdPct > A)
    const pools = { helmet: [A, B, C] };
    const ds = { higher: new Set(['damPct', 'sdPct']), lower: new Set() };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 2, 'Test 1: pool should have 2 items');
    assert(pools.helmet.includes(A), 'Test 1: A should remain');
    assert(!pools.helmet.includes(B), 'Test 1: B should be pruned');
    assert(pools.helmet.includes(C), 'Test 1: C should remain');
}

// Test 2: Lower-only
{
    const A = makeItem({ spRaw1: -15 });  // lower = better, A dominates
    const B = makeItem({ spRaw1: -10 });
    const pools = { helmet: [A, B] };
    const ds = { higher: new Set(), lower: new Set(['spRaw1']) };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 1, 'Test 2: pool should have 1 item');
    assert(pools.helmet.includes(A), 'Test 2: A should remain');
}

// Test 3: Bidirectional — A dominates B on both directions
{
    const A = makeItem({ damPct: 20, spRaw1: -15 });
    const B = makeItem({ damPct: 15, spRaw1: -10 });
    const pools = { helmet: [A, B] };
    const ds = { higher: new Set(['damPct']), lower: new Set(['spRaw1']) };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 1, 'Test 3: B should be pruned');
    assert(pools.helmet.includes(A), 'Test 3: A should remain');
}

// Test 4: No dominance when one direction fails
{
    const A = makeItem({ damPct: 20, spRaw1: -5 });   // better damage, worse cost
    const B = makeItem({ damPct: 15, spRaw1: -10 });  // worse damage, better cost
    const pools = { helmet: [A, B] };
    const ds = { higher: new Set(['damPct']), lower: new Set(['spRaw1']) };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 2, 'Test 4: neither should be pruned');
}

// Test 5: SP requirements break dominance
{
    const A = makeItem({ damPct: 20 }, [50,0,0,0,0]);  // higher reqs
    const B = makeItem({ damPct: 15 }, [10,0,0,0,0]);
    const pools = { helmet: [A, B] };
    const ds = { higher: new Set(['damPct']), lower: new Set() };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 2, 'Test 5: B not pruned due to lower reqs');
}

// Test 6: SP provisions break dominance
{
    const A = makeItem({ damPct: 20 }, [0,0,0,0,0], [0,0,0,0,0]);  // no SP
    const B = makeItem({ damPct: 15 }, [0,0,0,0,0], [5,0,0,0,0]);  // gives str
    const pools = { helmet: [A, B] };
    const ds = { higher: new Set(['damPct']), lower: new Set() };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 2, 'Test 6: B not pruned due to SP provisions');
}

// Test 7: NONE items never pruned
{
    const A = makeItem({ damPct: 20 });
    const N = makeNoneItem();
    const pools = { helmet: [A, N] };
    const ds = { higher: new Set(['damPct']), lower: new Set() };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 2, 'Test 7: NONE item not pruned');
    assert(pools.helmet.includes(N), 'Test 7: NONE item still in pool');
}

// Test 8: Empty lower set — same behavior as original
{
    const A = makeItem({ damPct: 20, sdPct: 10 });
    const B = makeItem({ damPct: 15, sdPct: 5 });
    const pools = { helmet: [A, B] };
    const ds = { higher: new Set(['damPct', 'sdPct']), lower: new Set() };
    _prune_dominated_items(pools, ds);
    assert(pools.helmet.length === 1, 'Test 8: B pruned with empty lower set');
}

// ── _build_dominance_stats tests ─────────────────────────────────────────────

// Test 9: Pure damage combo (no mana) — lower is empty
{
    const snap = { combo_time: 0, parsed_combo: [], scoring_target: 'combo_damage' };
    const dmg_weights = new Map([['damPct', 1], ['sdPct', 1]]);
    const restrictions = { stat_thresholds: [] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(ds.higher.has('damPct'), 'Test 9: damPct in higher');
    assert(ds.higher.has('sdPct'), 'Test 9: sdPct in higher');
    assert(ds.lower.size === 0, 'Test 9: lower is empty');
}

// Test 10: Mana-constrained combo — spell cost stats in lower
{
    const snap = {
        combo_time: 10, hp_casting: false,
        parsed_combo: [
            { spell: { base_spell: 1, scaling: 'spell' }, mana_excl: false },
            { spell: { base_spell: 3, scaling: 'spell' }, mana_excl: false },
        ],
    };
    const dmg_weights = new Map([['damPct', 1]]);
    const restrictions = { stat_thresholds: [] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(ds.lower.has('spRaw1'), 'Test 10: spRaw1 in lower');
    assert(ds.lower.has('spPct1'), 'Test 10: spPct1 in lower');
    assert(ds.lower.has('spRaw3'), 'Test 10: spRaw3 in lower');
    assert(ds.lower.has('spPct3'), 'Test 10: spPct3 in lower');
    assert(!ds.lower.has('spRaw2'), 'Test 10: spRaw2 NOT in lower');
}

// Test 11: hp_casting excludes spell costs
{
    const snap = {
        combo_time: 10, hp_casting: true,
        parsed_combo: [
            { spell: { base_spell: 1, scaling: 'spell' }, mana_excl: false },
        ],
    };
    const dmg_weights = new Map([['damPct', 1]]);
    const restrictions = { stat_thresholds: [] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(!ds.lower.has('spRaw1'), 'Test 11: no spell cost stats when hp_casting');
    assert(ds.lower.size === 0, 'Test 11: lower is empty');
}

// Test 12: le restriction adds to lower
{
    const snap = { combo_time: 0, parsed_combo: [] };
    const dmg_weights = new Map([['damPct', 1]]);
    const restrictions = { stat_thresholds: [{ stat: 'atkTier', op: 'le', value: 3 }] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(ds.lower.has('atkTier'), 'Test 12: atkTier in lower from le restriction');
}

// Test 13: Conflict resolution — stat in both sets removed from both
{
    const snap = { combo_time: 0, parsed_combo: [] };
    const dmg_weights = new Map([['atkTier', 1]]);  // higher
    const restrictions = { stat_thresholds: [{ stat: 'atkTier', op: 'le', value: 3 }] };  // lower
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(!ds.higher.has('atkTier'), 'Test 13: atkTier removed from higher');
    assert(!ds.lower.has('atkTier'), 'Test 13: atkTier removed from lower');
}

// Test 14: atkTier special case — melee + mana sustain
{
    const snap = {
        combo_time: 10, allow_downtime: false,
        parsed_combo: [
            { spell: { base_spell: 1, scaling: 'melee' }, mana_excl: false },
        ],
        hp_casting: false,
    };
    const dmg_weights = new Map([['atkTier', 1], ['damPct', 1]]);
    const restrictions = { stat_thresholds: [] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(!ds.higher.has('atkTier'), 'Test 14: atkTier removed from higher (melee+sustain)');
    assert(ds.higher.has('damPct'), 'Test 14: damPct still in higher');
}

// Test 15: Indirect stats filtered — ge ehp not added to higher
{
    const snap = { combo_time: 0, parsed_combo: [] };
    const dmg_weights = new Map();
    const restrictions = { stat_thresholds: [
        { stat: 'ehp', op: 'ge', value: 1000 },
        { stat: 'finalSpellCost1', op: 'le', value: 5 },
    ]};
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(!ds.higher.has('ehp'), 'Test 15: ehp not in higher (indirect)');
    assert(!ds.lower.has('finalSpellCost1'), 'Test 15: finalSpellCost1 not in lower (indirect)');
}

// Test 16: mana_excl rows skipped
{
    const snap = {
        combo_time: 10, hp_casting: false,
        parsed_combo: [
            { spell: { base_spell: 1, scaling: 'spell' }, mana_excl: false },
            { spell: { base_spell: 2, scaling: 'spell' }, mana_excl: true },
        ],
    };
    const dmg_weights = new Map();
    const restrictions = { stat_thresholds: [] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(ds.lower.has('spRaw1'), 'Test 16: spRaw1 in lower');
    assert(!ds.lower.has('spRaw2'), 'Test 16: spRaw2 NOT in lower (mana_excl)');
    assert(!ds.lower.has('spPct2'), 'Test 16: spPct2 NOT in lower (mana_excl)');
}

// Test 17: Melee rows (bs=0) skipped
{
    const snap = {
        combo_time: 10, hp_casting: false,
        parsed_combo: [
            { spell: { base_spell: 0, scaling: 'melee' }, mana_excl: false },
            { spell: { base_spell: 1, scaling: 'spell' }, mana_excl: false },
        ],
    };
    const dmg_weights = new Map();
    const restrictions = { stat_thresholds: [] };
    const ds = _build_dominance_stats(snap, dmg_weights, restrictions);
    assert(!ds.lower.has('spRaw0'), 'Test 17: spRaw0 NOT in lower (melee bs=0)');
    assert(ds.lower.has('spRaw1'), 'Test 17: spRaw1 in lower');
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log(`\nResults: ${_pass} passed, ${_fail} failed out of ${_pass + _fail} assertions`);
if (_fail > 0) process.exit(1);
