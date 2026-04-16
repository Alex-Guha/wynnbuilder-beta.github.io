// ── Sensitivity — weight pipeline + augmentation + public entry ─────────────
//
// Core sensitivity algorithm (perturb each stat, measure score change), the
// constraint/mana augmentation step, the legacy fallback used when the
// baseline score is zero, and the public `_build_dmg_weights` entry point
// consumed by search.js.
//
// Dependencies (loaded before this file):
//   - priority/helpers.js:              _CONSTRAINT_WEIGHT_FRACTION,
//       _MANA_WEIGHT_FRACTION, _MANA_RATIO_EXPONENT, _SP_SENSITIVITY_DAMPEN,
//       _SP_FEASIBILITY_SCALE, _INDIRECT_CONSTRAINT_STATS,
//       _INDIRECT_CONTRIBUTORS, _INDIRECT_SENS_SCALE,
//       _INDIRECT_SP_CONTRIBUTORS, _eval_indirect_stat, _item_stat_val,
//       _PERTURBABLE_STATS, _DEFAULT_DELTAS, _estimate_mana_balance,
//       _estimate_mana_tight
//   - priority/sensitivity_baseline.js: _sensitivity_eval_score,
//       _build_baseline_statmap, _assemble_baseline_combo,
//       _greedy_sp_alloc_main, _compute_pool_deltas
//   - build_utils.js:  skp_order
//
// Debug toggles: SOLVER_DEBUG_SENSITIVITY (defined in js/solver/debug_toggles.js)

// ── Step 8: Core sensitivity computation ────────────────────────────────────

/**
 * Compute sensitivity weights by building a baseline, perturbing each stat,
 * and measuring the change in the scoring target.
 *
 * Returns a Map of stat → sensitivity weight, with:
 *   - ._sp_sensitivities: [5] array of SP provision sensitivities
 *   - ._priority_only: Map of mana stats → weight (when mana is tight)
 * Returns null to signal fallback to legacy weights.
 */
function _compute_sensitivity_weights(snap, locked, pools) {
    const t0 = performance.now();
    const target = snap.scoring_target ?? 'combo_dps';

    // 1. Build baseline statMap from locked items
    const build_sm = _build_baseline_statmap(snap, locked);

    // 2. Greedy SP allocation
    const { total_sp, assigned_sp } = _greedy_sp_alloc_main(build_sm, snap, locked);

    // 3. Assemble combo stats
    const combo_base = _assemble_baseline_combo(build_sm, total_sp, snap);

    // 4. Baseline score & perturbation
    const baseline_score = _sensitivity_eval_score(combo_base, snap);

    // 5. Pool-calibrated deltas
    const { deltas, sp_deltas } = _compute_pool_deltas(pools);

    // 6. Fallback check: zero baseline for combo_dps means no damage at all
    //    (e.g. no combo rows, or weapon does 0 damage). Other targets (spd, poison)
    //    can legitimately start at 0 with few locked items.
    if (baseline_score === 0 && target === 'combo_dps') {
        if (SOLVER_DEBUG_SENSITIVITY) {
            console.log('[solver][sensitivity] baseline combo_dps = 0, falling back to legacy weights');
        }
        return null;
    }

    const weights = new Map();

    // ── Fast-tier perturbation: perturb combo_base directly ─────────────
    for (const stat of _PERTURBABLE_STATS) {
        const delta = deltas.get(stat);
        if (!delta || delta === 0) continue;

        const old = combo_base.get(stat) ?? 0;
        combo_base.set(stat, old + delta);
        const perturbed_score = _sensitivity_eval_score(combo_base, snap);
        combo_base.set(stat, old); // restore

        const sensitivity = (perturbed_score - baseline_score) / delta;
        if (sensitivity !== 0) {
            weights.set(stat, sensitivity);
        }
    }

    // ── Slow-tier perturbation: SP provisions ───────────────────────────
    const sp_sensitivities = [0, 0, 0, 0, 0];
    for (let i = 0; i < 5; i++) {
        const delta = sp_deltas[i];
        if (!delta || delta === 0) continue;

        const trial_sp = [...total_sp];
        trial_sp[i] += delta;
        const trial_combo = _assemble_baseline_combo(build_sm, trial_sp, snap);
        const perturbed_score = _sensitivity_eval_score(trial_combo, snap);
        sp_sensitivities[i] = (perturbed_score - baseline_score) / delta * _SP_SENSITIVITY_DAMPEN;
    }

    weights._sp_sensitivities = sp_sensitivities;

    // ── SP feasibility bonus ─────────────────────────────────────────
    // When item requirements (locked + pool) exceed the SP budget, SP
    // provisions from free items are essential for build feasibility.
    // Each SP index gets its own independent sensitivity derived from its
    // demand, added on top of the score-based sensitivity (which may be
    // near zero for stats like agi that don't affect the scoring target).
    {
        // Per-index max requirement across all items (locked + weapon + pools).
        // SP is global: if any item needs 125 agi, you need ≥125 agi total.
        const max_req = [0, 0, 0, 0, 0];
        for (const item of Object.values(locked)) {
            if (!item || item.statMap.has('NONE')) continue;
            const reqs = item.statMap.get('reqs');
            if (reqs) for (let i = 0; i < 5; i++) {
                if (reqs[i] > max_req[i]) max_req[i] = reqs[i];
            }
        }
        const w_reqs = snap.weapon_sm.get('reqs');
        if (w_reqs) for (let i = 0; i < 5; i++) {
            if (w_reqs[i] > max_req[i]) max_req[i] = w_reqs[i];
        }
        for (const pool of Object.values(pools)) {
            for (const item of pool) {
                if (item.statMap.has('NONE')) continue;
                const reqs = item.statMap.get('reqs');
                if (reqs) for (let i = 0; i < 5; i++) {
                    if (reqs[i] > max_req[i]) max_req[i] = reqs[i];
                }
            }
        }

        // Subtract locked items' + weapon's SP provisions (offset requirement burden)
        const locked_prov = [0, 0, 0, 0, 0];
        for (const item of Object.values(locked)) {
            if (!item || item.statMap.has('NONE')) continue;
            const skp = item.statMap.get('skillpoints');
            if (skp) for (let i = 0; i < 5; i++) locked_prov[i] += Math.max(0, skp[i]);
        }
        const w_skp = snap.weapon_sm.get('skillpoints');
        if (w_skp) for (let i = 0; i < 5; i++) locked_prov[i] += Math.max(0, w_skp[i]);

        const net_demand = [0, 0, 0, 0, 0];
        let demand_sum = 0;
        for (let i = 0; i < 5; i++) {
            net_demand[i] = Math.max(0, max_req[i] - locked_prov[i]);
            demand_sum += net_demand[i];
        }

        const deficit = demand_sum - snap.sp_budget;
        if (deficit > 0) {
            // Compute max impact from current stat weights for scaling reference.
            // Uses per-item impact (sensitivity × delta) so stats with small
            // deltas (atkTier=1) don't dominate over stats with large deltas.
            let local_max_abs = 1.0;
            for (const [stat, w] of weights) {
                const d = deltas.get(stat) ?? _DEFAULT_DELTAS[stat] ?? 1;
                const impact = Math.abs(w) * d;
                if (impact > local_max_abs) local_max_abs = impact;
            }

            // Each SP index gets an independent feasibility sensitivity
            // proportional to its share of total demand.  The scale constant
            // controls how strongly SP items compete with damage items.
            // local_max_abs is impact-based, so divide by SP delta to get
            // per-unit sensitivity.
            const pressure = Math.min(deficit / snap.sp_budget, 3.0);
            for (let i = 0; i < 5; i++) {
                if (net_demand[i] > 0) {
                    const eff_sp_delta = sp_deltas[i] || 10;
                    sp_sensitivities[i] += local_max_abs * pressure
                        * (net_demand[i] / demand_sum) * _SP_FEASIBILITY_SCALE
                        / eff_sp_delta;
                }
            }
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] SP feasibility: demand=${demand_sum}, budget=${snap.sp_budget}, deficit=${deficit}, pressure=${pressure.toFixed(3)}`);
                console.log(`  net_demand:`, net_demand, 'sp_sens after:', sp_sensitivities.map((s, i) =>
                    `${skp_order[i]}: ${s.toFixed(4)}`));
            }
        }
    }

    if (SOLVER_DEBUG_SENSITIVITY) {
        const elapsed = (performance.now() - t0).toFixed(1);
        console.groupCollapsed(`[solver][sensitivity] computed in ${elapsed}ms (target: ${target})`);

        // Baseline summary
        const key_stats = ['hp', 'hpBonus', 'str', 'dex', 'int', 'def', 'agi',
            'sdPct', 'sdRaw', 'mdPct', 'mdRaw', 'damPct', 'damRaw', 'critDamPct',
            'mr', 'ms', 'atkTier'];
        const baseline_summary = {};
        for (const k of key_stats) {
            const v = combo_base.get(k);
            if (v != null && v !== 0) baseline_summary[k] = v;
        }
        console.log('baseline stats:', baseline_summary);
        console.log('baseline score:', baseline_score);
        console.log('total SP:', [...total_sp], 'assigned:', assigned_sp);

        // Sensitivities sorted by |magnitude|
        const sorted = [...weights.entries()]
            .filter(([k]) => typeof k === 'string')
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log('stat sensitivities (sorted by |magnitude|):');
        for (const [stat, sens] of sorted) {
            console.log(`  ${stat}: ${sens.toFixed(4)} (delta: ${deltas.get(stat)})`);
        }
        console.log('SP sensitivities:', sp_sensitivities.map((s, i) =>
            `${skp_order[i]}: ${s.toFixed(4)} (delta: ${sp_deltas[i]})`));

        console.groupEnd();
    }

    return { weights, baseline_score, combo_base, deltas, sp_deltas, total_sp, build_sm };
}

// ── Step 9: Constraint & mana weight integration ────────────────────────────

/**
 * Augment sensitivity weights with constraint bonuses and mana sustainability hints.
 */
function _augment_sensitivity_weights(result, snap, restrictions, pools) {
    const { weights, combo_base, deltas, sp_deltas, total_sp, build_sm } = result;

    // Compute max per-item impact (sensitivity × delta) for bonus scaling.
    // Using impact instead of raw per-unit sensitivity prevents stats with
    // tiny deltas (atkTier, delta=1) from dominating max_abs and inflating
    // all augmentation bonuses — critical for DPS scoring where atkTier's
    // per-unit sensitivity is disproportionately large.
    let max_abs = 1.0;
    for (const [stat, w] of weights) {
        const d = deltas.get(stat) ?? _DEFAULT_DELTAS[stat] ?? 1;
        const impact = Math.abs(w) * d;
        if (impact > max_abs) max_abs = impact;
    }

    // ── Restriction thresholds (ge constraints on direct stats) ─────────
    for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
        if (op !== 'ge' || _INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        const current = combo_base.get(stat) ?? 0;
        const deficit = value - current;
        if (deficit > 0) {
            // max_abs is impact-based (per-item), so divide by stat_delta
            // to get a per-unit bonus.  This naturally normalizes across
            // stats with different magnitudes (atkTier ~1 vs damPct ~20).
            const stat_delta = deltas.get(stat) || _DEFAULT_DELTAS[stat] || 1;
            // When threshold is positive, scale by deficit/threshold (fractional shortfall).
            // When threshold <= 0 (e.g. mainAttackRange >= 0 with negative current),
            // use deficit/stat_delta instead (how many typical items of deficit).
            const scale = value > 0 ? (deficit / value) : (deficit / stat_delta);
            const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * scale / stat_delta;
            weights.set(stat, (weights.get(stat) ?? 0) + bonus);
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] constraint bonus: ${stat} += ${bonus.toFixed(2)} (deficit: ${deficit.toFixed(0)} / threshold: ${value}, delta: ${stat_delta})`);
            }
        }
    }

    // ── Indirect constraint sensitivity (ehp, ehpr, total_hp, hpr) ───────
    // These stats are computed from the full build via getDefenseStats(), so
    // we can't just read them from the statMap. Instead, perturb each
    // contributing direct stat and measure the indirect stat's response.
    for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
        if (!_INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        if (op !== 'ge') continue;
        if (!_INDIRECT_CONTRIBUTORS[stat]) continue;  // e.g. finalSpellCost — handled separately

        const baseline_val = _eval_indirect_stat(combo_base, stat);
        const deficit = value - baseline_val;
        if (deficit <= 0) continue;  // already met by baseline

        const contributors = _INDIRECT_CONTRIBUTORS[stat];
        for (const cstat of contributors) {
            const delta = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
            const old = combo_base.get(cstat) ?? 0;
            combo_base.set(cstat, old + delta);
            const perturbed_val = _eval_indirect_stat(combo_base, stat);
            combo_base.set(cstat, old);  // restore

            const indirect_sens = (perturbed_val - baseline_val) / delta;
            if (indirect_sens <= 0) continue;

            const stat_delta = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
            const scale = value > 0 ? (deficit / value) : (deficit / stat_delta);
            const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * scale / stat_delta * _INDIRECT_SENS_SCALE * indirect_sens;
            weights.set(cstat, (weights.get(cstat) ?? 0) + bonus);
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] indirect constraint bonus (${stat}): ${cstat} += ${bonus.toFixed(2)} (deficit: ${deficit.toFixed(0)} / threshold: ${value}, sens: ${indirect_sens.toFixed(4)}, delta: ${stat_delta})`);
            }
        }

        // ── SP provision sensitivity for def/agi → EHP/EHPR ─────────────
        // Items providing def/agi SP improve EHP via skillPointsToPercentage,
        // but the direct-stat perturbation above doesn't capture this.
        const sp_indices = _INDIRECT_SP_CONTRIBUTORS[stat];
        if (sp_indices && sp_deltas && total_sp && build_sm) {
            for (const si of sp_indices) {
                const sp_delta = sp_deltas[si] || 10;
                const trial_sp = [...total_sp];
                trial_sp[si] += sp_delta;
                const trial_combo = _assemble_baseline_combo(build_sm, trial_sp, snap);
                const perturbed_val = _eval_indirect_stat(trial_combo, stat);

                const sp_sens = (perturbed_val - baseline_val) / sp_delta;
                if (sp_sens <= 0) continue;

                const eff_sp_delta = sp_deltas[si] || 10;
                const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * (deficit / value)
                    * _INDIRECT_SENS_SCALE * sp_sens * _SP_SENSITIVITY_DAMPEN
                    / eff_sp_delta;
                weights._sp_sensitivities[si] += bonus;
                if (SOLVER_DEBUG_SENSITIVITY) {
                    console.log(`[solver][sensitivity] indirect SP constraint bonus (${stat}): ${skp_order[si]} += ${bonus.toFixed(2)} (deficit: ${deficit.toFixed(0)} / threshold: ${value}, sp_sens: ${sp_sens.toFixed(4)})`);
                }
            }
        }
    }

    // ── Mana sustainability (combo_time > 0, not hp_casting) ────────────
    // Uses locked items' mr/ms/int/maxMana via combo_base for accurate deficit.
    const mana_tight = _estimate_mana_tight(snap, combo_base);
    if (mana_tight) {
        if (!weights._priority_only) weights._priority_only = new Map();

        const bal = _estimate_mana_balance(snap, combo_base);
        const deficit = bal.total_cost - bal.start_mana - bal.regen_mana - bal.ms_mana;
        // ratio_raw can exceed 1.0 when negative mr/ms from locked items pushes
        // the deficit well beyond total spell cost.  The sqrt exponent dampens
        // extreme values naturally (e.g. ratio_raw=9 → ratio=3).
        const ratio_raw = bal.total_cost > 0 ? Math.max(0, deficit / bal.total_cost) : 0;
        const ratio = Math.pow(ratio_raw, _MANA_RATIO_EXPONENT);
        const mana_bonus = max_abs * _MANA_WEIGHT_FRACTION * ratio;

        const has_melee = (snap.parsed_combo ?? []).some(r => (r.spell?.scaling ?? 'spell') === 'melee');
        if (mana_bonus > 0) {
            // mana_bonus is impact-based; divide by each target stat's delta
            // to produce per-unit weights for priority scoring.
            const delta_mr = deltas.get('mr') ?? _DEFAULT_DELTAS.mr ?? 1;
            const delta_ms = deltas.get('ms') ?? _DEFAULT_DELTAS.ms ?? 1;
            const delta_maxMana = deltas.get('maxMana') ?? _DEFAULT_DELTAS.maxMana ?? 1;
            weights._priority_only.set('mr', (weights._priority_only.get('mr') ?? 0) + mana_bonus / delta_mr);
            if (has_melee) {
                weights._priority_only.set('ms', (weights._priority_only.get('ms') ?? 0) + mana_bonus * 0.5 / delta_ms);
            }
            weights._priority_only.set('maxMana', (weights._priority_only.get('maxMana') ?? 0) + mana_bonus * 0.3 / delta_maxMana);
            // Boost int SP sensitivity for mana
            const sp_delta_int = sp_deltas[2] || 10;
            weights._sp_sensitivities[2] += mana_bonus * 0.5 / sp_delta_int; // int is index 2

            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] mana bonus: ratio_raw=${ratio_raw.toFixed(3)}, ratio=${ratio.toFixed(3)}, mr+=${mana_bonus.toFixed(2)}` +
                    (has_melee ? `, ms+=${(mana_bonus * 0.5).toFixed(2)}` : ', ms=0 (no melee)'));
            }

            // ── Spell cost reduction bonuses ─────────────────────────
            // Weight spRaw/spPct by cast frequency relative to mr's mana value.
            const mr_equiv = Math.max((snap.combo_time ?? 0) / 5, 1);
            const casts_by_spell = new Map(); // base_spell_num → { total_casts, base_cost }
            for (const { sim_qty, spell, mana_excl } of (snap.parsed_combo ?? [])) {
                if (mana_excl || !spell || spell.cost == null) continue;
                const bs = spell.mana_derived_from ?? spell.base_spell;
                if (!bs) continue;
                const entry = casts_by_spell.get(bs);
                if (entry) {
                    entry.total_casts += sim_qty;
                } else {
                    casts_by_spell.set(bs, { total_casts: sim_qty, base_cost: spell.cost });
                }
            }

            for (const [bs, { total_casts, base_cost }] of casts_by_spell) {
                const raw_key = 'spRaw' + bs;
                const pct_key = 'spPct' + bs;

                // -1 spRaw saves total_casts mana; -1% spPct saves ~base_cost*total_casts/100
                const raw_ratio = Math.min(total_casts / mr_equiv, 3.0);
                const pct_ratio = Math.min(base_cost * total_casts / 100 / mr_equiv, 3.0);

                // Negative weight: items have negative values (cost reduction),
                // so negative × negative = positive score contribution.
                // Divide by target delta to convert impact-based mana_bonus to per-unit.
                const delta_spRaw = deltas.get(raw_key) ?? _DEFAULT_DELTAS[raw_key] ?? 1;
                const delta_spPct = deltas.get(pct_key) ?? _DEFAULT_DELTAS[pct_key] ?? 1;
                weights._priority_only.set(raw_key,
                    (weights._priority_only.get(raw_key) ?? 0) - mana_bonus * raw_ratio / delta_spRaw);
                weights._priority_only.set(pct_key,
                    (weights._priority_only.get(pct_key) ?? 0) - mana_bonus * pct_ratio / delta_spPct);
            }

            if (SOLVER_DEBUG_SENSITIVITY && casts_by_spell.size > 0) {
                const parts = [];
                for (const [bs, { total_casts, base_cost }] of casts_by_spell) {
                    const raw_r = Math.min(total_casts / mr_equiv, 3.0);
                    const pct_r = Math.min(base_cost * total_casts / 100 / mr_equiv, 3.0);
                    parts.push(`spell${bs}: casts=${total_casts}, cost=${base_cost}, ` +
                        `spRaw${bs}=${(-mana_bonus * raw_r).toFixed(2)}, spPct${bs}=${(-mana_bonus * pct_r).toFixed(2)}`);
                }
                console.log(`[solver][sensitivity] spell cost bonuses: ${parts.join('; ')}`);
            }
        }
    }

    // ── atkTier mana adjustment from pool ms ────────────────────────────
    // Higher atkTier increases baseDamageMultiplier divisor in ms_per_hit,
    // reducing mana steal per hit (ms > 0) or mana drain per hit (ms < 0).
    // The DPS sensitivity ignores this because combo_dps = damage/cycle_time
    // doesn't involve mana.  But the worker rejects mana-unsustainable builds,
    // so atkTier's mana cost/benefit must be reflected in its weight.
    //
    // This runs independently of the mana_tight block above, because baseline
    // ms may be 0 (no ms items locked) while pool items bring significant ms.
    {
        const target = snap.scoring_target ?? 'combo_dps';
        const has_melee = (snap.parsed_combo ?? []).some(
            r => (r.spell?.scaling ?? 'spell') === 'melee');

        if (has_melee && target === 'combo_dps' && combo_base && pools) {
            // Compute corrected ms from pool medians
            const pool_ms_medians = [];
            for (const pool of Object.values(pools)) {
                const slot_ms = [];
                for (const item of pool) {
                    if (item.statMap.has('NONE')) continue;
                    const ms_v = _item_stat_val(item.statMap, 'ms');
                    if (ms_v !== 0) slot_ms.push(ms_v);
                }
                if (slot_ms.length >= 2) {
                    slot_ms.sort((a, b) => a - b);
                    const mid = slot_ms.length >> 1;
                    pool_ms_medians.push(slot_ms.length & 1
                        ? slot_ms[mid] : (slot_ms[mid - 1] + slot_ms[mid]) / 2);
                }
            }
            const pool_ms_total = pool_ms_medians.reduce((a, b) => a + b, 0);

            // Apply restriction constraints on ms
            let ms_correction = pool_ms_total;
            for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
                if (stat !== 'ms') continue;
                if (op === 'le' && value <= 0 && ms_correction > 0) ms_correction = 0;
                if (op === 'ge' && value >= 0 && ms_correction < 0) ms_correction = 0;
            }

            const baseline_ms = combo_base.get('ms') ?? 0;
            const corrected_ms = baseline_ms + ms_correction;

            if (corrected_ms !== 0) {
                const atkTier_delta = deltas.get('atkTier') ?? 1;
                const baseAtkSpd = attackSpeeds.indexOf(combo_base.get('atkSpd'));
                const cur_atkTier = combo_base.get('atkTier') ?? 0;

                const adj_base = Math.max(0, Math.min(6, baseAtkSpd + cur_atkTier));
                const adj_pert = Math.max(0, Math.min(6, baseAtkSpd + cur_atkTier + atkTier_delta));

                if (adj_base !== adj_pert) {
                    const ms_per_hit_base = corrected_ms / 3 / baseDamageMultiplier[adj_base];
                    const ms_per_hit_pert = corrected_ms / 3 / baseDamageMultiplier[adj_pert];

                    let total_melee_hits = 0;
                    for (const { sim_qty, spell, mana_excl } of (snap.parsed_combo ?? [])) {
                        if (mana_excl || !spell) continue;
                        if (spell.scaling === 'melee') total_melee_hits += Math.round(sim_qty);
                    }

                    if (total_melee_hits > 0) {
                        // Mana change per atkTier_delta: negative when corrected_ms > 0
                        // (higher tier → larger divisor → less steal per hit)
                        const ms_mana_delta = (ms_per_hit_pert - ms_per_hit_base) * total_melee_hits;
                        const ms_mana_per_unit = ms_mana_delta / atkTier_delta;

                        // Compute mana tightness at corrected ms (may differ from baseline)
                        combo_base.set('ms', corrected_ms);
                        const bal = _estimate_mana_balance(snap, combo_base);
                        combo_base.set('ms', baseline_ms); // restore

                        if (bal) {
                            const deficit = bal.total_cost - bal.start_mana - bal.regen_mana - bal.ms_mana;
                            const ratio_raw = bal.total_cost > 0 ? Math.max(0, deficit / bal.total_cost) : 0;
                            const ratio = Math.pow(ratio_raw, _MANA_RATIO_EXPONENT);
                            const mana_bonus_adj = max_abs * _MANA_WEIGHT_FRACTION * ratio;

                            if (mana_bonus_adj > 0) {
                                // Convert atkTier mana to weight via mr-equivalence:
                                //   1 mr → combo_time/MANA_TICK_SECONDS mana per combo
                                //   1 atkTier → ms_mana_per_unit mana per combo
                                const combo_time = snap.combo_time ?? 0;
                                const mana_per_mr = combo_time > 0 ? combo_time / MANA_TICK_SECONDS : 1;
                                const delta_mr = deltas.get('mr') ?? _DEFAULT_DELTAS.mr ?? 1;
                                const mr_weight = mana_bonus_adj / delta_mr;

                                const atkTier_mana_w = ms_mana_per_unit / mana_per_mr * mr_weight;

                                const old_w = weights.get('atkTier') ?? 0;
                                weights.set('atkTier', old_w + atkTier_mana_w);

                                if (SOLVER_DEBUG_SENSITIVITY) {
                                    console.log(`[solver][sensitivity] atkTier mana adj:` +
                                        ` baseline_ms=${baseline_ms}, corrected_ms=${corrected_ms}` +
                                        ` | ms_mana_delta=${ms_mana_delta.toFixed(2)} (per ${atkTier_delta} atkTier)` +
                                        ` | mana_ratio=${ratio.toFixed(3)}, mana_bonus=${mana_bonus_adj.toFixed(2)}` +
                                        ` | atkTier_mana_w=${atkTier_mana_w.toFixed(2)}` +
                                        ` | atkTier: ${old_w.toFixed(2)} → ${(old_w + atkTier_mana_w).toFixed(2)}`
                                        + (ms_correction === 0 && pool_ms_total !== 0
                                            ? ' (ms correction suppressed by restriction)' : ''));
                                }
                            }
                        }
                    }
                }
            }
        }
    }
}

// ── Weight builders ──────────────────────────────────────────────────────────

/**
 * Legacy damage weight builder — used as fallback when sensitivity computation
 * returns null (e.g. zero baseline damage with combo_dps target).
 */
function _build_dmg_weights_legacy(snap) {
    const weights = new Map();
    const add = (stat, w) => weights.set(stat, (weights.get(stat) ?? 0) + w);

    const target = snap.scoring_target ?? 'combo_dps';

    if (target === 'total_healing') {
        add('healPct', 1.0);
        add('hpBonus', 0.01);
        return weights;
    }

    if (target === 'ehp') {
        add('hpBonus', 0.01);
        add('hprRaw', 0.1);
        return weights;
    }

    if (target === 'spd' || target === 'poison' ||
        target === 'lb' || target === 'xpb') {
        add(target, 1.0);
        return weights;
    }

    add('damPct', 1.0);
    add('damRaw', 0.5);
    add('critDamPct', 0.5);

    const combo = snap.parsed_combo ?? [];
    const has_spell = combo.length === 0 ||
        combo.some(r => (r.spell?.scaling ?? 'spell') === 'spell');
    const has_melee = combo.some(r => r.spell?.scaling === 'melee');

    if (has_spell) {
        add('sdPct', 1.0);
        add('sdRaw', 0.5);
    }
    if (has_melee) {
        add('mdPct', 1.0);
        add('mdRaw', 0.5);
        add('atkTier', 0.3);
    }

    for (const ep of ['e', 't', 'w', 'f', 'a']) {
        add(ep + 'DamPct', 1.0);
        add(ep + 'DamRaw', 0.5);
        if (has_spell) {
            add(ep + 'SdPct', 0.8);
            add(ep + 'SdRaw', 0.4);
        }
        if (has_melee) {
            add(ep + 'MdPct', 0.8);
            add(ep + 'MdRaw', 0.4);
        }
    }

    if (snap.combo_time && !snap.allow_downtime) {
        weights._priority_only = new Map();
        weights._priority_only.set('mr', 0.5);
        if (has_melee) weights._priority_only.set('ms', 0.5);
    }

    return weights;
}

/**
 * Build damage/scoring weights. Uses sensitivity-based computation when possible,
 * falls back to legacy heuristic weights otherwise.
 */
function _build_dmg_weights(snap, locked, pools) {
    const result = _compute_sensitivity_weights(snap, locked, pools);
    if (!result) return _build_dmg_weights_legacy(snap);

    _augment_sensitivity_weights(result, snap, snap.restrictions, pools);
    result.weights._deltas = result.deltas;
    return result.weights;
}
