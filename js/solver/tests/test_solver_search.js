// ══════════════════════════════════════════════════════════════════════════════
// SOLVER SEARCH TESTS
// Runs the full solver pipeline headlessly: pool building, sensitivity weights,
// dominance pruning, priority sorting, partitioning, and parallel worker
// enumeration via worker_threads.  Asserts the solver finds builds scoring
// >= a known threshold within a time limit.
//
// Run: node js/solver/tests/test_solver_search.js
// Requires Node.js >= 18.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const { Worker } = require('worker_threads');
const {
    createSandbox, loadGameData, decodeSolverUrl, decodeActiveNodes,
    buildAtreeMerged, collectSpells, collectRawStats,
    TestRunner, loadSnapshot, checkSnapshotFreshness, extractLockedItemStats,
    REPO_ROOT,
} = require('./harness');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const os = require('os');

// ── Setup ────────────────────────────────────────────────────────────────────

const ctx = createSandbox();
loadGameData(ctx);
const t = new TestRunner('Solver Search');

// Inject constants that search.js needs from other files (const/let scoped).
vm.runInContext(`
    // _NONE_ITEM_IDX is defined in solver/graph/build.js — inject it here
    // since we don't load that file (it has graph node dependencies).
    var _NONE_ITEM_IDX = {
        helmet: 0, chestplate: 1, leggings: 2, boots: 3,
        ring1: 4, ring2: 5, bracelet: 6, necklace: 7, weapon: 8,
    };
`, ctx);

// Load search.js for the pool-building / weight / prune / priority pipeline.
const searchPath = path.join(REPO_ROOT, 'js', 'solver', 'engine', 'search.js');
vm.runInContext(fs.readFileSync(searchPath, 'utf8'), ctx, { filename: searchPath });

// Export let/const vars from search.js we need.
vm.runInContext(`
    globalThis._build_item_pools = _build_item_pools;
    globalThis._serialize_pools = _serialize_pools;
    globalThis._serialize_locked = _serialize_locked;
    globalThis._build_worker_init_msg = _build_worker_init_msg;
    globalThis._apply_roll_mode_to_item = _apply_roll_mode_to_item;
    globalThis._partition_work = _partition_work;
    globalThis._TOP_N = typeof _TOP_N !== 'undefined' ? _TOP_N : 15;
`, ctx);

// ── Slot constants ───────────────────────────────────────────────────────────

const SLOT_NAMES = ['helmet', 'chestplate', 'leggings', 'boots', 'ring1', 'ring2', 'bracelet', 'necklace'];
const NONE_IDX = { helmet: 0, chestplate: 1, leggings: 2, boots: 3, ring1: 4, ring2: 5, bracelet: 6, necklace: 7 };
const WORKER_THREAD_PATH = path.join(__dirname, 'worker_thread.js');

// ── Build solver snapshot from decoded URL ───────────────────────────────────

function buildTestSnapshot(decoded, snap, spellMap, atreeMerged, rawStats) {
    const weaponItem = ctx.itemMap.get(decoded.equipment[8]);
    const weaponSM = ctx.expandItem(weaponItem);
    weaponSM.set('powders', []);
    ctx.apply_weapon_powders(weaponSM);

    const tomeNames = decoded.tomes || [];
    const tomes = [];
    for (let i = 0; i < 7; i++) {
        const name = tomeNames[i];
        const tome = (name && ctx.tomeMap.has(name)) ? ctx.tomeMap.get(name) : ctx.none_tomes[i];
        tomes.push({ statMap: ctx.expandItem(tome) });
    }

    // Guild tome (index 2)
    const guildTomeSM = tomes[2].statMap;

    // SP budget
    const sp_budget = ctx.SP_TOTAL_CAP;

    // Atree raw stats
    const atreeRaw = new Map();
    for (const [stat, value] of rawStats) ctx.merge_stat(atreeRaw, stat, value);

    // Button/slider states
    const buttonStates = snap.button_states ? new Map(Object.entries(snap.button_states)) : new Map();
    const sliderStates = snap.slider_states ? new Map(Object.entries(snap.slider_states)) : new Map();

    // Atree scaling
    const [, scaleStats] = ctx.atree_compute_scaling(atreeMerged, new Map(), buttonStates, sliderStates);
    const staticBoosts = new Map();
    for (const [stat, value] of scaleStats) ctx.merge_stat(staticBoosts, stat, value);

    // Parse combo from decoded solver params
    const sp = decoded.solverParams || {};
    const parsedCombo = [];
    for (const row of (sp.combo_rows || [])) {
        const spell = spellMap.get(row.spell_node_id);
        if (!spell) continue;
        parsedCombo.push({
            qty: row.qty,
            spell,
            boost_tokens: (row.boosts || []).map(b => ({
                name: `node_${b.node_id}_${b.effect_pos}`,
                value: b.has_value ? b.value : 1,
                is_pct: b.has_value,
            })),
            mana_excl: row.mana_excl,
            dmg_excl: row.dmg_excl,
        });
    }

    // Restrictions
    const rStats = vm.runInContext('RESTRICTION_STATS', ctx);
    const restrictions = {
        stat_thresholds: (sp.restrictions || []).map(r => ({
            stat: rStats?.[r.stat_index]?.key ?? 'unknown',
            op: r.op === 0 ? 'ge' : 'le',
            value: r.value,
        })),
    };

    // Spell base costs
    const spellBaseCosts = {};
    for (const [id, spell] of spellMap) {
        if (id >= 1 && id <= 4 && spell.cost != null) {
            spellBaseCosts[id] = spell.cost;
        }
    }

    return {
        weapon: { statMap: weaponSM },
        weapon_sm: weaponSM,
        level: decoded.level,
        tomes,
        guild_tome_item: { statMap: guildTomeSM },
        sp_budget,
        atree_mgd: atreeMerged,
        atree_raw: atreeRaw,
        button_states: buttonStates,
        slider_states: sliderStates,
        radiance_boost: 1.0,
        static_boosts: staticBoosts,
        parsed_combo: parsedCombo,
        boost_registry: [],
        scoring_target: snap.scoring_target || 'combo_damage',
        combo_time: sp.ctime || 0,
        allow_downtime: sp.dtime || false,
        flat_mana: sp.flat_mana || 0,
        hp_casting: false,
        health_config: null,
        corruption_slider_name: null,
        spell_base_costs: spellBaseCosts,
        restrictions,
        // Pool building restrictions
        lvl_min: sp.lvl_min || 1,
        lvl_max: sp.lvl_max || decoded.level,
        no_major_id: sp.nomaj || false,
        dir_enabled: sp.dir_enabled ?? 0x1F,
    };
}

// Partition work uses the real _partition_work() from search.js.

// ── Run solver with worker_threads ───────────────────────────────────────────

function runSolverWorkers(initMsgBase, ringPoolSer, partitions, numWorkers, timeLimitMs) {
    return new Promise((resolve) => {
        const workers = [];
        const allTop = [];
        const progressTop = [];
        const progressCounts = {};
        let totalChecked = 0, totalFeasible = 0;
        let partitionIdx = 0;
        let doneCount = 0;
        let timedOut = false;

        function dispatchNext(worker, workerId) {
            if (timedOut || partitionIdx >= partitions.length) return false;
            const partition = partitions[partitionIdx++];
            if (workerId === -1) {
                // First init message
                const msg = { ...initMsgBase, partition, worker_id: worker._workerId };
                worker.postMessage(msg);
            } else {
                worker.postMessage({ type: 'run', partition, worker_id: workerId });
            }
            return true;
        }

        function onProgress(msg) {
            // Accumulate running checked/feasible counts from progress updates.
            // Track per-worker latest counts to avoid double-counting.
            if (!progressCounts[msg.worker_id]) progressCounts[msg.worker_id] = { checked: 0, feasible: 0 };
            progressCounts[msg.worker_id].checked = msg.checked || 0;
            progressCounts[msg.worker_id].feasible = msg.feasible || 0;
            // Collect top5 from progress (when top5 changes, worker sends top5_names).
            if (msg.top5_names) {
                for (const entry of msg.top5_names) {
                    progressTop.push(entry);
                }
            }
        }

        function onDone(msg) {
            totalChecked += msg.checked || 0;
            totalFeasible += msg.feasible || 0;
            if (msg.top5) allTop.push(...msg.top5);
            // Clear progress counts for this worker (done supersedes progress).
            delete progressCounts[msg.worker_id];

            doneCount++;
            // Dispatch next partition to this worker
            const w = workers.find(w => w._workerId === msg.worker_id);
            if (w && !timedOut) {
                if (!dispatchNext(w, msg.worker_id)) {
                    // No more work for this worker
                }
            }

            // Check if all workers are idle
            if (doneCount >= partitions.length || timedOut) {
                cleanup();
            }
        }

        function cleanup() {
            clearTimeout(timer);
            for (const w of workers) {
                try { w.terminate(); } catch (e) {}
            }
            // Add progress counts from workers that didn't finish (timed out).
            for (const wid in progressCounts) {
                totalChecked += progressCounts[wid].checked;
                totalFeasible += progressCounts[wid].feasible;
            }
            // Merge top results from done messages + progress messages.
            const merged = [...allTop, ...progressTop];
            merged.sort((a, b) => (b.score || 0) - (a.score || 0));
            resolve({
                top5: merged.slice(0, 15),
                checked: totalChecked,
                feasible: totalFeasible,
                timedOut,
            });
        }

        // Time limit
        const timer = setTimeout(() => {
            timedOut = true;
            for (const w of workers) {
                try { w.postMessage({ type: 'cancel' }); } catch (e) {}
            }
            // Give workers a moment to finish current work
            setTimeout(cleanup, 500);
        }, timeLimitMs);

        // Spawn workers
        const actualWorkers = Math.min(numWorkers, partitions.length);
        for (let i = 0; i < actualWorkers; i++) {
            const w = new Worker(WORKER_THREAD_PATH, {
                workerData: { repoRoot: REPO_ROOT },
            });
            w._workerId = i;
            w.on('message', (msg) => {
                if (msg.type === 'done') onDone(msg);
                else if (msg.type === 'progress') onProgress(msg);
                // Ignore ready messages
            });
            w.on('error', (err) => {
                console.error(`  Worker ${i} error:`, err.message);
                console.error(err.stack);
            });
            workers.push(w);

            // Send init message with first partition
            dispatchNext(w, -1);
        }
    });
}

// ── Test runner ──────────────────────────────────────────────────────────────

async function runSolverTest(snapName) {
    const snap = loadSnapshot(snapName);

    // 1. Decode URL
    const decoded = decodeSolverUrl(ctx, snap.url_hash);
    t.assert(decoded.playerClass !== null, `${snapName}: decoded class = ${decoded.playerClass}`);

    // 2. Build atree + spells
    const activeNodes = decodeActiveNodes(ctx, decoded.playerClass, decoded.atree_data);
    t.assert(activeNodes.length > 0, `${snapName}: ${activeNodes.length} atree nodes`);

    const roughSM = new Map();
    roughSM.set('activeMajorIDs', []);
    const atreeMerged = buildAtreeMerged(ctx, decoded.playerClass, activeNodes, roughSM, decoded.aspects);
    const rawStats = collectRawStats(ctx, atreeMerged);
    const spellMap = collectSpells(ctx, atreeMerged);

    // 3. Build solver snapshot
    const solverSnap = buildTestSnapshot(decoded, snap, spellMap, atreeMerged, rawStats);

    // 4. Set roll mode in sandbox for pool building
    const sp = decoded.solverParams || {};
    if (sp.roll_groups) ctx.current_roll_mode = sp.roll_groups;

    // 5. Build pools using the real _build_item_pools
    const buildDir = {};
    const dirOrder = ['str', 'dex', 'int', 'def', 'agi'];
    for (let i = 0; i < 5; i++) {
        buildDir[dirOrder[i]] = !!((solverSnap.dir_enabled) & (1 << i));
    }
    const poolRestrictions = {
        lvl_min: solverSnap.lvl_min,
        lvl_max: solverSnap.lvl_max,
        no_major_id: solverSnap.no_major_id,
        build_dir: buildDir,
    };

    const allPools = ctx._build_item_pools(poolRestrictions);

    // 6. Determine locked vs free items from sfree mask (from URL).
    const sfree = sp.sfree ?? 0;
    const locked = {};
    const freePools = {};

    for (let i = 0; i < 8; i++) {
        const slot = SLOT_NAMES[i];
        const isFree = !!(sfree & (1 << i));

        if (!isFree) {
            // Lock this slot
            const name = decoded.equipment[i];
            const item = (name && ctx.itemMap.has(name)) ? ctx.itemMap.get(name) : ctx.none_items[NONE_IDX[slot]];
            const it = ctx._apply_roll_mode_to_item(new ctx.Item(item));
            locked[slot] = { statMap: it.statMap, _illegalSet: null, _illegalSetName: null };
        }
    }

    // Build free pools: map slot names to their item type pools
    const slotToType = { helmet: 'helmet', chestplate: 'chestplate', leggings: 'leggings',
                         boots: 'boots', ring1: 'ring', ring2: 'ring', bracelet: 'bracelet', necklace: 'necklace' };
    for (let i = 0; i < 8; i++) {
        const slot = SLOT_NAMES[i];
        if (sfree & (1 << i)) {
            const type = slotToType[slot];
            if (type === 'ring') {
                if (!freePools.ring) freePools.ring = allPools.ring;
            } else {
                freePools[slot] = allPools[type];
            }
        }
    }

    // 7. Sensitivity weights, dominance pruning, priority sorting
    const dmgWeights = ctx._build_dmg_weights(solverSnap, locked, freePools);
    if (dmgWeights) {
        const domStats = ctx._build_dominance_stats(solverSnap, dmgWeights, solverSnap.restrictions);
        ctx._prune_dominated_items(freePools, domStats);
        ctx._prioritize_pools(freePools, dmgWeights);
    }

    // Freshness check: locked item stats + compress hash (has free slots).
    const currentLockedStats = extractLockedItemStats(locked);
    const hasFreeSlots = Object.keys(freePools).length > 0;
    checkSnapshotFreshness(snap, t, currentLockedStats, hasFreeSlots);

    // Log pool sizes
    const poolSizes = {};
    for (const [slot, pool] of Object.entries(freePools)) {
        poolSizes[slot] = pool.length;
    }
    console.log(`  [${snapName}] pool sizes:`, poolSizes);

    // 8. Serialize for worker transfer
    const poolsSer = ctx._serialize_pools(freePools);
    const lockedSer = ctx._serialize_locked(locked);
    const ringPoolSer = poolsSer.ring || [];
    const noneItemSMs = ctx.none_items.slice(0, 8).map(ni => ctx.expandItem(ni));

    // 9. Build base init message (without partition)
    const initMsgBase = {
        type: 'init',
        pools: poolsSer,
        locked: lockedSer,
        weapon_sm: solverSnap.weapon_sm,
        level: solverSnap.level,
        tome_sms: solverSnap.tomes.map(t => t.statMap),
        guild_tome_sm: solverSnap.guild_tome_item.statMap,
        sp_budget: solverSnap.sp_budget,
        atree_merged: solverSnap.atree_mgd,
        atree_raw: solverSnap.atree_raw,
        button_states: solverSnap.button_states,
        slider_states: solverSnap.slider_states,
        radiance_boost: solverSnap.radiance_boost,
        static_boosts: solverSnap.static_boosts,
        parsed_combo: solverSnap.parsed_combo,
        boost_registry: solverSnap.boost_registry,
        scoring_target: solverSnap.scoring_target,
        combo_time: solverSnap.combo_time,
        allow_downtime: solverSnap.allow_downtime,
        flat_mana: solverSnap.flat_mana,
        hp_casting: solverSnap.hp_casting,
        health_config: solverSnap.health_config,
        corruption_slider_name: solverSnap.corruption_slider_name,
        spell_base_costs: solverSnap.spell_base_costs,
        restrictions: solverSnap.restrictions,
        sets_data: [...ctx.sets],
        ring_pool: ringPoolSer,
        ring1_locked: lockedSer.ring1 ?? null,
        ring2_locked: lockedSer.ring2 ?? null,
        none_item_sms: noneItemSMs,
        none_idx_map: NONE_IDX,
    };

    // 10. Build partitions and run workers
    // Match the real solver's worker count: min(hardwareConcurrency - 2, 16), at least 1.
    const numWorkers = snap.num_workers || Math.max(1, Math.min((os.cpus().length || 4) - 2, 16));
    const timeLimitMs = (snap.time_limit_seconds || 30) * 1000;
    // Real solver creates 4× worker count partitions for work-stealing.
    const numPartitions = Math.max(numWorkers * 4, numWorkers);
    const partitions = ctx._partition_work(freePools, locked, numPartitions);
    console.log(`  [${snapName}] ${partitions.length} partitions, ${numWorkers} workers, ${timeLimitMs / 1000}s limit`);

    const t0 = Date.now();
    const result = await runSolverWorkers(initMsgBase, ringPoolSer, partitions, numWorkers, timeLimitMs);
    const elapsed = Date.now() - t0;

    console.log(`  [${snapName}] checked: ${result.checked}, feasible: ${result.feasible}, top5: ${result.top5?.length}, time: ${elapsed}ms${result.timedOut ? ' (timed out)' : ''}`);

    // 11. Assert results
    if (result.top5 && result.top5.length > 0) {
        const bestScore = result.top5[0].score;
        console.log(`  [${snapName}] best score: ${Math.round(bestScore)}`);

        if (snap.expected_min_score != null) {
            // Score must reach or surpass the target.
            t.assertGe(bestScore, snap.expected_min_score,
                `${snapName}: best score ${Math.round(bestScore)} >= target ${snap.expected_min_score}`);
        } else {
            // No target given — just verify the solver found a functional build.
            t.assert(true, `${snapName}: found a functional build (score=${Math.round(bestScore)})`);
        }

        const best = result.top5[0];
        if (best.item_names) {
            const items = best.item_names.map((n, i) => n || `(none@${SLOT_NAMES[i]})`);
            console.log(`  [${snapName}] best items: ${items.join(', ')}`);
        }
    } else {
        t.assert(false, `${snapName}: solver found no results`);
    }
}

// ── Discover and run test cases ──────────────────────────────────────────────

async function main() {
    const snapDir = path.join(__dirname, 'snapshots');
    const solverSnaps = fs.readdirSync(snapDir)
        .filter(f => f.startsWith('solver_') && f.endsWith('.snap.json'))
        .map(f => f.replace('.snap.json', ''));

    if (solverSnaps.length === 0) {
        t.warn('No solver snapshots found. Create snapshots/solver_*.snap.json to add test cases.');
        t.warn('See README.md for snapshot format.');
    }

    for (const snapName of solverSnaps) {
        try {
            await runSolverTest(snapName);
        } catch (err) {
            t.assert(false, `${snapName}: threw error — ${err.message}`);
            console.error(err.stack);
        }
    }

    const summary = t.summary();
    if (require.main === module) {
        if (summary.fail > 0) process.exit(1);
    }
}

main();
