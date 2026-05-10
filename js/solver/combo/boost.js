// SpellDamageCalcNode and SpellDisplayNode are defined in shared_spell_nodes.js.
// computeSpellDisplayAvg, computeSpellDisplayFull are defined in pure/spell.js.

/**
 * Builds the inner HTML for the per-spell damage breakdown popup.
 * Mirrors WynnBuilder's displaySpellDamage() output format:
 *   Spell name (mana cost)
 *   Per part: element-coloured multiplier %s, Average, Non-Crit ranges, Crit ranges
 *   Crit chance footer.
 *
 * @param {object} full   Return value of computeSpellDisplayFull (non-null)
 * @param {number} crit_chance  0–1
 * @param {number|null} spell_cost  Pre-computed mana cost (null = no cost to show)
 */
function renderSpellPopupHTML(full, crit_chance, spell_cost) {
    const fmtN = n => Math.round(n).toLocaleString();

    let html = '';

    // ── Header: spell name + optional mana cost ──────────────────────────────
    if (full.has_cost && spell_cost != null) {
        html += `<div class="fw-bold">${full.spell_name} <span class="Mana">(${spell_cost.toFixed(1)})</span></div>`;
    } else {
        html += `<div class="fw-bold">${full.spell_name}</div>`;
    }

    // ── Per-part breakdown ────────────────────────────────────────────────────
    for (const part of full.parts) {
        html += '<hr class="my-1">';
        html += `<div class="text-secondary" style="font-size:0.9em">${part.name}</div>`;

        // Multiplier percentages (element-coloured)
        if (part.multipliers) {
            let mult_bits = [];
            let total_mult = 0;
            for (let i = 0; i < 6; i++) {
                const m = part.multipliers[i];
                if (m > 0.01) {
                    mult_bits.push(`<span class="${damageClasses[i]}">${Math.round(m * 10) / 10}%</span>`);
                    total_mult += m;
                }
            }
            if (mult_bits.length > 0) {
                const type_label = part.is_spell ? 'Spell' : 'Melee';
                html += `<div>${mult_bits.join(' ')} <span class="text-secondary">(${Math.round(total_mult * 10) / 10}%) ${type_label}</span></div>`;
            }
        }

        const nc_avg = (part.normal_total[0] + part.normal_total[1]) / 2;
        const c_avg = (part.crit_total[0] + part.crit_total[1]) / 2;
        const p_avg = (1 - crit_chance) * nc_avg + crit_chance * c_avg;
        html += `<div>Average: ${fmtN(p_avg)}</div>`;

        // Non-crit
        html += `<div>Non-Crit: ${fmtN(nc_avg)}</div>`;
        if (part.normal_min) {
            for (let i = 0; i < 6; i++) {
                if (part.normal_max[i] > 0.5) {
                    html += `<div class="${damageClasses[i]}">&nbsp;&nbsp;${fmtN(part.normal_min[i])} \u2013 ${fmtN(part.normal_max[i])}</div>`;
                }
            }
        }

        // Crit
        html += `<div>Crit: ${fmtN(c_avg)}</div>`;
        if (part.crit_min) {
            for (let i = 0; i < 6; i++) {
                if (part.crit_max[i] > 0.5) {
                    html += `<div class="${damageClasses[i]}">&nbsp;&nbsp;${fmtN(part.crit_min[i])} \u2013 ${fmtN(part.crit_max[i])}</div>`;
                }
            }
        }
    }

    // ── Footer: crit chance ───────────────────────────────────────────────────
    html += '<hr class="my-1">';
    html += `<div class="text-secondary">Crit chance: ${Math.round(crit_chance * 100)}%</div>`;

    return html;
}

// ── Powder special helpers ────────────────────────────────────────────────────

/**
 * Determine which (single) powder special is activated on one item — applies to
 * both weapons and armor pieces (in-game rule is identical for both).
 *
 * Rule: scan powders in application order; the first powder that is T4+ AND has a
 * later T4+ partner of the same element wins.  That pair determines both the element
 * (i.e. which special) and the tier.  Any other powders on the item are irrelevant
 * to the special — only the activating pair matters, regardless of how many other
 * same-element or different-element powders exist.
 *
 * Returns { ps_idx, tier } where ps_idx is 0..4 (matching powderSpecialStats order:
 * 0=earth/Rage|Quake, 1=thunder/Kill Streak|Chain Lightning, 2=water/Concentration|Curse,
 * 3=fire/Endurance|Courage, 4=air/Dodge|Wind Prison).  tier is 1-based — caller does
 * `tier - 1` to index into the effect arrays.  Returns null if no special is active.
 */
function get_powder_special(powders) {
    for (let i = 0; i < powders.length; i++) {
        const tier_i = powders[i] % POWDER_TIERS;
        if (tier_i <= 2) continue;
        const elem_i = (powders[i] / POWDER_TIERS) | 0;
        for (let j = i + 1; j < powders.length; j++) {
            const tier_j = powders[j] % POWDER_TIERS;
            if (tier_j <= 2) continue;
            const elem_j = (powders[j] / POWDER_TIERS) | 0;
            if (elem_j !== elem_i) continue;
            return { ps_idx: elem_i, tier: tier_i + tier_j - 5 };
        }
    }
    return null;
}

/**
 * Build a synthetic spell object for a damaging powder special.
 * ps_idx: 0=Quake(earth), 1=Chain Lightning(thunder), 3=Courage(fire)
 * Tier: 1-7.  The returned object is compatible with computeSpellDisplayAvg().
 */
function make_powder_special_spell(ps_idx, tier) {
    const ps = powderSpecialStats[ps_idx];
    const element_num = ps_idx + 1;   // damage_keys index: 1=earth, 2=thunder, 4=fire
    const damage_pct = ps.weaponSpecialEffects.get('Damage')[tier - 1];
    const conversions = [0, 0, 0, 0, 0, 0];
    conversions[element_num] = damage_pct;
    // Mirror builder displayPowderSpecials: a special's own Damage Boost must not
    // apply to its own damage hit (only Courage has both, but ignoring is harmless
    // for Quake / Chain Lightning since they have no Damage Boost).
    return {
        name: ps.weaponSpecialName,
        base_spell: 0,
        cost: undefined,   // powder specials don't have a regular mana cost
        scaling: 'melee',     // use_spell_damage = false (matches display.js call)
        use_atkspd: false,       // ignore_speed = true
        parts: [{
            name: 'Powder Special',
            display: true,
            multipliers: conversions,
            ignored_mults: [ps.weaponSpecialName],
        }],
        _is_powder_special: true,
    };
}

// ── Combo boost registry ──────────────────────────────────────────────────────

/**
 * Build a boost registry from the current ability tree (raw_stat toggles + stat_scaling sliders)
 * plus powder special buffs derived from the current build's weapon and armor powders.
 *
 * Each entry: { name, aliases[], type:'toggle'|'slider',
 *               max?, step?,
 *               stat_bonuses: [{key, value, mode}],
 *               prop_bonuses: [{ref:'abilId.propName', value_per_unit}] }
 *
 * Deduplication: toggles with the same name are skipped after the first.
 * Sliders with the same slider_name are merged: slider_max values are summed.
 */
function build_combo_boost_registry(atree_merged, build = null) {
    const registry = [];
    const toggle_seen = new Map();   // toggle name → index in registry
    const slider_idx = new Map();   // slider_name → index in registry

    if (!atree_merged) return registry;

    // Pass 1: accumulate total slider_max per slider_name.
    // Only explicitly-set slider_max values are summed (undefined means "doesn't add to max").
    // behavior:'overwrite' effects replace the total rather than adding to it.
    // slider_max_mult factors are accumulated multiplicatively and applied after all additive contributions.
    const slider_total_max = new Map();
    const slider_overwrite_max = new Map();
    const slider_total_mult = new Map();
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type === 'stat_scaling' && effect.slider === true && effect.slider_name) {
                const name = effect.slider_name;
                if (effect.behavior === 'overwrite') {
                    if (effect.slider_max != null) {
                        slider_overwrite_max.set(name, Math.max(slider_overwrite_max.get(name) ?? 0, effect.slider_max));
                    }
                } else {
                    if (effect.slider_max != null) {
                        // Only sum explicitly-set values; omitting slider_max means this effect
                        // does not extend the range (e.g. Breathless, Transonic Warp).
                        slider_total_max.set(name, (slider_total_max.get(name) ?? 0) + effect.slider_max);
                    }
                    if (effect.slider_max_mult != null) {
                        slider_total_mult.set(name, (slider_total_mult.get(name) ?? 1) * effect.slider_max_mult);
                    }
                }
            }
        }
    }
    // Overwrite takes precedence over the accumulated sum.
    for (const [name, max] of slider_overwrite_max) {
        slider_total_max.set(name, max);
    }
    // Apply multiplicative factors after additive accumulation.
    for (const [name, mult] of slider_total_mult) {
        if (mult !== 1) {
            const base = slider_total_max.get(name) ?? 0;
            slider_total_max.set(name, Math.round(base * mult));
        }
    }

    // Pass 2: build registry entries.
    // For toggles: first unique name wins.
    // For sliders: ALL effects with the same slider_name are merged into one entry so
    //              that moving the slider applies every ability's per-stack contribution
    //              (e.g. Windsweeper + Breathless + Thunderstorm all affect Winded at once).
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type === 'raw_stat' && effect.toggle) {
                const toggle_name = effect.toggle;

                const stat_bonuses = [];
                const prop_bonuses = [];
                for (const bonus of (effect.bonuses ?? [])) {
                    let val = bonus.value;
                    // Resolve "abilId.propName" string references.
                    if (typeof val === 'string') {
                        const [id_str, prop] = val.split('.');
                        val = atree_merged.get(parseInt(id_str))?.properties?.[prop] ?? 0;
                    }
                    if (typeof val !== 'number') continue;
                    if (bonus.type === 'stat') {
                        stat_bonuses.push({ key: bonus.name, value: val, mode: 'add' });
                    } else if (bonus.type === 'prop') {
                        prop_bonuses.push({ ref: String(bonus.abil) + '.' + bonus.name, value_per_unit: val, mode: 'add' });
                    }
                }
                if (stat_bonuses.length === 0 && prop_bonuses.length === 0) continue;

                // Merge into existing entry if toggle name was already seen
                // (e.g. Ambush adds to Surprise Strike's toggle).
                if (toggle_seen.has(toggle_name)) {
                    const existing = registry[toggle_seen.get(toggle_name)];
                    existing.stat_bonuses.push(...stat_bonuses);
                    existing.prop_bonuses.push(...prop_bonuses);
                } else {
                    toggle_seen.set(toggle_name, registry.length);
                    registry.push({ name: toggle_name, aliases: [], type: 'toggle', stat_bonuses, prop_bonuses });
                }
            } else if (effect.type === 'stat_scaling' && effect.slider === true) {
                const slider_name = effect.slider_name;

                const stat_bonuses = [];
                const prop_bonuses = [];
                const outputs = Array.isArray(effect.output) ? effect.output : (effect.output ? [effect.output] : []);
                const scaling = Array.isArray(effect.scaling) ? effect.scaling : [effect.scaling ?? 1];
                for (let i = 0; i < outputs.length; i++) {
                    const out = outputs[i];
                    let scale = scaling[i] ?? scaling[0] ?? 1;
                    // Resolve "abilId.propName" string references (e.g. "77.momentum_scaling").
                    if (typeof scale === 'string') scale = atree_translate(atree_merged, scale);
                    if (out.type === 'stat') {
                        const sb = { key: out.name, value: scale, mode: 'add' };
                        if (effect.round === false) sb.round = false;
                        if (typeof effect.max === 'number') sb.max = effect.max;
                        stat_bonuses.push(sb);
                    } else if (out.type === 'prop') {
                        const target_abil = atree_merged.get(out.abil);
                        const pb = {
                            ref: String(out.abil) + '.' + out.name, value_per_unit: scale,
                            base: target_abil?.properties?.[out.name] ?? 0
                        };
                        if (typeof effect.max === 'number') pb.max = effect.max;
                        if (effect.round === true) pb.round = true;
                        prop_bonuses.push(pb);
                    }
                }

                if (stat_bonuses.length === 0 && prop_bonuses.length === 0) continue;

                if (slider_idx.has(slider_name)) {
                    // Merge into the existing entry so all per-stack contributions are combined.
                    const existing = registry[slider_idx.get(slider_name)];
                    existing.stat_bonuses.push(...stat_bonuses);
                    existing.prop_bonuses.push(...prop_bonuses);
                } else {
                    slider_idx.set(slider_name, registry.length);
                    registry.push({
                        name: slider_name,
                        display_label: slider_name === 'Hits dealt' ? abil.display_name : undefined,
                        aliases: [],
                        type: 'slider',
                        min: effect.slider_min ?? 0,
                        max: slider_total_max.get(slider_name) ?? (effect.slider_max ?? 10),
                        step: effect.slider_step ?? 1,
                        stat_bonuses,
                        prop_bonuses,
                    });
                }
            }
        }
    }

    // ── Powder buff entries (weapon + armor specials) ─────────────────────────
    if (build) {
        // Weapon special: at most ONE special activates per weapon (the first T4+
        // same-element pair wins — see get_powder_special).  Curse/Courage/Wind Prison
        // additionally contribute a Damage Boost multiplier toggle to the registry;
        // Quake / Chain Lightning are damaging-only and don't appear here.
        const weapon_powders = build.weapon.statMap.get('powders') ?? [];
        const weapon_special = get_powder_special(weapon_powders);
        if (weapon_special) {
            const ps = powderSpecialStats[weapon_special.ps_idx];
            if (ps.weaponSpecialEffects.has('Damage Boost')) {
                const boost = ps.weaponSpecialEffects.get('Damage Boost')[weapon_special.tier - 1];
                registry.push({
                    name: ps.weaponSpecialName,
                    aliases: [],
                    type: 'toggle',
                    stat_bonuses: [{ key: 'damMult.' + ps.weaponSpecialName, value: boost, mode: 'add' }],
                    prop_bonuses: [],
                });
            }
        }

        // Armor specials: mirror builder's per-element "% {Earth/Thunder/…} Dmg Boost"
        // sliders (see builder.js init: gen_slider_labeled with max=ps.cap, fed into
        // armor_powder_node which writes {x}DamPct).  Each piece independently
        // activates at most one special via its first T4+ same-element pair, so we
        // only register a slider for specials that at least one piece activates —
        // showing all 5 in the solver registry would clutter the boost dropdown
        // with options the build can never produce in-game.
        // ps_idx → element: 0=e, 1=t, 2=w, 3=f, 4=a.
        const armor_active = new Array(5).fill(false);
        for (let i = 0; i < 4; i++) {
            const armor_powders = build.equipment[i]?.statMap?.get('powders') ?? [];
            const activated = get_powder_special(armor_powders);
            if (activated) armor_active[activated.ps_idx] = true;
        }
        for (let ps_idx = 0; ps_idx < 5; ps_idx++) {
            if (!armor_active[ps_idx]) continue;
            const ps = powderSpecialStats[ps_idx];
            registry.push({
                name: '% ' + damageClasses[ps_idx + 1] + ' Dmg Boost',
                aliases: [ps.armorSpecialName],
                type: 'slider',
                max: ps.cap,
                step: 1,
                stat_bonuses: [{ key: skp_elements[ps_idx] + 'DamPct', value: 1, mode: 'add' }],
                prop_bonuses: [],
            });
        }
    }

    // ── Trigger slider entries (e.g. Intoxicating Blood's "Enemies Per Hit") ──
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'trigger') continue;
            if (!effect.slider_name || slider_idx.has(effect.slider_name)) continue;
            slider_idx.set(effect.slider_name, registry.length);
            registry.push({
                name: effect.slider_name,
                aliases: [],
                type: 'slider',
                max: effect.slider_max ?? 10,
                step: effect.slider_step ?? 1,
                stat_bonuses: [],
                prop_bonuses: [],
            });
        }
    }

    // After building registry, scan atree for replace_spell effects to map prop refs → base_spells.
    const prop_ref_to_spells = new Map();  // "abilId.propName" → Set of base_spell IDs
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'replace_spell') continue;
            for (const part of (effect.parts ?? [])) {
                for (const val of Object.values(part.hits ?? {})) {
                    if (typeof val === 'string') {
                        if (!prop_ref_to_spells.has(val)) prop_ref_to_spells.set(val, new Set());
                        prop_ref_to_spells.get(val).add(effect.base_spell);
                    }
                }
            }
        }
    }
    // Also scan add_spell_prop effects for hit refs (e.g. Meteor Shower, Shrapnel Bomb).
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type !== 'add_spell_prop') continue;
            if (effect.target_part && 'hits' in effect) {
                for (const val of Object.values(effect.hits)) {
                    if (typeof val === 'string') {
                        if (!prop_ref_to_spells.has(val)) prop_ref_to_spells.set(val, new Set());
                        prop_ref_to_spells.get(val).add(effect.base_spell);
                    }
                }
            }
        }
    }
    // Annotate entries that have prop_bonuses with their target spells.
    for (const entry of registry) {
        if (entry.prop_bonuses.length > 0) {
            const targets = new Set();
            for (const p of entry.prop_bonuses) {
                const s = prop_ref_to_spells.get(p.ref);
                if (s) for (const id of s) targets.add(id);
            }
            entry.prop_target_spells = targets;
        }
    }

    return registry;
}

// find_all_matching_boosts, apply_combo_row_boosts, apply_spell_prop_overrides
// are defined in pure/boost.js.
// spell_has_damage, spell_has_heal, computeSpellHealingTotal are defined in pure/spell.js.

/**
 * Parse the boost column of a combo row (comma-separated boost tokens).
 * Returns [{name, value, is_pct}].
 *   - "Boost N%"  → {name:'Boost', value:N, is_pct:true}
 *   - "Boost N"   → {name:'Boost', value:N, is_pct:false}
 *   - "Boost"     → {name:'Boost', value:1, is_pct:false}
 */
function parse_combo_boost_tokens(boost_str) {
    const boost_tokens = [];
    for (const raw_tok of boost_str.split(',')) {
        const tok = raw_tok.trim();
        if (!tok) continue;
        const m = tok.match(/^(.*?)\s+(\d+(?:\.\d+)?)(%?)$/);
        if (m) {
            boost_tokens.push({ name: m[1].trim(), value: parseFloat(m[2]), is_pct: m[3] === '%' });
        } else {
            boost_tokens.push({ name: tok, value: 1, is_pct: false });
        }
    }
    return boost_tokens;
}

/**
 * Apply deferred powder special effects from atree_collect_spells to
 * all powder special entries in an augmented spell map.
 * @param {Map} aug_map - Augmented spell map (with PS entries keyed as -100x)
 * @param {Map} base_spell_map - Return value of atree_collect_spells (has _powder_special_effects)
 */
function apply_deferred_powder_special_effects(aug_map, base_spell_map) {
    const ps_effects = base_spell_map?._powder_special_effects;
    if (!ps_effects?.length) return;
    for (const [, spell] of aug_map) {
        if (!spell._is_powder_special) continue;
        for (const eff of ps_effects) {
            for (const key in eff) {
                if (_ASPELL_META.has(key)) continue;
                if (typeof eff[key] !== 'number') continue;
                spell[key] = (spell[key] ?? 0) + eff[key];
            }
        }
    }
}

// ── SolverComboTotalNode ──────────────────────────────────────────────────────

/**
 * Computes per-row combo damage total using per-row boost specifications.
 *
 * Inputs: build, base-stats (StatMap without potion boosts),
 *         spells (Map[id,Spell]), atree-merged (Map[id,Ability]).
 * Output: null (always). URL is updated asynchronously via _schedule_solver_hash_update.
 * Also updates #combo-total-avg DOM element directly.
 *
 * Also manages selection-mode row UI (spell dropdowns + boost controls).
 */
