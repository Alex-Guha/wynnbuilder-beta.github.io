// Tests for unified level-based enumeration ordering.
// Verifies that the enumerate algorithm visits combinations in non-decreasing
// order of combined rank-offset sum (level), with correct ring symmetry and
// partition coverage.
//
// Run: node js/solver/tests/test_enum_order.js

'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────

let _pass = 0, _fail = 0;
function assert(cond, msg) {
    if (cond) { _pass++; }
    else { _fail++; console.error('FAIL:', msg); }
}

// ── Core: standalone enumerate algorithm ─────────────────────────────────────
//
// Mirrors the enumerate() + L-loop from worker.js, stripped of all game logic
// (no stat maps, SP pruning, illegal sets). Records each visited combination
// as a tuple of pool indices.

function enumerate_and_record({ slot_names, pool_sizes, ring_pool_size, partition }) {
    const visits = [];
    const free_slots = [...slot_names];

    const _get_pool_size = (slot) =>
        (slot === 'ring1' || slot === 'ring2') ? ring_pool_size : pool_sizes[slot];

    // Sort by pool size ascending, ring1 before ring2 on ties.
    free_slots.sort((a, b) => {
        const diff = _get_pool_size(a) - _get_pool_size(b);
        if (diff !== 0) return diff;
        if (a === 'ring1' && b === 'ring2') return -1;
        if (a === 'ring2' && b === 'ring1') return 1;
        return 0;
    });

    const N_free = free_slots.length;
    const ring1_depth = free_slots.indexOf('ring1');
    const ring2_depth = free_slots.indexOf('ring2');

    // Effective pool sizes per slot (slot partition slices one pool).
    const eff = {};
    for (const slot of free_slots) eff[slot] = _get_pool_size(slot);

    // For slot partitions, record the offset so indices map back to the
    // original pool (mirrors how worker.js slices pools[slot]).
    let slot_partition_offset = 0;
    let slot_partition_slot = null;
    if ((partition && partition.type) === 'slot') {
        slot_partition_slot = partition.slot;
        slot_partition_offset = partition.start;
        eff[partition.slot] = partition.end - partition.start;
    }

    let L_max = 0;
    for (const slot of free_slots) L_max += eff[slot] - 1;

    let _ring1_placed_offset = 0;
    const current = new Array(N_free).fill(0);

    function enumerate(slot_idx, remaining_L) {
        if (slot_idx === N_free) {
            // Map back to original pool indices for slot partitions.
            const tuple = current.map((v, i) =>
                (free_slots[i] === slot_partition_slot) ? v + slot_partition_offset : v
            );
            visits.push(tuple);
            return;
        }

        const slot = free_slots[slot_idx];
        const is_ring1 = (slot_idx === ring1_depth);
        const is_ring2 = (slot_idx === ring2_depth);
        const pool_sz = eff[slot];

        let min_offset = 0;
        let pool_max = pool_sz - 1;

        // Ring2 symmetry: offset >= ring1's offset.
        if (is_ring2 && ring1_depth >= 0) {
            min_offset = _ring1_placed_offset;
        }
        // Ring partition: restrict ring1 (or single free ring) offset range.
        if (is_ring1 && (partition && partition.type) === 'ring') {
            min_offset = Math.max(min_offset, partition.start);
            pool_max = Math.min(pool_max, partition.end - 1);
        }
        if ((is_ring1 || is_ring2) && (partition && partition.type) === 'ring_single') {
            min_offset = Math.max(min_offset, partition.start);
            pool_max = Math.min(pool_max, partition.end - 1);
        }

        // Last slot: exact offset = remaining_L.
        if (slot_idx === N_free - 1) {
            if (remaining_L >= min_offset && remaining_L <= pool_max) {
                current[slot_idx] = remaining_L;
                const tuple = current.map((v, i) =>
                    (free_slots[i] === slot_partition_slot) ? v + slot_partition_offset : v
                );
                visits.push(tuple);
            }
            return;
        }

        const max_offset = Math.min(remaining_L, pool_max);
        for (let offset = min_offset; offset <= max_offset; offset++) {
            current[slot_idx] = offset;
            if (is_ring1) _ring1_placed_offset = offset;
            enumerate(slot_idx + 1, remaining_L - offset);
        }
    }

    for (let L = 0; L <= L_max; L++) {
        enumerate(0, L);
    }

    return { visits, free_slots, ring1_depth, ring2_depth };
}

// ── Assertion utilities ──────────────────────────────────────────────────────

function check_level_ordering(visits, label) {
    for (let i = 1; i < visits.length; i++) {
        const prev_L = visits[i - 1].reduce((a, b) => a + b, 0);
        const curr_L = visits[i].reduce((a, b) => a + b, 0);
        assert(curr_L >= prev_L,
            `${label}: level decreased at visit ${i}: L=${prev_L} -> L=${curr_L} ` +
            `(${visits[i-1]} -> ${visits[i]})`);
        if (curr_L < prev_L) return false;  // stop on first failure
    }
    return true;
}

function check_no_duplicates(visits, label) {
    const seen = new Set();
    let ok = true;
    for (const v of visits) {
        const key = v.join(',');
        if (seen.has(key)) {
            assert(false, `${label}: duplicate visit ${v}`);
            ok = false;
        }
        seen.add(key);
    }
    if (ok) _pass++;
    return ok;
}

function check_ring_symmetry(visits, ring1_depth, ring2_depth, label) {
    if (ring1_depth < 0 || ring2_depth < 0) return true;
    let ok = true;
    for (const v of visits) {
        if (v[ring2_depth] < v[ring1_depth]) {
            assert(false, `${label}: ring2 (${v[ring2_depth]}) < ring1 (${v[ring1_depth]}) in ${v}`);
            ok = false;
        }
    }
    if (ok) _pass++;
    return ok;
}

function check_count(visits, expected, label) {
    assert(visits.length === expected,
        `${label}: expected ${expected} visits, got ${visits.length}`);
}

function sets_equal(a, b) {
    if (a.size !== b.size) return false;
    for (const v of a) if (!b.has(v)) return false;
    return true;
}

function check_partition_completeness(partition_visits_list, unpartitioned_visits, label) {
    const all_keys = new Set();
    let total = 0;
    for (const pv of partition_visits_list) {
        for (const v of pv) {
            all_keys.add(v.join(','));
            total++;
        }
    }
    const expected_keys = new Set(unpartitioned_visits.map(v => v.join(',')));

    assert(total === unpartitioned_visits.length,
        `${label}: partition total ${total} != unpartitioned ${unpartitioned_visits.length}`);
    assert(sets_equal(all_keys, expected_keys),
        `${label}: partition union does not match unpartitioned set`);
}

// ── Tests ────────────────────────────────────────────────────────────────────

console.log('=== Test: Armor-only (3 slots, no rings) ===');
{
    const { visits } = enumerate_and_record({
        slot_names: ['helmet', 'boots', 'necklace'],
        pool_sizes: { helmet: 3, boots: 2, necklace: 4 },
        ring_pool_size: 0,
        partition: null,
    });
    check_level_ordering(visits, 'armor-only L order');
    check_no_duplicates(visits, 'armor-only no dupes');
    check_count(visits, 3 * 2 * 4, 'armor-only count');
}

console.log('=== Test: Both rings free + armor ===');
{
    const { visits, ring1_depth, ring2_depth } = enumerate_and_record({
        slot_names: ['helmet', 'boots', 'ring1', 'ring2'],
        pool_sizes: { helmet: 3, boots: 2 },
        ring_pool_size: 4,
        partition: null,
    });
    const ring_combos = 4 * (4 + 1) / 2;  // n*(n+1)/2 = 10
    check_level_ordering(visits, 'both-rings L order');
    check_no_duplicates(visits, 'both-rings no dupes');
    check_ring_symmetry(visits, ring1_depth, ring2_depth, 'both-rings symmetry');
    check_count(visits, ring_combos * 3 * 2, 'both-rings count');
}

console.log('=== Test: One ring free + armor ===');
{
    const { visits, ring1_depth, ring2_depth } = enumerate_and_record({
        slot_names: ['helmet', 'ring2'],
        pool_sizes: { helmet: 3 },
        ring_pool_size: 5,
        partition: null,
    });
    check_level_ordering(visits, 'one-ring L order');
    check_no_duplicates(visits, 'one-ring no dupes');
    assert(ring1_depth === -1, 'one-ring: ring1 should not be in free_slots');
    check_count(visits, 3 * 5, 'one-ring count');
}

console.log('=== Test: Ring symmetry — duplicate rings allowed ===');
{
    const { visits, ring1_depth, ring2_depth } = enumerate_and_record({
        slot_names: ['ring1', 'ring2'],
        pool_sizes: {},
        ring_pool_size: 3,
        partition: null,
    });
    // With pool size 3: (0,0)(0,1)(0,2)(1,1)(1,2)(2,2) = 6
    check_count(visits, 6, 'ring-symmetry count');
    check_ring_symmetry(visits, ring1_depth, ring2_depth, 'ring-symmetry');
    check_no_duplicates(visits, 'ring-symmetry no dupes');

    // Verify (i,i) pairs exist (duplicate rings are allowed)
    const diag = visits.filter(v => v[ring1_depth] === v[ring2_depth]);
    assert(diag.length === 3, `ring-symmetry: expected 3 diagonal pairs, got ${diag.length}`);
}

console.log('=== Test: Both rings free, ring partition ===');
{
    // Ring pool size 4 → partitions split ring1's range.
    // Triangular: work(i) = 4-i. Total = 10. Split into 2 workers.
    // Worker 0: ring1 in [0,2), Worker 1: ring1 in [2,4)
    const unpartitioned = enumerate_and_record({
        slot_names: ['helmet', 'ring1', 'ring2'],
        pool_sizes: { helmet: 3 },
        ring_pool_size: 4,
        partition: null,
    });

    const p0 = enumerate_and_record({
        slot_names: ['helmet', 'ring1', 'ring2'],
        pool_sizes: { helmet: 3 },
        ring_pool_size: 4,
        partition: { type: 'ring', start: 0, end: 2 },
    });

    const p1 = enumerate_and_record({
        slot_names: ['helmet', 'ring1', 'ring2'],
        pool_sizes: { helmet: 3 },
        ring_pool_size: 4,
        partition: { type: 'ring', start: 2, end: 4 },
    });

    check_level_ordering(p0.visits, 'ring-partition-w0 L order');
    check_level_ordering(p1.visits, 'ring-partition-w1 L order');
    check_no_duplicates(p0.visits, 'ring-partition-w0 no dupes');
    check_no_duplicates(p1.visits, 'ring-partition-w1 no dupes');
    check_partition_completeness(
        [p0.visits, p1.visits], unpartitioned.visits,
        'ring-partition completeness'
    );
}

console.log('=== Test: One ring free, ring_single partition ===');
{
    const unpartitioned = enumerate_and_record({
        slot_names: ['boots', 'ring1'],
        pool_sizes: { boots: 2 },
        ring_pool_size: 6,
        partition: null,
    });

    const p0 = enumerate_and_record({
        slot_names: ['boots', 'ring1'],
        pool_sizes: { boots: 2 },
        ring_pool_size: 6,
        partition: { type: 'ring_single', start: 0, end: 3 },
    });

    const p1 = enumerate_and_record({
        slot_names: ['boots', 'ring1'],
        pool_sizes: { boots: 2 },
        ring_pool_size: 6,
        partition: { type: 'ring_single', start: 3, end: 6 },
    });

    check_level_ordering(p0.visits, 'ring_single-w0 L order');
    check_level_ordering(p1.visits, 'ring_single-w1 L order');
    check_partition_completeness(
        [p0.visits, p1.visits], unpartitioned.visits,
        'ring_single completeness'
    );
}

console.log('=== Test: Slot partition (armor) ===');
{
    // Partition the largest armor pool (necklace, size 6).
    const unpartitioned = enumerate_and_record({
        slot_names: ['helmet', 'necklace'],
        pool_sizes: { helmet: 3, necklace: 6 },
        ring_pool_size: 0,
        partition: null,
    });

    const p0 = enumerate_and_record({
        slot_names: ['helmet', 'necklace'],
        pool_sizes: { helmet: 3, necklace: 6 },
        ring_pool_size: 0,
        partition: { type: 'slot', slot: 'necklace', start: 0, end: 3 },
    });

    const p1 = enumerate_and_record({
        slot_names: ['helmet', 'necklace'],
        pool_sizes: { helmet: 3, necklace: 6 },
        ring_pool_size: 0,
        partition: { type: 'slot', slot: 'necklace', start: 3, end: 6 },
    });

    check_level_ordering(p0.visits, 'slot-partition-w0 L order');
    check_level_ordering(p1.visits, 'slot-partition-w1 L order');
    check_partition_completeness(
        [p0.visits, p1.visits], unpartitioned.visits,
        'slot-partition completeness'
    );
}

console.log('=== Test: Rings + armor, 3-way ring partition ===');
{
    // More workers than ring pool size → some partitions may be empty.
    const unpartitioned = enumerate_and_record({
        slot_names: ['boots', 'ring1', 'ring2'],
        pool_sizes: { boots: 2 },
        ring_pool_size: 3,
        partition: null,
    });

    const partitions = [
        { type: 'ring', start: 0, end: 1 },
        { type: 'ring', start: 1, end: 2 },
        { type: 'ring', start: 2, end: 3 },
    ];

    const partition_visits = partitions.map(p =>
        enumerate_and_record({
            slot_names: ['boots', 'ring1', 'ring2'],
            pool_sizes: { boots: 2 },
            ring_pool_size: 3,
            partition: p,
        }).visits
    );

    for (let i = 0; i < partition_visits.length; i++) {
        check_level_ordering(partition_visits[i], `3way-ring-w${i} L order`);
    }
    check_partition_completeness(
        partition_visits, unpartitioned.visits,
        '3way-ring completeness'
    );
}

console.log('=== Test: Single free slot (edge case) ===');
{
    const { visits } = enumerate_and_record({
        slot_names: ['helmet'],
        pool_sizes: { helmet: 5 },
        ring_pool_size: 0,
        partition: null,
    });
    check_level_ordering(visits, 'single-slot L order');
    check_count(visits, 5, 'single-slot count');
    // Verify visits are [0], [1], [2], [3], [4]
    for (let i = 0; i < 5; i++) {
        assert(visits[i][0] === i, `single-slot: visit ${i} should be [${i}], got [${visits[i][0]}]`);
    }
}

console.log('=== Test: Large pool — 6 slots + 2 rings ===');
{
    const { visits, ring1_depth, ring2_depth } = enumerate_and_record({
        slot_names: ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace', 'ring1', 'ring2'],
        pool_sizes: { helmet: 2, chestplate: 2, leggings: 2, boots: 2, bracelet: 2, necklace: 2 },
        ring_pool_size: 3,
        partition: null,
    });
    const ring_combos = 3 * (3 + 1) / 2;  // 6
    const armor_combos = 2 ** 6;           // 64
    check_level_ordering(visits, 'large L order');
    check_no_duplicates(visits, 'large no dupes');
    check_ring_symmetry(visits, ring1_depth, ring2_depth, 'large symmetry');
    check_count(visits, ring_combos * armor_combos, 'large count');
}

// ── Results ──────────────────────────────────────────────────────────────────

console.log(`\n${_pass} passed, ${_fail} failed`);
if (_fail > 0) process.exit(1);
