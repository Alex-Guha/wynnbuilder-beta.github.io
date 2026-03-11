// SpellDamageCalcNode and SpellDisplayNode are defined in shared_spell_nodes.js.
// computeSpellDisplayAvg, computeSpellDisplayFull are defined in solver_pure.js.

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
        const c_avg  = (part.crit_total[0]   + part.crit_total[1])   / 2;
        const p_avg  = (1 - crit_chance) * nc_avg + crit_chance * c_avg;
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
 * Returns the powder special tier (1-5) for a given element on a set of powders,
 * or 0 if no powders of that element are present.
 * element_idx: 0=earth, 1=thunder, 2=water, 3=fire, 4=air  (same as powderSpecialStats order).
 */
function get_element_powder_tier(powders, element_idx) {
    const count = powders.filter(pid => ((pid / POWDER_TIERS) | 0) === element_idx).length;
    return count > 0 ? Math.min(count, 5) : 0;
}

/**
 * Build a synthetic spell object for a damaging powder special.
 * ps_idx: 0=Quake(earth), 1=Chain Lightning(thunder), 3=Courage(fire)
 * Tier: 1-5.  The returned object is compatible with computeSpellDisplayAvg().
 */
function make_powder_special_spell(ps_idx, tier) {
    const ps          = powderSpecialStats[ps_idx];
    const element_num = ps_idx + 1;   // damage_keys index: 1=earth, 2=thunder, 4=fire
    const damage_pct  = ps.weaponSpecialEffects.get('Damage')[tier - 1];
    const conversions = [0, 0, 0, 0, 0, 0];
    conversions[element_num] = damage_pct;
    return {
        name:        ps.weaponSpecialName,
        base_spell:  0,
        cost:        undefined,   // powder specials don't have a regular mana cost
        scaling:     'melee',     // use_spell_damage = false (matches display.js call)
        use_atkspd:  false,       // ignore_speed = true
        parts: [{ name: 'hit', display: true, multipliers: conversions }],
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
    const registry    = [];
    const toggle_seen = new Set();   // toggle name → already added
    const slider_idx  = new Map();   // slider_name → index in registry

    if (!atree_merged) return registry;

    // Pass 1: accumulate total slider_max per slider_name.
    // Only explicitly-set slider_max values are summed (undefined means "doesn't add to max").
    // behavior:'overwrite' effects replace the total rather than adding to it.
    const slider_total_max = new Map();
    const slider_overwrite_max = new Map();
    for (const [, abil] of atree_merged) {
        for (const effect of abil.effects) {
            if (effect.type === 'stat_scaling' && effect.slider === true && effect.slider_name) {
                const name = effect.slider_name;
                if (effect.behavior === 'overwrite') {
                    if (effect.slider_max != null) {
                        slider_overwrite_max.set(name, Math.max(slider_overwrite_max.get(name) ?? 0, effect.slider_max));
                    }
                } else if (effect.slider_max != null) {
                    // Only sum explicitly-set values; omitting slider_max means this effect
                    // does not extend the range (e.g. Breathless, Transonic Warp).
                    slider_total_max.set(name, (slider_total_max.get(name) ?? 0) + effect.slider_max);
                }
            }
        }
    }
    // Overwrite takes precedence over the accumulated sum.
    for (const [name, max] of slider_overwrite_max) {
        slider_total_max.set(name, max);
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
                if (toggle_seen.has(toggle_name)) continue;

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
                if (stat_bonuses.length > 0 || prop_bonuses.length > 0) {
                    toggle_seen.add(toggle_name);
                    registry.push({ name: toggle_name, aliases: [], type: 'toggle', stat_bonuses, prop_bonuses });
                }
            } else if (effect.type === 'stat_scaling' && effect.slider === true) {
                const slider_name = effect.slider_name;

                const stat_bonuses = [];
                const prop_bonuses = [];
                const outputs = Array.isArray(effect.output) ? effect.output : (effect.output ? [effect.output] : []);
                const scaling = Array.isArray(effect.scaling) ? effect.scaling : [effect.scaling ?? 1];
                for (let i = 0; i < outputs.length; i++) {
                    const out   = outputs[i];
                    const scale = scaling[i] ?? scaling[0] ?? 1;
                    if (out.type === 'stat') {
                        stat_bonuses.push({ key: out.name, value: scale, mode: 'add' });
                    } else if (out.type === 'prop') {
                        prop_bonuses.push({ ref: String(out.abil) + '.' + out.name, value_per_unit: scale });
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
                        max:  slider_total_max.get(slider_name) ?? (effect.slider_max ?? 10),
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
        const weapon_powders = build.weapon.statMap.get('powders') ?? [];

        // Weapon specials that add a damage multiplier (Curse=water, Courage=fire, Wind Prison=air).
        // ps_idx 2=Curse, 3=Courage, 4=Wind Prison; their element_idx matches ps_idx.
        const weapon_buff_ps = [
            { ps_idx: 2, elem: 2 },   // Curse (water)
            { ps_idx: 3, elem: 3 },   // Courage (fire) — damage-boost part
            { ps_idx: 4, elem: 4 },   // Wind Prison (air)
        ];
        for (const { ps_idx, elem } of weapon_buff_ps) {
            const tier = get_element_powder_tier(weapon_powders, elem);
            if (tier === 0) continue;
            const ps    = powderSpecialStats[ps_idx];
            const boost = ps.weaponSpecialEffects.get('Damage Boost')[tier - 1];
            registry.push({
                name: ps.weaponSpecialName,
                aliases: [],
                type: 'toggle',
                stat_bonuses: [{ key: 'damMult.' + ps.weaponSpecialName, value: boost, mode: 'add' }],
                prop_bonuses: [],
            });
        }

        // Armor specials: collect element powder counts across all armor pieces (helm, chest, legs, boots).
        // ps_idx: 0=Rage(earth), 1=Kill Streak(thunder), 2=Concentration(water), 3=Endurance(fire), 4=Dodge(air)
        const armor_elem_counts = new Array(5).fill(0);
        for (let i = 0; i < 4; i++) {
            const armor_powders = build.equipment[i]?.statMap?.get('powders') ?? [];
            for (const pid of armor_powders) {
                const elem = (pid / POWDER_TIERS) | 0;
                if (elem < 5) armor_elem_counts[elem]++;
            }
        }
        const armor_ps_defs = [
            { elem: 0, max: 75,  step: 1,  label: 'Rage (%HP missing)'        },   // Rage
            { elem: 1, max: 15,  step: 1,  label: 'Kill Streak (mobs killed)'  },   // Kill Streak
            { elem: 2, max: 100, step: 1,  label: 'Concentration (mana spent)' },   // Concentration
            { elem: 3, max: 30,  step: 1,  label: 'Endurance (hits taken)'     },   // Endurance
            { elem: 4, max: 10,  step: 1,  label: 'Dodge (near mobs)'          },   // Dodge
        ];
        for (const { elem, max, step, label } of armor_ps_defs) {
            const count = armor_elem_counts[elem];
            if (count === 0) continue;
            const tier      = Math.min(count, 5);
            const ps        = powderSpecialStats[elem];
            const per_unit  = ps.armorSpecialEffects.get('Damage')[tier - 1];
            registry.push({
                name: label,
                aliases: [ps.armorSpecialName],
                type: 'slider',
                max, step,
                stat_bonuses: [{ key: 'damMult.' + ps.armorSpecialName, value: per_unit, mode: 'add' }],
                prop_bonuses: [],
            });
        }
    }

    return registry;
}

// find_all_matching_boosts, apply_combo_row_boosts, apply_spell_prop_overrides,
// spell_has_damage, spell_has_heal, computeSpellHealingTotal are defined in solver_pure.js.

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
