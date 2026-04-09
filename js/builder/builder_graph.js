/**
 * File containing compute graph structure of the builder page.
 */

let armor_powder_node = new (class extends ComputeNode {
    constructor() { super('builder-armor-powder-input'); }

    compute_func(input_map) {
        let damage_boost = 0;
        let def_boost = 0;
        let statMap = new Map();
        for (const [e, elem] of zip2(skp_elements, skp_order)) {
            let val = parseInt(document.getElementById(elem + "_boost_armor").value);
            statMap.set(e + 'DamPct', val);
        }
        return statMap;
    }
})();

// compute_boosts is defined in shared_graph_nodes.js

let boosts_node = new (class extends ComputeNode {
    constructor() { super('builder-boost-input'); }
    compute_func(_input_map) { return compute_boosts(); }
})().update();

/* Updates all spell boosts
*/
function update_boosts(buttonId) {
    let elem = document.getElementById(buttonId);
    if (elem.classList.contains("toggleOn")) {
        elem.classList.remove("toggleOn");
    } else {
        elem.classList.add("toggleOn");
    }
    boosts_node.mark_dirty().update();
}

// specialNames is defined in shared_game_stats.js
let powder_special_input = new (class extends ComputeNode {
    constructor() { super('builder-powder-special-input'); }

    compute_func(input_map) {
        let powder_specials = []; // [ [special, power], [special, power]]
        for (const sName of specialNames) {
            for (let i = 1; i < 8; i++) {
                if (document.getElementById(sName.replace(" ", "_") + "-" + i).classList.contains("toggleOn")) {
                    let powder_special = powderSpecialStats[specialNames.indexOf(sName.replace("_", " "))];
                    powder_specials.push([powder_special, i]);
                    break;
                }
            }
        }
        return powder_specials;
    }
})();

// togglePowderSpecialButton is defined in shared_graph_nodes.js
function updatePowderSpecials(buttonId) {
    togglePowderSpecialButton(buttonId);
    powder_special_input.mark_dirty().update();
}

class PowderSpecialCalcNode extends ComputeNode {
    constructor() { super('builder-powder-special-apply'); }

    compute_func(input_map) {
        const powder_specials = input_map.get('powder-specials');
        let stats = new Map();
        for (const [special, power] of powder_specials) {
            if (special["weaponSpecialEffects"].has("Damage Boost")) {
                let name = special["weaponSpecialName"];
                if (name === "Courage" || name === "Curse" || name == "Wind Prison") { // Master mod all the way
                    stats.set("damMult." + name, special.weaponSpecialEffects.get("Damage Boost")[power - 1]);
                    // legacy
                    stats.set("poisonPct", special.weaponSpecialEffects.get("Damage Boost")[power - 1]);
                }
            }
        }
        return stats;
    }
}

class PowderSpecialDisplayNode extends ComputeNode {
    // TODO: Refactor this entirely to be adding more spells to the spell list
    constructor() {
        super('builder-powder-special-display');
        this.fail_cb = true;
    }

    compute_func(input_map) {
        const powder_specials = input_map.get('powder-specials');
        const stats = input_map.get('stats');
        const weapon = input_map.get('build').weapon;
        displayPowderSpecials(document.getElementById("powder-special-stats"), powder_specials, stats, weapon.statMap);
    }
}

// BaseItemInputNode is defined in shared_graph_nodes.js

/**
 * Builder-specific item input node. Extends BaseItemInputNode with:
 *   - Crafted item re-encoding (same skill group, different type)
 *   - Morph-weapon auto-fill of all equipment slots
 *
 * Signature: ItemInputNode() => Item | null
 */
class ItemInputNode extends BaseItemInputNode {
    compute_func(input_map) {
        const item_text = this.input_field.value;
        if (!item_text) return this.none_item;

        let item = this._lookup(item_text);

        if (item) {
            // Try basic type match first
            if (this._type_matches(item)) return item;

            // For crafted items in the same skill group, re-encode to the correct type
            if (item.statMap.get('crafted')) {
                const fieldType = this.none_item.statMap.get('type');
                const fieldSkill = type_to_skill(fieldType);
                if (item.recipe.get('skill') === fieldSkill) {
                    const originalRecipeName = item.recipe.get('name');
                    const levelRange = originalRecipeName.substring(originalRecipeName.indexOf('-') + 1);
                    const recipeName = `${capitalizeFirst(fieldType)}-${levelRange}`;
                    const newRecipe = expandRecipe(recipeMap.get(recipeName));
                    item = new Craft(newRecipe, item.mat_tiers, item.ingreds, item.atkSpd, '');
                    item.setHash(encodeCraft(item).toB64());
                    this.input_field.value = item.hash;
                    return item;
                }
            }
        }
        else if (this.category === 'weapon' && item_text.startsWith('Morph-')) {
            const replace_items = [
                'Morph-Stardust', 'Morph-Steel', 'Morph-Iron', 'Morph-Gold',
                'Morph-Topaz', 'Morph-Emerald', 'Morph-Amethyst', 'Morph-Ruby',
                item_text.substring(6)
            ];
            for (const [i, x] of zip2(equipment_inputs, replace_items)) { setValue(i, x); }
            for (const node of equip_inputs) {
                if (node !== this) { calcSchedule(node, 10); }
            }
            return this.compute_func(input_map);
        }
        return null;
    }
}

// ItemPowderingNode is defined in shared_graph_nodes.js

// BaseItemDisplayNode is defined in shared_graph_nodes.js

/** Builder item display: no extra behaviour beyond the base class. */
class ItemInputDisplayNode extends BaseItemDisplayNode {}

/**
 * Node for rendering an item.
 *
 * Signature: ItemDisplayNode(item: Item) => null
 */
class ItemDisplayNode extends ComputeNode {
    constructor(name, target_elem) {
        super(name);
        this.target_elem = target_elem;
    }

    compute_func(input_map) {
        if (input_map.size !== 1) { throw "ItemInputDisplayNode accepts exactly one input (item)"; }
        const [item] = input_map.values();  // Extract values, pattern match it into size one list and bind to first element

        displayExpandedItem(item.statMap, this.target_elem);
        collapse_element("#" + this.target_elem);
    }
}

/**
 * Change the weapon to match correct type.
 *
 * Signature: WeaponInputDisplayNode(item: Item) => null
 */
class WeaponInputDisplayNode extends ComputeNode {

    constructor(name, image_field, dps_field) {
        super(name);
        this.image = image_field;
        this.dps_field = dps_field;
    }

    compute_func(input_map) {
        if (input_map.size !== 1) { throw "WeaponDisplayNode accepts exactly one input (item)"; }
        const [item] = input_map.values();  // Extract values, pattern match it into size one list and bind to first element

        const type = item.statMap.get('type');
        this.image.style.backgroundPosition = itemBGPositions[type];

        let dps = get_base_dps(item.statMap);
        if (isNaN(dps)) {
            dps = dps[1];
            if (isNaN(dps)) dps = 0;
        }
        this.dps_field.textContent = Math.round(dps);
    }
}

/**
 * Encode the build into a url-able string.
 *
 * Signature: BuildEncodeNode(build: Build,
 *                            helmet-powder: List[powder],
 *                            chestplate-powder: List[powder],
 *                            leggings-powder: List[powder],
 *                            boots-powder: List[powder],
 *                            weapon-powder: List[powder]) => str
 */
class BuildEncodeNode extends ComputeNode {
    constructor() { super("builder-encode"); }

    compute_func(input_map) {
        const build = input_map.get('build');
        const atree = input_map.get('atree');
        const atree_state = input_map.get('atree-state');
        const aspects = input_map.get('aspects');
        let powders = [
            input_map.get('helmet-powder'),
            input_map.get('chestplate-powder'),
            input_map.get('leggings-powder'),
            input_map.get('boots-powder'),
            input_map.get('weapon-powder')
        ];
        const skillpoints = [
            input_map.get('str'),
            input_map.get('dex'),
            input_map.get('int'),
            input_map.get('def'),
            input_map.get('agi')
        ];
        // TODO: grr global state for copy button..
        player_build = build;
        build_powders = powders;
        return encodeBuild(build, powders, skillpoints, atree, atree_state, aspects);
    }
}

/**
 * Update the window's URL.
 *
 * Signature: URLUpdateNode(build_str: str) => null
 */
class URLUpdateNode extends ComputeNode {
    constructor() { super("builder-url-update"); }

    compute_func(input_map) {
        if (input_map.size !== 1) { throw "URLUpdateNode accepts exactly one input (build_str)"; }
        const [build_str] = input_map.values();  // Extract values, pattern match it into size one list and bind to first element
        // Using `history.pushState` instead of `location.replace` prevents the browser from refreshing the page upon URL change.
        window.history.pushState(null, "", location.origin + location.pathname + '#' + build_str.toB64());
    }
}

// BuildAssembleNode is defined in shared_graph_nodes.js
// PlayerClassNode is defined in shared_graph_nodes.js

// PowderInputNode is defined in shared_graph_nodes.js

// getDefenseStats is defined in shared_game_stats.js
// SpellDamageCalcNode and SpellDisplayNode are defined in shared_spell_nodes.js

/**
 * Display build stats.
 *
 * Signature: BuildDisplayNode(build: Build) => null
 */
class BuildDisplayNode extends ComputeNode {
    constructor() { super("builder-stats-display"); }

    compute_func(input_map) {
        const build = input_map.get('build');
        const stats = input_map.get('stats');
        displayBuildStats('summary-stats', build, build_overall_display_commands, stats);
        displayBuildStats("detailed-stats", build, build_detailed_display_commands, stats);
        displaySetBonuses("set-info", build);
        // TODO: move weapon out?
        // displayDefenseStats(document.getElementById("defensive-stats"), stats);

        displayPoisonDamage(document.getElementById("build-poison-stats"), stats);
    }
}

/**
 * Show warnings for skillpoints, level, set bonus for a build
 * Also shosw skill point remaining and other misc. info
 *
 * Signature: DisplayBuildWarningNode(build: Build, str: int, dex: int, int: int, def: int, agi: int) => null
 */
class DisplayBuildWarningsNode extends ComputeNode {
    constructor() { super("builder-show-warnings"); }

    compute_func(input_map) {
        const build = input_map.get('build');
        const min_assigned = build.base_skillpoints;
        const base_totals = build.total_skillpoints;
        const skillpoints = [
            input_map.get('str'),
            input_map.get('dex'),
            input_map.get('int'),
            input_map.get('def'),
            input_map.get('agi')
        ];
        const tome_skp = build.tomes[6].statMap.get("skillpoints") || [0, 0, 0, 0, 0];
        let skp_effects = ["% damage", "% crit", "% cost red.", "% resist", "% dodge"];
        let total_assigned = 0;
        const assigned_per_type = [];
        for (let i in skp_order) { //big bren
            const assigned = skillpoints[i] - base_totals[i] + min_assigned[i]
            setText(skp_order[i] + "-skp-base", "Original: " + base_totals[i]);
            const tome_bonus = tome_skp[i];
            setText(skp_order[i] + "-skp-assign", "Assign: " + assigned + (tome_bonus ? " (+" + tome_bonus + ")" : ""));
            setValue(skp_order[i] + "-skp", skillpoints[i]);
            let linebreak = document.createElement("br");
            linebreak.classList.add("itemp");
            setText(skp_order[i] + "-skp-pct", (skillPointsToPercentage(skillpoints[i]) * 100 * skillpoint_final_mult[i]).toFixed(1).concat(skp_effects[i]));
            document.getElementById(skp_order[i] + "-warnings").textContent = ''
            if (assigned > 100) {
                let skp_warning = document.createElement("p");
                skp_warning.classList.add("warning", "small-text");
                skp_warning.textContent += "Cannot assign " + assigned + " skillpoints in " + ["Strength", "Dexterity", "Intelligence", "Defense", "Agility"][i] + " manually.";
                document.getElementById(skp_order[i] + "-warnings").appendChild(skp_warning);
            }
            assigned_per_type.push(assigned);
            total_assigned += assigned;
        }

        let summarybox = document.getElementById("summary-box");
        summarybox.textContent = "";

        let remainingSkp = make_elem("p", ['scaled-font', 'my-0']);
        let remainingSkpTitle = make_elem("b", [], { textContent: "Assigned " + total_assigned + " skillpoints. Remaining skillpoints: " });
        let remainingSkpContent = document.createElement("b");
        remainingSkpContent.textContent = "" + (levelToSkillPoints(build.level) - total_assigned);
        remainingSkpContent.classList.add(levelToSkillPoints(build.level) - total_assigned < 0 ? "negative" : "positive");

        remainingSkp.append(remainingSkpTitle);
        remainingSkp.append(remainingSkpContent);

        summarybox.append(remainingSkp);
        if (total_assigned > levelToSkillPoints(build.level)) {
            const noGuildTome = build.tomes[6].statMap.has('NONE');
            if (noGuildTome) {
                const deficit = total_assigned - levelToSkillPoints(build.level);

                // Check focused tomes: +4 to one type (5 patterns)
                let focused_works = false;
                for (let i = 0; i < 5; i++) {
                    if (Math.min(4, assigned_per_type[i]) >= deficit) { focused_works = true; break; }
                }

                // Check rainbow/Assimilator: +1 to all 5
                let rainbow_savings = 0;
                for (let i = 0; i < 5; i++) rainbow_savings += Math.min(1, assigned_per_type[i]);
                const rainbow_works = rainbow_savings >= deficit;

                if (focused_works) {
                    let skpWarning = document.createElement("span");
                    skpWarning.classList.add("warning-yellow");
                    skpWarning.textContent = "WARNING: Build requires a guild tome.";
                    summarybox.append(skpWarning);
                } else if (rainbow_works) {
                    let skpWarning = document.createElement("span");
                    skpWarning.classList.add("warning-yellow");
                    skpWarning.textContent = "WARNING: Build requires the Assimilator guild tome.";
                    summarybox.append(skpWarning);
                } else {
                    let skpWarning = document.createElement("span");
                    skpWarning.classList.add("warning");
                    skpWarning.textContent = "WARNING: Too many skillpoints need to be assigned!";
                    let skpCount = document.createElement("p");
                    skpCount.classList.add("warning");
                    skpCount.textContent = "For level " + (build.level > 101 ? "101+" : build.level) + ", there are only " + levelToSkillPoints(build.level) + " skill points available.";
                    summarybox.append(skpWarning);
                    summarybox.append(skpCount);
                }
            } else {
                let skpWarning = document.createElement("span");
                skpWarning.classList.add("warning");
                skpWarning.textContent = "WARNING: Too many skillpoints need to be assigned!";
                let skpCount = document.createElement("p");
                skpCount.classList.add("warning");
                skpCount.textContent = "For level " + (build.level > 101 ? "101+" : build.level) + ", there are only " + levelToSkillPoints(build.level) + " skill points available.";
                summarybox.append(skpWarning);
                summarybox.append(skpCount);
            }
        }
        let lvlWarning;
        for (const item of build.items) {
            let item_lvl;
            if (item.statMap.get("crafted")) {
                //item_lvl = item.get("lvlLow") + "-" + item.get("lvl");
                item_lvl = item.statMap.get("lvlLow");
            }
            else {
                item_lvl = item.statMap.get("lvl");
            }

            if (build.level < item_lvl) {
                if (!lvlWarning) {
                    lvlWarning = document.createElement("p");
                    lvlWarning.classList.add("itemp"); lvlWarning.classList.add("warning");
                    lvlWarning.textContent = "WARNING: A level " + build.level + " player cannot use some piece(s) of this build."
                }
                let baditem = document.createElement("p");
                baditem.classList.add("nocolor"); baditem.classList.add("itemp");
                baditem.textContent = item.statMap.get("displayName") + " requires level " + item_lvl + " to use.";
                lvlWarning.appendChild(baditem);
            }
        }
        if (lvlWarning) {
            summarybox.append(lvlWarning);
        }
        for (const [setName, count] of build.activeSetCounts) {
            const bonus = sets.get(setName).bonuses[count - 1];
            if (bonus["illegal"]) {
                let setWarning = document.createElement("p");
                setWarning.classList.add("itemp"); setWarning.classList.add("warning");
                setWarning.textContent = "WARNING: illegal item combination: " + setName
                summarybox.append(setWarning);
            }
        }
    }
}

// AggregateStatsNode is defined in shared_graph_nodes.js

// compute_radiance is defined in shared_graph_nodes.js

// radiance_affected is defined in shared_graph_nodes.js
const radiance_node = new (class extends ComputeNode {
    constructor() { super('builder-radiance-node'); }
    compute_func(input_map) {
        const [statmap] = input_map.values();
        return compute_radiance(statmap);
    }
})();

/* Updates all spell boosts
*/
function update_radiance(input) {
    let elem = document.getElementById(input + '-boost');
    if (elem.classList.contains("toggleOn")) {
        elem.classList.remove("toggleOn");
    } else {
        elem.classList.add("toggleOn");
    }
    radiance_node.mark_dirty().update();
}


/**
 * Aggregate editable ID stats with build and weapon type.
 *
 * Signature: AggregateEditableIDNode(build: Build, weapon: Item, *args) => StatMap
 */
class AggregateEditableIDNode extends ComputeNode {
    constructor() { super("builder-aggregate-inputs"); }

    compute_func(input_map) {
        const build = input_map.get('build'); input_map.delete('build');

        const output_stats = new Map(build.statMap);
        for (const [k, v] of input_map.entries()) {
            output_stats.set(k, v);
        }

        output_stats.set('classDef', classDefenseMultipliers.get(build.weapon.statMap.get("type")));
        return output_stats;
    }
}

let edit_id_output;
function resetEditableIDs() {
    edit_id_output.mark_dirty().update();
    edit_id_output.notify();
}
/**
 * Set the editble id fields.
 *
 * Signature: EditableIDSetterNode(build: Build) => null
 */
class EditableIDSetterNode extends ComputeNode {
    constructor(notify_nodes) {
        super("builder-id-setter");
        this.notify_nodes = notify_nodes.slice();
        for (const child of this.notify_nodes) {
            child.link_to(this);
            child.fail_cb = true;
        }
    }

    compute_func(input_map) {
        if (input_map.size !== 1) { throw "EditableIDSetterNode accepts exactly one input (build)"; }
        const [build] = input_map.values();  // Extract values, pattern match it into size one list and bind to first element
        for (const id of editable_item_fields) {
            const val = build.statMap.get(id);
            document.getElementById(id).value = val;
            document.getElementById(id + '-base').textContent = 'Original Value: ' + val;
        }
    }

    notify() {
        // NOTE: DO NOT merge these loops for performance reasons!!!
        for (const node of this.notify_nodes) {
            node.mark_dirty();
        }
        for (const node of this.notify_nodes) {
            node.update();
        }
    }
}

/**
 * Set skillpoint fields from build.
 * This is separate because..... because of the way we work with edit ids vs skill points during the load sequence....
 *
 * Signature: SkillPointSetterNode(build: Build) => null
 */
class SkillPointSetterNode extends ComputeNode {
    constructor(notify_nodes) {
        super("builder-skillpoint-setter");
        this.notify_nodes = notify_nodes.slice();
        this.skillpoints = null;
        for (const child of this.notify_nodes) {
            child.link_to(this);
            child.fail_cb = true;
        }
    }

    compute_func(input_map) {
        if (input_map.size !== 1) { throw "SkillPointSetterNode accepts exactly one input (build)"; }
        const [build] = input_map.values();  // Extract values, pattern match it into size one list and bind to first element

        for (const [idx, elem] of skp_order.entries()) {
            document.getElementById(elem + '-skp').value = build.total_skillpoints[idx];
        }

        if (this.skillpoints !== null) {
            for (const [idx, elem] of skp_order.entries()) {
                if (this.skillpoints[idx] !== null) {
                    document.getElementById(elem + '-skp').value = this.skillpoints[idx];
                }
            }
            this.skillpoints = null;
        }
    }

    update(skillpoints = null) {
        this.skillpoints = skillpoints;
        return super.update()
    }
}

/**
 * Get number (possibly summed) from a text input.
 *
 * Signature: SumNumberInputNode() => int
 */
class SumNumberInputNode extends InputNode {
    compute_func(input_map) {
        let value = this.input_field.value;
        if (value === "") { value = "0"; }

        let input_num = 0;
        if (value.includes("+")) {
            let skp = value.split("+");
            for (const s of skp) {
                const val = parseInt(s, 10);
                if (isNaN(val)) {
                    return null;
                }
                input_num += val;
            }
        } else {
            input_num = parseInt(value, 10);
            if (isNaN(input_num)) {
                return null;
            }
        }
        return input_num;
    }
}

function generateTomeTooltip(tooltip_elem, tome) {
    const title = make_elem("p", [tome.statMap.get("tier"), "scaled-font", "mx-1", "my-1"]);
    const body = make_elem("p", ["mc-gray", "scaled-font", "text-wrap", "mx-1", "my-1"]);
    title.innerHTML = tome.statMap.get("displayName");
    let numberRegex = /[+-]?\d+(\.\d+)?[%+s]?/g; // +/- (optional), 1 or more digits, period followed by 1 or more digits (optional), %/+/s (optional)

    // To display:
    // - Tome level
    body.appendChild(make_elem("div", ["col"], {
        textContent: `Combat Level Min: ${tome.statMap.get("lvl")}`
    }));

    body.appendChild(make_elem("br", [], {}));

    // - Tome skillpoint bonuses
    let skp_bonuses = tome.statMap.get("skillpoints");
    if (skp_bonuses) {
        for (let [i, skp] of skp_order.entries()) {
            if (skp_bonuses[i] != 0) {
                let skp_div = make_elem("div", ["col"], {});
                let skp_title = make_elem("span", ["mc-white"], {
                    textContent: `${idPrefixes[skp]}`
                });
                let bonus_elem = make_elem("span", [skp_bonuses[i] < 0 ? "negative" : "positive"], {
                    textContent: `${skp_bonuses[i]}`
                });
                skp_div.append(skp_title, bonus_elem);
                body.appendChild(skp_div)
            }
        }
    }

    // - Tome stats
    let minRolls = tome.statMap.get("minRolls");
    let maxRolls = tome.statMap.get("maxRolls");

    for (const [id, value] of minRolls) {
        if (value == 0) continue;

        let value_max = maxRolls.get(id);

        let style = value < 0 ? "negative" : "positive";
        if (reversedIDs.includes(id)) {
            style === "positive" ? style = "negative" : style = "positive";
        }
        let id_row = make_elem("div", ["col"], {});
        let col_row = make_elem("div", ["row"], {});

        let minElem = make_elem("div", [style, "col", "text-start"], {
            textContent: `${value}${idSuffixes[id]}`
        });
        minElem.style.cssText += "flex-grow: 0"

        let idTitle = make_elem("div", ["mc-white", "col", "text-center"], {
            textContent: `${idPrefixes[id]}`
        });
        idTitle.style.cssText += "flex-grow: 1"

        let maxElem = make_elem("div", [style, "col", "text-end"], {
            textContent: `${value_max}${idSuffixes[id]}`
        });
        maxElem.style.cssText += "flex-grow: 0"

        col_row.append(minElem, idTitle, maxElem);
        id_row.append(col_row);
        body.append(id_row)
    }

    tooltip_elem.appendChild(title);
    tooltip_elem.appendChild(body);
}

/*
 * Renders the tooltips for tomes.
 * Signature TomeHoverRenderNode(name, trigger, bounding_elem) => None
 *
 * @param {name} the name of the node
 * @param {trigger} the trigger div
 * @param {bounding_elem} the box bounding (loosely) the elements.
 *
 * Notice that we're using the `on{event}` property instead of addEventListener to overwrite the listener
 * function every time an aspect update occurs.
 *
 * TODO(@orgold): Factor this into a more generic function (duplicate aspect logic).
 */
class TomeHoverRenderNode extends TooltipGeneratorNode {
    constructor(name, trigger, bounding_elem) {
        super(name, trigger, bounding_elem, generateTomeTooltip);
    }

    compute_func(input_map) {
        let tome = input_map.get('tooltip-args');

        // Clean up listeners
        if (tome.statMap.get("NONE")) {
            this.trigger.onmouseover = undefined;
            this.trigger.onmouseout = undefined;
            this.trigger.onclick = undefined;
            return;
        };
        super.compute_func(input_map)
    }
}

let item_final_nodes = [];
let powder_nodes = [];
let edit_input_nodes = [];
let skp_inputs = [];
let equip_inputs = [];
let build_node;
let stat_agg_node;
let edit_agg_node;
let atree_graph_creator;

/**
 * Construct compute nodes to link builder items and edit IDs to the appropriate display outputs.
 * To make things a bit cleaner, the compute graph structure goes like
 * [builder, build stats] -> [one agg node that is just a passthrough] -> all the spell calc nodes
 * This way, when things have to be deleted i can just delete one node from the dependencies of builder/build stats.
 *
 * Whenever this is updated, it forces an update of all the newly created spell nodes (if the build is clean).
 *
 * Signature: AbilityEnsureSpellsNodes(spells: Map[id, Spell]) => null
 */
class AbilityTreeEnsureNodesNode extends ComputeNode {
    constructor(build_node, stat_agg_node) {
        super('atree-make-nodes');
        this.build_node = build_node;
        this.stat_agg_node = stat_agg_node;
        this.passthrough = new PassThroughNode('spell-calc-buffer').link_to(this.build_node, 'build').link_to(this.stat_agg_node, 'stats');
        this.spelldmg_nodes = [];
        this.spell_display_elem = document.getElementById("all-spells-display");
    }

    compute_func(input_map) {
        this.passthrough.remove_link(this.build_node);
        this.passthrough.remove_link(this.stat_agg_node);
        this.passthrough = new PassThroughNode('spell-calc-buffer').link_to(this.build_node, 'build').link_to(this.stat_agg_node, 'stats');
        this.spell_display_elem.textContent = "";
        const build_node = this.passthrough.get_node('build');
        const stat_agg_node = this.passthrough.get_node('stats');

        const spell_map = input_map.get('spells');

        for (const [spell_id, spell] of new Map([...spell_map].sort((a, b) => a[0] - b[0])).entries()) {
            let calc_node = new SpellDamageCalcNode(spell)
                .link_to(build_node, 'build')
                .link_to(stat_agg_node, 'stats');
            this.spelldmg_nodes.push(calc_node);

            let display_elem = make_elem('div', ["col", "pe-0"]);
            let spell_summary = make_elem('div', ["col", "spell-display", "fake-button", "dark-5", "rounded", "dark-shadow", "pt-2", "border", "border-dark"],
                    { id: "spell"+spell.base_spell+"-infoAvg" });
            let spell_detail = make_elem('div', ["col", "spell-display", "dark-5", "rounded", "dark-shadow", "py-2"],
                    { id: "spell"+spell.base_spell+"-info", style: { display: 'none' } });

            display_elem.append(spell_summary, spell_detail);

            new SpellDisplayNode(spell)
                .link_to(stat_agg_node, 'stats')
                .link_to(calc_node, 'spell-damage');

            this.spell_display_elem.appendChild(display_elem);
        }
        this.passthrough.mark_dirty().update();
    }
}

/**
 * Parameters:
 *  save_skp:   bool    True if skillpoints are modified away from skp engine defaults.
 */
function builder_graph_init(skillpoints) {
    // Phase 1/3: Set up item input, propagate updates, etc.

    // Level input node.
    let level_input = new InputNode('level-input', document.getElementById('level-choice'));

    // "Build" now only refers to equipment and level (no powders). Powders are injected before damage calculation / stat display.
    build_node = new BuildAssembleNode('builder-make-build');
    build_node.link_to(level_input);
    atree_merge.link_to(build_node, "build");


    let build_encode_node = new BuildEncodeNode();
    build_encode_node.link_to(build_node, 'build');

    // Bind item input fields to input nodes, and some display stuff (for auto colorizing stuff).
    for (const [eq, display_elem, none_item] of zip3(equipment_fields, build_fields, none_items)) {
        let input_field = document.getElementById(eq + "-choice");

        let item_input = new ItemInputNode(eq + '-input', input_field, none_item);
        equip_inputs.push(item_input);
        if (powder_inputs.includes(eq + '-powder')) { // TODO: fragile
            const powder_name = eq + '-powder';
            let powder_node = new PowderInputNode(powder_name, document.getElementById(powder_name))
                .link_to(item_input, 'item');
            powder_nodes.push(powder_node);
            build_encode_node.link_to(powder_node, powder_name);
            let item_powdering = new ItemPowderingNode(eq + '-powder-apply')
                .link_to(powder_node, 'powdering').link_to(item_input, 'item');
            item_input = item_powdering;
        }
        item_final_nodes.push(item_input);
        new ItemInputDisplayNode(eq + '-input-display', eq).link_to(item_input);
        new ItemDisplayNode(eq + '-item-display', display_elem).link_to(item_input);
        //new PrintNode(eq+'-debug').link_to(item_input);
        //document.querySelector("#"+eq+"-tooltip").setAttribute("onclick", "collapse_element('#"+ eq +"-tooltip');"); //toggle_plus_minus('" + eq + "-pm'); 
        build_node.link_to(item_input, eq);
    }

    for (const [eq, none_item] of zip2(tome_fields, [none_tomes[0], none_tomes[0], none_tomes[1], none_tomes[1], none_tomes[1], none_tomes[1], none_tomes[2], none_tomes[3], none_tomes[4], none_tomes[4], none_tomes[5], none_tomes[5], none_tomes[6], none_tomes[6]])) {
        let input_field = document.getElementById(eq + "-choice");

        let item_input = new ItemInputNode(eq + '-input', input_field, none_item);
        equip_inputs.push(item_input);
        item_final_nodes.push(item_input);
        new ItemInputDisplayNode(eq + '-input-display', eq).link_to(item_input);
        let tomeDropdown = document.getElementById('tomes-dropdown');
        let tomeImage = document.getElementById(`${eq}-img-loc`);
        new TomeHoverRenderNode(`{eq}-render`, tomeImage, tomeDropdown).link_to(item_input, 'tooltip-args');
        build_node.link_to(item_input, eq);
    }

    // weapon image changer node.
    let weapon_image = document.getElementById("weapon-img");
    let weapon_dps = document.getElementById("weapon-dps");
    new WeaponInputDisplayNode('weapon-type-display', weapon_image, weapon_dps).link_to(item_final_nodes[8]);

    // linking to atree verification
    atree_validate.link_to(level_input, 'level');

    let url_update_node = new URLUpdateNode();
    url_update_node.link_to(build_encode_node, 'build-str');

    // Phase 2/3: Set up editable IDs, skill points; use decodeBuild() skill points, calculate damage

    // Create one node that will be the "aggregator node" (listen to all the editable id nodes, as well as the build_node (for non editable stats) and collect them into one statmap)
    pre_scale_agg_node = new AggregateStatsNode('pre-scale-stats');
    stat_agg_node = new AggregateStatsNode('final-stats');
    edit_agg_node = new AggregateEditableIDNode();
    edit_agg_node.link_to(build_node, 'build');
    for (const field of editable_item_fields) {
        // Create nodes that listens to each editable id input, the node name should match the "id"
        const elem = document.getElementById(field);
        const node = new SumNumberInputNode('builder-' + field + '-input', elem);

        edit_agg_node.link_to(node, field);
        edit_input_nodes.push(node);
    }
    // Edit IDs setter declared up here to set ids so they will be populated by default.
    edit_id_output = new EditableIDSetterNode(edit_input_nodes);    // Makes shallow copy of list.
    edit_id_output.link_to(build_node);
    edit_agg_node.link_to(edit_id_output, 'edit-id-setter');

    for (const skp of skp_order) {
        const elem = document.getElementById(skp + '-skp');
        const node = new SumNumberInputNode('builder-' + skp + '-input', elem);

        edit_agg_node.link_to(node, skp);
        build_encode_node.link_to(node, skp);
        edit_input_nodes.push(node);
        skp_inputs.push(node);
    }
    pre_scale_agg_node.link_to(edit_agg_node);

    // Phase 3/3: Set up atree and aspect stuff.

    let class_node = new PlayerClassNode('builder-class').link_to(build_node, 'build');
    // These two are defined in `game/atree.js`
    atree_node.link_to(class_node, 'player-class');
    atree_merge.link_to(class_node, 'player-class');
    pre_scale_agg_node.link_to(atree_raw_stats, 'atree-raw-stats');
    radiance_node.link_to(pre_scale_agg_node, 'stats');
    atree_scaling.link_to(radiance_node, 'scale-stats');
    stat_agg_node.link_to(radiance_node, 'pre-scaling');
    stat_agg_node.link_to(atree_scaling_stats, 'atree-scaling');

    build_encode_node.link_to(atree_node, 'atree').link_to(atree_state_node, 'atree-state');

    aspect_agg_node = new AspectAggregateNode('final-aspects');
    const aspects_dropdown = document.getElementById('aspects-dropdown');
    for (const field of aspect_fields) {
        const aspect_input_field = document.getElementById(field + '-choice');
        const aspect_tier_input_field = document.getElementById(field + '-tier-choice');
        const aspect_image_div = document.getElementById(field + '-img');
        const aspect_image_loc_div = document.getElementById(field + '-img-loc');
        new AspectAutocompleteInitNode(field + '-autocomplete', field).link_to(class_node, 'player-class');
        const aspect_input = new AspectInputNode(field + '-input', aspect_input_field).link_to(class_node, 'player-class');
        new AspectInputDisplayNode(field + '-input', aspect_input_field, aspect_image_div).link_to(aspect_input, "aspect-spec");
        aspect_inputs.push(aspect_input);
        const aspect_tier_input = new AspectTierInputNode(field + '-tier-input', aspect_tier_input_field).link_to(aspect_input, 'aspect-spec');
        new AspectRenderNode(field + '-render', aspect_image_loc_div, aspects_dropdown).link_to(aspect_tier_input, 'tooltip-args');
        aspect_agg_node.link_to(aspect_tier_input, field + '-tiered');
    }
    build_encode_node.link_to(aspect_agg_node, 'aspects');

    atree_merge.link_to(aspect_agg_node);

    // ---------------------------------------------------------------
    //  Trigger the update cascade for build!
    // ---------------------------------------------------------------
    for (const input_node of equip_inputs) {
        input_node.update();
    }

    armor_powder_node.update();
    level_input.update();


    atree_graph_creator = new AbilityTreeEnsureNodesNode(build_node, stat_agg_node)
        .link_to(atree_collect_spells, 'spells');

    // kinda janky, manually set atree and update. Some wasted compute here
    if (atree_data !== null && atree_node.value !== null) { // janky check if atree is valid
        const atree_state = atree_state_node.value;
        if (atree_data.length > 0) {
            try {
                let active_nodes;
                if (Array.isArray(atree_data)) {
                    // Cross-version upgrade: atree_data is an array of node IDs
                    const id_set = new Set(atree_data);
                    active_nodes = atree_node.value.filter(n => id_set.has(n.ability.id));
                } else {
                    // Same version: positional BitVector decode
                    active_nodes = decodeAtree(atree_node.value, atree_data);
                }
                for (const node of active_nodes) {
                    atree_set_state(atree_state.get(node.ability.id), true);
                }
                atree_state_node.mark_dirty().update();
            } catch (e) {
                console.error(e);
                console.log("Failed to decode atree. This can happen when updating versions. Give up!")
            }
        }
    }

    for (const aspect_input_node of aspect_inputs) {
        aspect_input_node.update();
    }

    // Powder specials.
    let powder_special_calc = new PowderSpecialCalcNode().link_to(powder_special_input, 'powder-specials');
    new PowderSpecialDisplayNode().link_to(powder_special_input, 'powder-specials')
        .link_to(stat_agg_node, 'stats').link_to(build_node, 'build');
    pre_scale_agg_node.link_to(powder_special_calc, 'powder-boost');
    stat_agg_node.link_to(armor_powder_node, 'armor-powder');
    powder_special_input.update();

    // Potion boost.
    stat_agg_node.link_to(boosts_node, 'potion-boost');

    // Also do something similar for skill points

    let build_disp_node = new BuildDisplayNode()
    build_disp_node.link_to(build_node, 'build');
    build_disp_node.link_to(stat_agg_node, 'stats');

    for (const node of edit_input_nodes) {
        node.update();
    }

    let skp_output = new SkillPointSetterNode(skp_inputs);
    skp_output.link_to(build_node);
    skp_output.update().mark_dirty().update(skillpoints);

    let build_warnings_node = new DisplayBuildWarningsNode();
    build_warnings_node.link_to(build_node, 'build');
    for (const [skp_input, skp] of zip2(skp_inputs, skp_order)) {
        build_warnings_node.link_to(skp_input, skp);
    }
    build_warnings_node.update();

    // call node.update() for each skillpoint node and stat edit listener node manually
    // NOTE: the text boxes for skill points are already filled out by decodeBuild() so this will fix them
    // this will propagate the update to the `stat_agg_node`, and then to damage calc

    console.log("Set up graph");
    graph_live_update = true;
}

