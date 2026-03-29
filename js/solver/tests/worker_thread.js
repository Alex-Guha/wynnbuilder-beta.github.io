// ══════════════════════════════════════════════════════════════════════════════
// NODE.JS WORKER THREAD ADAPTER
// Wraps the solver's Web Worker (worker.js) in a Node.js worker_threads Worker.
// Simulates the browser's importScripts / self / postMessage API.
//
// Uses the thread's real V8 global scope (no vm sandbox) for native JIT
// performance matching the browser.  Each worker_thread gets its own isolate,
// so polluting globalThis is safe.
//
// Used by test_solver_search.js for real parallel solver execution.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { parentPort, workerData } = require('worker_threads');
const vm = require('vm');
const fs = require('fs');
const path = require('path');

const REPO_ROOT = workerData.repoRoot;

// Shim the 3 Web Worker APIs on the real globalThis.
// vm.runInThisContext executes in the thread's real V8 context (no sandbox),
// so const/let declarations are visible across calls — like <script> tags in
// a browser.  Unlike vm.runInContext with a sandboxed context, this pays no
// context-switch overhead per property access or function call.
globalThis.self = globalThis;
globalThis.postMessage = (msg) => parentPort.postMessage(msg);
globalThis.importScripts = () => {};  // no-op — we load files explicitly below

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
    'js/solver/pure/spell.js',
    'js/solver/pure/boost.js',
    'js/solver/pure/utils.js',
    'js/solver/pure/simulate.js',
    'js/solver/pure/engine.js',
    'js/solver/engine/worker_shims.js',
];

for (const relPath of WORKER_DEPS) {
    const absPath = path.join(REPO_ROOT, relPath);
    vm.runInThisContext(fs.readFileSync(absPath, 'utf8'), { filename: absPath });
}

// Load worker.js — use the same progress interval as the browser (5000).
const workerPath = path.join(REPO_ROOT, 'js', 'solver', 'engine', 'worker.js');
const workerCode = fs.readFileSync(workerPath, 'utf8');
vm.runInThisContext(workerCode, { filename: workerPath });

// Relay messages from parent to the worker's self.onmessage.
parentPort.on('message', (msg) => {
    if (self.onmessage) {
        try {
            self.onmessage({ data: msg });
        } catch (err) {
            parentPort.postMessage({ type: 'worker_error', message: `[worker_thread] ${err.message}\n${err.stack}` });
            parentPort.postMessage({ type: 'done', worker_id: msg.worker_id ?? 0, checked: 0, feasible: 0, top5: [] });
        }
    }
});
