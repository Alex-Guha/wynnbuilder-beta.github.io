// ── State ─────────────────────────────────────────────────────────────────────

const _TOP_N = 15;
const _TOP_N_DISPLAY = 5;

const _solver_state = {
    running: false,
    top5: [],              // [{score, items:[Item×8], base_sp, total_sp, assigned_sp}] (up to _TOP_N entries)
    seed_build: null,      // seeded from current UI build (survives worker merges)
    checked: 0,
    feasible: 0,
    met_req: 0,
    start: 0,
    last_ui: 0,
    total: 0,
    last_eta: 0,
    workers: [],           // [{worker, done, checked, feasible, met_req, top5}]
    progress_timer: 0,     // setInterval handle
    verification_phase: false,
    dmg_weights: null,
    last_topN_change: 0,          // timestamp of last change to merged top-N
    _prev_topN_fingerprint: '',   // for change detection
    top15_expanded: false,        // UI expand state
    progress_expanded: false,     // progress details expand state
};

// Bitmask tracking which equipment slots were last filled by the solver.
let _solver_free_mask = 0;

// Set to true while _fill_build_into_ui is dispatching change events.
let _solver_filling_ui = false;

// ── Roll-mode helper ─────────────────────────────────────────────────────────

function _apply_roll_mode_to_item(item) {
    if (_allRollsMax()) return item;
    const minR = item.statMap.get('minRolls');
    const maxR = item.statMap.get('maxRolls');
    if (!minR || !maxR) return item;
    for (const [k, maxVal] of maxR) {
        const minVal = minR.get(k) ?? maxVal;
        maxR.set(k, getRolledValue(minVal, maxVal, k));
    }
    return item;
}

// ── Item pool building ────────────────────────────────────────────────────────

function _collect_locked_items(illegal_at_2) {
    const locked = {};
    for (let i = 0; i < 8; i++) {
        const slot = equipment_fields[i];
        const input = document.getElementById(slot + '-choice');
        if (input?.dataset.solverFilled === 'true') continue; // free slot — solver searches
        const node = solver_item_final_nodes[i];
        const item = node?.value;
        if (!item) continue;
        if (item.statMap.has('NONE')) {
            // Empty + locked — solver will keep this slot empty
            locked[slot] = item;
            continue;
        }
        // Attach illegal set info so the worker can track it
        const sn = item.statMap.get('set') ?? null;
        item._illegalSet = (sn && illegal_at_2.has(sn)) ? sn : null;
        item._illegalSetName = item._illegalSet
            ? (item.statMap.get('displayName') ?? item.statMap.get('name') ?? '') : null;
        locked[slot] = item;
    }
    return locked;
}

function _build_item_pools(restrictions, illegal_at_2 = new Set(), blacklist = new Set()) {
    const slot_types = {
        helmet: 'helmet', chestplate: 'chestplate', leggings: 'leggings',
        boots: 'boots', ring: 'ring', bracelet: 'bracelet', necklace: 'necklace',
    };
    const sp_keys = skp_order;
    const pools = {};
    for (const [slot, type] of Object.entries(slot_types)) {
        const pool = [];
        const names = itemLists.get(type) ?? [];
        for (const name of names) {
            const item_obj = itemMap.get(name);
            if (!item_obj) continue;
            if (item_obj.name?.startsWith('No ')) continue;
            if (blacklist.has(name)) continue;
            const lvl = item_obj.lvl ?? 0;
            if (lvl < restrictions.lvl_min || lvl > restrictions.lvl_max) continue;
            if (restrictions.no_major_id && item_obj.majorIds?.length > 0) continue;
            let skip = false;
            for (let i = 0; i < 5; i++) {
                if (!restrictions.build_dir[sp_keys[i]]) {
                    if ((item_obj.reqs?.[i] ?? 0) > 0) { skip = true; break; }
                }
            }
            if (skip) continue;
            const item = _apply_roll_mode_to_item(new Item(item_obj));
            const sn = item_obj.set ?? null;
            item._illegalSet = (sn && illegal_at_2.has(sn)) ? sn : null;
            item._illegalSetName = item._illegalSet ? (item_obj.displayName ?? item_obj.name ?? '') : null;
            pool.push(item);
        }
        const none_idx = _NONE_ITEM_IDX[slot === 'ring' ? 'ring1' : slot];
        pool.unshift(new Item(none_items[none_idx]));
        pools[slot] = pool;
    }
    return pools;
}

// ── Solver snapshot ───────────────────────────────────────────────────────────

function _parse_combo_for_search(spell_map, weapon) {
    const weapon_powders = weapon?.statMap?.get('powders') ?? [];
    const aug = new Map(spell_map);
    for (const ps_idx of [0, 1, 3]) {
        const tier = get_element_powder_tier(weapon_powders, ps_idx);
        if (tier > 0) aug.set(-1000 - ps_idx, make_powder_special_spell(ps_idx, tier));
    }
    apply_deferred_powder_special_effects(aug, spell_map);
    const rows = solver_combo_total_node._read_combo_rows(aug);
    return rows
        .map(r => {
            // Pseudo-spells: include as marker rows for worker state tracking.
            const spell_id = parseInt(r.dom_row?.querySelector('.combo-row-spell')?.value);
            // Check cancel state pseudo-spells
            let cancel_pseudo = null;
            for (const [state_name, cancel_id] of STATE_CANCEL_IDS) {
                if (spell_id === cancel_id) { cancel_pseudo = 'cancel_state:' + state_name; break; }
            }
            if (cancel_pseudo) {
                const mana_excl = r.dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false;
                return { pseudo: cancel_pseudo, mana_excl };
            }
            if (spell_id === MANA_RESET_SPELL_ID) {
                const mana_excl = r.dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false;
                return { pseudo: 'mana_reset', mana_excl };
            }

            const entry = {
                qty: r.qty,
                sim_qty: Math.round(r.qty),
                spell: r.spell,
                boost_tokens: r.boost_tokens,
                dmg_excl: r.dom_row?.querySelector('.combo-dmg-toggle')
                    ?.classList.contains('dmg-excluded') ?? false,
                mana_excl: r.dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false,
            };
            // DPS spells with a Total/Max part: pass per-hit display name and
            // hit count so the worker computes total damage (per-hit × hits)
            // instead of the raw DPS value.
            const dps_info = compute_dps_spell_hits_info(r.spell);
            if (dps_info) {
                entry.dps_per_hit_name = dps_info.per_hit_name;
                const hits_inp = r.dom_row?.querySelector('.combo-row-hits');
                entry.dps_hits = parseFloat(hits_inp?.value) || dps_info.max_hits;
            }
            return entry;
        })
        .filter(r => r.pseudo || (r.qty > 0 && r.spell && (spell_has_damage(r.spell) || spell_has_heal(r.spell) || r.spell.cost != null)));
}

/**
 * Serialize atree interactive state (button/slider DOM elements) into plain Maps.
 */
function _serialize_atree_interactive(atree_interactive_val) {
    const button_states = new Map();
    const slider_states = new Map();
    if (!atree_interactive_val) return { button_states, slider_states };
    const [slider_map, button_map] = atree_interactive_val;
    for (const [name, entry] of button_map) {
        button_states.set(name, entry.button?.classList.contains("toggleOn") ?? false);
    }
    for (const [name, entry] of slider_map) {
        const raw = parseInt(entry.slider?.value ?? '0');
        const rm = entry.real_min ?? 0;
        slider_states.set(name, (rm > 0 && raw < rm) ? 0 : raw);
    }
    return { button_states, slider_states };
}

function _build_solver_snapshot(restrictions) {
    const weapon = solver_item_final_nodes[8]?.value;
    const level = parseInt(document.getElementById('level-choice').value) || MAX_PLAYER_LEVEL;
    const tomes = solver_item_final_nodes.slice(9).map(n => n?.value).filter(Boolean);
    const atree_raw = atree_raw_stats.value ?? new Map();
    const atree_interactive_val = atree_make_interactives.value;
    const atree_mgd = atree_merge.value;
    const static_boosts = solver_boosts_node.value ?? new Map();

    let radiance_boost = 1;
    if (document.getElementById('radiance-boost')?.classList.contains('toggleOn')) radiance_boost += 0.15;
    if (document.getElementById('divinehonor-boost')?.classList.contains('toggleOn')) radiance_boost += 0.05;
    if (document.getElementById('shine-boost')?.classList.contains('toggleOn')) radiance_boost += 0.05;
    if (document.getElementById('judgement-boost')?.classList.contains('toggleOn')) radiance_boost = 1.4;

    // Guild tome handling: two sources — the item slot (guildTome1-choice) and
    // the restriction dropdown (restr-guild-tome).  When a specific tome is
    // selected in the item slot, its skillpoints are already in the statMap
    // (counted as bonus_skillpoints inside calculate_skillpoints), so the
    // assignable budget stays at 200.  When only the dropdown is set, we must
    // apply the bonus: Standard (+4) inflates the budget; Rainbow (+5) injects
    // a synthetic [1,1,1,1,1] tome so the fixed distribution is respected.
    const guild_tome_idx = tome_fields.indexOf('guildTome1');
    let guild_tome_item = (guild_tome_idx >= 0 && solver_item_final_nodes[9 + guild_tome_idx]?.value)
        ? solver_item_final_nodes[9 + guild_tome_idx].value
        : new Item(none_tomes[2]);

    const has_real_guild_tome = !guild_tome_item.statMap.has('NONE');
    let sp_budget = levelToSkillPoints(level);
    if (!has_real_guild_tome) {
        const gtome_mode = restrictions.guild_tome ?? 0;
        if (gtome_mode === 1) {
            // Standard: +4 freely assignable SP (solver picks optimal distribution)
            sp_budget = levelToSkillPoints(level) + 4;
        } else if (gtome_mode === 2) {
            // Rainbow: fixed [1,1,1,1,1] — create synthetic tome so SP calc
            // sees the exact per-attribute contribution (not freely distributable)
            const synth = new Map();
            synth.set('skillpoints', [1, 1, 1, 1, 1]);
            synth.set('reqs', [0, 0, 0, 0, 0]);
            guild_tome_item = { statMap: synth };
        }
    }

    const spell_map = atree_collect_spells.value ?? new Map();
    const boost_registry = build_combo_boost_registry(atree_mgd, solver_build_node.value);
    const parsed_combo = _parse_combo_for_search(spell_map, weapon);

    const scoring_target = document.getElementById('solver-target')?.value ?? 'combo_damage';

    const combo_time_str = document.getElementById('combo-time')?.value?.trim() ?? '';
    const combo_time = parseFloat(combo_time_str) || 0;
    const allow_downtime = document.getElementById('combo-downtime-btn')?.classList.contains('toggleOn') ?? false;
    const flat_mana = parseFloat(document.getElementById('flat-mana-input')?.value) || 0;

    // Extract health_config so workers can dynamically compute per-candidate
    // blood pact bonuses, corruption state, etc.
    const health_config = atree_mgd ? extract_health_config(atree_mgd) : null;
    const hp_casting = health_config?.hp_casting ?? false;
    // Precompute per-row recast penalty (build-independent, combo-sequence-dependent).
    // Workers need this for accurate mana tracking in both blood pact bonus computation
    // and the non-blood-pact mana budget check (_eval_combo_mana_check).
    // Replicates the recast penalty logic from simulate_spell_by_spell.
    {
        let _rc_last_base = null, _rc_consec = 0, _rc_penalty = 0;
        for (const row of parsed_combo) {
            // Pseudo-spell rows: Mana Reset resets recast state, others are skipped.
            if (row.pseudo) {
                if (row.pseudo === 'mana_reset' && !row.mana_excl) {
                    _rc_last_base = null; _rc_consec = 0; _rc_penalty = 0;
                }
                continue;
            }
            const { sim_qty, spell, mana_excl } = row;
            row.recast_penalty_per_cast = 0;
            if (!spell || sim_qty <= 0 || mana_excl || spell.cost == null) continue;
            const rc_base = spell.mana_derived_from ?? spell.base_spell;
            if (rc_base === 0) continue; // melee spells have no recast penalty

            let row_penalty = 0;
            let is_switch = false;
            if (rc_base !== _rc_last_base) {
                is_switch = true;
                if (_rc_consec <= 1) { _rc_penalty = 0; } else { _rc_penalty += 1; }
                _rc_consec = 0;
                _rc_last_base = rc_base;
            }
            if (is_switch && _rc_penalty > 0) {
                row_penalty = _rc_penalty * RECAST_MANA_PENALTY;
                _rc_penalty = 0;
                _rc_consec = 1;
                const remaining = sim_qty - 1;
                if (remaining > 0) {
                    const free_remaining = Math.min(remaining, 1);
                    const penalty_remaining = remaining - free_remaining;
                    if (penalty_remaining > 0) {
                        row_penalty += RECAST_MANA_PENALTY * penalty_remaining * (penalty_remaining + 1) / 2;
                        _rc_penalty = penalty_remaining;
                    }
                    _rc_consec += remaining;
                }
            } else if (_rc_penalty > 0) {
                row_penalty = RECAST_MANA_PENALTY * (sim_qty * _rc_penalty + sim_qty * (sim_qty + 1) / 2);
                _rc_penalty += sim_qty;
                _rc_consec += sim_qty;
            } else {
                const free_casts = Math.max(0, Math.min(sim_qty, 2 - _rc_consec));
                const penalty_casts = sim_qty - free_casts;
                if (penalty_casts > 0) {
                    row_penalty = RECAST_MANA_PENALTY * penalty_casts * (penalty_casts + 1) / 2;
                    _rc_penalty = penalty_casts;
                }
                _rc_consec += sim_qty;
            }
            row.recast_penalty_per_cast = sim_qty > 0 ? row_penalty / sim_qty : 0;
        }
    }

    // Build set of auto-filled slider names that must be stripped from parsed_combo
    // rows — workers compute these dynamically per candidate build.
    const auto_slider_names = new Set();
    if (hp_casting && health_config) {
        if (health_config.damage_boost?.slider_name)
            auto_slider_names.add(health_config.damage_boost.slider_name);
        for (const bs of health_config.buff_states)
            if (bs.slider_name) auto_slider_names.add(bs.slider_name);
    }
    if (auto_slider_names.size > 0) {
        for (const row of parsed_combo) {
            if (row.boost_tokens) {
                row.boost_tokens = row.boost_tokens.filter(t => t.manual || !auto_slider_names.has(t.name));
            }
        }
    }

    // Extract base spell costs for spells 1-4 (needed for final spell cost restrictions).
    // Prefer costs from parsed_combo (user's active spells) over spell_map defaults.
    const spell_base_costs = {};
    if (spell_map) {
        for (const [, spell] of spell_map) {
            if (spell.base_spell >= 1 && spell.base_spell <= 4 && spell.cost != null) {
                spell_base_costs[spell.base_spell] = spell.cost;
            }
        }
    }
    for (const row of parsed_combo) {
        if (row.spell?.base_spell >= 1 && row.spell?.base_spell <= 4 && row.spell.cost != null) {
            spell_base_costs[row.spell.base_spell] = row.spell.cost;
        }
    }

    // Serialize atree interactive state for workers
    const { button_states, slider_states } = _serialize_atree_interactive(atree_interactive_val);

    // Strip toggles that appear in the boost registry from button_states.
    // These toggles' stat bonuses are already applied per-row via
    // apply_combo_row_boosts; leaving them ON in button_states would cause
    // atree_compute_scaling to apply them a second time (double-counting).
    for (const entry of boost_registry) {
        if (entry.type === 'toggle') button_states.set(entry.name, false);
    }

    const weapon_sm = weapon?.statMap ?? new Map();

    return {
        weapon, weapon_sm, level, tomes, atree_raw, atree_mgd,
        static_boosts, radiance_boost, sp_budget,
        guild_tome_item, spell_map, boost_registry, parsed_combo,
        restrictions, button_states, slider_states, scoring_target,
        combo_time, allow_downtime, flat_mana, hp_casting, health_config, auto_slider_names: [...auto_slider_names], spell_base_costs,
    };
}

// ── Top-5 heap ────────────────────────────────────────────────────────────────

function _insert_top5(candidate) {
    // Dedup: if a build with the same item names already exists, keep the higher score
    const cand_names = candidate.items.map(i => i.statMap.get('name') ?? '').join(',');
    for (let i = 0; i < _solver_state.top5.length; i++) {
        const existing = _solver_state.top5[i];
        const ex_names = existing.items.map(i => i.statMap.get('name') ?? '').join(',');
        if (ex_names === cand_names) {
            if (candidate.score > existing.score) {
                _solver_state.top5[i] = candidate;
            }
            return;
        }
    }
    _solver_state.top5.push(candidate);
    _solver_state.top5.sort((a, b) => b.score - a.score);
    if (_solver_state.top5.length > _TOP_N) _solver_state.top5.length = _TOP_N;
}

// ── Seed build from current UI ─────────────────────────────────────────────
//
// Evaluate the currently entered build (all 8 slots) and, if it passes all
// solver constraints (SP, thresholds, mana), return a top-5 compatible result.
// This lets us preserve the user's manually entered build as the initial
// baseline so it isn't cleared when the solver starts.

function _eval_current_build(snap, restrictions) {
    // Collect all 8 item statMaps from the UI
    const items = [];
    const equip_sms = [];
    for (let i = 0; i < 8; i++) {
        const item = solver_item_final_nodes[i]?.value;
        items.push(item);
        // item.statMap always exists for graph-output Items; fallback constructs
        // an Item wrapper since raw none_items lack .statMap.
        equip_sms.push(item ? item.statMap : new Item(none_items[i]).statMap);
    }

    // Check that at least one non-NONE armor/accessory exists
    const has_any = equip_sms.some(sm => !sm.has('NONE'));
    if (!has_any) { console.warn('[seed] rejected: no non-NONE items'); return null; }

    // Build statMap using worker_shims (same path as the search worker)
    const fixed_sms = [snap.weapon_sm];
    for (const tome of snap.tomes) {
        if (tome && !tome.statMap.has('NONE')) fixed_sms.push(tome.statMap);
    }
    for (const sm of equip_sms) {
        if (!sm.has('NONE')) fixed_sms.push(sm);
    }
    const running_sm = _init_running_statmap(snap.level, fixed_sms);

    // Compute activeSetCounts
    const activeSetCounts = new Map();
    for (const sm of equip_sms) {
        if (sm.has('NONE')) continue;
        const setName = sm.get('set');
        if (setName) activeSetCounts.set(setName, (activeSetCounts.get(setName) ?? 0) + 1);
    }

    const all_equip_sms = [...equip_sms, ...snap.tomes.map(t => t?.statMap).filter(Boolean), snap.weapon_sm];
    const build_sm = _finalize_leaf_statmap(running_sm, snap.weapon_sm, activeSetCounts, sets, all_equip_sms);

    // SP calculation — use the UI's SP values when available (from
    // _solver_sp_override, which is set from URL-decoded greedy SP or a
    // previous solver result).  This ensures the seed evaluates the build
    // with the same SPs the user sees in the stat display / mana panel.
    // Falling back to calculate_skillpoints only when no override exists.
    let base_sp, total_sp, assigned_sp;
    if (_solver_sp_override?.total_sp) {
        base_sp  = [..._solver_sp_override.base_sp];
        total_sp = [..._solver_sp_override.total_sp];
        assigned_sp = _solver_sp_override.assigned_sp ?? base_sp.reduce((a, b) => a + b, 0);
    } else {
        const sp_equip = [...equip_sms, snap.guild_tome_item.statMap];
        const sp_result = calculate_skillpoints(sp_equip, snap.weapon_sm, snap.sp_budget);
        if (!sp_result) { console.warn('[seed] rejected: SP infeasible'); return null; }
        base_sp  = sp_result[0];
        total_sp = sp_result[1];
        assigned_sp = sp_result[2];
    }

    // Assemble combo stats
    const combo_base = _assemble_baseline_combo(build_sm, total_sp, snap);

    // Threshold check
    if (restrictions.stat_thresholds?.length > 0) {
        const thresh_stats = _deep_clone_statmap(combo_base);
        let _def_cache = null;
        const _get_def = () => _def_cache ?? (_def_cache = getDefenseStats(thresh_stats));
        for (const { stat, op, value } of restrictions.stat_thresholds) {
            let v;
            if (stat === 'ehp') v = _get_def()[1]?.[0] ?? 0;
            else if (stat === 'ehp_no_agi') v = _get_def()[1]?.[1] ?? 0;
            else if (stat === 'total_hp') v = _get_def()[0] ?? 0;
            else if (stat === 'ehpr') v = _get_def()[3]?.[0] ?? 0;
            else if (stat === 'hpr') v = _get_def()[2] ?? 0;
            else if (stat.startsWith('finalSpellCost')) {
                const spell_num = parseInt(stat.charAt(stat.length - 1));
                const base_cost = snap.spell_base_costs?.[spell_num];
                if (base_cost == null) continue;
                v = getSpellCost(thresh_stats, { cost: base_cost, base_spell: spell_num });
            } else {
                v = thresh_stats.get(stat) ?? 0;
            }
            if (op === 'ge' && v < value) { console.warn(`[seed] rejected: threshold ${stat} ${op} ${value}, got ${v}`); return null; }
            if (op === 'le' && v > value) { console.warn(`[seed] rejected: threshold ${stat} ${op} ${value}, got ${v}`); return null; }
        }
    }

    // Mana / HP check (mirrors worker's _eval_combo_mana_check)
    if (snap.hp_casting) {
        if (snap.health_config) {
            const has_transcendence = combo_base.get('activeMajorIDs')?.has('ARCANES') ?? false;
            const sim = simulate_combo_mana_hp(
                snap.parsed_combo, combo_base, snap.health_config, has_transcendence, snap.boost_registry);
            if (sim.row_results.some(r => r.hp_warning)) { console.warn('[seed] rejected: HP casting sim has hp_warning'); return null; }
        }
    } else if (snap.combo_time > 0) {
        let mana_cost = 0;
        let melee_hits = 0;
        for (const { sim_qty, spell, boost_tokens, mana_excl, recast_penalty_per_cast } of snap.parsed_combo) {
            if (mana_excl) continue;
            if (spell?.scaling === 'melee') melee_hits += sim_qty;
            if (spell == null || spell.cost == null) continue;
            // Apply per-row combo boosts (e.g. spell cost reductions) before computing cost.
            const { stats } = apply_combo_row_boosts(combo_base, boost_tokens, snap.boost_registry);
            mana_cost += (getSpellCost(stats, spell) + (recast_penalty_per_cast ?? 0)) * sim_qty;
        }
        if (combo_base.get('activeMajorIDs')?.has('ARCANES')) mana_cost *= 0.75;
        const mr = combo_base.get('mr') ?? 0;
        const ms = combo_base.get('ms') ?? 0;
        const item_mana = combo_base.get('maxMana') ?? 0;
        const int_mana = Math.floor(skillPointsToPercentage(combo_base.get('int') ?? 0) * 100);
        const start_mana = 100 + item_mana + int_mana;
        const mana_regen = ((mr + BASE_MANA_REGEN) / 5) * snap.combo_time;
        let mana_steal = 0;
        if (ms && melee_hits > 0) {
            let adjAtkSpd = attackSpeeds.indexOf(combo_base.get('atkSpd'))
                + (combo_base.get('atkTier') ?? 0);
            adjAtkSpd = Math.max(0, Math.min(6, adjAtkSpd));
            mana_steal = melee_hits * ms / 3 / baseDamageMultiplier[adjAtkSpd];
        }
        const flat_mana = snap.flat_mana ?? 0;
        const end_mana = start_mana - mana_cost + mana_regen + mana_steal + flat_mana;
        if (snap.allow_downtime) {
            if (end_mana <= 0) { console.warn('[seed] rejected: mana depleted (downtime mode), end_mana:', end_mana); return null; }
        } else {
            if ((start_mana - end_mana) > 5) { console.warn('[seed] rejected: mana deficit too high:', start_mana - end_mana); return null; }
        }
    }

    // Score
    const score = _sensitivity_eval_score(combo_base, snap);

    return {
        score,
        items: items.map((it, i) => it ?? new Item(none_items[i])),
        base_sp: [...base_sp],
        total_sp: [...total_sp],
        assigned_sp,
    };
}

/**
 * Merge top-5 results from all workers into _solver_state.top5.
 * When include_interim is true, also includes each worker's in-flight
 * partition results (_cur_top5) — used during progress updates and
 * when stopping mid-search.
 */
function _merge_worker_top5(workers, include_interim) {
    _solver_state.top5 = [];
    // Re-insert the seed build so it competes with worker results
    if (_solver_state.seed_build) _insert_top5(_solver_state.seed_build);
    for (const w of workers) {
        const sources = include_interim
            ? [w.top5 ?? [], w._cur_top5 ?? []]
            : [w.top5 ?? []];
        for (const src of sources) {
            for (const r of src) {
                if (!r.item_names) continue;
                const items = _reconstruct_result_items(r.item_names);
                const merged = {
                    score: r.score,
                    items,
                    base_sp: r.base_sp ?? [0, 0, 0, 0, 0],
                    total_sp: r.total_sp ?? [0, 0, 0, 0, 0],
                    assigned_sp: r.assigned_sp ?? 0,
                };
                if (r._debug_combo_base) merged._debug_combo_base = r._debug_combo_base;
                _insert_top5(merged);
            }
        }
    }
    // Detect changes to merged top-N for stability tracking
    const fp = _solver_state.top5.map(r =>
        r.score.toFixed(4) + '|' + r.items.map(i => i.statMap.get('name') ?? '').join(',')
    ).join(';');
    if (fp !== _solver_state._prev_topN_fingerprint) {
        _solver_state._prev_topN_fingerprint = fp;
        _solver_state.last_topN_change = Date.now();
    }
}

/**
 * Format a number in compact form: 1.2 K, 3.4 Mil, 5.6 Bil, etc.
 */
function _format_compact(n) {
    if (n < 1000) return n.toLocaleString();
    const suffixes = ['', 'K', 'Mil', 'Bil', 'Tril', 'Quad', 'Quin'];
    let tier = 0;
    let v = n;
    while (v >= 1000 && tier < suffixes.length - 1) { v /= 1000; tier++; }
    // Show one decimal place, but drop trailing .0
    const s = v.toFixed(1);
    const display = s.endsWith('.0') ? s.slice(0, -2) : s;
    return `${display} ${suffixes[tier]}`;
}

// ── Solver target metadata ─────────────────────────────────────────────────

const SOLVER_TARGET_LABELS = {
    combo_damage: '',
    ehp: 'EHP: ',
    ehpr: 'EHPR: ',
    total_healing: 'Healing: ',
    spd: 'Walk Speed: ',
    poison: 'Poison: ',
    lb: 'Loot Bonus: ',
    xpb: 'XP Bonus: ',
};

function _format_solver_score(score, target) {
    const prefix = SOLVER_TARGET_LABELS[target] ?? (target + ': ');
    return prefix + Math.round(score).toLocaleString();
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function _format_duration(total_s) {
    total_s = Math.max(0, Math.floor(total_s));
    const SECS_PER_YEAR = 31557600;  // 365.25 days
    const mill = Math.floor(total_s / (SECS_PER_YEAR * 1000));
    const rem_mill = total_s % (SECS_PER_YEAR * 1000);
    const c = Math.floor(rem_mill / (SECS_PER_YEAR * 100));
    const rem_c = rem_mill % (SECS_PER_YEAR * 100);
    const y = Math.floor(rem_c / SECS_PER_YEAR);
    const rem_y = rem_c % SECS_PER_YEAR;
    const w = Math.floor(rem_y / 604800);
    const rem_w = rem_y % 604800;
    const d = Math.floor(rem_w / 86400);
    const h = Math.floor((rem_w % 86400) / 3600);
    const m = Math.floor((rem_w % 3600) / 60);
    const s = rem_w % 60;
    if (mill > 0) return `${mill.toLocaleString()} millennia`;
    if (c > 0) return `${c}c ${y}y ${w}w`;
    if (y > 0) return `${y}y ${w}w ${d}d`;
    if (w > 0) return `${w}w ${d}d ${h}h`;
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

/**
 * Show the progress panel in stopped/completed state with a prefix label.
 */
function _show_solver_stopped_progress(label, elapsed_s) {
    const el = document.getElementById('solver-progress-text');
    el.style.display = '';
    const el_left = document.getElementById('solver-progress-left');
    const el_right = document.getElementById('solver-progress-right');
    if (el_left) el_left.textContent = `${label} - Checked: ${_format_compact(_solver_state.checked)} / ${_format_compact(_solver_state.total)}`;
    if (el_right) el_right.textContent = `Time: ${_format_duration(elapsed_s)}`;
    const el_feasible = document.getElementById('solver-feasible-count');
    if (el_feasible) el_feasible.textContent = _format_compact(_solver_state.feasible);
    const el_met_req = document.getElementById('solver-met-req-count');
    if (el_met_req) el_met_req.textContent = _format_compact(_solver_state.met_req);
    // Show remaining time estimate
    const el_remaining = document.getElementById('solver-remaining-text');
    const el_remaining_row = document.getElementById('solver-remaining-row');
    if (label === 'Stopped' && _solver_state.checked > 0 && _solver_state.total > _solver_state.checked) {
        const rate_ms = elapsed_s * 1000 / _solver_state.checked;
        const rem_s = Math.ceil(rate_ms * (_solver_state.total - _solver_state.checked) / 1000);
        if (el_remaining) el_remaining.textContent = 'Est. Remaining: ' + _format_duration(rem_s);
        if (el_remaining_row) el_remaining_row.style.display = '';
    } else {
        if (el_remaining) el_remaining.textContent = '';
        if (el_remaining_row) el_remaining_row.style.display = 'none';
    }
    // Restore expand state
    const details = document.getElementById('solver-progress-details');
    if (details) details.style.display = _solver_state.progress_expanded ? '' : 'none';
}

/** Set up the click-to-expand handler (called once at page load). */
function _init_solver_progress_toggle() {
    const header = document.getElementById('solver-progress-header');
    if (!header) return;
    const BG_HOVER = 'rgba(255, 255, 255, 0.12)';
    header.addEventListener('click', () => {
        _solver_state.progress_expanded = !_solver_state.progress_expanded;
        const details = document.getElementById('solver-progress-details');
        if (details) details.style.display = _solver_state.progress_expanded ? '' : 'none';
    });
    header.addEventListener('mouseenter', () => { header.style.backgroundColor = BG_HOVER; });
    header.addEventListener('mouseleave', () => { header.style.backgroundColor = ''; });
}

function _update_solver_progress_ui() {
    const el_left = document.getElementById('solver-progress-left');
    const el_right = document.getElementById('solver-progress-right');
    const el_feasible = document.getElementById('solver-feasible-count');
    const el_met_req = document.getElementById('solver-met-req-count');
    const el_remaining = document.getElementById('solver-remaining-text');
    const el_remaining_row = document.getElementById('solver-remaining-row');

    const now = Date.now();
    const elapsed_ms = now - _solver_state.start;
    const elapsed_str = _format_duration(elapsed_ms / 1000);
    const checked_str = `Checked: ${_format_compact(_solver_state.checked)} / ${_format_compact(_solver_state.total)}`;

    if (el_left) el_left.textContent = checked_str;
    if (el_right) el_right.textContent = elapsed_str;
    if (el_feasible) el_feasible.textContent = _format_compact(_solver_state.feasible);
    if (el_met_req) el_met_req.textContent = _format_compact(_solver_state.met_req);

    if (now - _solver_state.last_eta >= 1000) {
        _solver_state.last_eta = now;
        if (_solver_state.checked > 0 && _solver_state.total > _solver_state.checked) {
            const rate = elapsed_ms / _solver_state.checked;
            const remaining_s = Math.ceil(rate * (_solver_state.total - _solver_state.checked) / 1000);
            if (el_remaining) el_remaining.textContent = 'Est. Time: ' + _format_duration(remaining_s) + ' left';
            if (el_remaining_row) el_remaining_row.style.display = '';
        } else {
            if (el_remaining) el_remaining.textContent = '';
            if (el_remaining_row) el_remaining_row.style.display = 'none';
        }
    }
    // Verification phase detection — based on main-thread top-N change time
    {
        const time_since_change = now - _solver_state.last_topN_change;
        let min_L_ratio = 1.0;
        let any_active = false;
        for (const w of _solver_state.workers) {
            if (w.done) continue;
            any_active = true;
            const [L, Lmax] = w._cur_L_progress ?? [0, 1];
            min_L_ratio = Math.min(min_L_ratio, Lmax > 0 ? L / Lmax : 1.0);
        }
        const should_verify = any_active
            && _solver_state.top5.length > 0
            && elapsed_ms > 2000
            && time_since_change > 300_000
            && min_L_ratio > 0.10;
        _solver_state.verification_phase = should_verify;
        const el_status = document.getElementById('solver-status-msg');
        if (el_status) {
            const elapsed_s = elapsed_ms / 1000;
            const rate = elapsed_s > 0 ? _solver_state.checked / elapsed_s : 0;
            if (should_verify) {
                el_status.textContent = 'Top results possibly stable \u2014 exhaustive check in progress';
                el_status.className = 'text-info';
            } else if (elapsed_s > 20 && rate > 0 && rate < 1000) {
                el_status.innerHTML = '\u26A0 Very slow iteration \u2014 results may take a long time on this device';
                el_status.className = 'text-danger';
            } else {
                el_status.textContent = '';
            }
        }
    }

    // Every 5 s: merge interim top-5 from workers, refresh result panel and fill best build
    // Skip rebuild if no worker's interim top5 has changed since last merge.
    if (now - _solver_state.last_ui >= 5000) {
        _solver_state.last_ui = now;
        const any_top5_changed = _solver_state.workers.some(
            (w, i) => w._cur_top5 !== (_solver_state._last_merged_top5_refs?.[i]));
        if (any_top5_changed) {
            _merge_worker_top5(_solver_state.workers, true);
            _solver_state._last_merged_top5_refs = _solver_state.workers.map(w => w._cur_top5);
            if (_solver_state.top5.length > 0) {
                _fill_build_into_ui(_solver_state.top5[0]);
                _display_solver_results(_solver_state.top5);
            }
        }
    }

    // Live-update the "time since last update" counter when expanded
    if (_solver_state.top15_expanded) _update_top15_time_display();
}

// sfree URL persistence is now handled by the unified solver hash updater
// in solver_graph_build.js (_schedule_solver_hash_update / _do_solver_hash_update).

function _fill_build_into_ui(result) {
    // Store solver SP data so SolverSKPNode can show "Assign: X (+Y)" format
    // when the computation graph fires asynchronously.
    // Only set when real SP data is present (progress messages may lack it).
    _solver_sp_override = (result.base_sp && result.total_sp)
        ? { base_sp: result.base_sp, total_sp: result.total_sp, assigned_sp: result.assigned_sp ?? 0 }
        : null;
    _solver_filling_ui = true;
    _solver_free_mask = 0;
    let any_item_changed = false;
    for (let i = 0; i < 8; i++) {
        const slot = equipment_fields[i];
        const item = result.items[i];
        const hash = item.statMap.get('hash');
        const name = item.statMap.has('NONE') ? '' :
            (hash && (hash.slice(0, 3) === 'CI-' || hash.slice(0, 3) === 'CR-'))
                ? hash
                : (item.statMap.get('displayName') ?? item.statMap.get('name') ?? '');
        const input = document.getElementById(slot + '-choice');
        if (input) {
            if (input.value !== name) {
                input.dataset.solverFilled = 'true';
                _solver_free_mask |= (1 << i);
                input.value = name;
                input.dispatchEvent(new Event('change'));
                any_item_changed = true;
            } else if (input.dataset.solverFilled === 'true') {
                _solver_free_mask |= (1 << i);
            }
        }
    }
    _solver_filling_ui = false;
    _schedule_solver_hash_update();

    // When the SP override changed but no items changed, the graph won't
    // recompute on its own (no change events were dispatched).  Force a
    // recomputation so SolverBuildStatExtractNode and downstream nodes
    // pick up the new greedy SP values.
    if (!any_item_changed && _solver_sp_override && solver_build_node) {
        solver_build_node.mark_dirty(2).update();
    }
}

function _build_result_row(r, i, target) {
    const score_str = _format_solver_score(r.score, target);
    const item_names = r.items.map(item => {
        if (item.statMap.has('NONE')) return '\u2014';
        return item.statMap.get('displayName') ?? item.statMap.get('name') ?? '?';
    });
    const non_none = item_names.filter(n => n !== '\u2014');
    const names_str = non_none.length ? non_none.join(', ') : '(all empty)';
    const result_hash = solver_compute_result_hash(r);
    let new_tab_link = '';
    if (result_hash) {
        const url = new URL(window.location.href);
        const current_hash = window.location.hash.slice(1);
        const sep = current_hash.indexOf(SOLVER_HASH_SEP);
        url.hash = sep >= 0
            ? result_hash + current_hash.substring(sep)
            : result_hash;
        url.searchParams.delete('sfree');
        new_tab_link = `<a class="solver-result-newtab" href="${url.toString()}" ` +
            `target="_blank" title="Open in new tab" onclick="event.stopPropagation()">\u2197</a>`;
    }
    return `<div class="solver-result-row" title="${item_names.join(' | ')}" onclick="_fill_build_into_ui(_solver_state.top5[${i}])">` +
        `<span class="solver-result-rank">#${i + 1}</span>` +
        `<span class="solver-result-score">${score_str}</span>` +
        `<span class="solver-result-items small">${names_str}</span>` +
        new_tab_link +
        `</div>`;
}

function _display_solver_results(topN) {
    const panel = document.getElementById('solver-results-panel');
    if (!panel) return;
    if (!topN.length) { panel.innerHTML = ''; return; }
    const target = document.getElementById('solver-target')?.value ?? 'combo_damage';

    const visible = topN.slice(0, _TOP_N_DISPLAY);
    const extra = topN.slice(_TOP_N_DISPLAY);

    let html = '<div class="text-secondary small mb-1">Top builds \u2014 click to load:</div>';
    html += visible.map((r, i) => _build_result_row(r, i, target)).join('');

    if (extra.length > 0) {
        const expanded = _solver_state.top15_expanded;
        html += `<div id="solver-results-extra" style="display:${expanded ? 'block' : 'none'}">`;
        html += extra.map((r, i) => _build_result_row(r, i + _TOP_N_DISPLAY, target)).join('');
        html += '<div id="solver-top15-update-time" class="text-secondary small mt-1"></div>';
        html += '</div>';
        html += `<div class="solver-expand-toggle" onclick="_toggle_top15_expand()">`;
        html += expanded ? '\u25B4' : '\u25BE';
        html += '</div>';
    }

    panel.innerHTML = html;
    _display_priority_weights();
    if (_solver_state.top15_expanded) _update_top15_time_display();
}

function _toggle_top15_expand() {
    _solver_state.top15_expanded = !_solver_state.top15_expanded;
    const extra = document.getElementById('solver-results-extra');
    if (extra) extra.style.display = _solver_state.top15_expanded ? 'block' : 'none';
    const toggle = extra?.nextElementSibling;
    if (toggle && toggle.classList.contains('solver-expand-toggle')) {
        toggle.textContent = _solver_state.top15_expanded ? '\u25B4' : '\u25BE';
    }
    if (_solver_state.top15_expanded && _solver_state.running) _update_top15_time_display();
}

function _update_top15_time_display() {
    const el = document.getElementById('solver-top15-update-time');
    if (!el) return;
    if (!_solver_state.last_topN_change || !_solver_state.running) { el.textContent = ''; return; }
    const delta_s = Math.floor((Date.now() - _solver_state.last_topN_change) / 1000);
    el.textContent = 'Time since last update to top ' + _TOP_N + ': ' + _format_duration(delta_s);
}

// ── Priority weights display ─────────────────────────────────────────────────

const _ADV_TOP_N = 15;
const _STAT_LABEL_MAP = new Map(RESTRICTION_STATS.map(s => [s.key, s.label]));
const _SP_NAMES = ['Str', 'Dex', 'Int', 'Def', 'Agi'];

function _display_priority_weights() {
    const section = document.getElementById('solver-priority-section');
    const panel = document.getElementById('solver-priority-panel');
    if (!panel) return;

    const weights = _solver_state.dmg_weights;
    if (!solver_is_advanced() || !weights) {
        panel.innerHTML = '';
        if (section) section.style.display = 'none';
        return;
    }
    if (section) section.style.display = '';

    // Merge main weights + _priority_only into a single map for display
    const merged = new Map();
    for (const [stat, w] of weights) {
        if (typeof w !== 'number') continue;
        merged.set(stat, w);
    }
    if (weights._priority_only) {
        for (const [stat, w] of weights._priority_only) {
            merged.set(stat, (merged.get(stat) ?? 0) + w);
        }
    }

    // Top N stats by |weight|
    const entries = [...merged.entries()];
    entries.sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    const topN = entries.slice(0, _ADV_TOP_N);

    const stat_rows = topN.map(([stat, w]) => {
        const label = _STAT_LABEL_MAP.get(stat) ?? stat;
        return `<div class="adv-weight-row"><span class="adv-weight-label">${label}</span>`
            + `<span class="adv-weight-val">${Math.round(w)}</span></div>`;
    }).join('');

    // SP sensitivities
    const sp = weights._sp_sensitivities;
    const sp_rows = sp ? _SP_NAMES.map((name, i) =>
        `<span class="adv-sp-entry">${name}: ${Math.round(sp[i])}</span>`
    ).join('') : '';

    panel.innerHTML =
        `<div class="text-secondary small mt-2 mb-1">Priority Stats (top ${topN.length}):</div>`
        + stat_rows
        + (sp_rows ? `<div class="text-secondary small mt-2 mb-1">SP Sensitivities:</div>`
            + `<div class="adv-sp-row">${sp_rows}</div>` : '');
}

// ── Worker partitioning ───────────────────────────────────────────────────────

/**
 * Partition the search space across N workers.
 * Returns an array of partition descriptors.
 */
function _partition_work(pools, locked, num_workers) {
    const ring1_locked = !!locked.ring1;
    const ring2_locked = !!locked.ring2;
    const both_rings_free = !ring1_locked && !ring2_locked;

    // Both rings free: partition the outer ring index with triangular load balancing.
    // Outer index i iterates inner j from i to N-1, so work(i) = N - i.
    // Total work = N*(N+1)/2. We split into equal-work chunks.
    if (both_rings_free && pools.ring) {
        const n = pools.ring.length;
        if (n <= 1) return [{ type: 'ring', start: 0, end: n }];
        const total_work = n * (n + 1) / 2;
        const work_per_worker = total_work / num_workers;
        const partitions = [];
        let start = 0;
        let accum = 0;
        for (let w = 0; w < num_workers; w++) {
            const target = (w + 1) * work_per_worker;
            let end = start;
            while (end < n && accum + (n - end) <= target) {
                accum += (n - end);
                end++;
            }
            // Last worker gets the rest
            if (w === num_workers - 1) end = n;
            if (start < end) partitions.push({ type: 'ring', start, end });
            start = end;
            if (start >= n) break;
        }
        return partitions;
    }

    // One ring free: partition the ring pool
    if (pools.ring && (ring1_locked || ring2_locked)) {
        const n = pools.ring.length;
        const chunk = Math.ceil(n / num_workers);
        const partitions = [];
        for (let w = 0; w < num_workers; w++) {
            const start = w * chunk;
            const end = Math.min(start + chunk, n);
            if (start < end) partitions.push({ type: 'ring_single', start, end });
        }
        return partitions;
    }

    // Find largest free armor/accessory pool to partition
    let biggest_slot = null, biggest_size = 0;
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (pools[slot] && pools[slot].length > biggest_size) {
            biggest_slot = slot;
            biggest_size = pools[slot].length;
        }
    }

    if (!biggest_slot || biggest_size <= 1) return [{ type: 'full' }];

    const chunk = Math.ceil(biggest_size / num_workers);
    const partitions = [];
    for (let w = 0; w < num_workers; w++) {
        const start = w * chunk;
        const end = Math.min(start + chunk, biggest_size);
        if (start < end) partitions.push({ type: 'slot', slot: biggest_slot, start, end });
    }
    return partitions;
}

// ── Prepare serialized item data for worker ─────────────────────────────────

/**
 * Prepare item pool data for structured clone to worker.
 * Returns a plain object with statMap (Map, survives structured clone)
 * plus _illegalSet / _illegalSetName as top-level properties.
 * Note: arbitrary properties on Map instances are NOT preserved by structured clone,
 * so we wrap the statMap in a plain object.
 */
function _serialize_pool_item(item) {
    return {
        statMap: item.statMap,
        _illegalSet: item._illegalSet ?? null,
        _illegalSetName: item._illegalSetName ?? null,
    };
}

function _serialize_pools(pools) {
    const out = {};
    for (const [slot, pool] of Object.entries(pools)) {
        out[slot] = pool.map(item => _serialize_pool_item(item));
    }
    return out;
}

function _serialize_locked(locked) {
    const out = {};
    for (const [slot, item] of Object.entries(locked)) {
        out[slot] = _serialize_pool_item(item);
    }
    return out;
}

// ── Build worker init message ────────────────────────────────────────────────

// Pre-compute once (lazily, after items are loaded)
let _cached_none_sms = null;
let _cached_none_idx_map = null;

function _get_none_sms() {
    if (!_cached_none_sms) {
        _cached_none_sms = none_items.slice(0, 8).map(ni => new Item(ni).statMap);
        _cached_none_idx_map = {};
        for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'ring1', 'ring2', 'bracelet', 'necklace']) {
            _cached_none_idx_map[slot] = _NONE_ITEM_IDX[slot];
        }
    }
    return { none_item_sms: _cached_none_sms, none_idx_map: _cached_none_idx_map };
}

function _build_worker_init_msg(snap, pools_ser, locked_ser, ring_pool_ser, partition, worker_id) {
    const { none_item_sms, none_idx_map } = _get_none_sms();

    return {
        type: 'init',
        worker_id,
        // Search data
        pools: pools_ser,
        locked: locked_ser,
        weapon_sm: snap.weapon.statMap,
        level: snap.level,
        tome_sms: snap.tomes.map(t => t.statMap),
        guild_tome_sm: snap.guild_tome_item.statMap,
        sp_budget: snap.sp_budget,
        // Atree state
        atree_merged: snap.atree_mgd,
        atree_raw: snap.atree_raw,
        button_states: snap.button_states,
        slider_states: snap.slider_states,
        radiance_boost: snap.radiance_boost,
        static_boosts: snap.static_boosts,
        // Combo
        parsed_combo: snap.parsed_combo,
        boost_registry: snap.boost_registry,
        scoring_target: snap.scoring_target,
        combo_time: snap.combo_time,
        allow_downtime: snap.allow_downtime,
        flat_mana: snap.flat_mana,
        hp_casting: snap.hp_casting,
        health_config: snap.health_config,
        auto_slider_names: snap.auto_slider_names,
        spell_base_costs: snap.spell_base_costs,
        restrictions: snap.restrictions,
        // Global data
        sets_data: [...sets],
        // Ring
        ring_pool: ring_pool_ser,
        ring1_locked: locked_ser.ring1 ?? null,
        ring2_locked: locked_ser.ring2 ?? null,
        // Partition
        partition,
        // None items
        none_item_sms,
        none_idx_map,
    };
}

// ── Reconstruct Item instances from worker results ──────────────────────────

function _reconstruct_result_items(item_names) {
    return item_names.map((name, i) => {
        if (!name || name === '') {
            const it = new Item(none_items[i]);
            it.statMap.set('NONE', true);
            return it;
        }
        // Handle crafted/custom items (CR-/CI- hashes) that aren't in itemMap
        if (name.slice(0, 3) === 'CR-') {
            const craft = decodeCraft({ hash: name.substring(3) });
            if (craft) return _apply_roll_mode_to_item(craft);
        }
        if (name.slice(0, 3) === 'CI-') {
            const custom = decodeCustom({ hash: name.substring(3) });
            if (custom) return _apply_roll_mode_to_item(custom);
        }
        const item_obj = itemMap.get(name);
        if (!item_obj) {
            const it = new Item(none_items[i]);
            it.statMap.set('NONE', true);
            return it;
        }
        return _apply_roll_mode_to_item(new Item(item_obj));
    });
}

// ── Worker orchestration ────────────────────────────────────────────────────

function _stop_solver() {
    _solver_state.running = false;
    _solver_state.verification_phase = false;
    const _status_el = document.getElementById('solver-status-msg');
    if (_status_el) _status_el.textContent = '';
    // Snapshot final counts (cumulative + in-flight) before terminating
    _solver_state.checked = 0;
    _solver_state.feasible = 0;
    _solver_state.met_req = 0;
    for (const w of _solver_state.workers) {
        _solver_state.checked += w.checked + (w._cur_checked ?? 0);
        _solver_state.feasible += w.feasible + (w._cur_feasible ?? 0);
        _solver_state.met_req += w.met_req + (w._cur_met_req ?? 0);
    }
    // Terminate all workers
    for (const w of _solver_state.workers) {
        try { w.worker.terminate(); } catch (e) { }
    }
    _solver_state.workers = [];
    _solver_state.snap = null;
    _solver_state._last_merged_top5_refs = [];
    // Clear progress timer
    if (_solver_state.progress_timer) {
        clearInterval(_solver_state.progress_timer);
        _solver_state.progress_timer = 0;
    }
}

/**
 * Compute SP overflow diagnostics from current UI equipment.
 * Returns an array of warning strings for attributes where the required
 * base assignment exceeds the per-attribute cap (100).
 */
function _compute_sp_overflow_warnings() {
    const skp_names = ["Strength", "Dexterity", "Intelligence", "Defense", "Agility"];
    const warnings = [];

    // Gather equipment statMaps (8 equips + guild tome)
    const equip_sms = [];
    for (let i = 0; i < 8; i++) {
        const item = solver_item_final_nodes[i]?.value;
        equip_sms.push(item?.statMap ?? none_items[i].statMap);
    }
    const guild_tome_idx = tome_fields.indexOf('guildTome1');
    let gt_sm;
    const gt_node_val = (guild_tome_idx >= 0) ? solver_item_final_nodes[9 + guild_tome_idx]?.value : null;
    if (gt_node_val && !gt_node_val.statMap.has('NONE')) {
        gt_sm = gt_node_val.statMap;
    } else {
        // No specific tome — check restriction dropdown for rainbow synthetic
        const gtome_mode = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;
        if (gtome_mode === 2) {
            const synth = new Map();
            synth.set('skillpoints', [1, 1, 1, 1, 1]);
            synth.set('reqs', [0, 0, 0, 0, 0]);
            gt_sm = synth;
        } else {
            gt_sm = new Item(none_tomes[2]).statMap;
        }
    }
    equip_sms.push(gt_sm);

    const weapon = solver_item_final_nodes[8]?.value;
    if (!weapon || weapon.statMap.has('NONE')) return warnings;

    // SP budget: standard mode inflates budget, rainbow uses synthetic tome above
    let sp_overflow_budget = SP_TOTAL_CAP;
    if (!gt_node_val || gt_node_val.statMap.has('NONE')) {
        const gtome_mode = parseInt(document.getElementById('restr-guild-tome')?.value) || 0;
        if (gtome_mode === 1) sp_overflow_budget = SP_GUILD_TOME_STD;
    }

    const result = calculate_skillpoints(equip_sms, weapon.statMap, sp_overflow_budget);
    const assign = result[0];
    for (let i = 0; i < 5; i++) {
        if (assign[i] > SP_PER_ATTR_CAP) {
            warnings.push(`Cannot assign ${assign[i]} skillpoints in ${skp_names[i]} manually.`);
        }
    }
    return warnings;
}

/**
 * Debug re-evaluation: re-run the global top-1 build's combo damage on the
 * main thread with full row-by-row logging.  Uses the worker-saved combo_base
 * (statMap snapshot) so the output reflects exactly what the worker computed.
 * Called after _merge_worker_top5 when SOLVER_DEBUG_COMBO is true.
 */
function _debug_reeval_top1() {
    const top1 = _solver_state.top5[0];
    const combo_base = top1?._debug_combo_base;
    const snap = _solver_state.snap;
    if (!combo_base || !snap) return;

    const item_names = top1.items.map(it =>
        it.statMap.get('displayName') ?? it.statMap.get('name') ?? '').filter(n => n);
    console.log('[COMBO-DEBUG][SOLVER] ═══ Re-evaluating global top-1 with debug logging ═══');
    console.log('[COMBO-DEBUG][SOLVER] items:', item_names.join(', '));
    console.log('[COMBO-DEBUG][SOLVER] score:', top1.score);

    const crit = skillPointsToPercentage(combo_base.get('dex') || 0);
    let damage_rows = snap.parsed_combo;

    if (snap.hp_casting && snap.health_config) {
        const has_transcendence = combo_base.get('activeMajorIDs')?.has('ARCANES') ?? false;
        const sim = simulate_combo_mana_hp(
            snap.parsed_combo, combo_base, snap.health_config, has_transcendence, snap.boost_registry);

        console.log('[COMBO-DEBUG][SOLVER] sim results:', JSON.stringify(sim.row_results.map((r, i) => ({
            row: i, bp_bonus: Math.round(r.blood_pact_bonus * 100) / 100,
            states: r.state_values, hp_warn: r.hp_warning,
        }))));
        console.log('[COMBO-DEBUG][SOLVER] sim end_mana:', sim.end_mana,
            'end_hp:', Math.round(sim.end_hp), 'max_hp:', sim.max_hp,
            'start_mana:', sim.start_mana);

        const hc = snap.health_config;
        const bp_name = hc.damage_boost?.slider_name ?? null;
        const state_slider_names = {};
        for (const bs of (hc.buff_states ?? [])) {
            if (bs.slider_name) state_slider_names[bs.state_name] = bs.slider_name;
        }

        damage_rows = [];
        for (let i = 0; i < snap.parsed_combo.length; i++) {
            const row = snap.parsed_combo[i];
            const res = sim.row_results[i];
            const extra = [];
            const _has_manual = (n) => row.boost_tokens.some(t => t.manual && t.name === n);
            if (res.blood_pact_bonus > 0 && bp_name && !_has_manual(bp_name)) {
                extra.push({ name: bp_name, value: Math.round(res.blood_pact_bonus * 10) / 10, is_pct: true });
            }
            for (const [state_name, slider_name] of Object.entries(state_slider_names)) {
                const val = res.state_values?.[state_name] ?? 0;
                if (val > 0 && !_has_manual(slider_name)) extra.push({ name: slider_name, value: Math.round(val), is_pct: false });
            }
            if (extra.length === 0) { damage_rows.push(row); continue; }
            damage_rows.push({ ...row, boost_tokens: [...row.boost_tokens, ...extra] });
        }
    }

    compute_combo_damage_totals(
        combo_base, snap.weapon.statMap, damage_rows, crit,
        snap.boost_registry, snap.atree_mgd,
        { detailed: false, debug: true, debug_label: '[SOLVER]' });
}

function _on_all_workers_done(workers_snapshot) {
    const search_completed = _solver_state.running;  // true only if finished naturally
    const elapsed_s = Math.floor((Date.now() - _solver_state.start) / 1000);

    // Aggregate final stats before stopping (which clears _solver_state.workers)
    _solver_state.checked = 0;
    _solver_state.feasible = 0;
    _solver_state.met_req = 0;
    for (const w of workers_snapshot) {
        _solver_state.checked += w.checked;
        _solver_state.feasible += w.feasible;
        _solver_state.met_req += w.met_req;
    }

    _merge_worker_top5(workers_snapshot, false);

    // Debug combo re-evaluation: re-run global top-1 with full logging on main thread
    if (SOLVER_DEBUG_COMBO && _solver_state.top5.length > 0) {
        _debug_reeval_top1();
    }

    _stop_solver();

    // UI updates
    const _run_btn = document.getElementById('solver-run-btn');
    _run_btn.textContent = 'Solve';
    _run_btn.className = 'btn btn-sm btn-outline-success flex-grow-1';
    const _status_el = document.getElementById('solver-status-msg');
    if (_status_el) _status_el.textContent = '';

    // Show progress panel in stopped state
    _show_solver_stopped_progress(search_completed ? 'Solved' : 'Stopped', elapsed_s);
    _display_solver_results(_solver_state.top5);
    if (_solver_state.top5.length > 0) {
        _fill_build_into_ui(_solver_state.top5[0]);
    } else if (search_completed) {
        const panel = document.getElementById('solver-results-panel');
        if (panel) {
            if (_solver_state.feasible === 0) {
                let html = '<div class="text-warning small">'
                    + 'No builds satisfied the skill point requirements. Try relaxing restrictions or enabling guild tomes.';
                const sp_warnings = _compute_sp_overflow_warnings();
                for (const w of sp_warnings) {
                    html += `<br>${w}`;
                }
                html += '</div>';
                panel.innerHTML = html;
            } else {
                panel.innerHTML = '<div class="text-warning small">'
                    + 'No builds met the stat thresholds. Try lowering the restriction values.</div>';
            }
        }
    }
}

function _run_solver_search_workers(pools, locked, snap) {
    // Determine thread count
    const thread_sel = document.getElementById('solver-thread-count');
    const thread_val = thread_sel?.value ?? 'auto';
    const num_workers = thread_val === 'auto'
        ? Math.max(1, Math.min((navigator.hardwareConcurrency || 4) - 2, 16))
        : parseInt(thread_val);

    // Serialize pools and locked items
    const pools_ser = _serialize_pools(pools);
    const locked_ser = _serialize_locked(locked);
    const ring_pool_ser = pools_ser.ring ?? [];

    // Create fine-grained partitions for work-stealing (4× worker count)
    const num_partitions = Math.max(num_workers * 4, num_workers);
    const partitions = _partition_work(pools, locked, num_partitions);
    console.log('[solver]', partitions.length, 'partitions for', num_workers, 'workers (level-enum)');

    // Work-stealing queue (plain partitions)
    const partition_queue = [...partitions];
    let next_partition_id = 0;
    let active_count = 0;

    _solver_state.workers = [];

    function _insert_wstate_top5(wstate, entry) {
        wstate.top5.push(entry);
        wstate.top5.sort((a, b) => b.score - a.score);
        if (wstate.top5.length > _TOP_N) wstate.top5.length = _TOP_N;
    }

    // Send a lightweight 'run' message for subsequent partitions (no heavy data)
    function _dispatch_next(wstate) {
        if (partition_queue.length === 0 || !_solver_state.running) return false;
        const partition = partition_queue.shift();
        wstate.done = false;
        wstate._cur_checked = 0;
        wstate._cur_feasible = 0;
        wstate._cur_met_req = 0;
        wstate._cur_top5 = [];
        wstate._cur_checked_since_top5 = 0;
        wstate._cur_L_progress = [0, 1];
        wstate.worker.postMessage({
            type: 'run',
            partition,
            worker_id: next_partition_id++,
        });
        active_count++;
        return true;
    }

    function _on_partition_done(wstate, msg) {
        wstate.done = true;
        // Accumulate into cumulative totals
        wstate.checked += msg.checked;
        wstate.feasible += msg.feasible;
        wstate.met_req += msg.met_req ?? 0;
        wstate._cur_checked = 0;
        wstate._cur_feasible = 0;
        wstate._cur_met_req = 0;
        wstate._cur_top5 = [];
        wstate._cur_checked_since_top5 = 0;
        wstate._cur_L_progress = [0, 1];
        // Merge this partition's top5 into worker's cumulative top5
        for (const r of msg.top5) {
            _insert_wstate_top5(wstate, r);
        }
        active_count--;

        // Try to give this worker more work
        if (!_dispatch_next(wstate)) {
            // No more work — check if all workers are idle
            if (active_count === 0) {
                _on_all_workers_done(_solver_state.workers);
            }
        }
    }

    // Store snap for post-search debug re-evaluation
    _solver_state.snap = snap;

    // Build the heavy init message once (without partition — added per-worker below)
    const init_base = _build_worker_init_msg(snap, pools_ser, locked_ser, ring_pool_ser, null, 0);

    // Spawn workers: send heavy 'init' with first partition, then 'run' for subsequent
    const actual_workers = Math.min(num_workers, partitions.length);
    for (let i = 0; i < actual_workers; i++) {
        const w = new Worker('../js/solver/engine/worker.js?v=4');
        const wstate = {
            worker: w, done: true, checked: 0, feasible: 0, met_req: 0, top5: [],
            _cur_checked: 0, _cur_feasible: 0, _cur_met_req: 0, _cur_top5: [],
            _cur_checked_since_top5: 0, _cur_L_progress: [0, 1],
        };
        _solver_state.workers.push(wstate);

        w.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'progress') {
                wstate._cur_checked = msg.checked;
                wstate._cur_feasible = msg.feasible;
                wstate._cur_met_req = msg.met_req ?? 0;
                if (msg.top5_names) wstate._cur_top5 = msg.top5_names;
                if (msg.checked_since_top5 !== undefined) wstate._cur_checked_since_top5 = msg.checked_since_top5;
                if (msg.L_progress) wstate._cur_L_progress = msg.L_progress;
            } else if (msg.type === 'done') {
                _on_partition_done(wstate, msg);
            }
        };

        w.onerror = (err) => {
            console.error('[solver] worker error:', err);
            wstate.done = true;
            active_count--;
            if (active_count === 0 && partition_queue.length === 0) {
                _on_all_workers_done(_solver_state.workers);
            }
        };

        // Send heavy init with first partition included
        const first_partition = partition_queue.shift();
        const init_msg = Object.assign({}, init_base, {
            partition: first_partition,
            worker_id: next_partition_id++,
        });
        wstate.done = false;
        wstate._cur_checked = 0;
        wstate._cur_feasible = 0;
        wstate._cur_met_req = 0;
        wstate._cur_top5 = [];
        w.postMessage(init_msg);
        active_count++;
    }

    // Start progress timer
    _solver_state.progress_timer = setInterval(() => {
        if (!_solver_state.running) return;
        // Aggregate stats: cumulative completed + current in-flight partition
        _solver_state.checked = 0;
        _solver_state.feasible = 0;
        _solver_state.met_req = 0;
        for (const w of _solver_state.workers) {
            _solver_state.checked += w.checked + (w._cur_checked ?? 0);
            _solver_state.feasible += w.feasible + (w._cur_feasible ?? 0);
            _solver_state.met_req += w.met_req + (w._cur_met_req ?? 0);
        }
        _update_solver_progress_ui();
    }, 500);
}

// ── Top-level orchestrator ────────────────────────────────────────────────────

function toggle_solver() {
    if (_solver_state.running) {
        // Save worker references before _stop_solver clears them
        const saved_workers = [..._solver_state.workers];
        const elapsed_s = Math.floor((Date.now() - _solver_state.start) / 1000);
        _stop_solver();
        const btn = document.getElementById('solver-run-btn');
        btn.textContent = 'Solve';
        btn.className = 'btn btn-sm btn-outline-success flex-grow-1';
        const _status_el = document.getElementById('solver-status-msg');
        if (_status_el) _status_el.textContent = '';
        // Show stopped summary in progress panel
        _show_solver_stopped_progress('Stopped', elapsed_s);
        // Reconstruct and display any top-5 results we have
        // Include both cumulative (completed partitions) and interim (in-flight partition)
        _merge_worker_top5(saved_workers, true);
        _display_solver_results(_solver_state.top5);
        if (_solver_state.top5.length > 0) _fill_build_into_ui(_solver_state.top5[0]);
        return;
    }
    start_solver_search();
}

function start_solver_search() {
    const restrictions = get_restrictions();
    const snap = _build_solver_snapshot(restrictions);

    // Validate pre-conditions
    const err_el = document.getElementById('solver-error-text');
    if (err_el) err_el.textContent = '';

    if (!snap.weapon || snap.weapon.statMap.has('NONE')) {
        if (err_el) err_el.textContent = 'Set a weapon before solving.';
        return;
    }
    const _combo_required = snap.scoring_target === 'combo_damage' || snap.scoring_target === 'total_healing';
    if (_combo_required && snap.parsed_combo.length === 0) {
        if (err_el) err_el.textContent = 'Add combo rows with spells before solving.';
        return;
    }

    // Illegal sets
    const illegal_at_2 = new Set();
    for (const [setName, setData] of sets) {
        if (setData.bonuses?.length >= 2 && setData.bonuses[1]?.illegal) {
            illegal_at_2.add(setName);
        }
    }

    const blacklist = get_blacklist();
    const locked = _collect_locked_items(illegal_at_2);
    const pools = _build_item_pools(restrictions, illegal_at_2, blacklist);

    // Remove pools for locked slots
    if (locked.ring1 && locked.ring2) delete pools.ring;
    for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
        if (locked[slot]) delete pools[slot];
    }

    // If any locked item belongs to an exclusive set, remove all other items
    // from that set from the remaining pools (they can never be used).
    const locked_exclusive_sets = new Set();
    for (const item of Object.values(locked)) {
        const is = item?._illegalSet;
        if (is) locked_exclusive_sets.add(is);
    }
    if (locked_exclusive_sets.size > 0) {
        let excl_pruned = 0;
        for (const [slot, pool] of Object.entries(pools)) {
            const before = pool.length;
            pools[slot] = pool.filter(it =>
                it.statMap.has('NONE') || !locked_exclusive_sets.has(it._illegalSet)
            );
            excl_pruned += before - pools[slot].length;
        }
        if (excl_pruned > 0) {
            console.log(`[solver] exclusive-set lock pruned ${excl_pruned} items (sets: ${[...locked_exclusive_sets].join(', ')})`);
        }
    }

    console.log('[solver] free pool sizes:', Object.fromEntries(
        Object.entries(pools).map(([k, v]) => [k, v.length])
    ));

    // Pre-compute sensitivity-based weights for pruning and priority sorting.
    const dmg_weights = _build_dmg_weights(snap, locked, pools);
    _solver_state.dmg_weights = dmg_weights;
    _display_priority_weights();

    // Remove dominated items before sorting; smaller pools benefit search and sort.
    const dominance_stats = _build_dominance_stats(snap, dmg_weights, restrictions);
    _prune_dominated_items(pools, dominance_stats);

    // Sort each pool by damage/constraint relevance so level-0 visits the
    // best build first. NONE items are moved to the end of each pool.
    _prioritize_pools(pools, dmg_weights);

    // Compute total candidate count
    {
        let total = 1;
        for (const slot of ['helmet', 'chestplate', 'leggings', 'boots', 'bracelet', 'necklace']) {
            if (pools[slot]) total *= pools[slot].length;
        }
        if (pools.ring) {
            const n = pools.ring.length;
            if (!locked.ring1 && !locked.ring2) {
                total *= n * (n + 1) / 2;
            } else {
                total *= n;
            }
        }
        _solver_state.total = Math.round(total);
    }

    // Evaluate the current UI build as a seed — if it passes all constraints
    // it stays as top-1 until workers find something better.
    _solver_state.seed_build = _eval_current_build(snap, restrictions);
    if (_solver_state.seed_build) {
        console.log('[solver] seeded current build as baseline, score:', _solver_state.seed_build.score);
    }

    _solver_state.running = true;
    _solver_state.top5 = [];
    if (_solver_state.seed_build) _insert_top5(_solver_state.seed_build);
    _solver_state.checked = 0;
    _solver_state.feasible = 0;
    _solver_state.met_req = 0;
    _solver_state.start = Date.now();
    _solver_state.last_ui = Date.now();
    _solver_state.last_eta = Date.now();

    _solver_state.verification_phase = false;
    _solver_state.last_topN_change = Date.now();
    _solver_state._prev_topN_fingerprint = '';
    _solver_state.top15_expanded = false;
    _solver_state.progress_expanded = false;
    const _status_el = document.getElementById('solver-status-msg');
    if (_status_el) _status_el.textContent = '';

    const _run_btn = document.getElementById('solver-run-btn');
    _run_btn.textContent = 'Stop';
    _run_btn.className = 'btn btn-sm btn-outline-danger flex-grow-1';
    const _prog_el = document.getElementById('solver-progress-text');
    _prog_el.style.display = '';
    // Reset details to collapsed
    const _details_el = document.getElementById('solver-progress-details');
    if (_details_el) _details_el.style.display = 'none';
    const _remaining_row = document.getElementById('solver-remaining-row');
    if (_remaining_row) _remaining_row.style.display = 'none';

    _run_solver_search_workers(pools, locked, snap);
}
