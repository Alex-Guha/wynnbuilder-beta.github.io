// ══════════════════════════════════════════════════════════════════════════════
// SOLVER WEB WORKER
// Runs a synchronous level-based enumeration over item combinations.
// No DOM access — all state is received via postMessage.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

importScripts(
    '../core/utils.js',
    '../game/game_rules.js',
    '../game/build_utils.js',
    '../game/powders.js',
    '../game/skillpoints.js',
    '../game/damage_calc.js',
    '../game/shared_game_stats.js',
    './solver_pure.js',
    './solver_worker_shims.js'
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
//   - 'ehp': derived from HP + def% + agi% + classDef + defMult (has special handling)
//   - 'str','dex','int','def','agi': overwritten by total_sp from SP assignment
const _PRECHECK_EXCLUDED = new Set(['ehp', 'str', 'dex', 'int', 'def', 'agi']);
let _constraint_prechecks = [];  // [{stat, adjusted_threshold}]
let _ehp_precheck = null;        // {threshold, fixed_hp, ehp_divisor} or null

// ── Search state ────────────────────────────────────────────────────────────

const PROGRESS_INTERVAL = 5000;
let _checked = 0;
let _feasible = 0;
let _top5 = [];

function _insert_top5(candidate) {
    _top5.push(candidate);
    _top5.sort((a, b) => b.score - a.score);
    if (_top5.length > 5) _top5.length = 5;
}

/**
 * Build constraint prechecks from the restriction thresholds.
 * Called once during worker init.
 */
function _build_constraint_prechecks() {
    _constraint_prechecks = [];
    _ehp_precheck = null;

    const thresholds = _cfg.restrictions?.stat_thresholds ?? [];
    if (thresholds.length === 0) return;

    // Compute fixed stat contributions (constant across all candidates).
    // atree_raw and static_boosts are both Maps.
    const fixed = (stat) => {
        return (_cfg.atree_raw?.get(stat) ?? 0) + (_cfg.static_boosts?.get(stat) ?? 0);
    };

    for (const { stat, op, value } of thresholds) {
        if (op !== 'ge') continue;  // only ge constraints benefit from early rejection

        if (stat === 'ehp') {
            // Precompute fixed EHP constants
            const fixed_hp = fixed('hpBonus');

            const def_pct = skillPointsToPercentage(100) * skillpoint_final_mult[3];
            const agi_pct = skillPointsToPercentage(100) * skillpoint_final_mult[4];
            const agi_reduction = (100 - 90) / 100;
            const weaponType = _cfg.weapon_sm?.get('type');
            const classDef = classDefenseMultipliers.get(weaponType) || 1.0;
            const defMult = (2 - classDef);
            const ehp_divisor = (agi_reduction * agi_pct + (1 - agi_pct) * (1 - def_pct)) * defMult;

            _ehp_precheck = { threshold: value, fixed_hp, ehp_divisor };
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
 */
function _fast_ehp_precheck(running_sm) {
    if (!_ehp_precheck) return true;

    // running_sm.get('hp') = levelToHPBase + sum of item 'hp' (static ID)
    // running_sm.get('hpBonus') = sum of item hpBonus (from maxRolls)
    let totalHp = (running_sm.get('hp') ?? 0) + (running_sm.get('hpBonus') ?? 0)
                + _ehp_precheck.fixed_hp;
    if (totalHp < 5) totalHp = 5;

    return (totalHp / _ehp_precheck.ehp_divisor) >= _ehp_precheck.threshold;
}

// ── Per-candidate stat assembly ─────────────────────────────────────────────

function _assemble_combo_stats(build_sm, total_sp, weapon_sm) {
    const pre_scale = _deep_clone_statmap(build_sm);
    for (let i = 0; i < skp_order.length; i++) {
        pre_scale.set(skp_order[i], total_sp[i]);
    }
    const weaponType = weapon_sm.get('type');
    if (weaponType) pre_scale.set('classDef', classDefenseMultipliers.get(weaponType) || 1.0);
    _merge_into(pre_scale, _cfg.atree_raw);
    const radiance_scaled = _apply_radiance_scale(pre_scale, _cfg.radiance_boost);
    const [, atree_scaled_stats] = worker_atree_scaling(
        _cfg.atree_merged, radiance_scaled, _cfg.button_states, _cfg.slider_states);
    const combo_base = _deep_clone_statmap(radiance_scaled);
    _merge_into(combo_base, atree_scaled_stats);
    return combo_base;
}

function _assemble_threshold_stats(combo_base) {
    const s = _deep_clone_statmap(combo_base);
    _merge_into(s, _cfg.static_boosts);
    return s;
}

function _check_thresholds(stats, thresholds) {
    for (const { stat, op, value } of thresholds) {
        let v;
        if (stat === 'ehp') {
            const def = getDefenseStats(stats);
            v = def?.[1]?.[0] ?? 0;
        } else {
            v = stats.get(stat) ?? 0;
        }
        if (op === 'ge' && v < value) return false;
        if (op === 'le' && v > value) return false;
    }
    return true;
}

function _eval_combo_damage(combo_base) {
    const wep_sm = _cfg.weapon_sm;
    const crit = skillPointsToPercentage(combo_base.get('dex') || 0);
    let total = 0;
    for (const { qty, spell, boost_tokens, dmg_excl } of _cfg.parsed_combo) {
        if (dmg_excl) continue;
        const { stats, prop_overrides } =
            apply_combo_row_boosts(combo_base, boost_tokens, _cfg.boost_registry);
        const mod_spell = apply_spell_prop_overrides(spell, prop_overrides, _cfg.atree_merged);
        total += computeSpellDisplayAvg(stats, wep_sm, mod_spell, crit) * qty;
    }
    return total;
}

/**
 * Returns false if the combo mana budget is violated, per the configured constraint:
 *  - No combo_time set → always passes (no mana constraint).
 *  - combo_time set, allow_downtime=true  → end_mana must be > 0 (net positive).
 *  - combo_time set, allow_downtime=false → deficit must be ≤ 5 (sustainable).
 *
 * Mirrors _update_mana_display() in solver_combo_node.js.
 */
function _eval_combo_mana_check(combo_base) {
    const combo_time = _cfg.combo_time ?? 0;
    if (!combo_time) return true;

    const wep_sm = _cfg.weapon_sm;
    let mana_cost = 0;
    for (const { qty, spell, mana_excl } of _cfg.parsed_combo) {
        if (mana_excl) continue;
        if (spell.cost == null) continue;
        mana_cost += getSpellCost(combo_base, spell) * qty;
    }

    // Transcendence (ARCANES): 30% chance no mana cost → ×0.70 expected value
    if ((wep_sm.get('majorIds') ?? []).includes('ARCANES')) mana_cost *= 0.70;

    const mr         = combo_base.get('mr') ?? 0;
    const item_mana  = combo_base.get('maxMana') ?? 0;
    const int_mana   = Math.floor(skillPointsToPercentage(combo_base.get('int') ?? 0) * 100);
    const start_mana = 100 + item_mana + int_mana;
    const mana_regen = (mr / 5) * combo_time;
    const end_mana   = start_mana - mana_cost + mana_regen;

    if (_cfg.allow_downtime) {
        return end_mana > 0;
    } else {
        return (start_mana - end_mana) <= 5;
    }
}

function _eval_combo_healing(combo_base) {
    let total = 0;
    for (const { qty, spell, boost_tokens } of _cfg.parsed_combo) {
        const { stats } = apply_combo_row_boosts(combo_base, boost_tokens, _cfg.boost_registry);
        total += computeSpellHealingTotal(stats, spell) * qty;
    }
    return total;
}

/**
 * Dispatch to the correct scoring function based on _cfg.scoring_target.
 * @param {Map} combo_base  - stats after radiance+atree scaling (no static_boosts)
 * @param {Map} thresh_stats - combo_base + static_boosts (may be null; computed lazily)
 */
function _eval_score(combo_base, thresh_stats) {
    const target = _cfg.scoring_target ?? 'combo_damage';
    if (target === 'combo_damage') {
        return _eval_combo_damage(combo_base);
    }
    if (target === 'total_healing') {
        return _eval_combo_healing(combo_base);
    }
    const stats = thresh_stats ?? _assemble_threshold_stats(combo_base);
    if (target === 'ehp') {
        return getDefenseStats(stats)[1][0];   // EHP weighted by agility
    }
    return stats.get(target) ?? 0;
}

// ── Helper: get item display name from a statMap ────────────────────────────

function _get_item_name(sm) {
    if (sm.has('NONE')) return '';
    return sm.get('displayName') ?? sm.get('name') ?? '';
}

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

    const tracker = _make_illegal_tracker();

    // Wrap NONE statMaps into the same {statMap, _illegalSet, _illegalSetName} format
    const none_items_wrapped = none_item_sms.map(sm => ({ statMap: sm, _illegalSet: null, _illegalSetName: null }));

    // Determine free armor/accessory slots, sorted by pool size ascending (smallest first)
    const free_armor_slots = [];
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (!locked[slot]) free_armor_slots.push(slot);
    }
    free_armor_slots.sort((a, b) => (pools[a]?.length ?? 0) - (pools[b]?.length ?? 0));

    const rings_free = !ring1_locked || !ring2_locked;

    // partial: holds item wrapper objects for each of the 8 equipment positions
    const partial = {
        helmet:     locked.helmet     ?? none_items_wrapped[0],
        chestplate: locked.chestplate ?? none_items_wrapped[1],
        leggings:   locked.leggings   ?? none_items_wrapped[2],
        boots:      locked.boots      ?? none_items_wrapped[3],
        ring1:      ring1_locked      ?? none_items_wrapped[4],
        ring2:      ring2_locked      ?? none_items_wrapped[5],
        bracelet:   locked.bracelet   ?? none_items_wrapped[6],
        necklace:   locked.necklace   ?? none_items_wrapped[7],
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

    // ── Incremental stat accumulation ───────────────────────────────────────
    const N_free = free_armor_slots.length;
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

    // ── Progress reporting ──────────────────────────────────────────────────

    function _maybe_progress() {
        if (_checked % PROGRESS_INTERVAL === 0) {
            postMessage({
                type: 'progress',
                worker_id: _cfg.worker_id,
                checked: _checked,
                feasible: _feasible,
                top5_names: _top5.map(r => ({
                    score: r.score, item_names: r.item_names,
                    base_sp: r.base_sp, total_sp: r.total_sp, assigned_sp: r.assigned_sp,
                })),
            });
        }
    }

    // ── Greedy extra-SP allocator ───────────────────────────────────────────
    //
    // After the minimum SP is assigned to meet item requirements, any
    // remaining budget is greedily distributed to maximise the scoring target.
    // Uses geometric step-down (20 → 4 → 1) for O(50-95) trials worst case.

    function _greedy_allocate_sp(build_sm, base_sp, total_sp, assigned_sp, weapon_sm) {
        let remaining = sp_budget - assigned_sp;
        if (remaining <= 0) return assigned_sp;

        // Quick check: any attribute still has room?
        let any_room = false;
        for (let i = 0; i < 5; i++) {
            if (base_sp[i] < 100 && total_sp[i] < 150) { any_room = true; break; }
        }
        if (!any_room) return assigned_sp;

        const target = _cfg.scoring_target ?? 'combo_damage';
        const need_thresh = (target !== 'combo_damage' && target !== 'total_healing');

        function _trial_score() {
            const cb = _assemble_combo_stats(build_sm, total_sp, weapon_sm);
            const ts = need_thresh ? _assemble_threshold_stats(cb) : null;
            return _eval_score(cb, ts);
        }

        let cur = _trial_score();

        for (const step of [20, 4, 1]) {
            let progress = true;
            while (progress && remaining > 0) {
                progress = false;
                let best_i = -1, best_s = cur;

                for (let i = 0; i < 5; i++) {
                    const a = Math.min(step, remaining, 100 - base_sp[i], 150 - total_sp[i]);
                    if (a <= 0) continue;
                    total_sp[i] += a;
                    const s = _trial_score();
                    total_sp[i] -= a;
                    if (s > best_s) { best_s = s; best_i = i; }
                }

                if (best_i >= 0) {
                    const a = Math.min(step, remaining, 100 - base_sp[best_i], 150 - total_sp[best_i]);
                    base_sp[best_i] += a;
                    total_sp[best_i] += a;
                    remaining -= a;
                    assigned_sp += a;
                    cur = best_s;
                    progress = true;
                }
            }
        }

        return assigned_sp;
    }

    // ── Leaf evaluation ─────────────────────────────────────────────────────

    function _evaluate_leaf() {
        _checked++;

        // Fast constraint precheck: reject builds that can't meet simple
        // additive stat thresholds, before expensive SP solver + stat assembly.
        // running_sm has all item stats accumulated; prechecks account for
        // fixed contributions (atree_raw + static_boosts).
        if (_constraint_prechecks.length > 0 && !_fast_constraint_precheck(running_sm)) {
            _maybe_progress();
            return;
        }
        if (!_fast_ehp_precheck(running_sm)) {
            _maybe_progress();
            return;
        }

        const equip_8_sms = [
            partial.helmet.statMap, partial.chestplate.statMap,
            partial.leggings.statMap, partial.boots.statMap,
            partial.ring1.statMap, partial.ring2.statMap,
            partial.bracelet.statMap, partial.necklace.statMap,
        ];

        // Leaf-level SP pre-filter (quick reject before full SP calculation)
        if (!_sp_prefilter(equip_8_sms, weapon_sm, sp_budget)) {
            _maybe_progress();
            return;
        }

        // Full SP feasibility via calculate_skillpoints
        const result = calculate_skillpoints([...equip_8_sms, guild_tome_sm], weapon_sm);
        const base_sp = result[0];
        const total_sp = result[1];
        const assigned_sp = result[2];
        const activeSetCounts = result[3];
        if (assigned_sp > sp_budget) {
            _maybe_progress();
            return;
        }
        _feasible++;

        // Build stat assembly from running statMap (incremental accumulation)
        const all_equip_sms = [...equip_8_sms, ...tome_sms, weapon_sm];
        const build_sm = _finalize_leaf_statmap(running_sm, weapon_sm, activeSetCounts, sets, all_equip_sms);

        // Greedily assign any remaining SP budget to maximise the scoring target
        const final_assigned = _greedy_allocate_sp(build_sm, base_sp, total_sp, assigned_sp, weapon_sm);

        // Stat assembly + atree scaling
        const combo_base = _assemble_combo_stats(build_sm, total_sp, weapon_sm);

        // Compute thresh_stats once: used for threshold gate and non-damage scoring
        const need_thresh = restrictions.stat_thresholds.length > 0
            || (_cfg.scoring_target ?? 'combo_damage') !== 'combo_damage';
        const thresh_stats = need_thresh ? _assemble_threshold_stats(combo_base) : null;

        // Threshold check
        if (restrictions.stat_thresholds.length > 0) {
            if (!_check_thresholds(thresh_stats, restrictions.stat_thresholds)) {
                _maybe_progress();
                return;
            }
        }

        // Mana constraint check (only when combo_time is set)
        if (!_eval_combo_mana_check(combo_base)) {
            _maybe_progress();
            return;
        }

        // Score
        const score = _eval_score(combo_base, thresh_stats);
        const item_names = equip_8_sms.map(sm => _get_item_name(sm));
        _insert_top5({ score, item_names, base_sp, total_sp, assigned_sp: final_assigned });
        _maybe_progress();
    }

    // ── Stat tracking helpers ────────────────────────────────────────────────

    function _place_item(item_sm)   { _incr_add_item(running_sm, item_sm); }
    function _unplace_item(item_sm) { _incr_remove_item(running_sm, item_sm); }

    // ── Level-based enumeration over free armor/accessory slots ─────────────
    //
    // enumerate(slot_idx, remaining_L) tries all offsets 0..min(remaining_L, pool.size-1)
    // for the current slot, recurses with (remaining_L - offset) for the next slot.
    // The outer loop iterates L = 0, 1, ..., L_max so combinations are visited in
    // increasing order of sum-of-rank-offsets: best build first, then one step away, etc.

    // Compute the maximum achievable level (sum of pool sizes - 1 per slot)
    let L_max = 0;
    for (const slot of free_armor_slots) {
        const p = pools[slot];
        if (p) L_max += p.length - 1;
    }

    function enumerate(slot_idx, remaining_L) {
        if (_cancelled) return;

        if (slot_idx === N_free) {
            _evaluate_leaf();
            return;
        }

        const slot = free_armor_slots[slot_idx];
        const pool = pools[slot];
        if (!pool) { enumerate(slot_idx + 1, remaining_L); return; }

        // For the last free slot, we must place an item at exactly offset=remaining_L.
        // This ensures each combination is visited at exactly one level (level == sum of offsets),
        // preventing duplicates where lower-sum combinations were re-evaluated at every higher L.
        if (slot_idx === N_free - 1) {
            if (remaining_L <= pool.length - 1) {
                const item = pool[remaining_L];
                const is = item._illegalSet;
                const iname = item._illegalSetName;
                if (!tracker.blocks(is, iname)) {
                    if (is) tracker.add(is, iname);
                    partial[slot] = item;
                    _place_item(item.statMap);
                    _evaluate_leaf();
                    _unplace_item(item.statMap);
                    if (is) tracker.remove(is, iname);
                }
            }
            partial[slot] = locked[slot] ?? none_items_wrapped[_cfg.none_idx_map[slot]];
            return;
        }

        const max_offset = Math.min(remaining_L, pool.length - 1);

        for (let offset = 0; offset <= max_offset; offset++) {
            if (_cancelled) return;
            const item = pool[offset];
            const is = item._illegalSet;
            const iname = item._illegalSetName;
            if (tracker.blocks(is, iname)) continue;
            if (is) tracker.add(is, iname);

            partial[slot] = item;
            _place_item(item.statMap);
            enumerate(slot_idx + 1, remaining_L - offset);
            _unplace_item(item.statMap);
            if (is) tracker.remove(is, iname);
        }
        partial[slot] = locked[slot] ?? none_items_wrapped[_cfg.none_idx_map[slot]];
    }

    // Iterate armor/accessory slots by level for each fixed ring context.
    function run_armor_levels() {
        if (N_free === 0) {
            _evaluate_leaf();
            return;
        }
        for (let L = 0; L <= L_max && !_cancelled; L++) {
            enumerate(0, L);
        }
    }

    // ── Ring iteration ────────────────────────────────────────────────────────

    if (!rings_free) {
        run_armor_levels();
    } else if (ring1_locked) {
        const rp = ring_pool;
        const rp_start = (partition?.type === 'ring_single') ? partition.start : 0;
        const rp_end   = (partition?.type === 'ring_single') ? partition.end : rp.length;
        for (let j = rp_start; j < rp_end; j++) {
            if (_cancelled) break;
            const r2 = rp[j];
            const is = r2._illegalSet;
            if (tracker.blocks(is, r2._illegalSetName)) continue;
            if (is) tracker.add(is, r2._illegalSetName);
            partial.ring2 = r2;
            _place_item(r2.statMap);
            run_armor_levels();
            _unplace_item(r2.statMap);
            if (is) tracker.remove(is, r2._illegalSetName);
        }
    } else if (ring2_locked) {
        const rp = ring_pool;
        const rp_start = (partition?.type === 'ring_single') ? partition.start : 0;
        const rp_end   = (partition?.type === 'ring_single') ? partition.end : rp.length;
        for (let j = rp_start; j < rp_end; j++) {
            if (_cancelled) break;
            const r1 = rp[j];
            const is = r1._illegalSet;
            if (tracker.blocks(is, r1._illegalSetName)) continue;
            if (is) tracker.add(is, r1._illegalSetName);
            partial.ring1 = r1;
            _place_item(r1.statMap);
            run_armor_levels();
            _unplace_item(r1.statMap);
            if (is) tracker.remove(is, r1._illegalSetName);
        }
    } else {
        // Both rings free — enumerate (i, j) with i <= j
        const rp = ring_pool;
        const rp_start = (partition?.type === 'ring') ? partition.start : 0;
        const rp_end   = (partition?.type === 'ring') ? partition.end : rp.length;
        for (let i = rp_start; i < rp_end; i++) {
            if (_cancelled) break;
            const r1 = rp[i];
            const is1 = r1._illegalSet;
            if (tracker.blocks(is1, r1._illegalSetName)) continue;
            if (is1) tracker.add(is1, r1._illegalSetName);
            partial.ring1 = r1;
            _place_item(r1.statMap);
            for (let j = i; j < rp.length; j++) {
                if (_cancelled) break;
                const r2 = rp[j];
                const is2 = r2._illegalSet;
                if (tracker.blocks(is2, r2._illegalSetName)) continue;
                if (is2) tracker.add(is2, r2._illegalSetName);
                partial.ring2 = r2;
                _place_item(r2.statMap);
                run_armor_levels();
                _unplace_item(r2.statMap);
                if (is2) tracker.remove(is2, r2._illegalSetName);
            }
            _unplace_item(r1.statMap);
            if (is1) tracker.remove(is1, r1._illegalSetName);
        }
    }
}

// ── Message handler ─────────────────────────────────────────────────────────

self.onmessage = function(e) {
    const msg = e.data;
    if (msg.type === 'init') {
        // Heavy one-time initialization: store all shared data
        sets = new Map(msg.sets_data);
        _cfg = msg;
        _cancelled = false;
        _build_constraint_prechecks();

        // Run immediately if a partition is requested
        if (msg.partition) {
            _checked = 0;
            _feasible = 0;
            _top5 = [];
            _run_level_enum();
            postMessage({
                type: 'done',
                worker_id: msg.worker_id,
                checked: _checked,
                feasible: _feasible,
                top5: _top5,
            });
        }
    } else if (msg.type === 'run') {
        // Lightweight partition assignment — reuse stored _cfg data
        _cfg.partition = msg.partition;
        _cfg.worker_id = msg.worker_id;
        _checked = 0;
        _feasible = 0;
        _top5 = [];
        _cancelled = false;

        _run_level_enum();

        postMessage({
            type: 'done',
            worker_id: msg.worker_id,
            checked: _checked,
            feasible: _feasible,
            top5: _top5,
        });
    } else if (msg.type === 'cancel') {
        _cancelled = true;
    }
};
