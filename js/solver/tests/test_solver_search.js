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
    buildAtreeMerged, collectSpells, collectRawStats, extractAtreeInteractiveDefaults,
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

// Load combo/boost.js, combo/codec.js, and combo/simulate.js for boost registry,
// name resolution, and health config extraction.
for (const relPath of ['js/solver/combo/boost.js', 'js/solver/combo/codec.js', 'js/solver/combo/simulate.js']) {
    const absPath = path.join(REPO_ROOT, relPath);
    vm.runInContext(fs.readFileSync(absPath, 'utf8'), ctx, { filename: absPath });
}

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
    globalThis.build_combo_boost_registry = typeof build_combo_boost_registry !== 'undefined' ? build_combo_boost_registry : null;
    globalThis.node_ref_to_boost_name = typeof node_ref_to_boost_name !== 'undefined' ? node_ref_to_boost_name : null;
    globalThis.node_id_to_spell_value = typeof node_id_to_spell_value !== 'undefined' ? node_id_to_spell_value : null;
    globalThis.extract_health_config = typeof extract_health_config !== 'undefined' ? extract_health_config : null;
    globalThis.compute_dps_spell_hits_info = typeof compute_dps_spell_hits_info !== 'undefined' ? compute_dps_spell_hits_info : null;
`, ctx);

// ── Slot constants ───────────────────────────────────────────────────────────

const SLOT_NAMES = ['helmet', 'chestplate', 'leggings', 'boots', 'ring1', 'ring2', 'bracelet', 'necklace'];
const NONE_IDX = { helmet: 0, chestplate: 1, leggings: 2, boots: 3, ring1: 4, ring2: 5, bracelet: 6, necklace: 7 };
const WORKER_THREAD_PATH = path.join(__dirname, 'worker_thread.js');

// ── Powder parsing helper ────────────────────────────────────────────────────

/**
 * Convert decoded powder data to an array of integer powder IDs.
 * Handles both formats:
 *   - Modern (array of ints): already correct, return as-is
 *   - Legacy (string like "f7f7f7"): parse 2-char codes via powderIDs map
 */
function parsePowderData(raw) {
    if (Array.isArray(raw)) return raw;
    if (typeof raw !== 'string' || raw === '') return [];
    const ids = [];
    for (let i = 0; i + 1 < raw.length; i += 2) {
        const code = raw.substring(i, i + 2);
        const pid = ctx.powderIDs.get(code);
        if (pid !== undefined) ids.push(pid);
    }
    return ids;
}

// ── Build solver snapshot from decoded URL ───────────────────────────────────

function buildTestSnapshot(decoded, snap, spellMap, atreeMerged, rawStats) {
    const sp = decoded.solverParams || {};

    // ── 1. Weapon with powders ──────────────────────────────────────────────
    // Apply roll mode to weapon (expandItem only creates minRolls/maxRolls;
    // _apply_roll_mode_to_item selects actual values for the top-level statMap).
    const weaponItem = ctx.itemMap.get(decoded.equipment[8]);
    const weaponIt = ctx._apply_roll_mode_to_item(new ctx.Item(weaponItem));
    const weaponSM = weaponIt.statMap;
    // Apply weapon powders from decoded URL (powderables map: slot 8 → index 4)
    const weaponPowders = parsePowderData(decoded.powders && decoded.powders[4]);
    weaponSM.set('powders', weaponPowders);
    ctx.apply_weapon_powders(weaponSM);

    // ── 2. Tomes ────────────────────────────────────────────────────────────
    const tomeNames = decoded.tomes || [];
    const tomes = [];
    for (let i = 0; i < 7; i++) {
        const name = tomeNames[i];
        const tome = (name && ctx.tomeMap.has(name)) ? ctx.tomeMap.get(name) : ctx.none_tomes[i];
        tomes.push({ statMap: ctx.expandItem(tome) });
    }

    // ── 3. SP budget with guild tome handling (mirrors search.js:210-224) ───
    // Note: expandItem() does not set the 'NONE' flag — that flag is set by
    // the graph node system at runtime.  Detect NONE guild tomes by checking
    // whether a real tome name was decoded from the URL.
    const guildTomeName = tomeNames[2];
    const has_real_guild_tome = !!(guildTomeName && ctx.tomeMap.has(guildTomeName));
    let sp_budget = ctx.levelToSkillPoints(decoded.level);
    if (!has_real_guild_tome) {
        const gtome_mode = sp.gtome ?? 0;
        if (gtome_mode === 1) {
            // Standard: +4 freely assignable SP
            sp_budget = ctx.levelToSkillPoints(decoded.level) + 4;
        } else if (gtome_mode === 2) {
            // Rainbow: fixed [1,1,1,1,1] synthetic tome
            const synth = new Map();
            synth.set('skillpoints', [1, 1, 1, 1, 1]);
            synth.set('reqs', [0, 0, 0, 0, 0]);
            tomes[2] = { statMap: synth };
        }
    }

    // ── 4. Atree raw stats ──────────────────────────────────────────────────
    const atreeRaw = new Map();
    for (const [stat, value] of rawStats) ctx.merge_stat(atreeRaw, stat, value);

    // Button/slider states — use snapshot overrides if present, else atree defaults.
    // After combo parsing, we infer slider/button states from combo boost tokens
    // (the URL doesn't encode atree interactive state, but the combo rows reflect it).
    const atreeDefaults = extractAtreeInteractiveDefaults(atreeMerged);
    const buttonStates = snap.button_states
        ? new Map(Object.entries(snap.button_states))
        : new Map(atreeDefaults.button_states);
    const sliderStates = snap.slider_states
        ? new Map(Object.entries(snap.slider_states))
        : new Map(atreeDefaults.slider_states);

    // Static boosts — in the real app these come from compute_boosts() (potion
    // toggle buttons on the page).  No potions are active for headless tests,
    // so static_boosts is empty.
    const staticBoosts = new Map();

    // ── 5. Augmented spell map with powder specials (mirrors search.js:111-118)
    const augSpellMap = new Map(spellMap);
    for (const ps_idx of [0, 1, 3]) {
        const tier = ctx.get_element_powder_tier(weaponPowders, ps_idx);
        if (tier > 0) augSpellMap.set(-1000 - ps_idx, ctx.make_powder_special_spell(ps_idx, tier));
    }
    ctx.apply_deferred_powder_special_effects(augSpellMap, spellMap);

    // ── 6. Boost registry with weapon + armor powders ───────────────────────
    // Create minimal mock build so build_combo_boost_registry includes powder
    // buff entries (weapon buffs + armor sliders).
    const mockEquip = [];
    for (let i = 0; i < 4; i++) {
        const sm = new Map();
        sm.set('powders', parsePowderData(decoded.powders && decoded.powders[i]));
        mockEquip.push({ statMap: sm });
    }
    const mockBuild = { weapon: { statMap: weaponSM }, equipment: mockEquip };
    const boostRegistry = ctx.build_combo_boost_registry
        ? ctx.build_combo_boost_registry(atreeMerged, mockBuild)
        : [];

    // ── 7. Health config / Blood Pact ───────────────────────────────────────
    const health_config = ctx.extract_health_config
        ? ctx.extract_health_config(atreeMerged)
        : null;
    const hp_casting = health_config?.hp_casting ?? false;

    // ── 8. Parse combo rows (powder specials + pseudo-spells) ───────────────
    const parsedCombo = [];
    for (const row of (sp.combo_rows || [])) {
        const node_id = row.spell_node_id;

        // Pseudo-spell: Mana Reset
        if (node_id === ctx.MANA_RESET_NODE_ID) {
            parsedCombo.push({ pseudo: 'mana_reset', mana_excl: row.mana_excl });
            continue;
        }

        // Pseudo-spell: Cancel state (e.g. Cancel Corrupted)
        let cancel_pseudo = null;
        if (ctx.STATE_CANCEL_NODE_IDS) {
            for (const [state_name, cancel_node_id] of ctx.STATE_CANCEL_NODE_IDS) {
                if (node_id === cancel_node_id) {
                    cancel_pseudo = 'cancel_state:' + state_name;
                    break;
                }
            }
        }
        if (cancel_pseudo) {
            parsedCombo.push({ pseudo: cancel_pseudo, mana_excl: row.mana_excl });
            continue;
        }

        // Regular spell or powder special: resolve to spell map key
        const spell_value_str = ctx.node_id_to_spell_value
            ? ctx.node_id_to_spell_value(node_id)
            : String(node_id);
        const spell_key = parseInt(spell_value_str);
        const spell = augSpellMap.get(spell_key);
        if (!spell) continue;

        const entry = {
            qty: row.qty,
            spell,
            boost_tokens: (row.boosts || []).map(b => ({
                name: ctx.node_ref_to_boost_name
                    ? ctx.node_ref_to_boost_name(b.node_id, b.effect_pos, atreeMerged)
                    : `node_${b.node_id}_${b.effect_pos}`,
                value: b.has_value ? b.value : 1,
                is_pct: b.has_value,
            })),
            mana_excl: row.mana_excl,
            dmg_excl: row.dmg_excl,
        };

        // DPS spell info
        if (ctx.compute_dps_spell_hits_info) {
            const dps_info = ctx.compute_dps_spell_hits_info(spell);
            if (dps_info) {
                entry.dps_per_hit_name = dps_info.per_hit_name;
                entry.dps_hits = row.has_hits ? row.hits : dps_info.max_hits;
            }
        }

        parsedCombo.push(entry);
    }

    // ── 8b. Atree interactive state ─────────────────────────────────────────
    // The URL hash doesn't encode atree interactive state (button/slider).
    // We leave button_states and slider_states at defaults.  Toggle stat
    // bonuses (e.g. spPctXFinal from "Activate Dimensional Tear") are
    // applied per-row by combo boost tokens — NOT globally — to avoid the
    // double-counting bug documented in TOGGLE_DOUBLE_COUNT_BUG.md.
    // Snapshots can override via explicit button_states / slider_states fields.

    // ── 9. Recast penalties (mirrors search.js:245-297) ─────────────────────
    {
        const PENALTY = ctx.RECAST_MANA_PENALTY ?? 5;
        let _rc_last_base = null, _rc_consec = 0, _rc_penalty = 0;
        for (const row of parsedCombo) {
            if (row.pseudo) {
                if (row.pseudo === 'mana_reset' && !row.mana_excl) {
                    _rc_last_base = null; _rc_consec = 0; _rc_penalty = 0;
                }
                continue;
            }
            const { qty, spell, mana_excl } = row;
            row.recast_penalty_per_cast = 0;
            if (!spell || qty <= 0 || mana_excl || spell.cost == null) continue;
            const rc_base = spell.mana_derived_from ?? spell.base_spell;
            if (rc_base === 0) continue;

            let row_penalty = 0;
            let is_switch = false;
            if (rc_base !== _rc_last_base) {
                is_switch = true;
                if (_rc_consec <= 1) { _rc_penalty = 0; } else { _rc_penalty += 1; }
                _rc_consec = 0;
                _rc_last_base = rc_base;
            }
            if (is_switch && _rc_penalty > 0) {
                row_penalty = _rc_penalty * PENALTY;
                _rc_penalty = 0;
                _rc_consec = 1;
                const remaining = qty - 1;
                if (remaining > 0) {
                    const free_remaining = Math.min(remaining, 1);
                    const penalty_remaining = remaining - free_remaining;
                    if (penalty_remaining > 0) {
                        row_penalty += PENALTY * penalty_remaining * (penalty_remaining + 1) / 2;
                        _rc_penalty = penalty_remaining;
                    }
                    _rc_consec += remaining;
                }
            } else if (_rc_penalty > 0) {
                row_penalty = PENALTY * (qty * _rc_penalty + qty * (qty + 1) / 2);
                _rc_penalty += qty;
                _rc_consec += qty;
            } else {
                const free_casts = Math.max(0, Math.min(qty, 2 - _rc_consec));
                const penalty_casts = qty - free_casts;
                if (penalty_casts > 0) {
                    row_penalty = PENALTY * penalty_casts * (penalty_casts + 1) / 2;
                    _rc_penalty = penalty_casts;
                }
                _rc_consec += qty;
            }
            row.recast_penalty_per_cast = qty > 0 ? row_penalty / qty : 0;
        }
    }

    // ── 10. Auto-slider stripping (mirrors search.js:300-315) ───────────────
    const auto_slider_names_set = new Set();
    if (hp_casting && health_config) {
        if (health_config.damage_boost?.slider_name)
            auto_slider_names_set.add(health_config.damage_boost.slider_name);
        for (const bs of (health_config.buff_states || []))
            if (bs.slider_name) auto_slider_names_set.add(bs.slider_name);
    }
    if (auto_slider_names_set.size > 0) {
        for (const row of parsedCombo) {
            if (row.boost_tokens) {
                row.boost_tokens = row.boost_tokens.filter(t => !auto_slider_names_set.has(t.name));
            }
        }
    }

    // ── 11. Restrictions ────────────────────────────────────────────────────
    const rStats = vm.runInContext('RESTRICTION_STATS', ctx);
    const restrictions = {
        stat_thresholds: (sp.restrictions || []).map(r => ({
            stat: rStats?.[r.stat_index]?.key ?? 'unknown',
            op: r.op === 0 ? 'ge' : 'le',
            value: r.value,
        })),
    };

    // ── 12. Spell base costs ────────────────────────────────────────────────
    const spellBaseCosts = {};
    for (const [id, spell] of augSpellMap) {
        if (typeof id === 'number' && id >= 1 && id <= 4 && spell.cost != null) {
            spellBaseCosts[id] = spell.cost;
        }
    }
    // Prefer costs from parsed combo rows (user's active spells)
    for (const row of parsedCombo) {
        if (row.spell?.base_spell >= 1 && row.spell?.base_spell <= 4 && row.spell.cost != null) {
            spellBaseCosts[row.spell.base_spell] = row.spell.cost;
        }
    }

    return {
        weapon: { statMap: weaponSM },
        weapon_sm: weaponSM,
        level: decoded.level,
        tomes,
        guild_tome_item: { statMap: tomes[2].statMap },
        sp_budget,
        atree_mgd: atreeMerged,
        atree_raw: atreeRaw,
        button_states: buttonStates,
        slider_states: sliderStates,
        radiance_boost: 1.0,
        static_boosts: staticBoosts,
        parsed_combo: parsedCombo,
        boost_registry: boostRegistry,
        scoring_target: snap.scoring_target || 'combo_damage',
        combo_time: sp.ctime || 0,
        allow_downtime: sp.dtime || false,
        flat_mana: sp.flat_mana || 0,
        hp_casting,
        health_config,
        auto_slider_names: [...auto_slider_names_set],
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

// ── Seed build helper ────────────────────────────────────────────────────────

/**
 * Build a statMap from the URL-hash items to extract activeMajorIDs.
 * This mirrors the real solver which uses the pre-search UI build state
 * for the atree merge (major ID abilities depend on equipped items).
 */
function _buildSeedStatMap(decoded) {
    const sp = decoded.solverParams || {};
    if (sp.roll_groups) {
        vm.runInContext(`current_roll_mode = ${JSON.stringify(sp.roll_groups)}`, ctx);
    }

    // Build equipment statMaps
    const equipSMs = [];
    for (let i = 0; i < 8; i++) {
        const name = decoded.equipment[i];
        const item_obj = (name && ctx.itemMap.has(name)) ? ctx.itemMap.get(name) : ctx.none_items[NONE_IDX[SLOT_NAMES[i]]];
        const it = ctx._apply_roll_mode_to_item(new ctx.Item(item_obj));
        equipSMs.push(it.statMap);
    }

    // Build weapon statMap with powders (roll mode + powders)
    const weaponIt = ctx._apply_roll_mode_to_item(new ctx.Item(ctx.itemMap.get(decoded.equipment[8])));
    const weaponSM = weaponIt.statMap;
    const weaponPowders = parsePowderData(decoded.powders && decoded.powders[4]);
    weaponSM.set('powders', weaponPowders);
    ctx.apply_weapon_powders(weaponSM);

    // Build tome statMaps
    const tomeSMs = [];
    for (let i = 0; i < 7; i++) {
        const name = (decoded.tomes || [])[i];
        const tome = (name && ctx.tomeMap.has(name)) ? ctx.tomeMap.get(name) : ctx.none_tomes[i];
        tomeSMs.push(ctx.expandItem(tome));
    }

    // Assemble via worker-shim path to get activeMajorIDs from finalizeStatmap
    const locked_sms = [weaponSM, ...tomeSMs];
    const running = ctx._init_running_statmap(decoded.level, locked_sms);
    for (const sm of equipSMs) ctx._incr_add_item(running, sm);
    const activeSetCounts = ctx.calculate_skillpoints(
        [...equipSMs, tomeSMs[2]], weaponSM, ctx.levelToSkillPoints(decoded.level))?.[3];
    const build_sm = ctx._finalize_leaf_statmap(
        running, weaponSM, activeSetCounts || new Map(), ctx.sets,
        [...equipSMs, ...tomeSMs, weaponSM], null, null);
    return build_sm;
}

// ── Test runner ──────────────────────────────────────────────────────────────

async function runSolverTest(snapName) {
    const snap = loadSnapshot(snapName);

    // 1. Decode URL
    const decoded = decodeSolverUrl(ctx, snap.url_hash);
    t.assert(decoded.playerClass !== null, `${snapName}: decoded class = ${decoded.playerClass}`);

    // 2. Build atree + spells
    // Build a seed statMap from the URL-hash items so activeMajorIDs are populated
    // (mirrors the real solver which uses atree_merge.value from the pre-search UI state).
    const activeNodes = decodeActiveNodes(ctx, decoded.playerClass, decoded.atree_data);
    t.assert(activeNodes.length > 0, `${snapName}: ${activeNodes.length} atree nodes`);

    const seedSM = _buildSeedStatMap(decoded);
    const atreeMerged = buildAtreeMerged(ctx, decoded.playerClass, activeNodes, seedSM, decoded.aspects);
    const rawStats = collectRawStats(ctx, atreeMerged);
    const spellMap = collectSpells(ctx, atreeMerged);

    // 3. Build solver snapshot
    const solverSnap = buildTestSnapshot(decoded, snap, spellMap, atreeMerged, rawStats);

    // 4. Set roll mode in sandbox for pool building
    const sp = decoded.solverParams || {};
    if (sp.roll_groups) {
        vm.runInContext(`current_roll_mode = ${JSON.stringify(sp.roll_groups)}`, ctx);
    }

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
            // Apply armor powders from decoded URL (powderables indices 0-3 = armor slots 0-3)
            if (i < 4) {
                const armorPowders = parsePowderData(decoded.powders && decoded.powders[i]);
                if (armorPowders.length > 0) {
                    it.statMap.set('powders', armorPowders);
                }
            }
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
        auto_slider_names: solverSnap.auto_slider_names,
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
