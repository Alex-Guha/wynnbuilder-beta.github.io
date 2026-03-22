// ══════════════════════════════════════════════════════════════════════════════
// COMBO DAMAGE CROSS-VALIDATION TESTS
//
// Cross-validates per-spell damage between two independent stat assembly paths:
//   1. Builder path:  Build class (same as BuildAssembleNode on the page) →
//                     builder statMap → calculateSpellDamage → crit-weighted avg
//   2. Solver path:   _init_running_statmap / _incr_add_item / _finalize_leaf_statmap
//                     (same as solver worker) → solver statMap →
//                     compute_combo_damage_totals (via computeSpellDisplayAvg)
//
// The test first compares the statMaps produced by both paths (pre- and
// post-atree), then cross-validates per-row combo damage using each path's
// own statMap.  This catches divergences in stat assembly, SP calculation,
// set bonuses, and damage computation.
//
// Test cases are defined by solver URL hashes in snapshots/combo_*.snap.json.
//
// Run: node js/solver/tests/test_combo_damage.js
// Requires Node.js >= 18.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const {
    createSandbox, loadGameData, decodeSolverUrl, decodeActiveNodes,
    buildAtreeMerged, collectSpells, collectRawStats,
    TestRunner, loadSnapshot, checkSnapshotFreshness, extractEquipmentStats,
    REPO_ROOT,
} = require('./harness');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// ── Setup ────────────────────────────────────────────────────────────────────

const ctx = createSandbox();
loadGameData(ctx);

// Load combo/boost.js and combo/codec.js into the sandbox (no DOM deps).
for (const relPath of ['js/solver/combo/boost.js', 'js/solver/combo/codec.js']) {
    const code = fs.readFileSync(path.join(REPO_ROOT, relPath), 'utf8');
    vm.runInContext(code, ctx, { filename: path.join(REPO_ROOT, relPath) });
}

// Export tome_fields and classDefenseMultipliers for builder path.
vm.runInContext(`
    globalThis.tome_fields = tome_fields;
    globalThis.classDefenseMultipliers = classDefenseMultipliers;
`, ctx);

// 14-slot → 7-type none_tome index mapping (mirrors _NONE_TOME_KEY in solver/graph/build.js).
const _NONE_TOME_KEY = {
    weaponTome1: 0, weaponTome2: 0,
    armorTome1: 1, armorTome2: 1, armorTome3: 1, armorTome4: 1,
    guildTome1: 2,
    lootrunTome1: 3,
    gatherXpTome1: 4, gatherXpTome2: 4,
    dungeonXpTome1: 5, dungeonXpTome2: 5,
    mobXpTome1: 6, mobXpTome2: 6,
};

const t = new TestRunner('Combo Damage Cross-Validation');

// ── Builder-path: evaluate a single spell's display damage ──────────────────

/**
 * Evaluate a spell via the builder path (SpellDamageCalcNode.compute_func logic)
 * and return the crit-weighted average of the display part.
 *
 * This mirrors shared_spell_nodes.js lines 27-120, computing per-element
 * min/max/crit arrays, then manually computing the crit-weighted average
 * to cross-validate against the solver's computeSpellDisplayAvg.
 */
function evalSpellBuilderAvg(spell, stats, weaponSM, crit_chance, displayPartName) {
    ctx.__spell_tmp = spell;
    ctx.__stats_tmp = stats;
    ctx.__weapon_tmp = weaponSM;

    const results = vm.runInContext(`
        (function() {
            const weapon = __weapon_tmp;
            const spell  = __spell_tmp;
            const stats  = __stats_tmp;
            const use_speed = ('use_atkspd' in spell) ? spell.use_atkspd : true;
            const use_spell = ('scaling'   in spell) ? spell.scaling === 'spell' : true;

            let spell_result_map = new Map();
            for (const part of spell.parts) {
                spell_result_map.set(part.name, { type: 'need_eval', store_part: part });
            }

            function eval_part(part_name) {
                let dat = spell_result_map.get(part_name);
                if (!dat) return dat;
                if (dat.type !== 'need_eval') return dat;

                const part = dat.store_part;
                const part_id = spell.base_spell + '.' + part.name;
                let spell_result;

                if ('multipliers' in part) {
                    const use_str       = ('use_str'       in part) ? part.use_str       : true;
                    const ignored_mults = ('ignored_mults' in part) ? part.ignored_mults : [];
                    const results = calculateSpellDamage(
                        stats, weapon, part.multipliers, use_spell, !use_speed,
                        part_id, !use_str, ignored_mults);
                    spell_result = {
                        type: 'damage',
                        normal_total: results[0],
                        crit_total:   results[1],
                    };
                } else if ('power' in part) {
                    const mult_map = stats.get('healMult');
                    let heal_mult = 1;
                    for (const [k, v] of mult_map.entries()) {
                        if (k.includes(':') && k.split(':')[1] !== part_id) continue;
                        heal_mult *= (1 + v / 100);
                    }
                    spell_result = {
                        type: 'heal',
                        heal_amount: part.power * getDefenseStats(stats)[0] * heal_mult,
                    };
                } else {
                    spell_result = {
                        normal_total: [0, 0],
                        crit_total:   [0, 0],
                        heal_amount:  0,
                    };
                    for (const [sub_name, hits] of Object.entries(part.hits)) {
                        const sub = eval_part(sub_name);
                        if (!sub) continue;
                        if (!spell_result.type) spell_result.type = sub.type;
                        if (sub.type === 'damage') {
                            spell_result.type = 'damage';
                            spell_result.normal_total[0] += sub.normal_total[0] * hits;
                            spell_result.normal_total[1] += sub.normal_total[1] * hits;
                            spell_result.crit_total[0]   += sub.crit_total[0]   * hits;
                            spell_result.crit_total[1]   += sub.crit_total[1]   * hits;
                        } else if (sub.type === 'heal') {
                            spell_result.type = 'heal';
                            spell_result.heal_amount += sub.heal_amount * hits;
                        }
                    }
                }
                const { name, display = true } = part;
                spell_result.name    = name;
                spell_result.display = display;
                spell_result_map.set(part_name, spell_result);
                return spell_result;
            }

            const all_results = [];
            for (const part of spell.parts) {
                all_results.push(eval_part(part.name));
            }
            return all_results;
        })()
    `, ctx);

    delete ctx.__spell_tmp;
    delete ctx.__stats_tmp;
    delete ctx.__weapon_tmp;

    // Find the display result (same logic as _find_display_result in pure.js).
    const target = displayPartName || spell.display;
    let display_result = target
        ? results.find(r => r?.name === target)
        : null;
    if (!display_result) {
        display_result = [...results].reverse().find(r => r?.display && r?.type === 'damage');
    }
    if (!display_result || display_result.type !== 'damage') return 0;

    const non_crit_avg = (display_result.normal_total[0] + display_result.normal_total[1]) / 2;
    const crit_avg     = (display_result.crit_total[0]   + display_result.crit_total[1])   / 2;
    return (1 - crit_chance) * non_crit_avg + crit_chance * crit_avg;
}

/**
 * Evaluate healing via the builder path (same as heal branch in SpellDamageCalcNode).
 */
function evalSpellBuilderHealing(spell, stats) {
    ctx.__spell_tmp = spell;
    ctx.__stats_tmp = stats;

    const result = vm.runInContext(`
        computeSpellHealingTotal(__stats_tmp, __spell_tmp)
    `, ctx);

    delete ctx.__spell_tmp;
    delete ctx.__stats_tmp;
    return result;
}

// ── Resolve decoded combo rows ──────────────────────────────────────────────

/**
 * Convert raw decoded combo rows (from decodeSolverParams) into parsed_rows
 * format that compute_combo_damage_totals expects.
 *
 * Resolves spell_node_id → spell object and boost node refs → boost tokens.
 */
function resolveComboRows(decodedRows, spellMap, atree_merged) {
    const rows = [];
    for (const raw of decodedRows) {
        // Resolve spell
        const spell = spellMap.get(raw.spell_node_id) ?? null;

        // Resolve pseudo-spells
        let pseudo = null;
        if (raw.spell_node_id === vm.runInContext('MANA_RESET_NODE_ID', ctx)) pseudo = 'mana_reset';
        else if (raw.spell_node_id === vm.runInContext('CANCEL_BAKALS_NODE_ID', ctx)) pseudo = 'cancel_state:Corrupted';

        // Resolve boost tokens via node_ref_to_boost_info
        const boost_tokens = [];
        for (const b of (raw.boosts || [])) {
            ctx.__b_node = b.node_id;
            ctx.__b_pos = b.effect_pos;
            ctx.__b_atree = atree_merged;
            const info = vm.runInContext(
                'node_ref_to_boost_info(__b_node, __b_pos, __b_atree)', ctx);
            delete ctx.__b_node; delete ctx.__b_pos; delete ctx.__b_atree;

            if (info.name) {
                boost_tokens.push({
                    name: info.name,
                    value: b.has_value ? b.value : 1,
                    is_pct: info.is_calc,
                });
            }
        }

        rows.push({
            qty: raw.qty,
            spell,
            boost_tokens,
            dmg_excl: raw.dmg_excl || false,
            pseudo,
            dps_hits_override: raw.has_hits ? raw.hits : undefined,
        });
    }
    return rows;
}

// ── StatMap comparison helper ────────────────────────────────────────────────

/**
 * Compare two statMaps and report differences.  Skips nested Map/Set entries
 * (damMult, defMult, healMult, activeMajorIDs) since those are set up by
 * the same finalizeStatmap function on both paths.
 */
function compareStatMaps(label, builderSM, solverSM, t) {
    const allKeys = new Set([...builderSM.keys(), ...solverSM.keys()]);
    let mismatches = 0;
    for (const key of allKeys) {
        const bv = builderSM.get(key);
        const sv = solverSM.get(key);
        // Skip nested structures (Maps, Sets) — compared identically via finalizeStatmap.
        if (bv instanceof Map || bv instanceof Set || sv instanceof Map || sv instanceof Set) continue;
        if (typeof bv === 'string' || typeof sv === 'string') {
            if (bv !== sv) {
                t.assert(false, `${label} statMap mismatch: "${key}" builder="${bv}" solver="${sv}"`);
                mismatches++;
            }
            continue;
        }
        const bn = bv ?? 0;
        const sn = sv ?? 0;
        if (bn !== sn) {
            t.assert(false, `${label} statMap mismatch: "${key}" builder=${bn} solver=${sn}`);
            mismatches++;
        }
    }
    if (mismatches === 0) {
        t.assert(true, `${label} statMaps match (${allKeys.size} keys)`);
    }
    return mismatches;
}

// ── Test runner ──────────────────────────────────────────────────────────────

function runComboTest(snapName) {
    const snap = loadSnapshot(snapName);

    // 1. Decode URL hash.
    const decoded = decodeSolverUrl(ctx, snap.url_hash);
    checkSnapshotFreshness(snap, t, extractEquipmentStats(decoded, ctx), false);
    t.assert(decoded.playerClass !== null, `${snapName}: decoded class = ${decoded.playerClass}`);

    // 2. Resolve items (raw item data from itemMap).
    const equipNames = decoded.equipment;
    const equips = [];
    for (let i = 0; i < 8; i++) {
        const name = equipNames[i];
        equips.push((name && ctx.itemMap.has(name)) ? ctx.itemMap.get(name) : ctx.none_items[i]);
    }
    const weaponName = equipNames[8];
    const weapon = (weaponName && ctx.itemMap.has(weaponName)) ? ctx.itemMap.get(weaponName) : ctx.none_items[8];
    t.assert(weapon, `${snapName}: weapon "${weaponName}" found`);

    // Tomes: decode all 14 slots with correct none_tome fallback per slot type.
    const tomeNames = decoded.tomes || [];
    const resolvedTomes = [];
    for (let i = 0; i < ctx.tome_fields.length; i++) {
        const name = tomeNames[i];
        const noneIdx = _NONE_TOME_KEY[ctx.tome_fields[i]];
        resolvedTomes.push((name && ctx.tomeMap.has(name)) ? ctx.tomeMap.get(name) : ctx.none_tomes[noneIdx]);
    }

    // 3. Build statMaps (shared: weapon with powders applied).
    const weaponSM = ctx.expandItem(weapon);
    weaponSM.set('powders', decoded.powders?.[8] ?? []);
    ctx.apply_weapon_powders(weaponSM);

    // 4. Decode atree.
    const activeNodes = decodeActiveNodes(ctx, decoded.playerClass, decoded.atree_data);
    t.assert(activeNodes.length > 0, `${snapName}: ${activeNodes.length} active atree nodes`);

    // ═══════════════════════════════════════════════════════════════════════
    // PATH A: Builder stat assembly (via Build class, same as BuildAssembleNode)
    // ═══════════════════════════════════════════════════════════════════════

    // Wrap raw item data as Item objects (Build class reads item.statMap).
    const equipItems = equips.map(it => new ctx.Item(it));
    const weaponItem = new ctx.Item(weapon);
    // Apply powders to the weapon Item's statMap (must match weaponSM).
    weaponItem.statMap.set('powders', decoded.powders?.[8] ?? []);
    ctx.apply_weapon_powders(weaponItem.statMap);
    const tomeItems = resolvedTomes.map(it => new ctx.Item(it));

    // Wynn equip order for SP calc: boots→helmet, ring1→neck, guildTome only.
    // This matches BuildAssembleNode in shared_graph_nodes.js.
    const wynn_equip = [
        equipItems[3], equipItems[2], equipItems[1], equipItems[0],
        equipItems[4], equipItems[5], equipItems[6], equipItems[7],
        tomeItems[ctx.tome_fields.indexOf('guildTome1')],
    ];

    ctx.__level = decoded.level;
    ctx.__equips = equipItems;
    ctx.__tomes = tomeItems;
    ctx.__weapon = weaponItem;
    ctx.__wynn = wynn_equip;
    const builderBuild = vm.runInContext(
        'new Build(__level, __equips, __tomes, __weapon, __wynn)', ctx);
    delete ctx.__level; delete ctx.__equips; delete ctx.__tomes;
    delete ctx.__weapon; delete ctx.__wynn;

    // Extract builder statMap (mirrors SolverBuildStatExtractNode).
    const builder_sm = new Map(builderBuild.statMap);
    for (let i = 0; i < 5; i++) {
        builder_sm.set(ctx.skp_order[i], builderBuild.total_skillpoints[i]);
    }
    const weaponType = weaponSM.get('type');
    if (weaponType) {
        builder_sm.set('classDef', ctx.classDefenseMultipliers.get(weaponType) || 1.0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // PATH B: Solver stat assembly (via worker shims, same as solver worker)
    // ═══════════════════════════════════════════════════════════════════════

    const equipSMs = equips.map(it => ctx.expandItem(it));
    const tomeSMs = resolvedTomes.map(it => ctx.expandItem(it));

    // SP calculation: wynn order with guild tome only (matching builder path).
    const guildTomeIdx = ctx.tome_fields.indexOf('guildTome1');
    const solver_wynn_order = [
        equipSMs[3], equipSMs[2], equipSMs[1], equipSMs[0],
        equipSMs[4], equipSMs[5], equipSMs[6], equipSMs[7],
        tomeSMs[guildTomeIdx],
    ];
    const spResult = ctx.calculate_skillpoints(solver_wynn_order, weaponSM);
    t.assert(spResult !== null, `${snapName}: SP calculation succeeded`);
    const [, total_sp, , activeSetCounts] = spResult;

    // Build final statMap via worker shims.
    const locked_sms = [weaponSM, ...tomeSMs];
    const running = ctx._init_running_statmap(decoded.level, locked_sms);
    for (const sm of equipSMs) ctx._incr_add_item(running, sm);
    const solver_sm = ctx._finalize_leaf_statmap(
        running, weaponSM, activeSetCounts, ctx.sets, [...equipSMs, ...tomeSMs, weaponSM], null, null);

    for (let i = 0; i < 5; i++) solver_sm.set(ctx.skp_order[i], total_sp[i]);
    if (weaponType) {
        solver_sm.set('classDef', ctx.classDefenseMultipliers.get(weaponType) || 1.0);
    }

    // ═══════════════════════════════════════════════════════════════════════
    // COMPARE: Builder vs Solver statMaps (pre-atree)
    // ═══════════════════════════════════════════════════════════════════════

    compareStatMaps(`${snapName} pre-atree`, builder_sm, solver_sm, t);

    // 7. Atree merged → raw stats → scaling → spells.
    // Apply atree stats to BOTH statMaps independently.
    const atree_merged = buildAtreeMerged(ctx, decoded.playerClass, activeNodes, solver_sm, decoded.aspects);

    const rawStats = collectRawStats(ctx, atree_merged);
    for (const [stat, value] of rawStats) {
        ctx.merge_stat(builder_sm, stat, value);
        ctx.merge_stat(solver_sm, stat, value);
    }

    const button_states = snap.button_states ? new Map(Object.entries(snap.button_states)) : new Map();
    const slider_states = snap.slider_states ? new Map(Object.entries(snap.slider_states)) : new Map();

    const [, atree_scale_stats] = ctx.atree_compute_scaling(atree_merged, solver_sm, button_states, slider_states);
    for (const [stat, value] of atree_scale_stats) {
        ctx.merge_stat(builder_sm, stat, value);
        ctx.merge_stat(solver_sm, stat, value);
    }

    // Post-atree statMap comparison.
    compareStatMaps(`${snapName} post-atree`, builder_sm, solver_sm, t);

    const spellMap = collectSpells(ctx, atree_merged);
    t.assert(spellMap.size > 0, `${snapName}: ${spellMap.size} spells collected`);

    // 8. Build boost registry.
    ctx.__atree_tmp = atree_merged;
    const registry = vm.runInContext('build_combo_boost_registry(__atree_tmp, null)', ctx);
    delete ctx.__atree_tmp;

    // 9. Resolve combo rows from URL-decoded solver params.
    const comboRowsRaw = decoded.solverParams?.combo_rows ?? [];
    t.assert(comboRowsRaw.length > 0, `${snapName}: ${comboRowsRaw.length} combo rows in URL`);
    const parsedRows = resolveComboRows(comboRowsRaw, spellMap, atree_merged);

    // 10. Compute crit chance from each statMap.
    const builder_crit = ctx.skillPointsToPercentage(builder_sm.get('dex') || 0);
    const solver_crit = ctx.skillPointsToPercentage(solver_sm.get('dex') || 0);

    // 11. Cross-validate each combo row.
    //     Builder path uses builder_sm; solver path uses solver_sm via
    //     compute_combo_damage_totals. This catches both stat assembly
    //     divergences AND damage calculation divergences.
    const tolerance = 1e-6;
    let rowsTested = 0;

    // Run compute_combo_damage_totals (solver aggregate path) on solver_sm.
    ctx.__sm = solver_sm;
    ctx.__wsm = weaponSM;
    ctx.__rows = parsedRows;
    ctx.__cc = solver_crit;
    ctx.__reg = registry;
    ctx.__am = atree_merged;
    const solverTotals = vm.runInContext(
        'compute_combo_damage_totals(__sm, __wsm, __rows, __cc, __reg, __am, { detailed: true })', ctx);
    delete ctx.__sm; delete ctx.__wsm; delete ctx.__rows;
    delete ctx.__cc; delete ctx.__reg; delete ctx.__am;

    let builderTotalDamage = 0;
    let builderTotalHealing = 0;

    for (let i = 0; i < parsedRows.length; i++) {
        const row = parsedRows[i];
        const { qty, spell, boost_tokens, dmg_excl, pseudo, dps_hits_override } = row;
        const solverRow = solverTotals.per_row[i];

        if (!spell || qty <= 0 || pseudo) {
            t.assert(solverRow.damage === 0,
                `${snapName} row ${i}: skipped row (pseudo=${pseudo}) has zero damage`);
            continue;
        }

        // Apply boosts to BUILDER statMap (independent path).
        ctx.__sm = builder_sm;
        ctx.__bt = boost_tokens;
        ctx.__reg = registry;
        const boosted = vm.runInContext(
            'apply_combo_row_boosts(__sm, __bt, __reg, null)', ctx);
        delete ctx.__sm; delete ctx.__bt; delete ctx.__reg;

        const boostedStats = boosted.stats;
        const prop_overrides = boosted.prop_overrides;

        // Apply spell prop overrides.
        ctx.__spell = spell;
        ctx.__po = prop_overrides;
        ctx.__am = atree_merged;
        const modSpell = vm.runInContext(
            'apply_spell_prop_overrides(__spell, __po, __am)', ctx);
        delete ctx.__spell; delete ctx.__po; delete ctx.__am;

        // DPS spell detection.
        ctx.__ms = modSpell;
        const dpsInfo = vm.runInContext('compute_dps_spell_hits_info(__ms)', ctx);
        delete ctx.__ms;

        let effDpsName = null;
        let effDpsHits = 0;
        if (dpsInfo) {
            effDpsName = dpsInfo.per_hit_name;
            effDpsHits = dps_hits_override ?? dpsInfo.max_hits;
        }

        // ── Builder path: per-row damage (using builder_sm stats) ──
        let builderPerCast;
        if (effDpsName) {
            const perHit = evalSpellBuilderAvg(modSpell, boostedStats, weaponSM, builder_crit, effDpsName);
            builderPerCast = perHit * effDpsHits;
        } else {
            builderPerCast = evalSpellBuilderAvg(modSpell, boostedStats, weaponSM, builder_crit, null);
        }

        // ── Solver path: per-row damage (from compute_combo_damage_totals) ──
        const solverPerCast = solverRow.damage;

        // Compare per-cast damage.
        const denom = Math.max(Math.abs(builderPerCast), 1);
        const relErr = Math.abs(builderPerCast - solverPerCast) / denom;
        const boostDesc = boost_tokens.length > 0
            ? ` [${boost_tokens.map(b => `${b.name}=${b.value}${b.is_pct ? '%' : ''}`).join(', ')}]`
            : '';
        const dpsDesc = effDpsName ? ` (DPS: ${effDpsHits} hits)` : '';
        const rowLabel = `${snapName} row ${i}: ${spell.name}${boostDesc}${dpsDesc}`;

        if (relErr <= tolerance) {
            t.assert(true, `${rowLabel} damage matched`);
        } else {
            t.assert(false,
                `${rowLabel} damage mismatch: builder=${builderPerCast.toFixed(2)} solver=${solverPerCast.toFixed(2)} relErr=${relErr.toFixed(6)}`);
        }

        // Compare per-cast healing.
        const builderHeal = evalSpellBuilderHealing(modSpell, boostedStats);
        const solverHeal = solverRow.healing;
        const healDenom = Math.max(Math.abs(builderHeal), 1);
        const healErr = Math.abs(builderHeal - solverHeal) / healDenom;
        if (healErr <= tolerance) {
            t.assert(true, `${rowLabel} healing matched`);
        } else {
            t.assert(false,
                `${rowLabel} healing mismatch: builder=${builderHeal.toFixed(2)} solver=${solverHeal.toFixed(2)} relErr=${healErr.toFixed(6)}`);
        }

        // Accumulate totals for aggregate check.
        const rowDamage = dmg_excl ? 0 : builderPerCast * qty;
        const rowHealing = builderHeal * qty;
        builderTotalDamage += rowDamage;
        builderTotalHealing += rowHealing;

        rowsTested++;
    }

    // 12. Verify aggregate totals match.
    const totalDmgDenom = Math.max(Math.abs(builderTotalDamage), 1);
    const totalDmgErr = Math.abs(builderTotalDamage - solverTotals.total_damage) / totalDmgDenom;
    t.assert(totalDmgErr <= tolerance,
        totalDmgErr <= tolerance
            ? `${snapName}: total damage matched (${Math.round(solverTotals.total_damage)})`
            : `${snapName}: total damage mismatch: builder=${builderTotalDamage.toFixed(2)} solver=${solverTotals.total_damage.toFixed(2)} relErr=${totalDmgErr.toFixed(6)}`);

    const totalHealDenom = Math.max(Math.abs(builderTotalHealing), 1);
    const totalHealErr = Math.abs(builderTotalHealing - solverTotals.total_healing) / totalHealDenom;
    t.assert(totalHealErr <= tolerance,
        totalHealErr <= tolerance
            ? `${snapName}: total healing matched (${Math.round(solverTotals.total_healing)})`
            : `${snapName}: total healing mismatch: builder=${builderTotalHealing.toFixed(2)} solver=${solverTotals.total_healing.toFixed(2)} relErr=${totalHealErr.toFixed(6)}`);

    console.log(`  [${snapName}] cross-validated ${rowsTested} combo rows (class=${decoded.playerClass}, weapon=${weaponName})`);
}

// ── Discover and run test cases ──────────────────────────────────────────────

const snapDir = path.join(__dirname, 'snapshots');
const comboSnaps = fs.readdirSync(snapDir)
    .filter(f => f.startsWith('combo_') && f.endsWith('.snap.json'))
    .map(f => f.replace('.snap.json', ''));

if (comboSnaps.length === 0) {
    t.warn('No combo snapshots found. Create snapshots/combo_*.snap.json to add test cases.');
    t.warn('See README.md for snapshot format.');
}

for (const snapName of comboSnaps) {
    try {
        runComboTest(snapName);
    } catch (err) {
        t.assert(false, `${snapName}: threw error — ${err.message}`);
        console.error(err.stack);
    }
}

// ── Summary ──────────────────────────────────────────────────────────────────

const summary = t.summary();
if (require.main === module) {
    if (summary.fail > 0) process.exit(1);
}
module.exports = summary;
