// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WEB WORKER
// Runs a synchronous level-based enumeration over item combinations.
// No DOM access — all state is received via postMessage.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

importScripts(
    '../../core/utils.js',
    '../../game/game_rules.js',
    '../../game/build_utils.js',
    '../../game/skillpoints.js',
    '../../game/powders.js',
    '../../game/damage_calc.js',
    '../../game/shared_game_stats.js',
    '../debug_toggles.js',
    '../pure/spell.js',
    '../pure/boost.js',
    '../pure/utils.js',
    '../pure/simulate.js',
    '../pure/engine.js',
    './worker_shims.js'
);

// ── Globals set during init ─────────────────────────────────────────────────

let sets = new Map();   // needed by calculate_skillpoints (set bonus tracking)
let _cfg = null;        // full config from init message
let _cancelled = false;

// ── Constraint prechecks (computed once at init) ────────────────────────────
// For each eligible ge-threshold, we precompute:
//   adjusted_threshold = threshold - fixed_contributions
// where fixed_contributions = atree_raw[stat] + static_boosts[stat].
// At the leaf, we check running_sm.get(stat) >= adjusted_threshold.
// This is a conservative lower bound (ignores radiance boost, atree scaling,
// set bonuses — all of which can only increase the stat for ge constraints).
//
// Stats excluded from simple precheck:
//   - INDIRECT_CONSTRAINT_STATS (from pure/engine.js): derived stats needing full build context
//   - 'str','dex','int','def','agi': overwritten by total_sp from SP assignment
const _PRECHECK_EXCLUDED = new Set(INDIRECT_CONSTRAINT_STATS);
for (const sp of ['str', 'dex', 'int', 'def', 'agi']) _PRECHECK_EXCLUDED.add(sp);
let _constraint_prechecks = [];  // [{stat, adjusted_threshold}]
let _ehp_precheck = null;        // {threshold, fixed_hp, ehp_divisor} or null
let _ehp_no_agi_precheck = null; // {threshold, fixed_hp, ehp_divisor} or null
let _total_hp_precheck = null;   // {threshold, fixed_hp} or null

// ── SP floor/cap constraints (computed once at init) ─────────────────────────
// Floors: minimum total_sp per attribute (from ge thresholds on SP stats).
// Caps:   maximum total_sp per attribute (from le thresholds on SP stats).
const _SKP_STAT_TO_IDX = { str: 0, dex: 1, int: 2, def: 3, agi: 4 };
let _sp_floors = null;  // Int32Array(5) or null
let _sp_caps = null;    // Int32Array(5) or null
const _default_sp_caps = new Int32Array([150, 150, 150, 150, 150]);

// Debug toggles: SOLVER_DEBUG_WORKER, SOLVER_DEBUG_COMBO
// (defined in js/solver/debug_toggles.js, loaded via importScripts)

// ── Search state ────────────────────────────────────────────────────────────

const PROGRESS_INTERVAL = 5000;
const PROGRESS_INTERVAL_LONG = 50000;
let _checked = 0;
let _feasible = 0;
let _met_req = 0;
let _top5 = [];
let _top5_version = 0;
let _last_sent_top5_version = 0;
let _checked_at_last_top5_change = 0;
let _current_L = 0;

function _insert_top5(candidate) {
    _top5.push(candidate);
    _top5.sort((a, b) => b.score - a.score);
    if (_top5.length > 15) _top5.length = 15;
    _top5_version++;
    _checked_at_last_top5_change = _checked;
}

// ── Pre-allocated scratch Maps (reused across leaves to eliminate GC churn) ──

let _cached_hp_sim = null;  // cached simulate_combo_mana_hp result (avoids double-sim)

const _scratch_finalize = new Map();
const _scratch_pre_scale = new Map();
const _scratch_pre_scale_nested = { damMult: new Map(), defMult: new Map(), healMult: new Map() };
const _scratch_combo_base = new Map();
const _scratch_combo_base_nested = { damMult: new Map(), defMult: new Map(), healMult: new Map() };
const _scratch_thresh = new Map();
const _scratch_thresh_nested = { damMult: new Map(), defMult: new Map(), healMult: new Map() };
const _scratch_row = { stats: new Map(), damMult: new Map(), defMult: new Map(), prop_overrides: new Map() };
const _scratch_atree = { atree_edit: new Map(), ret_effects: new Map() };
const _scratch_finalize_inner = { damMult: new Map(), defMult: new Map(), healMult: new Map(), majorIds: new Set() };
const _scratch_sp_set_counts = new Map();
const _scratch_orig_base_sp = new Int32Array(5);  // pre-greedy base_sp snapshot for mana rescue

// ── Pre-allocated scratch arrays for leaf evaluation (eliminate per-leaf allocs) ──
const _scratch_equip_8 = new Array(8);
const _scratch_sp_input = new Array(9);    // 8 equips + guild_tome
let _scratch_all_equip = null;             // sized at init: 8 + tome_sms.length + 1 (weapon)
const _scratch_sp = {
    assign:          [0, 0, 0, 0, 0],
    final:           [0, 0, 0, 0, 0],
    free_bonus:      [0, 0, 0, 0, 0],
    max_passive_req: [0, 0, 0, 0, 0],
    post_floor:      [0, 0, 0, 0, 0],
    running_bonus:   [0, 0, 0, 0, 0],
    best_assign:     [0, 0, 0, 0, 0],
    save_stack:      new Array(45),      // 9 depths * 5 attrs
    ord_items:       new Array(9),
    ord_reqs:        new Array(9),
    ord_skp:         new Array(9),
    no_bonus:        [],  // sized at init (max 9: weapon + up to 8 crafted items)
    _no_bonus_len:   0,
};

/**
 * Build constraint prechecks from the restriction thresholds.
 * Called once during worker init.
 */
function _build_constraint_prechecks() {
    _constraint_prechecks = [];
    _ehp_precheck = null;
    _ehp_no_agi_precheck = null;
    _total_hp_precheck = null;

    const thresholds = _cfg.restrictions?.stat_thresholds ?? [];
    if (thresholds.length === 0) return;

    // Compute fixed stat contributions (constant across all candidates).
    // atree_raw and static_boosts are both Maps.
    const fixed = (stat) => {
        return (_cfg.atree_raw?.get(stat) ?? 0) + (_cfg.static_boosts?.get(stat) ?? 0);
    };

    for (const { stat, op, value } of thresholds) {
        if (op !== 'ge') continue;  // only ge constraints benefit from early rejection

        if (stat === 'ehp' || stat === 'ehp_no_agi') {
            // Precompute fixed EHP constants
            const fixed_hp = fixed('hpBonus');

            const def_pct = skillPointsToPercentage(100) * skillpoint_final_mult[3];
            const weaponType = _cfg.weapon_sm?.get('type');
            const classDef = classDefenseMultipliers.get(weaponType) || 1.0;
            const defMult = (2 - classDef);

            if (stat === 'ehp') {
                const agi_pct = skillPointsToPercentage(100) * skillpoint_final_mult[4];
                const agi_reduction = (100 - 90) / 100;
                const ehp_divisor = (agi_reduction * agi_pct + (1 - agi_pct) * (1 - def_pct)) * defMult;
                _ehp_precheck = { threshold: value, fixed_hp, ehp_divisor };
            } else {
                // ehp_no_agi: no agility dodge factor, just def_pct
                const ehp_divisor = (1 - def_pct) * defMult;
                _ehp_no_agi_precheck = { threshold: value, fixed_hp, ehp_divisor };
            }
            continue;
        }

        if (stat === 'total_hp') {
            _total_hp_precheck = { threshold: value, fixed_hp: fixed('hpBonus') };
            continue;
        }

        if (_PRECHECK_EXCLUDED.has(stat)) continue;

        const fixed_contrib = fixed(stat);
        _constraint_prechecks.push({
            stat,
            adjusted_threshold: value - fixed_contrib,
        });
    }
}

/**
 * Build SP floor/cap constraints from restriction thresholds.
 * Floors come from ge thresholds on SP stats, caps from le thresholds.
 * Called once during worker init.
 */
function _build_sp_constraints() {
    _sp_floors = null;
    _sp_caps = null;

    const thresholds = _cfg.restrictions?.stat_thresholds ?? [];
    if (thresholds.length === 0) return;

    for (const { stat, op, value } of thresholds) {
        const idx = _SKP_STAT_TO_IDX[stat];
        if (idx === undefined) continue;

        if (op === 'ge') {
            if (!_sp_floors) { _sp_floors = new Int32Array(5); }
            _sp_floors[idx] = Math.max(_sp_floors[idx], value);
        } else if (op === 'le') {
            if (!_sp_caps) { _sp_caps = new Int32Array([150, 150, 150, 150, 150]); }
            _sp_caps[idx] = Math.min(_sp_caps[idx], value);
        }
    }
}

/**
 * Fast constraint precheck against the running statMap.
 * Returns false if any ge-threshold cannot be met (conservative lower bound).
 */
function _fast_constraint_precheck(running_sm) {
    for (let i = 0; i < _constraint_prechecks.length; i++) {
        const pc = _constraint_prechecks[i];
        if ((running_sm.get(pc.stat) ?? 0) < pc.adjusted_threshold) return false;
    }
    return true;
}

/**
 * Optimistic EHP precheck using precomputed constants.
 * Computes an upper bound on EHP assuming max def/agi skill points (100 each)
 * and no extra defMult penalties. If even this can't meet the threshold, reject.
 * Also checks ehp_no_agi and total_hp prechecks.
 */
function _fast_ehp_precheck(running_sm) {
    if (!_ehp_precheck && !_ehp_no_agi_precheck && !_total_hp_precheck) return true;

    // running_sm.get('hp') = levelToHPBase + sum of item 'hp' (static ID)
    // running_sm.get('hpBonus') = sum of item hpBonus (from maxRolls)
    const raw_hp = (running_sm.get('hp') ?? 0) + (running_sm.get('hpBonus') ?? 0);

    if (_ehp_precheck) {
        let totalHp = raw_hp + _ehp_precheck.fixed_hp;
        if (totalHp < 5) totalHp = 5;
        if ((totalHp / _ehp_precheck.ehp_divisor) < _ehp_precheck.threshold) return false;
    }

    if (_ehp_no_agi_precheck) {
        let totalHp = raw_hp + _ehp_no_agi_precheck.fixed_hp;
        if (totalHp < 5) totalHp = 5;
        if ((totalHp / _ehp_no_agi_precheck.ehp_divisor) < _ehp_no_agi_precheck.threshold) return false;
    }

    if (_total_hp_precheck) {
        let totalHp = raw_hp + _total_hp_precheck.fixed_hp;
        if (totalHp < 5) totalHp = 5;
        if (totalHp < _total_hp_precheck.threshold) return false;
    }

    return true;
}

// ── Per-candidate stat assembly ─────────────────────────────────────────────

function _assemble_combo_stats(build_sm, total_sp, weapon_sm) {
    return assemble_combo_stats(build_sm, total_sp, weapon_sm,
        _cfg.atree_raw, _cfg.radiance_boost, _cfg.atree_merged,
        _cfg.button_states, _cfg.slider_states, _cfg.static_boosts,
        { pre_scale: _scratch_pre_scale, pre_scale_nested: _scratch_pre_scale_nested,
          combo_base: _scratch_combo_base, combo_base_nested: _scratch_combo_base_nested,
          atree: _scratch_atree });
}

function _assemble_threshold_stats(combo_base) {
    // static_boosts are already merged into combo_base by _assemble_combo_stats.
    return _deep_clone_statmap_into(_scratch_thresh, combo_base, _scratch_thresh_nested);
}

function _check_thresholds(stats, thresholds) {
    return check_thresholds(stats, thresholds, _cfg.spell_base_costs);
}

function _eval_combo_damage(combo_base, debug) {
    const result = eval_combo_damage_with_bp(combo_base, _cfg.weapon_sm, _cfg.parsed_combo, {
        hp_casting: _cfg.hp_casting,
        has_dynamic_sliders: _cfg.has_dynamic_sliders,
        health_config: _cfg.health_config,
        boost_registry: _cfg.boost_registry,
        atree_merged: _cfg.atree_merged,
        bp_slider_name: _cfg.bp_slider_name,
        state_slider_names: _cfg.state_slider_names,
    }, {
        scratch_row: _scratch_row,
        debug,
        debug_label: '[WORKER]',
        cached_hp_sim: _cached_hp_sim,
    });
    _cached_hp_sim = null;  // consume cache
    return result.total_damage;
}

/** Mana/HP feasibility gate — delegates to shared eval_combo_mana_check(). */
function _eval_combo_mana_check(combo_base) {
    _cached_hp_sim = null;
    const result = eval_combo_mana_check({
        parsed_combo: _cfg.parsed_combo,
        combo_base,
        hp_casting: _cfg.hp_casting,
        combo_time: _cfg.combo_time ?? 0,
        allow_downtime: _cfg.allow_downtime,
        health_config: _cfg.health_config ?? DEFAULT_HEALTH_CONFIG,
        boost_registry: _cfg.boost_registry,
        scratch_row: _scratch_row,
        use_fast_sim: true,
    });
    _cached_hp_sim = result.sim;
    return result.passed;
}

function _eval_combo_healing(combo_base) {
    return eval_combo_healing(_cfg.parsed_combo, combo_base, _cfg.boost_registry, _scratch_row);
}

/**
 * Dispatch to the correct scoring function based on _cfg.scoring_target.
 * @param {Map} combo_base  - stats after radiance+atree scaling+static_boosts
 * @param {Map} thresh_stats - deep clone of combo_base (may be null; computed lazily)
 */
function _eval_score(combo_base, thresh_stats) {
    return eval_score_dispatch(_cfg.scoring_target, combo_base,
        () => _eval_combo_damage(combo_base),
        () => _eval_combo_healing(combo_base),
        thresh_stats ?? _assemble_threshold_stats(combo_base));
}

// get_item_display_name() — shared from pure/engine.js
const _get_item_name = get_item_display_name;

// ── Illegal-set tracking ────────────────────────────────────────────────────

function _make_illegal_tracker() {
    const occupants = new Map();
    return {
        add(setName, itemName) {
            if (!occupants.has(setName)) occupants.set(setName, new Map());
            const m = occupants.get(setName);
            m.set(itemName, (m.get(itemName) ?? 0) + 1);
        },
        remove(setName, itemName) {
            const m = occupants.get(setName);
            if (!m) return;
            const c = m.get(itemName) ?? 1;
            if (c <= 1) m.delete(itemName); else m.set(itemName, c - 1);
        },
        blocks(is, iname) {
            if (!is) return false;
            const m = occupants.get(is);
            // Block any item from an illegal-at-2 set once one is already placed,
            // including a duplicate of the same item (e.g. two Hive rings).
            return !!(m && m.size > 0);
        }
    };
}

// ── Level-based enumeration ──────────────────────────────────────────────────
//
// Enumerates all item combinations ordered by sum-of-rank-offsets (level L).
// Level L=0 visits (rank0, rank0, ..., rank0) — the globally best build first.
// Level L=1 visits all builds with exactly one slot at rank 1 (others rank 0).
// Memory is O(k). No heap or visited set needed.
//
// Items in pools/locked are wrapper objects: { statMap: Map, _illegalSet, _illegalSetName }
// none_item_sms are raw statMaps (no illegal set info needed for NONE items).
// We wrap NONE items too for uniform handling in partial[].

function _run_level_enum() {
    const { locked, weapon_sm, level, tome_sms, guild_tome_sm,
        sp_budget, restrictions, partition, none_item_sms,
        ring_pool, ring1_locked, ring2_locked } = _cfg;

    // Shallow-copy pools so partition slicing doesn't mutate _cfg.pools.
    // Without this, subsequent work-stealing partitions on the same worker
    // would see already-sliced (effectively empty) pools.
    const pools = { ..._cfg.pools };
    const _dbg = SOLVER_DEBUG_WORKER && _cfg.worker_id === 0;
    let _dbg_sp_prune_count = 0;
    let _dbg_sp_leaf_reject = 0;
    let _dbg_precheck_reject = 0;
    let _dbg_ehp_reject = 0;
    let _dbg_sp_reject = 0;
    let _dbg_threshold_reject = 0;
    let _dbg_mana_reject = 0;
    let _dbg_mana_rescued = 0;
    let _dbg_hp_reject = 0;
    let _dbg_scored = 0;
    let _dbg_leaf_time = 0;  // cumulative ms for feasible leaf processing

    const tracker = _make_illegal_tracker();

    // Wrap NONE statMaps into the same {statMap, _illegalSet, _illegalSetName} format
    const none_items_wrapped = none_item_sms.map(sm => ({ statMap: sm, _illegalSet: null, _illegalSetName: null }));

    // Determine all free slots (armor/accessory + rings), sorted by pool size ascending.
    // Rings are included in the unified level enumeration for combined-priority ordering.
    const free_slots = [];
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (!locked[slot]) free_slots.push(slot);
    }
    if (!ring1_locked) free_slots.push('ring1');
    if (!ring2_locked) free_slots.push('ring2');

    // Pool lookup: ring1/ring2 share ring_pool; armor slots use pools[slot].
    const _get_pool = (slot) =>
        (slot === 'ring1' || slot === 'ring2') ? ring_pool : pools[slot];

    free_slots.sort((a, b) => {
        const diff = (_get_pool(a)?.length ?? 0) - (_get_pool(b)?.length ?? 0);
        if (diff !== 0) return diff;
        // Ensure ring1 before ring2 (same pool size) for symmetry constraint.
        if (a === 'ring1' && b === 'ring2') return -1;
        if (a === 'ring2' && b === 'ring1') return 1;
        return 0;
    });

    // Depth indices for ring slots (-1 if locked). Used for symmetry & partition logic.
    const ring1_depth = free_slots.indexOf('ring1');
    const ring2_depth = free_slots.indexOf('ring2');

    // partial: holds item wrapper objects for each of the 8 equipment positions
    const partial = {
        helmet: locked.helmet ?? none_items_wrapped[0],
        chestplate: locked.chestplate ?? none_items_wrapped[1],
        leggings: locked.leggings ?? none_items_wrapped[2],
        boots: locked.boots ?? none_items_wrapped[3],
        ring1: ring1_locked ?? none_items_wrapped[4],
        ring2: ring2_locked ?? none_items_wrapped[5],
        bracelet: locked.bracelet ?? none_items_wrapped[6],
        necklace: locked.necklace ?? none_items_wrapped[7],
    };

    // Track illegal sets for locked items
    for (const item of Object.values(partial)) {
        if (!item || !item.statMap || item.statMap.has('NONE')) continue;
        const name = _get_item_name(item.statMap);
        const is = item._illegalSet;
        if (is && name) tracker.add(is, name);
    }

    // If this worker has a partition, apply it: restrict one slot's pool to [start, end)
    if (partition && partition.type === 'slot' && pools[partition.slot]) {
        pools[partition.slot] = pools[partition.slot].slice(partition.start, partition.end);
    }

    const N_free = free_slots.length;

    // ── Mid-tree SP pruning precomputation ─────────────────────────────────
    //
    // For each free slot's pool, the element-wise max provision across
    // all items.  Used to compute an optimistic upper bound on bonus SP from
    // remaining (unplaced) slots.

    const _sp_max_pool_prov = [];  // _sp_max_pool_prov[depth_idx] = [5]
    for (let d = 0; d < N_free; d++) {
        const pool = _get_pool(free_slots[d]);
        const maxp = [0, 0, 0, 0, 0];
        if (pool) {
            for (const item of pool) {
                const skp = item.statMap.get('skillpoints');
                for (let i = 0; i < 5; i++) {
                    if (skp[i] > maxp[i]) maxp[i] = skp[i];
                }
            }
        }
        _sp_max_pool_prov.push(maxp);
    }

    // Suffix sums: _sp_suffix_max_prov[d][i] = sum of _sp_max_pool_prov[k][i]
    // for k = d, d+1, ..., N_free-1.
    // Index N_free = [0,0,0,0,0] (no remaining slots).
    const _sp_suffix_max_prov = new Array(N_free + 1);
    _sp_suffix_max_prov[N_free] = [0, 0, 0, 0, 0];
    for (let d = N_free - 1; d >= 0; d--) {
        _sp_suffix_max_prov[d] = [0, 0, 0, 0, 0];
        for (let i = 0; i < 5; i++) {
            _sp_suffix_max_prov[d][i] = _sp_suffix_max_prov[d + 1][i]
                + _sp_max_pool_prov[d][i];
        }
    }

    // ── Incremental stat accumulation ───────────────────────────────────────
    // Build base statMap from locked items + tomes + weapon. Free items are added/removed during search.

    const fixed_item_sms = [];
    // Locked equipment
    for (const item of Object.values(partial)) {
        if (item && item.statMap && !item.statMap.has('NONE')) fixed_item_sms.push(item.statMap);
    }
    // Tomes and weapon
    for (const t of tome_sms) fixed_item_sms.push(t);
    fixed_item_sms.push(weapon_sm);

    const running_sm = _init_running_statmap(level, fixed_item_sms);

    // Size scratch arrays now that tome_sms is known
    _scratch_all_equip = new Array(8 + tome_sms.length + 1);  // 8 equips + tomes + weapon
    _scratch_sp.no_bonus = new Array(9);  // weapon + up to 8 crafted items (max possible)

    // ── Progress reporting ──────────────────────────────────────────────────

    function _maybe_progress() {
        const interval = _checked < 1_000_000 ? PROGRESS_INTERVAL : PROGRESS_INTERVAL_LONG;
        if (_checked % interval === 0) {
            const msg = {
                type: 'progress',
                worker_id: _cfg.worker_id,
                checked: _checked,
                feasible: _feasible,
                met_req: _met_req,
                checked_since_top5: _checked - _checked_at_last_top5_change,
                L_progress: [_current_L, L_max],
            };
            // Only include top5 data when it has actually changed
            if (_top5_version !== _last_sent_top5_version) {
                msg.top5_names = _top5.map(r => ({
                    score: r.score, item_names: r.item_names,
                    base_sp: r.base_sp, total_sp: r.total_sp, assigned_sp: r.assigned_sp,
                }));
                _last_sent_top5_version = _top5_version;
            }
            postMessage(msg);
        }
    }

    // ── Greedy extra-SP allocator ───────────────────────────────────────────
    //
    // After the minimum SP is assigned to meet item requirements, any
    // remaining budget is greedily distributed to maximise the scoring target.
    // Uses geometric step-down (20 → 4 → 1) for O(50-95) trials worst case.

    function _greedy_allocate_sp(build_sm, base_sp, total_sp, assigned_sp, weapon_sm) {
        const remaining = sp_budget - assigned_sp;

        const target = _cfg.scoring_target ?? 'combo_damage';
        const need_thresh = (target !== 'combo_damage' && target !== 'total_healing');

        function _trial_score() {
            const cb = _assemble_combo_stats(build_sm, total_sp, weapon_sm);
            const ts = need_thresh ? _assemble_threshold_stats(cb) : null;
            return _eval_score(cb, ts);
        }

        const cap_total = _sp_caps ?? _default_sp_caps;
        // Snapshot base_sp for mana rescue. on_post_floor re-snapshots after
        // floor enforcement so rescue sees post-floor (not post-greedy) state.
        _scratch_orig_base_sp.set(base_sp);
        assigned_sp += greedy_sp_allocate(base_sp, total_sp, remaining, cap_total,
            _sp_floors, _trial_score, () => _scratch_orig_base_sp.set(base_sp));

        return assigned_sp;
    }

    // ── Mana rescue: shift SP into Int when mana check fails ───────────────
    //
    // After greedy allocation optimises for score, the mana check may fail.
    // This function attempts to steal freely-assigned SP from other attributes
    // and shift it into Int (which reduces spell costs and increases mana pool).
    // Only applies to non-Blood-Pact builds with a combo_time constraint.
    //
    // Returns true if rescue succeeded (base_sp/total_sp mutated, combo_base
    // reassembled). Returns false if rescue impossible or insufficient.

    const _scratch_rescue_base = new Int32Array(5);
    const _scratch_rescue_total = new Int32Array(5);

    function _mana_rescue(build_sm, base_sp, total_sp, orig_base_sp, weapon_sm) {
        if (_cfg.hp_casting && _cfg.health_config?.health_cost > 0) return false;
        if (!(_cfg.combo_time ?? 0)) return false;

        const INT_IDX = 2;
        const int_base_room = 100 - base_sp[INT_IDX];
        const int_total_room = ((_sp_caps ? _sp_caps[INT_IDX] : 150) - total_sp[INT_IDX]);
        const int_room = Math.min(int_base_room, int_total_room);
        if (int_room <= 0) return false;

        // Compute how much SP the greedy allocator freely assigned per attribute
        // (i.e. beyond the SP solver minimum). These are stealable.
        let total_stealable = 0;
        const stealable = [0, 0, 0, 0, 0];
        for (let i = 0; i < 5; i++) {
            if (i === INT_IDX) continue;
            stealable[i] = base_sp[i] - orig_base_sp[i];
            total_stealable += stealable[i];
        }
        if (total_stealable <= 0) return false;

        const max_shift = Math.min(total_stealable, int_room);
        if (max_shift <= 0) return false;

        // Save current allocation in case rescue fails
        _scratch_rescue_base.set(base_sp);
        _scratch_rescue_total.set(total_sp);

        // Try shifting SP into Int in increasing amounts: 25%, 50%, 75%, 100% of max
        for (const frac of [0.25, 0.5, 0.75, 1.0]) {
            let shift_target = Math.ceil(max_shift * frac);
            if (shift_target <= 0) continue;

            // Restore to pre-rescue state
            for (let i = 0; i < 5; i++) {
                base_sp[i] = _scratch_rescue_base[i];
                total_sp[i] = _scratch_rescue_total[i];
            }

            // Steal from attributes with most free SP first
            let shifted = 0;
            // Build sorted steal order (descending by stealable)
            const order = [0, 1, 3, 4]; // exclude INT_IDX=2
            order.sort((a, b) => stealable[b] - stealable[a]);

            for (const i of order) {
                if (shifted >= shift_target) break;
                const take = Math.min(stealable[i], shift_target - shifted);
                if (take <= 0) continue;
                base_sp[i] -= take;
                total_sp[i] -= take;
                shifted += take;
            }

            // Add stolen SP to Int
            base_sp[INT_IDX] += shifted;
            total_sp[INT_IDX] += shifted;

            // Reassemble combo stats and check mana
            _assemble_combo_stats(build_sm, total_sp, weapon_sm);
            if (_eval_combo_mana_check(_scratch_combo_base)) {
                return true;  // Rescue succeeded; combo_base (scratch) is valid
            }
        }

        // All attempts failed — restore original allocation
        for (let i = 0; i < 5; i++) {
            base_sp[i] = _scratch_rescue_base[i];
            total_sp[i] = _scratch_rescue_total[i];
        }
        return false;
    }

    // ── Leaf evaluation ─────────────────────────────────────────────────────

    function _evaluate_leaf() {
        _checked++;

        // Fast constraint precheck: reject builds that can't meet simple
        // additive stat thresholds, before expensive SP solver + stat assembly.
        // running_sm has all item stats accumulated; prechecks account for
        // fixed contributions (atree_raw + static_boosts).
        if (_constraint_prechecks.length > 0 && !_fast_constraint_precheck(running_sm)) {
            _dbg_precheck_reject++;
            _maybe_progress();
            return;
        }
        if (!_fast_ehp_precheck(running_sm)) {
            _dbg_ehp_reject++;
            _maybe_progress();
            return;
        }

        // Fill scratch arrays (pointer writes only, no allocation)
        _scratch_equip_8[0] = partial.helmet.statMap;
        _scratch_equip_8[1] = partial.chestplate.statMap;
        _scratch_equip_8[2] = partial.leggings.statMap;
        _scratch_equip_8[3] = partial.boots.statMap;
        _scratch_equip_8[4] = partial.ring1.statMap;
        _scratch_equip_8[5] = partial.ring2.statMap;
        _scratch_equip_8[6] = partial.bracelet.statMap;
        _scratch_equip_8[7] = partial.necklace.statMap;

        // SP input: 8 equips + guild_tome (reuse scratch)
        for (let i = 0; i < 8; i++) _scratch_sp_input[i] = _scratch_equip_8[i];
        _scratch_sp_input[8] = guild_tome_sm;

        // Combined SP feasibility check + full calculation (single pass).
        const sp_result = calculate_skillpoints(_scratch_sp_input, weapon_sm, sp_budget, _scratch_sp_set_counts, _scratch_sp);
        if (!sp_result) {
            _dbg_sp_reject++;
            _maybe_progress();
            return;
        }
        const base_sp = sp_result[0];
        const total_sp = sp_result[1];
        const assigned_sp = sp_result[2];
        const activeSetCounts = sp_result[3];
        _feasible++;

        // Build stat assembly from running statMap (incremental accumulation)
        const t0 = _dbg ? performance.now() : 0;
        // Fill _scratch_all_equip: 8 equips + tomes + weapon (no allocation)
        for (let i = 0; i < 8; i++) _scratch_all_equip[i] = _scratch_equip_8[i];
        for (let i = 0; i < tome_sms.length; i++) _scratch_all_equip[8 + i] = tome_sms[i];
        _scratch_all_equip[8 + tome_sms.length] = weapon_sm;
        const build_sm = _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets, _scratch_all_equip, _scratch_finalize, _scratch_finalize_inner);

        // Greedily assign any remaining SP budget to maximise the scoring target
        let final_assigned = _greedy_allocate_sp(build_sm, base_sp, total_sp, assigned_sp, weapon_sm);

        // Stat assembly + atree scaling
        const combo_base = _assemble_combo_stats(build_sm, total_sp, weapon_sm);

        // Compute thresh_stats once: used for threshold gate and non-damage scoring
        const need_thresh = restrictions.stat_thresholds.length > 0
            || (_cfg.scoring_target ?? 'combo_damage') !== 'combo_damage';
        let thresh_stats = need_thresh ? _assemble_threshold_stats(combo_base) : null;

        // Threshold check
        if (restrictions.stat_thresholds.length > 0) {
            if (!_check_thresholds(thresh_stats, restrictions.stat_thresholds)) {
                _dbg_threshold_reject++;
                if (_dbg) _dbg_leaf_time += performance.now() - t0;
                _maybe_progress();
                return;
            }
        }

        // Mana / HP constraint check (with rescue attempt on failure)
        let mana_hp_result = _eval_combo_mana_check(combo_base);
        if (!mana_hp_result) {
            if (!_cfg.hp_casting && _mana_rescue(build_sm, base_sp, total_sp, _scratch_orig_base_sp, weapon_sm)) {
                // Rescue succeeded — combo_base was reassembled by _mana_rescue.
                // Re-check thresholds since SP distribution changed.
                if (restrictions.stat_thresholds.length > 0) {
                    const ts2 = _assemble_threshold_stats(combo_base);
                    if (!_check_thresholds(ts2, restrictions.stat_thresholds)) {
                        _dbg_threshold_reject++;
                        if (_dbg) _dbg_leaf_time += performance.now() - t0;
                        _maybe_progress();
                        return;
                    }
                    thresh_stats = ts2;
                } else if (need_thresh) {
                    thresh_stats = _assemble_threshold_stats(combo_base);
                }
                // final_assigned unchanged: rescue is a zero-sum redistribution
                _dbg_mana_rescued++;
                mana_hp_result = true;
            }
            if (!mana_hp_result) {
                if (_cfg.hp_casting) _dbg_hp_reject++; else _dbg_mana_reject++;
                if (_dbg) _dbg_leaf_time += performance.now() - t0;
                _maybe_progress();
                return;
            }
        }

        // Score
        const score = _eval_score(combo_base, thresh_stats);
        _dbg_scored++;
        _met_req++;
        if (_dbg) _dbg_leaf_time += performance.now() - t0;
        const item_names = _scratch_equip_8.map(sm => _get_item_name(sm));
        // Clone SP arrays before storing — they may alias scratch buffers
        const entry = { score, item_names, base_sp: base_sp.slice(), total_sp: total_sp.slice(), assigned_sp: final_assigned };
        // In debug mode, store a deep clone of combo_base so we can re-evaluate with logging
        if (SOLVER_DEBUG_COMBO) entry._debug_combo_base = _deep_clone_statmap(combo_base);
        _insert_top5(entry);
        _maybe_progress();
    }

    // ── Stat tracking helpers ────────────────────────────────────────────────

    function _place_item(item_sm) { _incr_add_item(running_sm, item_sm); }
    function _unplace_item(item_sm) { _incr_remove_item(running_sm, item_sm); }

    // ── Level-based enumeration over free armor/accessory slots ─────────────
    //
    // enumerate(slot_idx, remaining_L) tries all offsets 0..min(remaining_L, pool.size-1)
    // for the current slot, recurses with (remaining_L - offset) for the next slot.
    // The outer loop iterates L = 0, 1, ..., L_max so combinations are visited in
    // increasing order of sum-of-rank-offsets: best build first, then one step away, etc.

    // Compute the maximum achievable level (sum of pool sizes - 1 per slot)
    let L_max = 0;
    const _pool_maxes = [];
    for (const slot of free_slots) {
        const p = _get_pool(slot);
        const pm = p ? p.length - 1 : 0;
        L_max += pm;
        _pool_maxes.push(pm);
    }

    // ── Subtree leaf count table (for SP-prune build tallying) ──────────────
    //
    // _subtree_leaf_count[d][L] = number of leaf builds in the subtree from
    // depth d..N_free-1 with remaining level budget L.  Ignores ring symmetry
    // and illegal-set blocking (slight overcount, acceptable for progress).
    // Used to credit pruned subtrees to _checked so progress is accurate.

    const _subtree_leaf_count = new Array(N_free);
    if (N_free > 0) {
        for (let d = 0; d < N_free; d++) {
            _subtree_leaf_count[d] = new Float64Array(L_max + 1);
        }
        // Last slot: offset is forced to exactly remaining_L
        const last_pm = _pool_maxes[N_free - 1];
        for (let L = 0; L <= Math.min(L_max, last_pm); L++) {
            _subtree_leaf_count[N_free - 1][L] = 1;
        }
        // Fill from N_free-2 down to 0 using prefix sums
        for (let d = N_free - 2; d >= 0; d--) {
            const pm = _pool_maxes[d];
            const next = _subtree_leaf_count[d + 1];
            // prefix[k] = sum of next[0..k-1]
            const prefix = new Float64Array(L_max + 2);
            for (let L = 0; L <= L_max; L++) {
                prefix[L + 1] = prefix[L] + next[L];
            }
            for (let L = 0; L <= L_max; L++) {
                const lo = Math.max(0, L - pm);
                _subtree_leaf_count[d][L] = prefix[L + 1] - prefix[lo];
            }
        }
    }

    // ── Mid-tree SP pruning state & helpers ──────────────────────────────────
    //
    // Track running SP requirements and provisions as free armor items are
    // placed/unplaced during enumerate().  An optimistic feasibility check
    // prunes subtrees where SP assignment provably exceeds the budget.

    // Fixed-item SP baseline (recomputed once per ring combination).
    const _sp_fixed_max_eff_req = [0, 0, 0, 0, 0];
    const _sp_fixed_sum_prov = [0, 0, 0, 0, 0];

    // Per-depth effective requirement from each placed free item.
    const _sp_slot_eff_req = [];
    for (let d = 0; d < N_free; d++) _sp_slot_eff_req.push([0, 0, 0, 0, 0]);

    // Running max eff req (fixed + placed free) and running free provisions.
    const _sp_running_max_eff_req = [0, 0, 0, 0, 0];
    const _sp_running_free_prov = [0, 0, 0, 0, 0];

    /**
     * Compute SP baseline from all fixed items (locked equips, guild tome,
     * weapon).  Called once before the unified level enumeration.
     */
    function _sp_compute_fixed_baseline() {
        _sp_fixed_max_eff_req.fill(0);
        _sp_fixed_sum_prov.fill(0);

        const free_set = new Set(free_slots);
        for (const [slot, item] of Object.entries(partial)) {
            if (free_set.has(slot)) continue;
            if (!item || !item.statMap || item.statMap.has('NONE')) continue;
            const sm = item.statMap;
            const skp = sm.get('skillpoints');
            const req = sm.get('reqs');
            const is_crafted = sm.get('crafted');

            if (!is_crafted) {
                for (let i = 0; i < 5; i++) {
                    if (skp[i] > 0) _sp_fixed_sum_prov[i] += skp[i];
                }
            }

            // Raw requirements (cascade: no self-contribution undoing)
            for (let i = 0; i < 5; i++) {
                const eff = req[i];
                if (eff > _sp_fixed_max_eff_req[i])
                    _sp_fixed_max_eff_req[i] = eff;
            }
        }

        // Guild tome: adds provisions + effective reqs
        if (guild_tome_sm && !guild_tome_sm.has('NONE')) {
            const skp = guild_tome_sm.get('skillpoints');
            const req = guild_tome_sm.get('reqs');
            for (let i = 0; i < 5; i++) {
                if (skp[i] > 0) _sp_fixed_sum_prov[i] += skp[i];
            }
            for (let i = 0; i < 5; i++) {
                const eff = req[i];
                if (eff > _sp_fixed_max_eff_req[i])
                    _sp_fixed_max_eff_req[i] = eff;
            }
        }

        // Weapon: raw requirements only, excluded from prov
        const wep_req = weapon_sm.get('reqs');
        for (let i = 0; i < 5; i++) {
            if (wep_req[i] > _sp_fixed_max_eff_req[i])
                _sp_fixed_max_eff_req[i] = wep_req[i];
        }
    }

    /**
     * Reset running SP state and compute fixed baseline.
     * Called once before the unified level enumeration.
     */
    function _sp_reset() {
        _sp_compute_fixed_baseline();
        _sp_running_free_prov.fill(0);
        for (let i = 0; i < 5; i++)
            _sp_running_max_eff_req[i] = _sp_fixed_max_eff_req[i];
    }

    /**
     * Update running SP state when placing a free item at a given depth.
     */
    function _sp_place_free_item(sm, depth) {
        const skp = sm.get('skillpoints');
        const req = sm.get('reqs');
        const is_crafted = sm.get('crafted');

        if (!is_crafted) {
            for (let i = 0; i < 5; i++) {
                if (skp[i] > 0) _sp_running_free_prov[i] += skp[i];
            }
        }

        // Raw requirements (cascade: no self-contribution undoing)
        const eff = _sp_slot_eff_req[depth];
        for (let i = 0; i < 5; i++) {
            eff[i] = req[i];
        }

        for (let i = 0; i < 5; i++) {
            if (eff[i] > _sp_running_max_eff_req[i])
                _sp_running_max_eff_req[i] = eff[i];
        }
    }

    /**
     * Restore running SP state when unplacing a free item at a given depth.
     */
    function _sp_unplace_free_item(sm, depth) {
        if (!sm.get('crafted')) {
            const skp = sm.get('skillpoints');
            for (let i = 0; i < 5; i++) {
                if (skp[i] > 0) _sp_running_free_prov[i] -= skp[i];
            }
        }

        // Recompute running max from fixed baseline + slots 0..depth-1
        for (let i = 0; i < 5; i++) _sp_running_max_eff_req[i] = _sp_fixed_max_eff_req[i];
        for (let d = 0; d < depth; d++) {
            for (let i = 0; i < 5; i++) {
                if (_sp_slot_eff_req[d][i] > _sp_running_max_eff_req[i])
                    _sp_running_max_eff_req[i] = _sp_slot_eff_req[d][i];
            }
        }
    }

    /**
     * Returns true if the subtree rooted at next_depth might contain a
     * feasible build (SP-wise).  Returns false to prune.
     */
    function _sp_mid_tree_feasible(next_depth) {
        if (next_depth >= N_free) return true;

        let total_deficit = 0;
        for (let i = 0; i < 5; i++) {
            if (_sp_running_max_eff_req[i] === 0) continue;
            const optimistic_prov = _sp_fixed_sum_prov[i]
                + _sp_running_free_prov[i]
                + _sp_suffix_max_prov[next_depth][i];
            if (_sp_running_max_eff_req[i] <= optimistic_prov) continue;
            const deficit = _sp_running_max_eff_req[i] - optimistic_prov;
            if (deficit > SP_PER_ATTR_CAP) return false;
            total_deficit += deficit;
            if (total_deficit > sp_budget) return false;
        }
        return true;
    }

    /**
     * Leaf-level SP feasibility check — all items are placed, no suffix term.
     * Identical logic to _sp_mid_tree_feasible but without the suffix
     * optimistic provision (no remaining slots) and no early return.
     * ~20 int ops, zero allocation — cheapest possible rejection at the leaf.
     */
    function _sp_leaf_feasible() {
        let total_deficit = 0;
        for (let i = 0; i < 5; i++) {
            if (_sp_running_max_eff_req[i] === 0) continue;
            const prov = _sp_fixed_sum_prov[i] + _sp_running_free_prov[i];
            if (_sp_running_max_eff_req[i] <= prov) continue;
            const deficit = _sp_running_max_eff_req[i] - prov;
            if (deficit > SP_PER_ATTR_CAP) return false;
            total_deficit += deficit;
            if (total_deficit > sp_budget) return false;
        }
        return true;
    }

    // Track ring1's placed offset for ring2 symmetry constraint (ring2 offset >= ring1 offset).
    let _ring1_placed_offset = 0;

    function enumerate(slot_idx, remaining_L) {
        if (_cancelled) return;

        if (slot_idx === N_free) {
            _evaluate_leaf();
            return;
        }

        const slot = free_slots[slot_idx];
        const pool = _get_pool(slot);
        if (!pool) { enumerate(slot_idx + 1, remaining_L); return; }

        const is_ring1 = (slot_idx === ring1_depth);
        const is_ring2 = (slot_idx === ring2_depth);

        // Compute offset bounds for this slot.
        let min_offset = 0;
        let pool_max = pool.length - 1;

        // Ring2 symmetry: offset >= ring1's offset (deduplicates symmetric pairs).
        if (is_ring2 && ring1_depth >= 0) {
            min_offset = _ring1_placed_offset;
        }
        // Ring partition: restrict ring1 (or single free ring) offset range.
        if (is_ring1 && partition?.type === 'ring') {
            min_offset = Math.max(min_offset, partition.start);
            pool_max = Math.min(pool_max, partition.end - 1);
        }
        if ((is_ring1 || is_ring2) && partition?.type === 'ring_single') {
            min_offset = Math.max(min_offset, partition.start);
            pool_max = Math.min(pool_max, partition.end - 1);
        }

        // For the last free slot, we must place an item at exactly offset=remaining_L.
        // This ensures each combination is visited at exactly one level (level == sum of offsets),
        // preventing duplicates where lower-sum combinations were re-evaluated at every higher L.
        if (slot_idx === N_free - 1) {
            if (remaining_L >= min_offset && remaining_L <= pool_max) {
                const item = pool[remaining_L];
                const is = item._illegalSet;
                const iname = item._illegalSetName;
                if (!tracker.blocks(is, iname)) {
                    if (is) tracker.add(is, iname);
                    partial[slot] = item;
                    _place_item(item.statMap);
                    _sp_place_free_item(item.statMap, slot_idx);
                    if (_sp_leaf_feasible()) {
                        _evaluate_leaf();
                    } else {
                        _checked++;
                        _dbg_sp_leaf_reject++;
                        _maybe_progress();
                    }
                    _sp_unplace_free_item(item.statMap, slot_idx);
                    _unplace_item(item.statMap);
                    if (is) tracker.remove(is, iname);
                }
            }
            partial[slot] = locked[slot] ?? none_items_wrapped[_cfg.none_idx_map[slot]];
            return;
        }

        const max_offset = Math.min(remaining_L, pool_max);

        for (let offset = min_offset; offset <= max_offset; offset++) {
            if (_cancelled) return;
            const item = pool[offset];
            const is = item._illegalSet;
            const iname = item._illegalSetName;
            if (tracker.blocks(is, iname)) continue;
            if (is) tracker.add(is, iname);

            partial[slot] = item;
            _place_item(item.statMap);
            _sp_place_free_item(item.statMap, slot_idx);

            if (is_ring1) _ring1_placed_offset = offset;

            if (_sp_mid_tree_feasible(slot_idx + 1)) {
                enumerate(slot_idx + 1, remaining_L - offset);
            } else {
                const pruned = _subtree_leaf_count[slot_idx + 1][remaining_L - offset];
                _checked += pruned;
                _dbg_sp_prune_count += pruned;
                _maybe_progress();
            }

            _sp_unplace_free_item(item.statMap, slot_idx);
            _unplace_item(item.statMap);
            if (is) tracker.remove(is, iname);
        }
        partial[slot] = locked[slot] ?? none_items_wrapped[_cfg.none_idx_map[slot]];
    }

    // ── Unified level enumeration over all free slots (armor + rings) ────────

    _sp_reset();
    if (N_free === 0) {
        _evaluate_leaf();
    } else {
        for (let L = 0; L <= L_max && !_cancelled; L++) {
            _current_L = L;
            enumerate(0, L);
        }
    }

    if (_dbg) {
        const pool_sizes = Object.fromEntries(
            Object.entries(pools).map(([k, v]) => [k, v.length]));
        console.log('[w0] enum setup | free:', free_slots,
            '| pools:', pool_sizes,
            '| L_max:', L_max,
            '| ring_pool:', ring_pool?.length,
            '| partition:', JSON.stringify(partition));
        console.log('[w0] leaf breakdown | checked:', _checked,
            '| precheck_reject:', _dbg_precheck_reject,
            '| ehp_reject:', _dbg_ehp_reject,
            '| sp_leaf_reject:', _dbg_sp_leaf_reject,
            '| sp_reject:', _dbg_sp_reject,
            '| sp_pruned:', _dbg_sp_prune_count,
            '| feasible:', _feasible,
            '| threshold_reject:', _dbg_threshold_reject,
            '| mana_reject:', _dbg_mana_reject,
            '| mana_rescued:', _dbg_mana_rescued,
            '| hp_reject:', _dbg_hp_reject,
            '| scored:', _dbg_scored);
        if (_feasible > 0) {
            console.log('[w0] perf | avg feasible leaf:',
                (_dbg_leaf_time / _feasible).toFixed(2), 'ms',
                '| total feasible time:', _dbg_leaf_time.toFixed(0), 'ms');
        }
        if (_top5.length > 0) {
            console.log('[w0] best score:', _top5[0].score.toFixed(1),
                '| items:', _top5[0].item_names.filter(n => n).join(', '));
        }
    }

}

// ── Message handler ─────────────────────────────────────────────────────────

self.onmessage = function (e) {
    const msg = e.data;
    if (msg.type === 'init') {
        // Heavy one-time initialization: store all shared data
        sets = new Map(msg.sets_data);
        _cfg = msg;
        _cancelled = false;
        // Precompute generic slider names for boost token injection
        const _sn = extract_slider_names(_cfg.health_config);
        _cfg.bp_slider_name = _sn.bp_slider_name;
        _cfg.state_slider_names = _sn.state_slider_names;
        try {
            _build_constraint_prechecks();
            _build_sp_constraints();
        } catch (err) {
            console.error('[w] prechecks crashed:', err.message, err.stack);
            postMessage({ type: 'done', worker_id: msg.worker_id, checked: 0, feasible: 0, met_req: 0, top5: [] });
            return;
        }
        if (SOLVER_DEBUG_WORKER && msg.worker_id === 0) {
            console.log('[w0] init | scoring:', msg.scoring_target,
                '| combo_rows:', msg.parsed_combo?.length,
                '| combo_time:', msg.combo_time,
                '| allow_downtime:', msg.allow_downtime,
                '| sp_budget:', msg.sp_budget,
                '| prechecks:', _constraint_prechecks.length,
                '| ehp_precheck:', !!_ehp_precheck, '| ehp_no_agi_precheck:', !!_ehp_no_agi_precheck, '| total_hp_precheck:', !!_total_hp_precheck,
                '| thresholds:', msg.restrictions?.stat_thresholds?.length ?? 0,
                '| sp_floors:', _sp_floors ? Array.from(_sp_floors) : null,
                '| sp_caps:', _sp_caps ? Array.from(_sp_caps) : null);
        }

        // Run immediately if a partition is requested
        if (msg.partition) {
            _checked = 0;
            _feasible = 0;
            _met_req = 0;
            _top5 = [];
            _top5_version = 0;
            _last_sent_top5_version = 0;
            _checked_at_last_top5_change = 0;
            _current_L = 0;
            try {
                _run_level_enum();
            } catch (err) {
                console.error('[w] enum crashed:', err.message, err.stack);
            }
            postMessage({
                type: 'done',
                worker_id: msg.worker_id,
                checked: _checked,
                feasible: _feasible,
                met_req: _met_req,
                top5: _top5,
            });
        }
    } else if (msg.type === 'run') {
        // Lightweight partition assignment — reuse stored _cfg data
        _cfg.partition = msg.partition;
        _cfg.worker_id = msg.worker_id;
        _checked = 0;
        _feasible = 0;
        _met_req = 0;
        _top5 = [];
        _top5_version = 0;
        _last_sent_top5_version = 0;
        _checked_at_last_top5_change = 0;
        _current_L = 0;
        _cancelled = false;

        try {
            _run_level_enum();
        } catch (err) {
            console.error('[w] enum crashed:', err.message, err.stack);
        }
        postMessage({
            type: 'done',
            worker_id: msg.worker_id,
            checked: _checked,
            feasible: _feasible,
            met_req: _met_req,
            top5: _top5,
        });
    } else if (msg.type === 'cancel') {
        _cancelled = true;
    }
};
