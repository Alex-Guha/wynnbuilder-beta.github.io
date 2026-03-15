// ── State ─────────────────────────────────────────────────────────────────────

const _solver_state = {
    running: false,
    top5: [],              // [{score, items:[Item×8], base_sp, total_sp, assigned_sp}]
    checked: 0,
    feasible: 0,
    start: 0,
    last_ui: 0,
    total: 0,
    last_eta: 0,
    workers: [],           // [{worker, done, checked, feasible, top5}]
    progress_timer: 0,     // setInterval handle
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
    const rows = solver_combo_total_node._read_combo_rows(aug);
    return rows
        .map(r => {
            // Pseudo-spells: include as marker rows for worker state tracking.
            const spell_id = parseInt(r.dom_row?.querySelector('.combo-row-spell')?.value);
            if (spell_id === CANCEL_BAKALS_SPELL_ID) {
                const mana_excl = r.dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false;
                return { pseudo: 'cancel_bakals', mana_excl };
            }
            if (spell_id === MANA_RESET_SPELL_ID) {
                const mana_excl = r.dom_row?.querySelector('.combo-mana-toggle')
                    ?.classList.contains('mana-excluded') ?? false;
                return { pseudo: 'mana_reset', mana_excl };
            }

            const entry = {
                qty: r.qty,
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
        slider_states.set(name, parseInt(entry.slider?.value ?? '0'));
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

    const sp_budget = restrictions.guild_tome === 2 ? SP_GUILD_TOME_RARE :
        restrictions.guild_tome === 1 ? SP_GUILD_TOME_STD : SP_TOTAL_CAP;

    const guild_tome_idx = tome_fields.indexOf('guildTome1');
    const guild_tome_item = (guild_tome_idx >= 0 && solver_item_final_nodes[9 + guild_tome_idx]?.value)
        ? solver_item_final_nodes[9 + guild_tome_idx].value
        : new Item(none_tomes[2]);

    const spell_map = atree_collect_spells.value ?? new Map();
    const boost_registry = build_combo_boost_registry(atree_mgd, solver_build_node.value);
    const parsed_combo = _parse_combo_for_search(spell_map, weapon);

    const scoring_target = document.getElementById('solver-target')?.value ?? 'combo_damage';

    const combo_time_str = document.getElementById('combo-time')?.value?.trim() ?? '';
    const combo_time = parseFloat(combo_time_str) || 0;
    const allow_downtime = document.getElementById('combo-downtime-btn')?.classList.contains('toggleOn') ?? false;
    const flat_mana = parseFloat(document.getElementById('flat-mana-input')?.value) || 0;

    // Blood Pact: when active, spells are paid with HP, so skip mana gating in workers.
    // Also extract health_config so workers can dynamically compute per-candidate
    // blood pact bonuses instead of using frozen values from the current build.
    let hp_casting = false;
    let health_config = null;
    if (atree_mgd) {
        for (const [, abil] of atree_mgd) {
            if (abil.properties?.health_cost != null) { hp_casting = true; break; }
        }
    }
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
            const { qty, spell, mana_excl } = row;
            row.recast_penalty_per_cast = 0;
            if (!spell || qty <= 0 || mana_excl || spell.cost == null) continue;
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
                const remaining = qty - 1;
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
                row_penalty = RECAST_MANA_PENALTY * (qty * _rc_penalty + qty * (qty + 1) / 2);
                _rc_penalty += qty;
                _rc_consec += qty;
            } else {
                const free_casts = Math.max(0, Math.min(qty, 2 - _rc_consec));
                const penalty_casts = qty - free_casts;
                if (penalty_casts > 0) {
                    row_penalty = RECAST_MANA_PENALTY * penalty_casts * (penalty_casts + 1) / 2;
                    _rc_penalty = penalty_casts;
                }
                _rc_consec += qty;
            }
            row.recast_penalty_per_cast = qty > 0 ? row_penalty / qty : 0;
        }
    }

    let corruption_slider_name = null;
    if (hp_casting) {
        health_config = extract_health_config(atree_mgd);
        // Strip calculated (Blood Pact) boost tokens from parsed_combo rows —
        // the worker computes these dynamically per candidate build based on
        // that build's mana pool, rather than using the frozen snapshot value.
        const strip_names = new Set(
            boost_registry.filter(e => e.type === 'calculated').map(e => e.name));

        // Also strip auto-filled Corrupted slider tokens when corruption is active —
        // corruption % depends on per-build blood pact HP costs, so it must be
        // recomputed dynamically in the worker just like Blood Pact bonus.
        if (health_config.corruption.active) {
            for (const entry of boost_registry) {
                if (entry.type === 'slider' && entry.name === 'Corrupted') {
                    corruption_slider_name = entry.name;
                    strip_names.add(entry.name);
                    break;
                }
            }
        }

        for (const row of parsed_combo) {
            if (row.boost_tokens) {
                row.boost_tokens = row.boost_tokens.filter(t => !strip_names.has(t.name));
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

    const weapon_sm = weapon?.statMap ?? new Map();

    return {
        weapon, weapon_sm, level, tomes, atree_raw, atree_mgd,
        static_boosts, radiance_boost, sp_budget,
        guild_tome_item, spell_map, boost_registry, parsed_combo,
        restrictions, button_states, slider_states, scoring_target,
        combo_time, allow_downtime, flat_mana, hp_casting, health_config, corruption_slider_name, spell_base_costs,
    };
}

// ── Top-5 heap ────────────────────────────────────────────────────────────────

function _insert_top5(candidate) {
    _solver_state.top5.push(candidate);
    _solver_state.top5.sort((a, b) => b.score - a.score);
    if (_solver_state.top5.length > 5) _solver_state.top5.length = 5;
}

/**
 * Merge top-5 results from all workers into _solver_state.top5.
 * When include_interim is true, also includes each worker's in-flight
 * partition results (_cur_top5) — used during progress updates and
 * when stopping mid-search.
 */
function _merge_worker_top5(workers, include_interim) {
    _solver_state.top5 = [];
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
}

/**
 * Format the solver summary status text shown after completion or stop.
 */
function _format_solver_summary(completed, elapsed_s) {
    if (completed) {
        return `Solved \u2014 Checked: ${_solver_state.checked.toLocaleString()}, Feasible: ${_solver_state.feasible.toLocaleString()}, Time: ${_format_duration(elapsed_s)}`;
    }
    const rate_ms = _solver_state.checked > 0 ? (elapsed_s * 1000 / _solver_state.checked) : 0;
    const rem_s = rate_ms > 0 ? Math.ceil(rate_ms * (_solver_state.total - _solver_state.checked) / 1000) : null;
    const rem_str = rem_s !== null ? `, Est. Remaining: ${_format_duration(rem_s)}` : '';
    return `Stopped \u2014 Checked: ${_solver_state.checked.toLocaleString()} / ${_solver_state.total.toLocaleString()}, Feasible: ${_solver_state.feasible.toLocaleString()}, Time: ${_format_duration(elapsed_s)}${rem_str}`;
}

// ── Solver target metadata ─────────────────────────────────────────────────

const SOLVER_TARGET_LABELS = {
    combo_damage: '',
    ehp: 'EHP: ',
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
    const d = Math.floor(total_s / 86400);
    const h = Math.floor((total_s % 86400) / 3600);
    const m = Math.floor((total_s % 3600) / 60);
    const s = total_s % 60;
    if (d > 0) return `${d}d ${h}h ${m}m ${s}s`;
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function _update_solver_progress_ui() {
    const el_checked = document.getElementById('solver-checked-count');
    const el_feasible = document.getElementById('solver-feasible-count');
    const el_elapsed = document.getElementById('solver-elapsed-text');
    const el_total = document.getElementById('solver-total-count');
    const el_remaining = document.getElementById('solver-remaining-text');
    if (el_checked) el_checked.textContent = _solver_state.checked.toLocaleString();
    if (el_feasible) el_feasible.textContent = _solver_state.feasible.toLocaleString();
    if (el_total) el_total.textContent = _solver_state.total.toLocaleString();
    const now = Date.now();
    const elapsed_ms = now - _solver_state.start;
    if (el_elapsed) el_elapsed.textContent = _format_duration(elapsed_ms / 1000);

    if (now - _solver_state.last_eta >= 1000) {
        _solver_state.last_eta = now;
        const el_warn = document.getElementById('solver-eta-warning');
        if (_solver_state.checked > 0 && _solver_state.total > _solver_state.checked) {
            const rate = elapsed_ms / _solver_state.checked;
            const remaining_s = Math.ceil(rate * (_solver_state.total - _solver_state.checked) / 1000);
            if (el_remaining) el_remaining.textContent = _format_duration(remaining_s) + ' left';
            if (el_warn) el_warn.style.display = remaining_s > 1200 ? '' : 'none';
        } else {
            if (el_remaining) el_remaining.textContent = '';
            if (el_warn) el_warn.style.display = 'none';
        }
    }
    // Every 5 s: merge interim top-5 from workers, refresh result panel and fill best build
    if (now - _solver_state.last_ui >= 5000) {
        _solver_state.last_ui = now;
        _merge_worker_top5(_solver_state.workers, true);
        if (_solver_state.top5.length > 0) {
            _fill_build_into_ui(_solver_state.top5[0]);
            _display_solver_results(_solver_state.top5);
        }
    }
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
        const name = item.statMap.has('NONE') ? '' :
            (item.statMap.get('displayName') ?? item.statMap.get('name') ?? '');
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

function _display_solver_results(top5) {
    const panel = document.getElementById('solver-results-panel');
    if (!panel) return;
    if (!top5.length) { panel.innerHTML = ''; return; }
    const target = document.getElementById('solver-target')?.value ?? 'combo_damage';
    const rows = top5.map((r, i) => {
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
            // Preserve solver params (combo, restrictions, roll, etc.) from the
            // current hash.  The full hash format is <build_b64>_<solver_b64>.
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
    }).join('');
    panel.innerHTML =
        `<div class="text-secondary small mb-1">Top builds \u2014 click to load:</div>` + rows;
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
        corruption_slider_name: snap.corruption_slider_name,
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
            const craft = decodeCraft({hash: name.substring(3)});
            if (craft) return _apply_roll_mode_to_item(craft);
        }
        if (name.slice(0, 3) === 'CI-') {
            const custom = decodeCustom({hash: name.substring(3)});
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
    // Snapshot final counts (cumulative + in-flight) before terminating
    _solver_state.checked = 0;
    _solver_state.feasible = 0;
    for (const w of _solver_state.workers) {
        _solver_state.checked += w.checked + (w._cur_checked ?? 0);
        _solver_state.feasible += w.feasible + (w._cur_feasible ?? 0);
    }
    // Terminate all workers
    for (const w of _solver_state.workers) {
        try { w.worker.terminate(); } catch (e) { }
    }
    _solver_state.workers = [];
    _solver_state.snap = null;
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
    const gt_item = (guild_tome_idx >= 0 && solver_item_final_nodes[9 + guild_tome_idx]?.value)
        ? solver_item_final_nodes[9 + guild_tome_idx].value
        : new Item(none_tomes[2]);
    equip_sms.push(gt_item.statMap);

    const weapon = solver_item_final_nodes[8]?.value;
    if (!weapon || weapon.statMap.has('NONE')) return warnings;

    const result = calculate_skillpoints(equip_sms, weapon.statMap);
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
            corruption: Math.round(r.corruption_pct), hp_warn: r.hp_warning,
        }))));
        console.log('[COMBO-DEBUG][SOLVER] sim end_mana:', sim.end_mana,
            'end_hp:', Math.round(sim.end_hp), 'max_hp:', sim.max_hp,
            'start_mana:', sim.start_mana);

        // Compute bp_entry_name from boost_registry (same logic as worker init)
        let bp_name = null;
        for (const entry of snap.boost_registry) {
            if (entry.type === 'calculated' && entry.calc_key === 'blood_pact') {
                bp_name = entry.name; break;
            }
        }
        const corr_name = snap.corruption_slider_name;

        damage_rows = [];
        for (let i = 0; i < snap.parsed_combo.length; i++) {
            const row = snap.parsed_combo[i];
            const res = sim.row_results[i];
            const has_bp = res.blood_pact_bonus > 0 && bp_name;
            const has_corr = corr_name && res.corruption_pct > 0;
            if (!has_bp && !has_corr) { damage_rows.push(row); continue; }
            const extra = [];
            if (has_bp) extra.push({ name: bp_name, value: Math.round(res.blood_pact_bonus * 10) / 10, is_pct: true });
            if (has_corr) extra.push({ name: corr_name, value: Math.round(res.corruption_pct), is_pct: false });
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
    for (const w of workers_snapshot) {
        _solver_state.checked += w.checked;
        _solver_state.feasible += w.feasible;
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
    document.getElementById('solver-progress-text').style.display = 'none';
    const _warn_el = document.getElementById('solver-eta-warning');
    if (_warn_el) _warn_el.style.display = 'none';

    const _sum_el = document.getElementById('solver-summary-text');
    if (_sum_el) {
        _sum_el.textContent = _format_solver_summary(search_completed, elapsed_s);
    }

    _update_solver_progress_ui();
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
        ? Math.min(navigator.hardwareConcurrency || 4, 16)
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
        if (wstate.top5.length > 5) wstate.top5.length = 5;
    }

    // Send a lightweight 'run' message for subsequent partitions (no heavy data)
    function _dispatch_next(wstate) {
        if (partition_queue.length === 0 || !_solver_state.running) return false;
        const partition = partition_queue.shift();
        wstate.done = false;
        wstate._cur_checked = 0;
        wstate._cur_feasible = 0;
        wstate._cur_top5 = [];
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
        wstate._cur_checked = 0;
        wstate._cur_feasible = 0;
        wstate._cur_top5 = [];
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
        const w = new Worker('../js/solver/engine/worker.js?v=3');
        const wstate = {
            worker: w, done: true, checked: 0, feasible: 0, top5: [],
            _cur_checked: 0, _cur_feasible: 0, _cur_top5: [],
        };
        _solver_state.workers.push(wstate);

        w.onmessage = (e) => {
            const msg = e.data;
            if (msg.type === 'progress') {
                wstate._cur_checked = msg.checked;
                wstate._cur_feasible = msg.feasible;
                if (msg.top5_names) wstate._cur_top5 = msg.top5_names;
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
        for (const w of _solver_state.workers) {
            _solver_state.checked += w.checked + (w._cur_checked ?? 0);
            _solver_state.feasible += w.feasible + (w._cur_feasible ?? 0);
        }
        _update_solver_progress_ui();
    }, 500);
}

// ── Top-level orchestrator ────────────────────────────────────────────────────

function toggle_solver() {
    if (_solver_state.running) {
        // Save worker references before _stop_solver clears them
        const saved_workers = [..._solver_state.workers];
        _stop_solver();
        const btn = document.getElementById('solver-run-btn');
        btn.textContent = 'Solve';
        btn.className = 'btn btn-sm btn-outline-success flex-grow-1';
        document.getElementById('solver-progress-text').style.display = 'none';
        const _warn_el = document.getElementById('solver-eta-warning');
        if (_warn_el) _warn_el.style.display = 'none';
        // Show stopped summary
        const elapsed_s = Math.floor((Date.now() - _solver_state.start) / 1000);
        const _sum_el = document.getElementById('solver-summary-text');
        if (_sum_el) {
            _sum_el.textContent = _format_solver_summary(false, elapsed_s);
        }
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

    _solver_state.running = true;
    _solver_state.top5 = [];
    _solver_state.checked = 0;
    _solver_state.feasible = 0;
    _solver_state.start = Date.now();
    _solver_state.last_ui = Date.now();
    _solver_state.last_eta = Date.now();

    const _sum_el = document.getElementById('solver-summary-text');
    if (_sum_el) _sum_el.textContent = '';
    const _warn_el = document.getElementById('solver-eta-warning');
    if (_warn_el) _warn_el.style.display = 'none';

    const _run_btn = document.getElementById('solver-run-btn');
    _run_btn.textContent = 'Stop';
    _run_btn.className = 'btn btn-sm btn-outline-danger flex-grow-1';
    document.getElementById('solver-progress-text').style.display = '';

    _run_solver_search_workers(pools, locked, snap);
}
