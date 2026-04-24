// ── Sensitivity — weight pipeline + augmentation + public entry ─────────────
//
// Public entry: `_compute_sensitivity_weights` — builds a baseline, perturbs
// each stat, measures the change in the scoring target, then augments the raw
// sensitivities with constraint bonuses and mana sustainability hints.  The
// top-level body is an ordering of helper calls; each helper owns one block
// of the pipeline.
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

// ── Core perturbation helpers ───────────────────────────────────────────────

/**
 * Fast-tier perturbation: perturb combo_base directly for each stat in
 * _PERTURBABLE_STATS and write the resulting sensitivity into `weights`.
 */
function _perturb_stat_sensitivities(weights, combo_base, deltas, baseline_score, snap) {
    for (const stat of _PERTURBABLE_STATS) {
        const delta = deltas.get(stat);
        if (!delta || delta === 0) continue;

        const old = combo_base.get(stat) ?? 0;

        combo_base.set(stat, old + delta);
        const score_up = _sensitivity_eval_score(combo_base, snap);
        const s_up = (score_up - baseline_score) / delta;

        if (_SPLIT_STATS.has(stat)) {
            // Split: also measure the -delta direction.  A boundary-clamped
            // direction (e.g. atkTier at tier 0) reports zero and is skipped.
            combo_base.set(stat, old - delta);
            const score_down = _sensitivity_eval_score(combo_base, snap);
            combo_base.set(stat, old); // restore
            const s_down = (score_down - baseline_score) / (-delta);
            if (s_up !== 0) weights._pos_bonuses.set(stat, s_up);
            if (s_down !== 0) weights._neg_bonuses.set(stat, s_down);
        } else {
            combo_base.set(stat, old); // restore
            if (s_up !== 0) weights.set(stat, s_up);
        }
    }
}

/**
 * Slow-tier perturbation: perturb each SP provision by reassembling the
 * combo statMap with a trial SP vector.  Returns the [5] sensitivities array.
 */
function _perturb_sp_sensitivities(build_sm, total_sp, sp_deltas, baseline_score, snap) {
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
    return sp_sensitivities;
}

/**
 * When item requirements (locked + pool) exceed the SP budget, SP provisions
 * from free items are essential for build feasibility.  Each SP index gets
 * its own independent sensitivity derived from its demand, added on top of
 * the score-based sensitivity (which may be near zero for stats like agi
 * that don't affect the scoring target).
 */
function _apply_sp_feasibility_bonus(weights, sp_sensitivities, snap, locked, pools, deltas, sp_deltas) {
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

    // Subtract locked items' SP provisions (offset requirement burden)
    const locked_prov = [0, 0, 0, 0, 0];
    for (const item of Object.values(locked)) {
        if (!item || item.statMap.has('NONE')) continue;
        // TODO Verify skp doesn't include set and crafted items
        const skp = item.statMap.get('skillpoints');
        if (skp) for (let i = 0; i < 5; i++) locked_prov[i] += Math.max(0, skp[i]);
    }

    const net_demand = [0, 0, 0, 0, 0];
    let demand_sum = 0;
    for (let i = 0; i < 5; i++) {
        net_demand[i] = Math.max(0, max_req[i] - locked_prov[i]);
        demand_sum += net_demand[i];
    }

    const deficit = demand_sum - snap.sp_budget;
    if (deficit <= 0) return;

    // Compute max impact from current stat weights for scaling reference.
    // Uses per-item impact (sensitivity × delta) so stats with small
    // deltas (atkTier=1) don't dominate over stats with large deltas.
    const local_max_abs = _compute_max_abs_impact(weights, deltas);

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

// ── Augmentation helpers ────────────────────────────────────────────────────

/**
 * Max per-item impact (sensitivity × delta) across current weights.  Using
 * impact instead of raw per-unit sensitivity prevents stats with tiny deltas
 * (atkTier, delta=1) from dominating max_abs and inflating all augmentation
 * bonuses — critical for DPS scoring where atkTier's per-unit sensitivity is
 * disproportionately large.
 */
function _compute_max_abs_impact(weights, deltas) {
    let max_abs = 1.0;
    const consider = (stat, w) => {
        const d = deltas.get(stat) ?? _DEFAULT_DELTAS[stat] ?? 1;
        const impact = Math.abs(w) * Math.abs(d);
        if (impact > max_abs) max_abs = impact;
    };
    for (const [stat, w] of weights) consider(stat, w);
    // Split-stat sensitivities live in the asymmetric channels — include them
    // so max_abs reflects their magnitude for downstream calibration.
    if (weights._pos_bonuses) for (const [s, w] of weights._pos_bonuses) consider(s, w);
    if (weights._neg_bonuses) for (const [s, w] of weights._neg_bonuses) consider(s, w);
    return max_abs;
}

/**
 * Direct threshold constraints (ge/le ops on direct stats): push weight in the
 * direction that relieves the constraint, scaled by how much the baseline
 * violates it.  `ge` adds positive weight (higher is better); `le` subtracts
 * (lower is better), consistent with dominance placing the stat in `lower`.
 *
 * Active equation (per restriction):
 *   shortfall_units = shortfall_raw / stat_delta          // how many of an avg item we would need to meet the constraint
 *   per_item_units  = shortfall_units / max(1, slots-1)   // spread burden across items
 *      TODO some slot types provide more of some stats...a problem for later
 *   scale           = max(_CONSTRAINT_SATISFIED_FLOOR, per_item_units)
 *   bonus_mag       = _CONSTRAINT_WEIGHT_FRACTION * scale * max_abs / stat_delta
 *   weight         += sign(op) * bonus_mag
 *
 * Asymmetric pos/neg channels (scored via max(0,v)*w and min(0,v)*w):
 *   ge: _neg_bonuses[stat] += |bonus|   → penalizes items with v<0  (min(0,v)*|w| < 0)
 *   le: _pos_bonuses[stat] -= |bonus|   → penalizes items with v>0  (max(0,v)*-|w| < 0)
 * Active constraints push the unified weight AND the asymmetric channel.
 * Satisfied constraints push only the asymmetric channel at the floor — so
 * slack-eroders are penalized without giving slack-providers a free boost.
 *
 * `max_abs` keeps magnitude calibrated against score-based weights; the
 * trailing `/ stat_delta` converts impact to a per-unit weight.
 */
function _apply_direct_constraint_bonuses(result, restrictions) {
    const { weights, combo_base, deltas, max_abs, slots_available } = result;

    for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
        if (_INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        if (op !== 'ge' && op !== 'le') continue;

        const current = combo_base.get(stat) ?? 0;
        const shortfall_raw = op === 'ge' ? (value - current) : (current - value);

        const stat_delta = deltas.get(stat) || _DEFAULT_DELTAS[stat] || 1;
        const shortfall_units = shortfall_raw / stat_delta;
        const per_item_units = shortfall_units / Math.max(1, slots_available - 1);

        const active = shortfall_raw > 0;
        const scale = active ? per_item_units : _CONSTRAINT_SATISFIED_FLOOR;
        const bonus_mag = _CONSTRAINT_WEIGHT_FRACTION * scale * max_abs / stat_delta;
        const split = _SPLIT_STATS.has(stat);

        if (active) {
            // For split stats, route to the pos channel (so items with v>0
            // get the active reward/penalty) instead of unified — otherwise
            // the scoring main loop would apply the weight symmetrically.
            const signed_bonus = op === 'ge' ? bonus_mag : -bonus_mag;
            if (split) {
                weights._pos_bonuses.set(stat, (weights._pos_bonuses.get(stat) ?? 0) + signed_bonus);
            } else {
                weights.set(stat, (weights.get(stat) ?? 0) + signed_bonus);
            }
        }
        if (op === 'ge') {
            weights._neg_bonuses.set(stat, (weights._neg_bonuses.get(stat) ?? 0) + bonus_mag);
        } else {
            weights._pos_bonuses.set(stat, (weights._pos_bonuses.get(stat) ?? 0) - bonus_mag);
            // For split + le: also reward items with v<0 via neg channel.
            if (split) {
                weights._neg_bonuses.set(stat, (weights._neg_bonuses.get(stat) ?? 0) - bonus_mag);
            }
        }

        if (SOLVER_DEBUG_SENSITIVITY) {
            console.log(`[solver][sensitivity] constraint bonus (${op}, ${active ? 'active' : 'satisfied'}): ${stat} bonus_mag=${bonus_mag.toFixed(2)} (shortfall_raw: ${shortfall_raw.toFixed(0)}, per_item_units: ${per_item_units.toFixed(3)}, slots_available: ${slots_available}, stat_delta: ${stat_delta})`);
        }
    }
}

/**
 * Indirect constraints (ehp, ehpr, total_hp, hpr): stats computed from the
 * full build via getDefenseStats().  Can't be read from the statMap, so we
 * perturb contributing direct stats (and relevant SP indices) and measure
 * the indirect stat's response.
 *
 * Joint per-item measurement: an average item carries multiple contributors
 * at once (hp + hpBonus + hprPct + def/agi SP), and the indirect formula is
 * non-linear.  So we perturb ALL contributors together to get
 * `agg_indirect_delta` — the indirect-stat change per average item — and use
 * that as the denominator for "items needed":
 *
 *   shortfall_units = deficit / agg_indirect_delta
 *   per_item_units  = shortfall_units / max(1, slots_available - 1)
 *
 * Each contributor's per-unit weight is then its individual sensitivity's
 * share of the joint closure: (indirect_sens[cstat] / agg_indirect_delta).
 *
 * Only runs on active `ge` deficits — no satisfied-floor branch.  Mirrors
 * into `_neg_bonuses` so items with v<0 contributors get penalized
 * (contributor is positive-by-construction for ge-indirect).
 */
function _apply_indirect_constraint_bonuses(result, snap, restrictions) {
    const { weights, combo_base, deltas, sp_deltas, total_sp, build_sm, max_abs, slots_available } = result;

    for (const { stat, op, value } of (restrictions.stat_thresholds ?? [])) {
        if (!_INDIRECT_CONSTRAINT_STATS.has(stat)) continue;
        if (op !== 'ge') continue;
        if (!_INDIRECT_CONTRIBUTORS[stat]) continue;  // e.g. finalSpellCost — handled separately

        const baseline_val = _eval_indirect_stat(combo_base, stat);
        const deficit = value - baseline_val;
        if (deficit <= 0) continue;  // already met by baseline

        const contributors = _INDIRECT_CONTRIBUTORS[stat];
        const sp_indices = _INDIRECT_SP_CONTRIBUTORS[stat];
        const sp_available = sp_indices && sp_deltas && total_sp && build_sm;

        // ── Aggregate per-item perturbation ─────────────────────────────
        // Perturb every contributor (stat + SP) by its delta simultaneously.
        // When SP applies, rebuild with trial_sp first (returns a fresh Map),
        // then stack the stat deltas onto that rebuilt combo — otherwise the
        // rebuild would discard our direct-stat perturbations.
        let agg_combo;
        let saved_contribs = null;
        if (sp_available) {
            const trial_sp = [...total_sp];
            for (const si of sp_indices) trial_sp[si] += sp_deltas[si] || 10;
            agg_combo = _assemble_baseline_combo(build_sm, trial_sp, snap);
            for (const cstat of contributors) {
                const d = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
                agg_combo.set(cstat, (agg_combo.get(cstat) ?? 0) + d);
            }
        } else {
            saved_contribs = new Map();
            for (const cstat of contributors) {
                const d = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
                saved_contribs.set(cstat, combo_base.get(cstat) ?? 0);
                combo_base.set(cstat, saved_contribs.get(cstat) + d);
            }
            agg_combo = combo_base;
        }
        const agg_perturbed_val = _eval_indirect_stat(agg_combo, stat);
        if (saved_contribs) {
            for (const [cstat, old] of saved_contribs) combo_base.set(cstat, old);
        }

        const agg_indirect_delta = agg_perturbed_val - baseline_val;
        if (agg_indirect_delta <= 0) {
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] indirect (${stat}): skipped — agg_indirect_delta=${agg_indirect_delta.toFixed(4)} (non-linear cancellation)`);
            }
            continue;
        }

        const shortfall_units = deficit / agg_indirect_delta;
        const per_item_units = shortfall_units / Math.max(1, slots_available - 1);

        if (SOLVER_DEBUG_SENSITIVITY) {
            console.log(`[solver][sensitivity] indirect (${stat}): deficit=${deficit.toFixed(0)}, agg_indirect_delta=${agg_indirect_delta.toFixed(2)}, shortfall_units=${shortfall_units.toFixed(3)}, per_item_units=${per_item_units.toFixed(3)}, slots_available=${slots_available}, contributors=[${contributors.join(',')}${sp_available ? ',SP:' + sp_indices.map(i => skp_order[i]).join(',') : ''}]`);
        }

        // ── Per-contributor per-unit weight ─────────────────────────────
        for (const cstat of contributors) {
            const stat_delta = deltas.get(cstat) || _DEFAULT_DELTAS[cstat] || 1;
            const old = combo_base.get(cstat) ?? 0;
            combo_base.set(cstat, old + stat_delta);
            const perturbed_val = _eval_indirect_stat(combo_base, stat);
            combo_base.set(cstat, old);  // restore

            const indirect_sens = (perturbed_val - baseline_val) / stat_delta;
            if (indirect_sens <= 0) continue;

            const share = indirect_sens / agg_indirect_delta;
            const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * per_item_units
                * _INDIRECT_SENS_SCALE * share;
            weights.set(cstat, (weights.get(cstat) ?? 0) + bonus);
            // Parent constraint is `ge` (gated above); contributor positively
            // affects the indirect stat — so items with v<0 of the contributor
            // make the deficit worse.  Penalize via _neg_bonuses.
            weights._neg_bonuses.set(cstat, (weights._neg_bonuses.get(cstat) ?? 0) + bonus);
            if (SOLVER_DEBUG_SENSITIVITY) {
                console.log(`[solver][sensitivity] indirect constraint bonus (${stat}): ${cstat} += ${bonus.toFixed(2)} (sens: ${indirect_sens.toFixed(4)}, share: ${share.toFixed(4)}, delta: ${stat_delta})`);
            }
        }

        // ── SP provision sensitivity for def/agi → EHP/EHPR ─────────────
        if (sp_available) {
            for (const si of sp_indices) {
                const sp_delta = sp_deltas[si] || 10;
                const trial_sp = [...total_sp];
                trial_sp[si] += sp_delta;
                const trial_combo = _assemble_baseline_combo(build_sm, trial_sp, snap);
                const perturbed_val = _eval_indirect_stat(trial_combo, stat);

                const sp_sens = (perturbed_val - baseline_val) / sp_delta;
                if (sp_sens <= 0) continue;

                const share = sp_sens / agg_indirect_delta;
                const bonus = max_abs * _CONSTRAINT_WEIGHT_FRACTION * per_item_units
                    * _INDIRECT_SENS_SCALE * share * _SP_SENSITIVITY_DAMPEN;
                weights._sp_sensitivities[si] += bonus;
                if (SOLVER_DEBUG_SENSITIVITY) {
                    console.log(`[solver][sensitivity] indirect SP constraint bonus (${stat}): ${skp_order[si]} += ${bonus.toFixed(2)} (sp_sens: ${sp_sens.toFixed(4)}, share: ${share.toFixed(4)})`);
                }
            }
        }
    }
}

/**
 * Mana sustainability (combo_time > 0, not hp_casting): when the baseline
 * mana balance is insufficient, boost mr/ms/maxMana/int SP and spell-cost
 * reduction stats proportionally to the deficit.
 *
 * Uses locked items' mr/ms/int/maxMana via combo_base for accurate deficit.
 */
function _apply_mana_sustainability_bonuses(result, snap) {
    const { weights, combo_base, deltas, sp_deltas, max_abs } = result;

    const mana_tight = _estimate_mana_tight(snap, combo_base);
    if (!mana_tight) return;

    if (!weights._priority_only) weights._priority_only = new Map();

    const bal = _estimate_mana_balance(snap, combo_base);
    const deficit = bal.total_cost - bal.start_mana - bal.regen_mana - bal.ms_mana;
    // ratio_raw can exceed 1.0 when negative mr/ms from locked items pushes
    // the deficit well beyond total spell cost.  The sqrt exponent dampens
    // extreme values naturally (e.g. ratio_raw=9 → ratio=3).
    const ratio_raw = bal.total_cost > 0 ? Math.max(0, deficit / bal.total_cost) : 0;
    const ratio = Math.pow(ratio_raw, _MANA_RATIO_EXPONENT);
    const mana_bonus = max_abs * _MANA_WEIGHT_FRACTION * ratio;

    if (mana_bonus <= 0) return;

    const has_melee = (snap.parsed_combo ?? []).some(r => (r.spell?.scaling ?? 'spell') === 'melee');

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

/**
 * atkTier mana adjustment from pool ms.
 *
 * Higher atkTier increases baseDamageMultiplier divisor in ms_per_hit,
 * reducing mana steal per hit (ms > 0) or mana drain per hit (ms < 0).
 * The DPS sensitivity ignores this because combo_dps = damage/cycle_time
 * doesn't involve mana.  But the worker rejects mana-unsustainable builds,
 * so atkTier's mana cost/benefit must be reflected in its weight.
 *
 * Runs independently of the mana-sustainability block above, because
 * baseline ms may be 0 (no ms items locked) while pool items bring
 * significant ms.
 */
function _apply_atktier_mana_adjustment(result, snap, restrictions, pools) {
    const { weights, combo_base, deltas, max_abs } = result;

    const target = snap.scoring_target ?? 'combo_dps';
    const has_melee = (snap.parsed_combo ?? []).some(
        r => (r.spell?.scaling ?? 'spell') === 'melee');

    if (!has_melee || !(target === 'combo_dps' || target === 'combo_damage') || !combo_base || !pools) return;

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
    if (corrected_ms === 0) return;

    const atkTier_delta = deltas.get('atkTier') ?? 1;
    const baseAtkSpd = attackSpeeds.indexOf(combo_base.get('atkSpd'));
    const cur_atkTier = combo_base.get('atkTier') ?? 0;

    const adj_base = Math.max(0, Math.min(6, baseAtkSpd + cur_atkTier));
    const adj_pert_up = Math.max(0, Math.min(6, baseAtkSpd + cur_atkTier + atkTier_delta));
    const adj_pert_down = Math.max(0, Math.min(6, baseAtkSpd + cur_atkTier - atkTier_delta));
    const do_up = adj_pert_up !== adj_base;
    const do_down = adj_pert_down !== adj_base;
    if (!do_up && !do_down) return;

    const ms_per_hit_base = corrected_ms / 3 / baseDamageMultiplier[adj_base];

    let total_melee_hits = 0;
    for (const { sim_qty, spell, mana_excl } of (snap.parsed_combo ?? [])) {
        if (mana_excl || !spell) continue;
        if (spell.scaling === 'melee') total_melee_hits += Math.round(sim_qty);
    }
    if (total_melee_hits <= 0) return;

    // Compute mana tightness at corrected ms (may differ from baseline)
    combo_base.set('ms', corrected_ms);
    const bal = _estimate_mana_balance(snap, combo_base);
    combo_base.set('ms', baseline_ms); // restore
    if (!bal) return;

    const deficit = bal.total_cost - bal.start_mana - bal.regen_mana - bal.ms_mana;
    const ratio_raw = bal.total_cost > 0 ? Math.max(0, deficit / bal.total_cost) : 0;
    const ratio = Math.pow(ratio_raw, _MANA_RATIO_EXPONENT);
    const mana_bonus_adj = max_abs * _MANA_WEIGHT_FRACTION * ratio;
    if (mana_bonus_adj <= 0) return;

    // Convert atkTier mana to weight via mr-equivalence:
    //   1 mr → combo_time/MANA_TICK_SECONDS mana per combo
    //   1 atkTier → ms_mana_per_unit mana per combo
    const combo_time = snap.combo_time ?? 0;
    const mana_per_mr = combo_time > 0 ? combo_time / MANA_TICK_SECONDS : 1;
    const delta_mr = deltas.get('mr') ?? _DEFAULT_DELTAS.mr ?? 1;
    const mr_weight = mana_bonus_adj / delta_mr;

    // Per-unit weight for a +signed_delta atkTier movement reaching adj_pert.
    const compute_w = (adj_pert, signed_delta) => {
        const ms_per_hit_pert = corrected_ms / 3 / baseDamageMultiplier[adj_pert];
        const ms_mana_delta = (ms_per_hit_pert - ms_per_hit_base) * total_melee_hits;
        const ms_mana_per_unit = ms_mana_delta / signed_delta;
        return ms_mana_per_unit / mana_per_mr * mr_weight;
    };

    const split = _SPLIT_STATS.has('atkTier');
    let w_up = 0, w_down = 0, old_pos = 0, old_neg = 0, old_uni = 0;
    if (split) {
        old_pos = weights._pos_bonuses.get('atkTier') ?? 0;
        old_neg = weights._neg_bonuses.get('atkTier') ?? 0;
        if (do_up) {
            w_up = compute_w(adj_pert_up, atkTier_delta);
            weights._pos_bonuses.set('atkTier', old_pos + w_up);
        }
        if (do_down) {
            // signed_delta is -atkTier_delta: measures per-unit upward
            // movement from the down-perturbed position.
            w_down = compute_w(adj_pert_down, -atkTier_delta);
            weights._neg_bonuses.set('atkTier', old_neg + w_down);
        }
    } else {
        old_uni = weights.get('atkTier') ?? 0;
        if (do_up) {
            w_up = compute_w(adj_pert_up, atkTier_delta);
            weights.set('atkTier', old_uni + w_up);
        }
    }

    if (SOLVER_DEBUG_SENSITIVITY) {
        const parts = [`baseline_ms=${baseline_ms}, corrected_ms=${corrected_ms}`,
            `mana_ratio=${ratio.toFixed(3)}, mana_bonus=${mana_bonus_adj.toFixed(2)}`];
        if (split) {
            if (do_up) parts.push(`pos: ${old_pos.toFixed(2)} → ${(old_pos + w_up).toFixed(2)} (w_up=${w_up.toFixed(2)})`);
            if (do_down) parts.push(`neg: ${old_neg.toFixed(2)} → ${(old_neg + w_down).toFixed(2)} (w_down=${w_down.toFixed(2)})`);
        } else {
            parts.push(`atkTier: ${old_uni.toFixed(2)} → ${(old_uni + w_up).toFixed(2)}`);
        }
        if (ms_correction === 0 && pool_ms_total !== 0) parts.push('(ms correction suppressed by restriction)');
        console.log(`[solver][sensitivity] atkTier mana adj: ${parts.join(' | ')}`);
    }
}

// ── Debug summary ───────────────────────────────────────────────────────────

function _log_sensitivity_summary(t0, target, combo_base, baseline_score, total_sp, assigned_sp, weights, sp_sensitivities, deltas, sp_deltas) {
    const elapsed = (performance.now() - t0).toFixed(1);
    console.groupCollapsed(`[solver][sensitivity] computed in ${elapsed}ms (target: ${target})`);

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

    const sorted = [...weights.entries()]
        .filter(([k]) => typeof k === 'string')
        .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    console.log('stat weights (sorted by |magnitude|):');
    for (const [stat, sens] of sorted) {
        console.log(`  ${stat}: ${sens.toFixed(4)} (delta: ${deltas.get(stat)})`);
    }
    console.log('SP sensitivities:', sp_sensitivities.map((s, i) =>
        `${skp_order[i]}: ${s.toFixed(4)} (delta: ${sp_deltas[i]})`));

    if (weights._pos_bonuses?.size) {
        const entries = [...weights._pos_bonuses.entries()]
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log('pos-only bonuses (applied to max(0, v)):');
        for (const [stat, w] of entries) console.log(`  ${stat}: ${w.toFixed(4)}`);
    }
    if (weights._neg_bonuses?.size) {
        const entries = [...weights._neg_bonuses.entries()]
            .sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
        console.log('neg-only bonuses (applied to min(0, v)):');
        for (const [stat, w] of entries) console.log(`  ${stat}: ${w.toFixed(4)}`);
    }

    console.groupEnd();
}

// ── Public entry ────────────────────────────────────────────────────────────

/**
 * Build priority weights by perturbing each stat against a baseline and
 * measuring the change in the scoring target, then augmenting with constraint
 * bonuses and mana sustainability hints.
 *
 * Returns a Map of stat → weight, with:
 *   - ._sp_sensitivities: [5] array of SP provision sensitivities
 *   - ._priority_only:    Map of mana/cost stats → weight (priority-only)
 *   - ._deltas:           Map of stat → perturbation delta used
 *
 * Throws when the baseline combo_dps score is zero — the scoring target has
 * no optimizable signal (e.g. no combo rows defined, weapon deals 0 damage).
 */
function _compute_sensitivity_weights(snap, locked, pools) {
    const t0 = performance.now();
    const target = snap.scoring_target ?? 'combo_dps';

    const build_sm = _build_baseline_statmap(snap, locked);
    const { total_sp, assigned_sp } = _greedy_sp_alloc_main(build_sm, snap, locked);
    const combo_base = _assemble_baseline_combo(build_sm, total_sp, snap);
    const baseline_score = _sensitivity_eval_score(combo_base, snap);

    // delta = median(pool)
    const { deltas, sp_deltas } = _compute_pool_deltas(pools);

    if (baseline_score === 0 && (target === 'combo_dps' || target === 'combo_damage')) {
        console.warn(`[solver][sensitivity] baseline ${target} = 0; scoring target cannot be optimized. Check that combo rows are defined and the weapon deals damage.`);
        throw new Error(`Sensitivity baseline ${target} = 0 — no optimizable scoring signal.`);
    }

    const weights = new Map();
    // Asymmetric scoring channels.  Scored as max(0, v) * w (_pos_bonuses) and
    // min(0, v) * w (_neg_bonuses) — so a positive _neg_bonuses entry penalizes
    // items with v<0, and a negative _pos_bonuses entry penalizes items with v>0.
    weights._pos_bonuses = new Map();
    weights._neg_bonuses = new Map();

    // stat weight = (score(stat + delta) - score(stat)) / delta
    _perturb_stat_sensitivities(weights, combo_base, deltas, baseline_score, snap);

    // sp weight = (score(sp + delta) - score(sp)) / delta * _SP_SENSITIVITY_DAMPEN
    const sp_sensitivities = _perturb_sp_sensitivities(build_sm, total_sp, sp_deltas, baseline_score, snap);
    weights._sp_sensitivities = sp_sensitivities;

    // demand = req - provided
    // budget = assignable sp (generally 200) (+4 if tome)
    // sp weight += (max ∀stats (weight * delta)) * (min(((total demand - budget) / budget), 3)) * ((demand) / (total demand)) * _SP_FEASIBILITY_SCALE / delta
    _apply_sp_feasibility_bonus(weights, sp_sensitivities, snap, locked, pools, deltas, sp_deltas);

    const result = {
        weights, baseline_score, combo_base,
        deltas, sp_deltas, total_sp, build_sm,
        max_abs: _compute_max_abs_impact(weights, deltas),
        // pools.ring represents up to 2 free slots (ring1 and/or ring2); every
        // other pool key is exactly one free slot.
        slots_available: Object.keys(pools).reduce((n, slot) => n + (slot === 'ring'
            ? (locked.ring1 ? 0 : 1) + (locked.ring2 ? 0 : 1)
            : 1), 0),
    };

    _apply_direct_constraint_bonuses(result, snap.restrictions);
    _apply_indirect_constraint_bonuses(result, snap, snap.restrictions);
    _apply_mana_sustainability_bonuses(result, snap);
    _apply_atktier_mana_adjustment(result, snap, snap.restrictions, pools);

    if (SOLVER_DEBUG_SENSITIVITY) {
        _log_sensitivity_summary(t0, target, combo_base, baseline_score, total_sp, assigned_sp, weights, sp_sensitivities, deltas, sp_deltas);
    }

    weights._deltas = deltas;
    return weights;
}
