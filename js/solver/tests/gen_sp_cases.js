#!/usr/bin/env node
// Generate random skillpoint test cases.
//
// Usage:
//   node js/solver/tests/gen_sp_cases.js [count] [--level MIN-MAX] [--feasible-only] [--append]
//
// Options:
//   count           Number of cases to generate (default: 20)
//   --level MIN-MAX Level range for items (default: 1-121)
//   --feasible-only Only keep cases where calculate_skillpoints succeeds
//   --append        Append to existing cases instead of replacing random ones
//   --fill-expected Also compute expected values (careful: current code may be buggy)
//
// Output: writes to test_skillpoints.json

'use strict';

const fs = require('fs');
const path = require('path');
const { createSandbox, loadGameData } = require('./harness');

const CASES_PATH = path.join(__dirname, 'test_skillpoints.json');

// ── Parse args ──────────────────────────────────────────────────────────────

let count = 20;
let levelMin = 1, levelMax = 121;
let feasibleOnly = false;
let append = false;
let fillExpected = false;

for (let i = 2; i < process.argv.length; i++) {
    const arg = process.argv[i];
    if (arg === '--feasible-only') { feasibleOnly = true; continue; }
    if (arg === '--append') { append = true; continue; }
    if (arg === '--fill-expected') { fillExpected = true; continue; }
    if (arg === '--level') {
        const range = process.argv[++i];
        const [lo, hi] = range.split('-').map(Number);
        levelMin = lo; levelMax = hi;
        continue;
    }
    if (/^\d+$/.test(arg)) { count = parseInt(arg); continue; }
    console.error(`Unknown arg: ${arg}`);
    process.exit(1);
}

// ── Setup ───────────────────────────────────────────────────────────────────

const ctx = createSandbox();
const { itemMap, none_items } = loadGameData(ctx);

const calculate_skillpoints = ctx.calculate_skillpoints;
const expandItem = ctx.expandItem;

// Build per-slot item pools (only non-crafted, non-quest items within level range).
// Slot types: 0=helmet, 1=chestplate, 2=leggings, 3=boots, 4=ring, 5=ring, 6=bracelet, 7=necklace
const SLOT_TYPES = ['helmet', 'chestplate', 'leggings', 'boots', 'ring', 'ring', 'bracelet', 'necklace'];

const pools = [];
for (let s = 0; s < 8; s++) {
    const slotType = SLOT_TYPES[s];
    const pool = [];
    for (const [name, item] of itemMap) {
        if (item.type !== slotType) continue;
        if (item.category === 'weapon') continue;
        const lvl = item.lvl || 0;
        if (lvl < levelMin || lvl > levelMax) continue;
        pool.push(name);
    }
    // Always include the NONE item as a possibility.
    pool.push(none_items[s].displayName);
    pools[s] = pool;
}

// Weapon pool.
const weaponTypes = new Set(['bow', 'wand', 'dagger', 'spear', 'relik']);
const weaponPool = [];
for (const [name, item] of itemMap) {
    if (!weaponTypes.has(item.type)) continue;
    const lvl = item.lvl || 0;
    if (lvl < levelMin || lvl > levelMax) continue;
    weaponPool.push(name);
}
weaponPool.push(none_items[8].displayName);

console.log(`Pool sizes: ${pools.map((p, i) => `${SLOT_TYPES[i]}=${p.length}`).join(', ')}, weapon=${weaponPool.length}`);

// ── Generate ────────────────────────────────────────────────────────────────

const WYNN_ORDER = [3, 2, 1, 0, 4, 5, 6, 7];

function pick(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

function generateOne(idx) {
    const items = [];
    for (let s = 0; s < 8; s++) {
        items.push(pick(pools[s]));
    }
    const weapon = pick(weaponPool);

    const tc = {
        name: `random_${idx}`,
        items,
        weapon,
        expected: null,
    };

    if (fillExpected || feasibleOnly) {
        // Try to compute expected.
        const rawEquips = items.map((name, i) => {
            if (!name || name === none_items[i].displayName) return none_items[i];
            return itemMap.get(name) || none_items[i];
        });
        const rawWeapon = itemMap.get(weapon) || none_items[8];

        const equipSMs = rawEquips.map(it => expandItem(it));
        const weaponSM = expandItem(rawWeapon);
        const wynnSMs = WYNN_ORDER.map(i => equipSMs[i]);

        const result = calculate_skillpoints(wynnSMs, weaponSM);

        if (feasibleOnly && result === null) return null;

        if (fillExpected) {
            if (result === null) {
                tc.expected = 'infeasible';
            } else {
                const [assign, total, total_assigned] = result;
                tc.expected = {
                    assign: Array.from(assign),
                    total: Array.from(total),
                    total_assigned,
                };
            }
        }
    }

    return tc;
}

const generated = [];
let attempts = 0;
const maxAttempts = count * 100;

while (generated.length < count && attempts < maxAttempts) {
    attempts++;
    const tc = generateOne(generated.length);
    if (tc !== null) generated.push(tc);
}

if (generated.length < count) {
    console.warn(`Only generated ${generated.length}/${count} cases after ${attempts} attempts.`);
}

// ── Write ───────────────────────────────────────────────────────────────────

let data;
if (fs.existsSync(CASES_PATH)) {
    data = JSON.parse(fs.readFileSync(CASES_PATH, 'utf8'));
} else {
    data = { cases: [] };
}

if (append) {
    data.cases = data.cases.concat(generated);
} else {
    // Replace only the random_ cases, keep hand-made ones.
    const handmade = data.cases.filter(c => !c.name.startsWith('random_'));
    data.cases = handmade.concat(generated);
}

fs.writeFileSync(CASES_PATH, JSON.stringify(data, null, '\t') + '\n');
console.log(`Wrote ${generated.length} random case(s) to test_skillpoints.json (total: ${data.cases.length}).`);
if (!fillExpected) {
    console.log('Expected values are null. Run test_skillpoints.js --update to fill them.');
}
