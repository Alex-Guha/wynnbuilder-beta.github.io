// Tests for calculate_skillpoints.
// Run: node js/solver/tests/test_skillpoints.js [--update]
//
// Test cases live in test_skillpoints.json.
// --update  : recompute all expected values from current code (mass update).
//
// Generate random cases:  node js/solver/tests/gen_sp_cases.js [count]

'use strict';

const fs = require('fs');
const path = require('path');
const { createSandbox, loadGameData, TestRunner } = require('./harness');

const CASES_PATH = path.join(__dirname, 'test_skillpoints.json');

// ── Setup ────────────────────────────────────────────────────────────────────

const ctx = createSandbox();
const { itemMap, sets, none_items } = loadGameData(ctx);

const calculate_skillpoints = ctx.calculate_skillpoints;
const expandItem = ctx.expandItem;

// Slot index → item type for lookup in itemMap.
const SLOT_TYPES = ['helmet', 'chestplate', 'leggings', 'boots', 'ring', 'ring', 'bracelet', 'necklace'];
const NONE_NAMES = [
    'No Helmet', 'No Chestplate', 'No Leggings', 'No Boots',
    'No Ring 1', 'No Ring 2', 'No Bracelet', 'No Necklace',
];

// Wynn order: boots, legs, chest, helmet, ring1, ring2, bracelet, necklace
const WYNN_ORDER = [3, 2, 1, 0, 4, 5, 6, 7];

// ── Helpers ──────────────────────────────────────────────────────────────────

function resolveItem(name, slotIdx) {
    if (!name || name === NONE_NAMES[slotIdx]) return none_items[slotIdx];
    return itemMap.get(name) || null;
}

function resolveWeapon(name) {
    if (!name || name === 'No Weapon') return none_items[8];
    return itemMap.get(name) || null;
}

/**
 * Build the equipment statMap array in wynn order from a test case.
 */
function buildStatMaps(tc) {
    const rawEquips = [];
    for (let i = 0; i < 8; i++) {
        const item = resolveItem(tc.items[i], i);
        if (!item) return { error: `Unknown item "${tc.items[i]}" at slot ${i}` };
        rawEquips.push(item);
    }
    const weaponRaw = resolveWeapon(tc.weapon);
    if (!weaponRaw) return { error: `Unknown weapon "${tc.weapon}"` };

    const equipSMs = rawEquips.map(it => expandItem(it));
    const weaponSM = expandItem(weaponRaw);

    // Reorder to wynn order (boots, legs, chest, helmet, ring1, ring2, bracelet, necklace).
    const wynnEquipSMs = WYNN_ORDER.map(i => equipSMs[i]);

    return { equipSMs: wynnEquipSMs, weaponSM };
}

/**
 * Run calculate_skillpoints on a test case.
 * Returns { assign, total, total_assigned } or null if infeasible.
 */
function runSP(tc) {
    const resolved = buildStatMaps(tc);
    if (resolved.error) return { error: resolved.error };

    const budget = tc.sp_budget !== undefined ? tc.sp_budget : Infinity;
    const result = calculate_skillpoints(resolved.equipSMs, resolved.weaponSM, budget);
    if (result === null) return null;

    const [assign, total, total_assigned] = result;
    return {
        assign: Array.from(assign),
        total: Array.from(total),
        total_assigned,
    };
}

// ── Load & Run ──────────────────────────────────────────────────────────────

const isUpdate = process.argv.includes('--update');

const data = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
const cases = data.cases;

if (cases.length === 0 && !isUpdate) {
    console.log('No test cases in test_skillpoints.json. Use gen_sp_cases.js to generate some.');
    console.log('\n[Skillpoints] 0 passed, 0 failed, 0 warnings');
    process.exit(0);
}

if (isUpdate) {
    // ── Mass Update Mode ────────────────────────────────────────────────────
    let updated = 0;
    let errors = 0;
    for (const tc of cases) {
        const result = runSP(tc);
        if (result && result.error) {
            console.error(`  ERROR [${tc.name}]: ${result.error}`);
            errors++;
            continue;
        }
        tc.expected = result;  // null if infeasible, object if feasible
        updated++;
    }
    fs.writeFileSync(CASES_PATH, JSON.stringify(data, null, '\t') + '\n');
    console.log(`Updated ${updated} test case(s), ${errors} error(s).`);
    process.exit(errors > 0 ? 1 : 0);
}

// ── Normal Test Mode ────────────────────────────────────────────────────────

const t = new TestRunner('Skillpoints');

for (const tc of cases) {
    const label = tc.name;

    // Skip cases with null expected (not yet computed).
    if (tc.expected === null || tc.expected === undefined) {
        t.warn(`${label}: no expected values (run with --update or fill in manually)`);
        continue;
    }

    const resolved = buildStatMaps(tc);
    if (resolved.error) {
        t.assert(false, `${label}: ${resolved.error}`);
        continue;
    }

    const { equipSMs, weaponSM } = resolved;
    const budget = tc.sp_budget !== undefined ? tc.sp_budget : Infinity;
    const result = calculate_skillpoints(equipSMs, weaponSM, budget);

    if (tc.expected === 'infeasible') {
        t.assert(result === null, `${label}: expected infeasible, got result`);
        continue;
    }

    // Expected is { assign, total, total_assigned }.
    if (result === null) {
        t.assert(false, `${label}: calculate_skillpoints returned null (infeasible), expected feasible`);
        continue;
    }

    const [assign, total, total_assigned] = result;

    // Compare assign.
    let assign_ok = true;
    for (let i = 0; i < 5; i++) {
        if (assign[i] !== tc.expected.assign[i]) {
            t.assert(false, `${label}: assign[${i}] = ${assign[i]}, expected ${tc.expected.assign[i]}`);
            assign_ok = false;
        }
    }
    if (assign_ok) t.assert(true, `${label}: assign matches`);

    // Compare total.
    let total_ok = true;
    for (let i = 0; i < 5; i++) {
        if (total[i] !== tc.expected.total[i]) {
            t.assert(false, `${label}: total[${i}] = ${total[i]}, expected ${tc.expected.total[i]}`);
            total_ok = false;
        }
    }
    if (total_ok) t.assert(true, `${label}: total matches`);

    // Compare total_assigned.
    t.assert(
        total_assigned === tc.expected.total_assigned,
        `${label}: total_assigned = ${total_assigned}, expected ${tc.expected.total_assigned}`
    );
}

const { fail } = t.summary();
if (fail > 0) process.exit(1);
