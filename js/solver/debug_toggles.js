// ══════════════════════════════════════════════════════════════════════════════
// SOLVER DEBUG TOGGLES
//
// Central location for all solver debug flags. Flip these to enable console
// logging for the corresponding subsystem. All default to false for production.
//
// Loaded as a plain <script> on the main thread AND via importScripts() in the
// Web Worker, so no DOM or module-system dependencies are allowed here.
// ══════════════════════════════════════════════════════════════════════════════

// ── Item priority & dominance pruning (main thread) ─────────────────────────

// Log damage weights, constraint weights, priority scores, and pool ordering
// for each slot (top 20 items with scores).  [item_priority.js]
const SOLVER_DEBUG_PRIORITY = false;

// Log dominance pruning: before/after pool sizes per slot, which items were
// pruned, which item dominated them, and the stats that caused it.
// Uses console.group() for collapsible output.  [item_priority.js]
const SOLVER_DEBUG_DOMINANCE = false;

// ── Worker enumeration (Web Worker, worker 0 only) ──────────────────────────

// Log worker-0 enumeration stats: SP prune / precheck / threshold / mana
// rejection counts, feasible leaf timing, and best score found.  [worker.js]
const SOLVER_DEBUG_WORKER = false;

// ── Combo damage (main thread + Web Worker) ─────────────────────────────────

// Log detailed combo damage computation on the page (node.js) and re-evaluate
// the global top-1 solver result on the main thread with full row-by-row output.
// Covers: sim results, base_stats, weapon, crit chance, per-row boosts,
// stat deltas, per-cast damage, and totals.  [node.js, search.js, worker.js, pure.js]
const SOLVER_DEBUG_COMBO = false;
