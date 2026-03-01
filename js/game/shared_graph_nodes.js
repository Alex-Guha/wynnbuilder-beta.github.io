/**
 * Shared computation graph node classes used by both the Builder and Solver pages.
 *
 * Dependencies (must be loaded before this file):
 *   - computation_graph.js: ComputeNode, ValueCheckComputeNode, InputNode
 *   - build_utils.js:       merge_stat, wep_to_class, applyArmorPowders, apply_weapon_powders,
 *                            reversedIDs
 *   - shared_game_stats.js: damageMultipliers, radiance_affected
 */

/**
 * Merges multiple StatMap inputs into one StatMap.
 * Skips null inputs (fail_cb = true allows partial computation).
 *
 * Signature: AggregateStatsNode(...maps) => StatMap
 */
class AggregateStatsNode extends ComputeNode {
    constructor(name) { super(name); this.fail_cb = true; }

    compute_func(input_map) {
        const out = new Map();
        for (const v of input_map.values()) {
            if (!v) continue;
            for (const [k, v2] of v.entries()) {
                merge_stat(out, k, v2);
            }
        }
        return out;
    }
}

/**
 * Detects player class from weapon type.
 * Returns null when no build or weapon is selected.
 *
 * Signature: PlayerClassNode(build: Build) => string | null
 */
class PlayerClassNode extends ValueCheckComputeNode {
    constructor(name) { super(name); }

    compute_func(input_map) {
        const build = input_map.get('build');
        if (!build || build.weapon.statMap.has('NONE')) return null;
        return wep_to_class.get(build.weapon.statMap.get('type'));
    }
}

/**
 * Create a "build" object from a set of equipments.
 * Returns a new Build object, or null if all items are NONE items.
 *
 * Signature: BuildAssembleNode(helmet, chestplate, leggings, boots,
 *              ring1, ring2, bracelet, necklace, weapon,
 *              weaponTome1..mobXpTome2, level-input) => Build | null
 */
class BuildAssembleNode extends ComputeNode {
    constructor(name) { super(name || 'make-build'); }

    compute_func(input_map) {
        const equipments = [
            input_map.get('helmet'),
            input_map.get('chestplate'),
            input_map.get('leggings'),
            input_map.get('boots'),
            input_map.get('ring1'),
            input_map.get('ring2'),
            input_map.get('bracelet'),
            input_map.get('necklace'),
        ];
        const tomes = [
            input_map.get('weaponTome1'),
            input_map.get('weaponTome2'),
            input_map.get('armorTome1'),
            input_map.get('armorTome2'),
            input_map.get('armorTome3'),
            input_map.get('armorTome4'),
            input_map.get('guildTome1'),
            input_map.get('lootrunTome1'),
            input_map.get('gatherXpTome1'),
            input_map.get('gatherXpTome2'),
            input_map.get('dungeonXpTome1'),
            input_map.get('dungeonXpTome2'),
            input_map.get('mobXpTome1'),
            input_map.get('mobXpTome2'),
        ];
        // Wynncraft skill-point equipping order: boots→helmet, ring1→neck, guildTome
        const wynn_equip = [
            input_map.get('boots'),
            input_map.get('leggings'),
            input_map.get('chestplate'),
            input_map.get('helmet'),
            input_map.get('ring1'),
            input_map.get('ring2'),
            input_map.get('bracelet'),
            input_map.get('necklace'),
            input_map.get('guildTome1'),
        ];
        const weapon = input_map.get('weapon');

        let level = parseInt(input_map.get('level-input'));
        if (isNaN(level)) level = MAX_PLAYER_LEVEL;

        const all_none = equipments.concat([...tomes, weapon]).every(x => x.statMap.has('NONE'));
        if (all_none && !location.hash) return null;

        return new Build(level, equipments, tomes, weapon, wynn_equip);
    }
}

/**
 * Read an input field and parse into a list of powderings.
 * Every two characters makes one powder.
 *
 * Signature: PowderInputNode(item: Item) => List[powder]
 */
class PowderInputNode extends InputNode {
    constructor(name, input_field) {
        super(name, input_field);
        this.fail_cb = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();
        if (item === null) {
            this.input_field.placeholder = 'powders';
            return [];
        }
        if (item.statMap.has('slots')) {
            this.input_field.placeholder = item.statMap.get('slots') + ' slots';
        }

        let input = this.input_field.value.trim();
        let powdering = [];
        let errors = [];
        while (input) {
            const first = input.slice(0, 2).toLowerCase();
            const powder = powderIDs.get(first);
            if (powder === undefined) {
                if (first.length > 0) errors.push(first);
                else break;
            } else {
                powdering.push(powder);
            }
            input = input.slice(2);
        }

        if (errors.length || (item.statMap.get('slots') < powdering.length)) {
            this.input_field.classList.add('is-invalid');
        } else {
            this.input_field.classList.remove('is-invalid');
        }
        return powdering;
    }
}

/**
 * Applies powders to a copy of an item.
 *
 * Signature: ItemPowderingNode(item: Item, powdering: List[powder]) => Item
 */
class ItemPowderingNode extends ComputeNode {
    constructor(name) { super(name); }

    compute_func(input_map) {
        const powdering  = input_map.get('powdering');
        const input_item = input_map.get('item');
        const item       = input_item.copy();
        const max_slots  = item.statMap.get('slots');
        item.statMap.set('powders', powdering.slice(0, max_slots));
        if (item.statMap.get('category') === 'armor') {
            applyArmorPowders(item.statMap);
        } else if (item.statMap.get('category') === 'weapon') {
            apply_weapon_powders(item.statMap);
        }
        return item;
    }
}

// ── Base item display node ───────────────────────────────────────────────────

const _TIER_CLASSES        = ['Normal','Unique','Rare','Legendary','Fabled','Mythic','Set','Crafted','Custom'];
const _TIER_SHADOW_CLASSES = _TIER_CLASSES.map(t => t + '-shadow');

/**
 * Base class for item slot display nodes. Handles tier colour, health, level,
 * and image shadow. Subclasses can override hooks for page-specific extras.
 *
 * Signature: BaseItemDisplayNode(item: Item) => null
 */
class BaseItemDisplayNode extends ComputeNode {
    constructor(name, eq) {
        super(name);
        this.input_field  = document.getElementById(eq + '-choice');
        this.health_field = document.getElementById(eq + '-health') || null;
        this.level_field  = document.getElementById(eq + '-lv')     || null;
        this.item_image   = document.getElementById(eq + '-img')    || null;
        this.fail_cb      = true;
    }

    /** Called when item is null or NONE. Override for slot-unlocked styling, etc. */
    _on_empty(_item) { return null; }
    /** Called after setting tier/health/level on a valid item. Override for lock UI, etc. */
    _on_display(_item) {}

    compute_func(input_map) {
        const [item] = input_map.values();

        // Reset styling
        this.input_field.classList.remove('text-light', 'is-invalid', ..._TIER_CLASSES);
        this.input_field.classList.add('text-light');
        if (this.item_image) this.item_image.classList.remove(..._TIER_SHADOW_CLASSES);
        if (this.health_field) this.health_field.textContent = '0';
        if (this.level_field)  this.level_field.textContent  = '0';

        if (!item) {
            this.input_field.classList.add('is-invalid');
            return this._on_empty(null);
        }
        if (item.statMap.has('NONE')) {
            return this._on_empty(item);
        }

        const tier = item.statMap.get('tier');
        this.input_field.classList.add(tier);
        if (this.health_field) this.health_field.textContent = item.statMap.get('hp') || '0';
        if (this.level_field)  this.level_field.textContent  = item.statMap.get('lvl') || '0';
        if (this.item_image)   this.item_image.classList.add(tier + '-shadow');
        this._on_display(item);
        return null;
    }
}

// ── Base item input node ─────────────────────────────────────────────────────

/**
 * Base class for item input nodes. Handles item lookup from an input field
 * (CI-/CR- custom items, itemMap, tomeMap) and basic type matching.
 *
 * Subclasses can override:
 *   _on_match(item)                   — called when an item matches the slot type
 *   compute_func(input_map)           — for fundamentally different control flow
 *
 * Signature: BaseItemInputNode() => Item | null
 */
class BaseItemInputNode extends InputNode {
    constructor(name, input_field, none_item) {
        super(name, input_field);
        this.none_item = new Item(none_item);
        this.category = this.none_item.statMap.get('category');
        if (this.category === 'armor' || this.category === 'weapon') {
            this.none_item.statMap.set('powders', []);
            apply_weapon_powders(this.none_item.statMap);
        }
        this.none_item.statMap.set('NONE', true);
    }

    /** Look up an item by text (CI-/CR- hash, itemMap name, tomeMap name). */
    _lookup(item_text) {
        if (item_text.slice(0, 3) === 'CI-') return decodeCustom({hash: item_text.substring(3)});
        if (item_text.slice(0, 3) === 'CR-') return decodeCraft({hash: item_text.substring(3)});
        if (itemMap.has(item_text)) return new Item(itemMap.get(item_text));
        if (tomeMap.has(item_text)) return new Item(tomeMap.get(item_text));
        return null;
    }

    /** Check whether a looked-up item matches this slot's expected type. */
    _type_matches(item) {
        if (this.category === 'weapon') return item.statMap.get('category') === 'weapon';
        return item.statMap.get('type') === this.none_item.statMap.get('type');
    }

    /** Hook called when the item passes type matching. Override for roll mode, etc. */
    _on_match(item) { return item; }

    compute_func(_input_map) {
        const item_text = this.input_field.value;
        if (!item_text) return this.none_item;

        const item = this._lookup(item_text);
        if (item && this._type_matches(item)) return this._on_match(item);
        return null;
    }
}

// ── Shared compute functions for boost / radiance nodes ──────────────────────

/**
 * Read active boost toggles from the DOM and return a damMult/defMult StatMap.
 * Used by both builder's boosts_node and solver's solver_boosts_node.
 */
function compute_boosts() {
    let damage_boost = 0;
    let str_boost    = 0;
    let vuln_boost   = 0;
    let def_boost    = 0;
    for (const [key, value] of damageMultipliers) {
        const elem = document.getElementById(key + '-boost');
        if (elem && elem.classList.contains('toggleOn')) {
            if (value > damage_boost) { damage_boost = value; }
            if (key === 'warscream')       { def_boost  += 0.20; }
            else if (key === 'emboldeningcry') { def_boost += 0.05; str_boost += 0.08; }
            else if (key === 'eldritchcall')   { vuln_boost += 0.15; }
        }
    }
    const res = new Map();
    res.set('damMult.Potion',        100 * damage_boost);
    res.set('damMult.Strength',      100 * str_boost);
    res.set('damMult.Vulnerability', 100 * vuln_boost);
    res.set('defMult.Potion',        100 * def_boost);
    return res;
}

/**
 * Apply Radiance (+20%) and/or Divine Honor (+10%) scaling to a StatMap.
 * Returns the input unchanged when neither is active; otherwise returns a new Map.
 */
function compute_radiance(statmap) {
    if (!statmap) return new Map();

    let boost = 1;
    if (document.getElementById('radiance-boost')?.classList.contains('toggleOn'))    { boost += 0.2; }
    if (document.getElementById('divinehonor-boost')?.classList.contains('toggleOn')) { boost += 0.1; }

    if (boost === 1) return statmap;

    const ret = new Map(statmap);
    for (const id of radiance_affected) {
        const val = ret.get(id) || 0;
        if (reversedIDs.includes(id)) {
            if (val < 0) { ret.set(id, Math.floor(val * boost)); }
        } else {
            if (val > 0) { ret.set(id, Math.floor(val * boost)); }
        }
    }
    return ret;
}

/**
 * Toggle a powder special button: turn off others with the same prefix, turn on the clicked one.
 * Shared DOM toggle logic used by both builder and solver updatePowderSpecials handlers.
 */
function togglePowderSpecialButton(buttonId) {
    const prefix = buttonId.split('-')[0].replace(' ', '_') + '-';
    const elem = document.getElementById(buttonId);
    if (!elem) return;
    if (elem.classList.contains('toggleOn')) {
        elem.classList.remove('toggleOn');
    } else {
        for (let i = 1; i < 6; i++) {
            const other = document.getElementById(prefix + i);
            if (other && other.classList.contains('toggleOn')) {
                other.classList.remove('toggleOn');
            }
        }
        elem.classList.add('toggleOn');
    }
}
