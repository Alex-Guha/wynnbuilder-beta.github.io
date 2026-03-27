/**
 * Shared spell damage computation and display nodes used by both the Builder
 * and Solver pages.
 *
 * These are instantiated dynamically by atree.js (AbilityTreeEnsureNodesNode)
 * via `new SpellDamageCalcNode(spell)` and `new SpellDisplayNode(spell)`.
 *
 * Dependencies (must be loaded before this file):
 *   - computation_graph.js: ComputeNode
 *   - damage_calc.js:       calculateSpellDamage
 *   - shared_game_stats.js: getDefenseStats
 *   - display.js:           displaySpellDamage
 */

/**
 * Compute spell damage of spell parts.
 *
 * Inputs: build (Build object), stats (StatMap)
 * Output: List[SpellDamage]
 */
class SpellDamageCalcNode extends ComputeNode {
    constructor(spell) {
        super('spell' + spell.base_spell + '-calc');
        this.spell = spell;
    }

    compute_func(input_map) {
        const weapon = input_map.get('build').weapon.statMap;
        const spell  = this.spell;
        const stats  = input_map.get('stats');
        const use_speed = ('use_atkspd' in spell) ? spell.use_atkspd : true;
        const use_spell = ('scaling'   in spell) ? spell.scaling === 'spell' : true;

        let display_spell_results = [];
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
                    normal_min:   results[2].map(x => x[0]),
                    normal_max:   results[2].map(x => x[1]),
                    normal_total: results[0],
                    crit_min:     results[2].map(x => x[2]),
                    crit_max:     results[2].map(x => x[3]),
                    crit_total:   results[1],
                    is_spell:     use_spell,
                    multipliers:  results[3],
                };
            } else if ('max_hp_heal_pct' in part) {
                const mult_map = stats.get('healMult');
                let heal_mult = 1;
                for (const [k, v] of mult_map.entries()) {
                    if (k.includes(':') && k.split(':')[1] !== part_id) continue;
                    heal_mult *= (1 + v / 100);
                }
                spell_result = {
                    type: 'heal',
                    heal_amount: part.max_hp_heal_pct * getDefenseStats(stats)[0] * heal_mult,
                };
            } else {
                spell_result = {
                    normal_min:   [0, 0, 0, 0, 0, 0],
                    normal_max:   [0, 0, 0, 0, 0, 0],
                    normal_total: [0, 0],
                    crit_min:     [0, 0, 0, 0, 0, 0],
                    crit_max:     [0, 0, 0, 0, 0, 0],
                    crit_total:   [0, 0],
                    heal_amount:  0,
                    multipliers:  [0, 0, 0, 0, 0, 0],
                };
                const dam_keys = ['normal_min', 'normal_max', 'normal_total',
                                  'crit_min', 'crit_max', 'crit_total', 'multipliers'];
                for (const [sub_name, hits] of Object.entries(part.hits)) {
                    const sub = eval_part(sub_name);
                    if (!sub) continue;
                    if (spell_result.type) {
                        if (sub.type !== spell_result.type) throw new Error('SpellCalc total subpart type mismatch');
                    } else {
                        spell_result.type = sub.type;
                    }
                    if (spell_result.type === 'damage') {
                        for (const key of dam_keys) {
                            for (let i in spell_result.normal_min) {
                                spell_result[key][i] += sub[key][i] * hits;
                            }
                        }
                    } else {
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

        for (const part of spell.parts) {
            display_spell_results.push(eval_part(part.name));
        }
        return display_spell_results;
    }
}

/**
 * Display spell damage from spell parts.
 *
 * Inputs: stats (StatMap), spell-damage (List[SpellDamage])
 * Output: null (renders to DOM)
 */
class SpellDisplayNode extends ComputeNode {
    constructor(spell) {
        super('spell' + spell.base_spell + '-display');
        this.spell = spell;
    }

    compute_func(input_map) {
        const stats   = input_map.get('stats');
        const damages = input_map.get('spell-damage');
        const spell   = this.spell;
        const i = spell.base_spell;
        const parent_elem        = document.getElementById('spell' + i + '-info');
        const overallparent_elem = document.getElementById('spell' + i + '-infoAvg');
        displaySpellDamage(parent_elem, overallparent_elem, stats, spell, i, damages);
    }
}
