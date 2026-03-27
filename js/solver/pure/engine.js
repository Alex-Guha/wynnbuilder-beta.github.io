// ══════════════════════════════════════════════════════════════════════════════
// SOLVER PURE — Combo damage totals & engine helpers
// Shared between the solver main thread (<script> tag) and the Web Worker
// (importScripts). NO DOM access, NO window/document/navigator references.
//
// pure/ dependencies:
//   - pure/spell.js:    computeSpellDisplayAvg, computeSpellDisplayFull,
//                       computeSpellHealingTotal, compute_dps_spell_hits_info,
//                       spell_has_damage, spell_has_heal
//   - pure/boost.js:    apply_combo_row_boosts, apply_spell_prop_overrides
//   - pure/utils.js:    _deep_clone_statmap, _deep_clone_statmap_into,
//                       _merge_into, _apply_radiance_scale_inplace,
//                       atree_compute_scaling, compute_melee_time_hits
//   - pure/simulate.js: simulate_combo_mana_hp, simulate_combo_mana_fast,
//                       DEFAULT_HEALTH_CONFIG
// External dependencies (must be loaded before this file):
//   - build_utils.js:      skp_order
//   - game_rules.js:       SPELL_CAST_DELAY
//   - shared_game_stats.js: getDefenseStats, getSpellCost, classDefenseMultipliers
// ══════════════════════════════════════════════════════════════════════════════

// ── Combo damage totals ─────────────────────────────────────────────────────

/**
 * Pure combo damage totals computation shared by main thread and worker.
 * Iterates combo rows, applies per-row boost tokens, computes spell damage
 * and healing for each row.
 *
 * @param {Map} base_stats - Aggregated build statMap
 * @param {Map} weapon_sm - Weapon statMap
 * @param {Object[]} parsed_rows - Each row:
 *   { qty, spell, boost_tokens, dmg_excl, dps_per_hit_name, dps_hits, pseudo }
 * @param {number} crit_chance - Crit chance (from dex skill percentage)
 * @param {Object[]} registry - Boost registry
 * @param {Map} atree_merged - Merged ability tree
 * @param {Object} [opts] - { detailed: bool, scratch_row: Map|null }
 *   detailed=false → computeSpellDisplayAvg (fast, worker)
 *   detailed=true  → computeSpellDisplayFull (main thread popups)
 * @returns {Object} { total_damage, total_healing, per_row[] }
 *   per_row: { damage, healing, full_display, spell_cost }
 */
function compute_combo_damage_totals(base_stats, weapon_sm, parsed_rows, crit_chance, registry, atree_merged, opts) {
    const { detailed = false, scratch_row = null, debug = false, debug_label = '[PAGE]' } = opts || {};
    let total_damage = 0;
    let total_healing = 0;
    const per_row = [];

    if (debug) {
        const _ds = (sm) => {
            const keys = ['hp','hpBonus','str','dex','int','def','agi',
                'sdPct','sdRaw','mdPct','mdRaw','damPct','damRaw',
                'rSdPct','rSdRaw','rMdPct','rMdRaw','rDamPct','rDamRaw',
                'mr','ms','maxMana','critDamPct','atkSpd','atkTier',
                'spPct1','spPct2','spPct3','spPct4','spRaw1','spRaw2','spRaw3','spRaw4'];
            const o = {};
            for (const k of keys) { const v = sm.get(k); if (v != null && v !== 0) o[k] = v; }
            const dm = sm.get('damMult');
            if (dm?.size) o.damMult = Object.fromEntries(dm);
            const dfm = sm.get('defMult');
            if (dfm?.size) o.defMult = Object.fromEntries(dfm);
            return o;
        };
        const _ws = (sm) => {
            const o = {};
            for (const e of ['n','e','t','w','f','a']) {
                const v = sm.get(e + 'Dam_');
                if (v) o[e + 'Dam_'] = v;
            }
            o.atkSpd = sm.get('atkSpd');
            return o;
        };
        console.log('[COMBO-DEBUG]' + debug_label + ' base_stats:', JSON.stringify(_ds(base_stats)));
        console.log('[COMBO-DEBUG]' + debug_label + ' weapon:', JSON.stringify(_ws(weapon_sm)));
        console.log('[COMBO-DEBUG]' + debug_label + ' crit_chance:', crit_chance, 'detailed:', detailed);
    }

    for (let _row_idx = 0; _row_idx < parsed_rows.length; _row_idx++) {
        const row = parsed_rows[_row_idx];
        const { qty, spell, boost_tokens, dmg_excl, pseudo } = row;

        if (!spell || qty <= 0 || pseudo) {
            per_row.push({ damage: 0, healing: 0, full_display: null, spell_cost: null, dps_info: null });
            if (debug && pseudo) console.log('[COMBO-DEBUG]' + debug_label + ' row', _row_idx, '(pseudo:', pseudo + ')');
            continue;
        }

        const { stats, prop_overrides } =
            apply_combo_row_boosts(base_stats, boost_tokens, registry, scratch_row);
        const mod_spell = apply_spell_prop_overrides(spell, prop_overrides, atree_merged);

        // DPS spell detection: use pre-set fields or auto-detect from mod_spell
        let eff_dps_name = row.dps_per_hit_name ?? null;
        let eff_dps_hits = row.dps_hits ?? 0;
        let dps_info = null;
        if (!eff_dps_name) {
            dps_info = compute_dps_spell_hits_info(mod_spell);
            if (dps_info) {
                eff_dps_name = dps_info.per_hit_name;
                eff_dps_hits = row.dps_hits_override ?? dps_info.max_hits;
            }
        }

        let per_cast, full_display = null;
        if (detailed) {
            let full;
            if (eff_dps_name) {
                const per_hit_spell = { ...mod_spell, display: eff_dps_name };
                full = computeSpellDisplayFull(stats, weapon_sm, per_hit_spell, crit_chance);
                per_cast = full ? full.avg * eff_dps_hits : 0;
            } else {
                full = computeSpellDisplayFull(stats, weapon_sm, mod_spell, crit_chance);
                per_cast = full ? full.avg : 0;
            }
            full_display = full;
        } else {
            if (eff_dps_name) {
                const per_hit_spell = { ...mod_spell, display: eff_dps_name };
                per_cast = computeSpellDisplayAvg(stats, weapon_sm, per_hit_spell, crit_chance) * eff_dps_hits;
            } else {
                per_cast = computeSpellDisplayAvg(stats, weapon_sm, mod_spell, crit_chance);
            }
        }

        const eff_qty = row.is_melee_time
            ? compute_melee_time_hits(qty, base_stats, SPELL_CAST_DELAY)
            : qty;
        const row_damage = dmg_excl ? 0 : per_cast * eff_qty;
        const heal_per_cast = computeSpellHealingTotal(stats, mod_spell);
        const row_healing = heal_per_cast * eff_qty;

        if (debug) {
            const _bt = boost_tokens?.map(t => `${t.name}=${t.value}${t.is_pct?'%':''}`) ?? [];
            const _po = prop_overrides.size ? Object.fromEntries([...prop_overrides].map(([k,v]) => [k, `replace=${v.replace} add=${v.add}`])) : null;
            // Log key boosted stat deltas vs base
            const _deltas = {};
            for (const k of ['sdPct','sdRaw','mdPct','mdRaw','damPct','damRaw','critDamPct',
                             'rSdPct','rSdRaw','rMdPct','rMdRaw','rDamPct','rDamRaw']) {
                const sv = stats.get(k) ?? 0, bv = base_stats.get(k) ?? 0;
                if (sv !== bv) _deltas[k] = `${bv}→${sv}`;
            }
            const sdm = stats.get('damMult'), bdm = base_stats.get('damMult');
            if (sdm) for (const [k,v] of sdm) {
                const bv = bdm?.get(k) ?? 0;
                if (v !== bv) _deltas['damMult.' + k] = `${bv}→${v}`;
            }
            console.log('[COMBO-DEBUG]' + debug_label + ' row', _row_idx, JSON.stringify({
                spell: spell.name, qty, dmg_excl: dmg_excl || undefined,
                boosts: _bt.length ? _bt : undefined,
                prop_overrides: _po,
                stat_deltas: Object.keys(_deltas).length ? _deltas : undefined,
                dps: eff_dps_name ? { name: eff_dps_name, hits: eff_dps_hits, preset: !!row.dps_per_hit_name } : undefined,
                per_cast: Math.round(per_cast),
                row_damage: Math.round(row_damage),
            }));
        }

        total_damage += row_damage;
        total_healing += row_healing;

        // Spell cost (for popup display)
        const spell_cost = (detailed && mod_spell.cost != null)
            ? getSpellCost(stats, mod_spell) : null;

        per_row.push({ damage: per_cast, healing: heal_per_cast, full_display, spell_cost, dps_info });
    }

    if (debug) {
        console.log('[COMBO-DEBUG]' + debug_label + ' TOTAL damage:', Math.round(total_damage), 'healing:', Math.round(total_healing));
    }

    return { total_damage, total_healing, per_row };
}

// ── Shared engine helpers ───────────────────────────────────────────────────
// Used by both the search worker and the main-thread evaluators
// (item_priority.js, search.js).

/**
 * Check stat threshold constraints (ge/le).
 * Returns false if any constraint is violated.
 */
function check_thresholds(stats, thresholds, spell_base_costs) {
    let _def_cache = null;
    const _get_def = () => _def_cache ?? (_def_cache = getDefenseStats(stats));
    for (const { stat, op, value } of thresholds) {
        let v;
        if (stat === 'ehp') {
            v = _get_def()[1]?.[0] ?? 0;
        } else if (stat === 'ehp_no_agi') {
            v = _get_def()[1]?.[1] ?? 0;
        } else if (stat === 'total_hp') {
            v = _get_def()[0] ?? 0;
        } else if (stat === 'ehpr') {
            v = _get_def()[3]?.[0] ?? 0;
        } else if (stat === 'hpr') {
            v = _get_def()[2] ?? 0;
        } else if (stat.startsWith('finalSpellCost')) {
            const spell_num = parseInt(stat.charAt(stat.length - 1));
            const base_cost = spell_base_costs?.[spell_num];
            if (base_cost == null) continue;
            v = getSpellCost(stats, { cost: base_cost, base_spell: spell_num });
        } else {
            v = stats.get(stat) ?? 0;
        }
        if (op === 'ge' && v < value) return false;
        if (op === 'le' && v > value) return false;
    }
    return true;
}

/**
 * Inject simulation-derived boost tokens (blood pact bonus, state values)
 * into parsed_combo rows.  Returns a new array of rows (original rows are
 * reused when no tokens need injecting).
 */
function inject_blood_pact_boosts(parsed_combo, sim, bp_slider_name, state_slider_names) {
    const result = [];
    for (let i = 0; i < parsed_combo.length; i++) {
        const row = parsed_combo[i];
        const res = sim.row_results[i];
        const extra = [];
        const _has_manual = (n) => row.boost_tokens.some(t => t.manual && t.name === n);
        if (res.blood_pact_bonus > 0 && bp_slider_name && !_has_manual(bp_slider_name)) {
            extra.push({ name: bp_slider_name, value: Math.round(res.blood_pact_bonus * 10) / 10, is_pct: true });
        }
        for (const [state_name, slider_name] of Object.entries(state_slider_names)) {
            const val = res.state_values?.[state_name] ?? 0;
            if (val > 0 && !_has_manual(slider_name)) {
                extra.push({ name: slider_name, value: Math.round(val), is_pct: false });
            }
        }
        if (extra.length === 0) { result.push(row); continue; }
        result.push({ ...row, boost_tokens: [...row.boost_tokens, ...extra] });
    }
    return result;
}

/**
 * Evaluate total combo healing across all rows.
 * Handles is_melee_time rows via compute_melee_time_hits.
 */
function eval_combo_healing(parsed_combo, combo_base, boost_registry, scratch_row) {
    let total = 0;
    for (const row of parsed_combo) {
        if (row.pseudo) continue;
        const { qty, spell, boost_tokens } = row;
        const { stats } = apply_combo_row_boosts(combo_base, boost_tokens, boost_registry, scratch_row);
        const eff_qty = row.is_melee_time
            ? compute_melee_time_hits(qty, combo_base, SPELL_CAST_DELAY)
            : qty;
        total += computeSpellHealingTotal(stats, spell) * eff_qty;
    }
    return total;
}

/**
 * Evaluate combo damage with full Blood Pact flow.
 * Handles: hp_casting check → simulate → extract slider names → inject boosts → damage totals.
 * Shared by worker, item_priority, and search.js debug path.
 *
 * @param {Map} combo_base - Aggregated+scaled build statMap
 * @param {Map} weapon_sm - Weapon statMap
 * @param {Object[]} parsed_combo - Pre-parsed combo rows
 * @param {Object} bp_config - {
 *     hp_casting, health_config, boost_registry, atree_merged,
 *     bp_slider_name (optional), state_slider_names (optional)
 * }
 * @param {Object} [opts] - {
 *     detailed, scratch_row, debug, debug_label,
 *     cached_hp_sim: pre-computed sim result (worker optimization)
 * }
 * @returns {{ total_damage, total_healing, per_row, hp_sim }}
 */
function eval_combo_damage_with_bp(combo_base, weapon_sm, parsed_combo, bp_config, opts) {
    const { hp_casting, health_config, boost_registry, atree_merged } = bp_config;
    const { detailed = false, scratch_row = null, debug = false, debug_label = '',
            cached_hp_sim = null } = opts || {};

    const crit = skillPointsToPercentage(combo_base.get('dex') || 0);
    let damage_rows = parsed_combo;
    let hp_sim = null;

    if (hp_casting && health_config) {
        const has_transcendence = combo_base.get('activeMajorIDs')?.has('ARCANES') ?? false;
        hp_sim = cached_hp_sim ?? simulate_combo_mana_hp(
            parsed_combo, combo_base, health_config, has_transcendence,
            boost_registry, scratch_row);

        // Use pre-computed slider names if available, otherwise extract
        const bp_name = bp_config.bp_slider_name ?? (health_config.damage_boost?.slider_name ?? null);
        const ssn = bp_config.state_slider_names ?? extract_slider_names(health_config).state_slider_names;

        damage_rows = inject_blood_pact_boosts(parsed_combo, hp_sim, bp_name, ssn);
    }

    const result = compute_combo_damage_totals(
        combo_base, weapon_sm, damage_rows, crit,
        boost_registry, atree_merged,
        { detailed, scratch_row, debug, debug_label });

    return { total_damage: result.total_damage, total_healing: result.total_healing,
             per_row: result.per_row, hp_sim };
}

/**
 * Assemble combo stats from a build statMap + total skill points.
 * Worker passes scratch objects for zero-allocation; main thread passes null.
 *
 * @param {Object|null} scratch - Optional pre-allocated Maps:
 *   { pre_scale, pre_scale_nested, combo_base, combo_base_nested, atree }
 */
function assemble_combo_stats(build_sm, total_sp, weapon_sm, atree_raw, radiance_boost,
                               atree_merged, button_states, slider_states, static_boosts,
                               scratch) {
    let pre_scale;
    if (scratch?.pre_scale) {
        _deep_clone_statmap_into(scratch.pre_scale, build_sm, scratch.pre_scale_nested);
        pre_scale = scratch.pre_scale;
    } else {
        pre_scale = _deep_clone_statmap(build_sm);
    }
    for (let i = 0; i < skp_order.length; i++) {
        pre_scale.set(skp_order[i], total_sp[i]);
    }
    const weaponType = weapon_sm.get('type');
    if (weaponType) pre_scale.set('classDef', classDefenseMultipliers.get(weaponType) || 1.0);
    _merge_into(pre_scale, atree_raw);
    _apply_radiance_scale_inplace(pre_scale, radiance_boost);
    const [, atree_scaled_stats] = atree_compute_scaling(
        atree_merged, pre_scale, button_states, slider_states, scratch?.atree);

    let combo_base;
    if (scratch?.combo_base) {
        _deep_clone_statmap_into(scratch.combo_base, pre_scale, scratch.combo_base_nested);
        combo_base = scratch.combo_base;
    } else {
        combo_base = _deep_clone_statmap(pre_scale);
    }
    _merge_into(combo_base, atree_scaled_stats);
    _merge_into(combo_base, static_boosts);
    return combo_base;
}

/**
 * Greedy SP allocation loop — shared by worker and main-thread sensitivity.
 * Step-down [20, 4, 1] with try-revert-keep pattern.
 *
 * @param {Int32Array|number[]} base_sp - Per-attribute base SP (mutated in-place)
 * @param {Int32Array|number[]} total_sp - Per-attribute total SP (mutated in-place)
 * @param {number} remaining - Remaining SP budget to allocate
 * @param {Int32Array|number[]} cap_total - Per-attribute total_sp cap
 * @param {Function} trial_score_fn - () => number, called with total_sp already mutated for trial
 * @returns {number} Number of SP points allocated
 */
function greedy_sp_loop(base_sp, total_sp, remaining, cap_total, trial_score_fn) {
    let allocated = 0;
    let cur = trial_score_fn();

    for (const step of [20, 4, 1]) {
        let progress = true;
        while (progress && remaining > 0) {
            progress = false;
            let best_i = -1, best_s = cur;

            for (let i = 0; i < 5; i++) {
                const a = Math.min(step, remaining, 100 - base_sp[i], cap_total[i] - total_sp[i]);
                if (a <= 0) continue;
                total_sp[i] += a;
                const s = trial_score_fn();
                total_sp[i] -= a;
                if (s > best_s) { best_s = s; best_i = i; }
            }

            if (best_i >= 0) {
                const a = Math.min(step, remaining, 100 - base_sp[best_i], cap_total[best_i] - total_sp[best_i]);
                base_sp[best_i] += a;
                total_sp[best_i] += a;
                remaining -= a;
                allocated += a;
                cur = best_s;
                progress = true;
            }
        }
    }

    return allocated;
}

/**
 * Score dispatch — routes to the correct scoring evaluator based on target.
 * Callers pass their local damage/healing evaluators as callbacks.
 *
 * @param {Function} eval_damage_fn - () => number
 * @param {Function} eval_healing_fn - () => number
 * @param {Map|null} thresh_stats - pre-cloned stats for non-damage targets (or null to use combo_base)
 */
function eval_score_dispatch(scoring_target, combo_base, eval_damage_fn, eval_healing_fn, thresh_stats) {
    const target = scoring_target ?? 'combo_damage';
    if (target === 'combo_damage') return eval_damage_fn();
    if (target === 'total_healing') return eval_healing_fn();
    const stats = thresh_stats ?? combo_base;
    return eval_indirect_stat(stats, target);
}

// ── Shared constants ─────────────────────────────────────────────────────────

/** Stats that cannot be prechecked from simple item-stat sums (require full build context). */
const INDIRECT_CONSTRAINT_STATS = new Set([
    'ehp', 'ehp_no_agi', 'total_hp', 'ehpr', 'hpr',
    'finalSpellCost1', 'finalSpellCost2', 'finalSpellCost3', 'finalSpellCost4',
]);

// ── Shared helpers ───────────────────────────────────────────────────────────

/**
 * Evaluate an indirect/derived stat from a statMap.
 * Routes to getDefenseStats() for EHP/HP/HPR/EHPR, falls back to map lookup.
 */
function eval_indirect_stat(stats, stat) {
    if (stat === 'ehp') return getDefenseStats(stats)[1][0];
    if (stat === 'ehp_no_agi') return getDefenseStats(stats)[1][1];
    if (stat === 'total_hp') return getDefenseStats(stats)[0];
    if (stat === 'hpr') return getDefenseStats(stats)[2];
    if (stat === 'ehpr') return getDefenseStats(stats)[3][0];
    return stats.get(stat) ?? 0;
}

/**
 * Extract display name from an item statMap.
 * Returns '' for NONE items, CI-/CR- hash for custom/crafted items,
 * otherwise displayName or name.
 */
function get_item_display_name(sm) {
    if (sm.has('NONE')) return '';
    const hash = sm.get('hash');
    if (hash && (hash.slice(0, 3) === 'CI-' || hash.slice(0, 3) === 'CR-')) return hash;
    return sm.get('displayName') ?? sm.get('name') ?? '';
}

/**
 * Evaluate combo mana/HP feasibility.
 * Shared between worker and main-thread seed evaluation.
 *
 * @param {Object} p
 * @param {Object[]} p.parsed_combo
 * @param {Map} p.combo_base - stats after radiance+atree scaling+static_boosts
 * @param {boolean} p.hp_casting - Blood Pact mode
 * @param {number} p.combo_time - 0 means no mana constraint
 * @param {boolean} p.allow_downtime - true: end_mana > 0; false: deficit <= 5
 * @param {Object} p.health_config
 * @param {Object[]} p.boost_registry
 * @param {Map|null} [p.scratch_row] - reusable row Map (worker perf opt)
 * @param {boolean} [p.use_fast_sim=false] - use simulate_combo_mana_fast for non-BP
 * @returns {{ passed: boolean, sim: Object|null }}
 */
function eval_combo_mana_check(p) {
    const combo_time = p.combo_time ?? 0;
    if (!combo_time && !p.hp_casting) return { passed: true, sim: null };

    const hc = p.health_config ?? DEFAULT_HEALTH_CONFIG;
    const has_transcendence = p.combo_base.get('activeMajorIDs')?.has('ARCANES') ?? false;

    // BP builds: full simulation (damage calc reuses row_results via cached sim).
    if (p.hp_casting && hc.health_cost > 0) {
        const sim = simulate_combo_mana_hp(
            p.parsed_combo, p.combo_base, hc, has_transcendence,
            p.boost_registry, p.scratch_row);
        if (sim.row_results.some(r => r.hp_warning)) return { passed: false, sim };
        return { passed: true, sim };  // BP: skip mana gating, spells paid with HP
    }

    // Non-BP builds: fast mana-only check (worker) or full sim (main thread).
    if (p.use_fast_sim) {
        const sim = simulate_combo_mana_fast(
            p.parsed_combo, p.combo_base, hc, has_transcendence,
            p.boost_registry, p.scratch_row);
        if (sim.has_hp_warning) return { passed: false, sim };
        if (p.allow_downtime) return { passed: sim.end_mana > 0, sim };
        return { passed: (sim.start_mana - sim.end_mana) <= 5, sim };
    }

    const sim = simulate_combo_mana_hp(
        p.parsed_combo, p.combo_base, hc, has_transcendence,
        p.boost_registry, p.scratch_row);
    if (sim.row_results.some(r => r.hp_warning)) return { passed: false, sim };
    if (p.allow_downtime) return { passed: sim.end_mana > 0, sim };
    return { passed: (sim.start_mana - sim.end_mana) <= 5, sim };
}

/**
 * Greedy SP allocation with optional floor enforcement.
 * Wraps greedy_sp_loop with budget check, room check, and floor phase.
 *
 * @param {Int32Array|number[]} base_sp - mutated in-place
 * @param {Int32Array|number[]} total_sp - mutated in-place
 * @param {number} remaining - SP budget remaining after item requirements
 * @param {Int32Array|number[]} cap_total - per-attribute total_sp cap [5]
 * @param {Int32Array|number[]|null} sp_floors - per-attribute minimum total_sp, or null
 * @param {Function} trial_score_fn - () => number
 * @param {Function|null} on_post_floor - called after floor enforcement, before greedy loop
 * @returns {number} total SP allocated (floors + greedy)
 */
function greedy_sp_allocate(base_sp, total_sp, remaining, cap_total, sp_floors, trial_score_fn, on_post_floor) {
    if (remaining <= 0) return 0;

    // Quick check: any attribute still has room?
    let any_room = false;
    for (let i = 0; i < 5; i++) {
        if (base_sp[i] < 100 && total_sp[i] < 150) { any_room = true; break; }
    }
    if (!any_room) return 0;

    let allocated = 0;

    // Phase 1: Enforce SP floors from ge restrictions (e.g. Int >= 40).
    if (sp_floors) {
        for (let i = 0; i < 5; i++) {
            const deficit = sp_floors[i] - total_sp[i];
            if (deficit <= 0) continue;
            const add = Math.min(deficit, remaining, 100 - base_sp[i], 150 - total_sp[i]);
            if (add <= 0) continue;
            base_sp[i] += add;
            total_sp[i] += add;
            remaining -= add;
            allocated += add;
        }
        if (remaining <= 0) return allocated;
        // Re-check room after floor enforcement
        any_room = false;
        for (let i = 0; i < 5; i++) {
            if (base_sp[i] < 100 && total_sp[i] < 150) { any_room = true; break; }
        }
        if (!any_room) return allocated;
    }

    if (on_post_floor) on_post_floor();

    // Phase 2: Score-based greedy allocation via step-down loop.
    allocated += greedy_sp_loop(base_sp, total_sp, remaining, cap_total, trial_score_fn);
    return allocated;
}
