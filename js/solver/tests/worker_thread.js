// ══════════════════════════════════════════════════════════════════════════════
// NODE.JS WORKER THREAD ADAPTER
// Wraps the solver's Web Worker (worker.js) in a Node.js worker_threads Worker.
// Simulates the browser's importScripts / self / postMessage API.
//
// Used by test_solver_search.js for real parallel solver execution.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');

const REPO_ROOT = workerData.repoRoot;

// Build a VM context that mirrors the browser's Web Worker environment.
const ctx = vm.createContext({
    console,
    Math, Object, Array, Map, Set, WeakMap, WeakSet,
    JSON, Number, String, Boolean, Symbol, RegExp, Error,
    TypeError, RangeError, SyntaxError, ReferenceError,
    Int8Array, Uint8Array, Int16Array, Uint16Array,
    Int32Array, Uint32Array, Float32Array, Float64Array,
    BigInt64Array, BigUint64Array, ArrayBuffer, DataView,
    Promise, Proxy, Reflect,
    setTimeout, clearTimeout, setInterval, clearInterval,
    performance,
    structuredClone,
    isNaN, isFinite, parseInt, parseFloat,
    encodeURIComponent, decodeURIComponent,

    // Web Worker API stubs
    self: {},
    postMessage(msg) { parentPort.postMessage(msg); },
    importScripts() {},  // no-op — we load files explicitly below
});

ctx.self.postMessage = ctx.postMessage;
ctx.globalThis = ctx;

// Load the same files that worker.js importScripts() would load.
const WORKER_DEPS = [
    'js/core/utils.js',
    'js/game/game_rules.js',
    'js/game/build_utils.js',
    'js/game/skillpoints.js',
    'js/game/powders.js',
    'js/game/damage_calc.js',
    'js/game/shared_game_stats.js',
    'js/solver/debug_toggles.js',
    'js/solver/pure.js',
    'js/solver/engine/worker_shims.js',
];

for (const relPath of WORKER_DEPS) {
    const absPath = path.join(REPO_ROOT, relPath);
    vm.runInContext(fs.readFileSync(absPath, 'utf8'), ctx, { filename: absPath });
}

// Load worker.js itself.
const workerPath = path.join(REPO_ROOT, 'js', 'solver', 'engine', 'worker.js');
vm.runInContext(fs.readFileSync(workerPath, 'utf8'), ctx, { filename: workerPath });

// Relay messages from parent to the worker's self.onmessage.
parentPort.on('message', (msg) => {
    if (ctx.self.onmessage) {
        try {
            ctx.self.onmessage({ data: msg });
        } catch (err) {
            console.error('[worker_thread] onmessage error:', err.message, err.stack);
            parentPort.postMessage({ type: 'done', worker_id: msg.worker_id ?? 0, checked: 0, feasible: 0, top5: [] });
        }
    }
});
