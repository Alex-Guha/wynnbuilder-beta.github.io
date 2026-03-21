#!/usr/bin/env node
// ══════════════════════════════════════════════════════════════════════════════
// TEST RUNNER — discovers and runs all test_*.js files in this directory.
//
// Run:  node js/solver/tests/run_all.js
// Requires Node.js >= 18.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const TEST_DIR = __dirname;
const testFiles = fs.readdirSync(TEST_DIR)
    .filter(f => f.startsWith('test_') && f.endsWith('.js'))
    .sort();

if (testFiles.length === 0) {
    console.log('No test files found.');
    process.exit(0);
}

console.log(`Found ${testFiles.length} test file(s):\n`);

let totalPass = 0, totalFail = 0, totalWarn = 0;
const results = [];

for (const file of testFiles) {
    const filePath = path.join(TEST_DIR, file);
    const label = file.replace('.js', '');
    process.stdout.write(`Running ${label}...`);

    try {
        const output = execSync(`node "${filePath}"`, {
            encoding: 'utf8',
            timeout: 120000,  // 2 minute timeout per test
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        // Parse pass/fail from output (TestRunner format: "X passed, Y failed, Z warnings")
        const match = output.match(/(\d+) passed, (\d+) failed, (\d+) warnings?/);
        if (match) {
            const p = parseInt(match[1]), f = parseInt(match[2]), w = parseInt(match[3]);
            totalPass += p;
            totalFail += f;
            totalWarn += w;
            results.push({ file: label, pass: p, fail: f, warn: w, status: f > 0 ? 'FAIL' : 'PASS' });
            console.log(` ${f > 0 ? 'FAIL' : 'PASS'} (${p}/${p + f}${w > 0 ? `, ${w} warnings` : ''})`);
        } else {
            // Self-contained test (like test_enum_order.js) — infer from exit code.
            results.push({ file: label, pass: '?', fail: 0, warn: 0, status: 'PASS' });
            console.log(' PASS');
        }

        // Print any warnings or failures from stdout.
        const lines = output.split('\n').filter(l =>
            l.includes('FAIL:') || l.includes('WARN:'));
        for (const line of lines) {
            console.log(`    ${line.trim()}`);
        }

    } catch (err) {
        // Non-zero exit code.
        const output = (err.stdout || '') + (err.stderr || '');
        const match = output.match(/(\d+) passed, (\d+) failed, (\d+) warnings?/);
        if (match) {
            const p = parseInt(match[1]), f = parseInt(match[2]), w = parseInt(match[3]);
            totalPass += p;
            totalFail += f;
            totalWarn += w;
            results.push({ file: label, pass: p, fail: f, warn: w, status: 'FAIL' });
            console.log(` FAIL (${p}/${p + f}${w > 0 ? `, ${w} warnings` : ''})`);
        } else {
            totalFail++;
            results.push({ file: label, pass: 0, fail: 1, warn: 0, status: 'CRASH' });
            console.log(' CRASH');
        }

        // Print error details.
        const lines = output.split('\n').filter(l =>
            l.includes('FAIL:') || l.includes('WARN:') || l.includes('Error:'));
        for (const line of lines.slice(0, 10)) {
            console.log(`    ${line.trim()}`);
        }
    }
}

// ── Summary ──────────────────────────────────────────────────────────────────

console.log('\n' + '═'.repeat(60));
console.log(`TOTAL: ${totalPass} passed, ${totalFail} failed, ${totalWarn} warnings`);
console.log('═'.repeat(60));

if (totalFail > 0) {
    console.log('\nFailed tests:');
    for (const r of results) {
        if (r.status === 'FAIL' || r.status === 'CRASH') {
            console.log(`  - ${r.file} (${r.status})`);
        }
    }
    process.exit(1);
}
