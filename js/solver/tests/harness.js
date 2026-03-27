// ══════════════════════════════════════════════════════════════════════════════
// TEST HARNESS — VM sandbox, game data loader, URL decoder, atree processor,
//                assertion library, and snapshot helpers.
//
// Provides a Node.js test environment that simulates the browser global scope
// by loading the codebase's vanilla-JS files into a vm.Context in the correct
// dependency order.
//
// Usage:
//   const { createSandbox, loadGameData, decodeSolverUrl,
//           buildAtreeMerged, collectSpells, collectRawStats,
//           TestRunner, loadSnapshot, saveSnapshot,
//           checkSnapshotFreshness, computeFileHash,
//           REPO_ROOT } = require('./harness');
//
// Requires Node.js >= 18.
// ══════════════════════════════════════════════════════════════════════════════

'use strict';

const vm = require('vm');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { performance } = require('perf_hooks');

// ── Paths ────────────────────────────────────────────────────────────────────

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const JS_ROOT = path.join(REPO_ROOT, 'js');
const SNAP_DIR = path.join(__dirname, 'snapshots');
const LATEST_VERSION = '2.2.0.15';

// ── Sandbox ──────────────────────────────────────────────────────────────────

/**
 * File load order for the VM sandbox.  This is the "compute subset" of the
 * codebase — pure logic files that have no DOM dependencies at parse time.
 */
const SANDBOX_FILES = [
    'js/core/utils.js',
    'js/game/game_rules.js',
    'js/game/build_utils.js',
    'js/game/powders.js',
    'js/game/skillpoints.js',
    'js/game/damage_calc.js',
    'js/game/shared_game_stats.js',
    'js/game/shared_constants.js',
    'js/solver/debug_toggles.js',
    'js/solver/constants.js',
    'js/solver/pure/spell.js',
    'js/solver/pure/boost.js',
    'js/solver/pure/utils.js',
    'js/solver/pure/simulate.js',
    'js/solver/pure/engine.js',
    'js/solver/engine/worker_shims.js',
    'js/solver/engine/item_priority.js',
    'js/game/build.js',
    'js/core/build_encode.js',
    'js/core/build_decode.js',
];

/**
 * Create a VM sandbox that simulates the browser global scope.
 * Loads all compute-subset files in dependency order.
 *
 * @returns {vm.Context} The sandbox context with all loaded globals.
 */
function createSandbox() {
    // Build a minimal "browser-like" global environment.
    const stub_element = {
        textContent: '', value: '', innerHTML: '', style: {},
        classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
        addEventListener() {},
        appendChild() {},
        getAttribute() { return null; },
        setAttribute() {},
        querySelectorAll() { return []; },
        querySelector() { return null; },
    };

    const ctx = vm.createContext({
        // Builtins that vm contexts don't inherit automatically.
        console,
        Math, Object, Array, Map, Set, WeakMap, WeakSet,
        JSON, Number, String, Boolean, Symbol, RegExp, Error,
        TypeError, RangeError, SyntaxError, ReferenceError,
        Int8Array, Uint8Array, Int16Array, Uint16Array,
        Int32Array, Uint32Array, Float32Array, Float64Array,
        BigInt64Array, BigUint64Array, ArrayBuffer, DataView,
        Promise, Proxy, Reflect,
        setTimeout, clearTimeout, setInterval, clearInterval,
        performance,
        structuredClone,
        isNaN, isFinite, parseInt, parseFloat,
        encodeURIComponent, decodeURIComponent,

        // Stubs for browser APIs referenced at parse time.
        window: {
            location: { hash: '', search: '', href: '', protocol: 'https:', host: 'localhost',
                        pathname: '/', hostname: 'localhost' },
            history: { replaceState() {} },
        },
        document: {
            getElementById() { return Object.create(stub_element); },
            createElement(tag) { return Object.create(stub_element); },
            querySelector() { return null; },
            querySelectorAll() { return []; },
        },
        self: {},
        postMessage() {},
        importScripts() {},
        navigator: { userAgent: 'node-test-harness' },
        confirm() { return false; },
        alert() {},
        fetch() { return Promise.reject(new Error('fetch not available in test sandbox')); },

        // Will be populated by loadGameData.
        SITE_BASE: '',
    });

    // Make window === globalThis in the context (some code does `window.X = ...`).
    ctx.window.document = ctx.document;
    ctx.globalThis = ctx;

    // Load each file into the shared context.
    for (const relPath of SANDBOX_FILES) {
        const absPath = path.join(REPO_ROOT, relPath);
        const code = fs.readFileSync(absPath, 'utf8');
        try {
            vm.runInContext(code, ctx, { filename: absPath });
        } catch (err) {
            throw new Error(`Failed to load ${relPath} into sandbox: ${err.message}`);
        }
    }

    // Variables declared with let/const in VM scripts don't become properties
    // of the context object.  Export the ones we need by running a helper script.
    vm.runInContext(`
        globalThis._item_fields = item_fields;
        globalThis._str_item_fields = str_item_fields;
        globalThis._item_types = item_types;
        globalThis._tome_types = tome_types;
        globalThis._skp_order = skp_order;
        globalThis._wep_to_class = wep_to_class;
        globalThis._damageClasses = typeof damageClasses !== 'undefined' ? damageClasses : null;
        globalThis._default_spells = typeof default_spells !== 'undefined' ? default_spells : null;
        globalThis._damage_keys = typeof damage_keys !== 'undefined' ? damage_keys : null;
        globalThis._powderNames = typeof powderNames !== 'undefined' ? powderNames : null;
        globalThis.Item = typeof Item !== 'undefined' ? Item : null;
        globalThis.SP_TOTAL_CAP = SP_TOTAL_CAP;
        globalThis.POWDER_TIERS = typeof POWDER_TIERS !== 'undefined' ? POWDER_TIERS : 7;
        globalThis.powderIDs = typeof powderIDs !== 'undefined' ? powderIDs : new Map();
        globalThis.RECAST_MANA_PENALTY = typeof RECAST_MANA_PENALTY !== 'undefined' ? RECAST_MANA_PENALTY : 5;
        globalThis.MANA_RESET_NODE_ID = typeof MANA_RESET_NODE_ID !== 'undefined' ? MANA_RESET_NODE_ID : 126;
        globalThis.STATE_CANCEL_NODE_IDS = typeof STATE_CANCEL_NODE_IDS !== 'undefined' ? STATE_CANCEL_NODE_IDS : new Map();
        globalThis.levelToSkillPoints = levelToSkillPoints;
    `, ctx);

    // Alias for convenience so callers can use ctx.item_fields etc.
    ctx.item_fields = ctx._item_fields;
    ctx.str_item_fields = ctx._str_item_fields;
    ctx.item_types = ctx._item_types;
    ctx.tome_types = ctx._tome_types;
    ctx.skp_order = ctx._skp_order;
    ctx.wep_to_class = ctx._wep_to_class;
    ctx.damageClasses = ctx._damageClasses;
    ctx.default_spells = ctx._default_spells;
    ctx.damage_keys = ctx._damage_keys;

    return ctx;
}

// ── Game Data Loading ────────────────────────────────────────────────────────

/**
 * Replicate clean_item() from load_item.js (lines 170-197).
 * Assigns defaults for missing fields using item_fields / str_item_fields
 * from the sandbox.
 */
function _clean_item(item, ctx) {
    if (item.remapID !== undefined) return;

    if (item.displayName === undefined) {
        item.displayName = item.name;
    }
    item.skillpoints = [item.str, item.dex, item.int, item.def, item.agi];
    item.reqs = [item.strReq, item.dexReq, item.intReq, item.defReq, item.agiReq];
    item.has_negstat = false;
    for (let i = 0; i < 5; ++i) {
        if (item.reqs[i] === undefined) item.reqs[i] = 0;
        if (item.skillpoints[i] === undefined) item.skillpoints[i] = 0;
        if (item.skillpoints[i] < 0) item.has_negstat = true;
    }
    for (const key of ctx.item_fields) {
        if (item[key] === undefined) {
            if (ctx.str_item_fields.includes(key)) {
                item[key] = '';
            } else if (key === 'majorIds') {
                item[key] = [];
            } else {
                item[key] = 0;
            }
        }
    }
}

/**
 * Load all game data from disk and inject into the sandbox context.
 *
 * Populates: itemMap, itemLists, idMap, sets, none_items, tomeMap, tomeIDMap,
 *            none_tomes, DEC, ENC, ATREES, MAJOR_IDS
 */
function loadGameData(ctx) {
    // ── Items + Sets ──
    const compress = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'data', 'baseline', 'compressed', 'compress.json'), 'utf8'));
    let items = compress.items;
    const raw_sets = compress.sets;

    // Build sets Map.
    const sets = new Map();
    for (const [setName, setData] of Object.entries(raw_sets)) {
        sets.set(setName, setData);
    }

    // Clean items.
    for (const item of items) {
        _clean_item(item, ctx);
    }

    // Build none_items (9 entries: helmet..weapon).
    const none_items_info = [
        ['armor', 'helmet', 'No Helmet'],
        ['armor', 'chestplate', 'No Chestplate'],
        ['armor', 'leggings', 'No Leggings'],
        ['armor', 'boots', 'No Boots'],
        ['accessory', 'ring', 'No Ring 1'],
        ['accessory', 'ring', 'No Ring 2'],
        ['accessory', 'bracelet', 'No Bracelet'],
        ['accessory', 'necklace', 'No Necklace'],
        ['weapon', 'dagger', 'No Weapon'],
    ];

    const none_items = [];
    for (let i = 0; i < none_items_info.length; i++) {
        const item = {};
        item.slots = 0;
        item.category = none_items_info[i][0];
        item.type = none_items_info[i][1];
        item.name = none_items_info[i][2];
        item.displayName = item.name;
        item.set = null;
        item.quest = null;
        item.skillpoints = [0, 0, 0, 0, 0];
        item.has_negstat = false;
        item.reqs = [0, 0, 0, 0, 0];
        item.fixID = true;
        item.tier = 'Normal';
        item.id = 10000 + i;
        item.nDam = '0-0';
        item.eDam = '0-0';
        item.tDam = '0-0';
        item.wDam = '0-0';
        item.fDam = '0-0';
        item.aDam = '0-0';
        _clean_item(item, ctx);
        none_items.push(item);
    }

    items = items.concat(none_items);

    // Build itemMap, idMap, itemLists.
    const itemMap = new Map();
    const idMap = new Map();
    const itemLists = new Map();
    for (const it of ctx.item_types) {
        itemLists.set(it, []);
    }
    for (const item of items) {
        if (item.remapID === undefined) {
            if (itemLists.has(item.type)) {
                itemLists.get(item.type).push(item.displayName);
            }
            itemMap.set(item.displayName, item);
            if (none_items.includes(item)) {
                idMap.set(item.id, '');
            } else {
                idMap.set(item.id, item.displayName);
            }
        }
    }
    // Assign set names to items.
    for (const [setName, setData] of sets) {
        for (const itemName of setData.items) {
            const it = itemMap.get(itemName);
            if (it) it.set = setName;
        }
    }

    // ── Tomes ──
    // tome_map.json is a name→ID mapping. Full tome data is in the versioned directory.
    const tomePath = path.join(REPO_ROOT, 'data', LATEST_VERSION, 'tomes.json');
    const tome_json = JSON.parse(fs.readFileSync(tomePath, 'utf8'));
    let tomes_raw = tome_json.tomes || tome_json;
    if (!Array.isArray(tomes_raw)) tomes_raw = [];
    for (const tome of tomes_raw) {
        tome.category = 'tome';
        _clean_item(tome, ctx);
    }

    const none_tomes_info = [
        ['tome', 'weaponTome', 'No Weapon Tome', 61],
        ['tome', 'armorTome', 'No Armor Tome', 62],
        ['tome', 'guildTome', 'No Guild Tome', 63],
        ['tome', 'lootrunTome', 'No Lootrun Tome', 93],
        ['tome', 'gatherXpTome', 'No Marathon Tome', 162],
        ['tome', 'dungeonXpTome', 'No Mysticism Tome', 163],
        ['tome', 'mobXpTome', 'No Expertise Tome', 164],
    ];
    const none_tomes = [];
    for (let i = 0; i < none_tomes_info.length; i++) {
        const tome = {};
        tome.slots = 0;
        tome.category = none_tomes_info[i][0];
        tome.type = none_tomes_info[i][1];
        tome.name = none_tomes_info[i][2];
        tome.displayName = tome.name;
        tome.set = null;
        tome.quest = null;
        tome.skillpoints = [0, 0, 0, 0, 0];
        tome.has_negstat = false;
        tome.reqs = [0, 0, 0, 0, 0];
        tome.fixID = true;
        tome.tier = 'Normal';
        tome.id = none_tomes_info[i][3];
        tome.nDam = '0-0'; tome.eDam = '0-0'; tome.tDam = '0-0';
        tome.wDam = '0-0'; tome.fDam = '0-0'; tome.aDam = '0-0';
        _clean_item(tome, ctx);
        none_tomes.push(tome);
    }

    const all_tomes = tomes_raw.concat(none_tomes);
    const tomeMap = new Map();
    const tomeIDMap = new Map();
    const tomeLists = new Map();
    for (const tt of ctx.tome_types) {
        tomeLists.set(tt, []);
    }
    for (const tome of all_tomes) {
        if (tome.remapID === undefined) {
            if (tomeLists.has(tome.type)) {
                tomeLists.get(tome.type).push(tome.displayName);
            }
            tomeMap.set(tome.displayName, tome);
            if (none_tomes.includes(tome)) {
                tomeIDMap.set(tome.id, '');
            } else {
                tomeIDMap.set(tome.id, tome.displayName);
            }
        }
    }

    // ── Encoding constants (DEC / ENC) ──
    const encPath = path.join(REPO_ROOT, 'data', LATEST_VERSION, 'encoding_consts.json');
    const enc_data = JSON.parse(fs.readFileSync(encPath, 'utf8'));

    // ── Atree data ──
    const atreePath = path.join(REPO_ROOT, 'data', LATEST_VERSION, 'atree.json');
    const atrees = JSON.parse(fs.readFileSync(atreePath, 'utf8'));

    // ── Major IDs ──
    const majidPath = path.join(REPO_ROOT, 'data', LATEST_VERSION, 'majid.json');
    let major_ids = {};
    if (fs.existsSync(majidPath)) {
        major_ids = JSON.parse(fs.readFileSync(majidPath, 'utf8'));
    } else {
        // Fallback to the older location.
        const altPath = path.join(REPO_ROOT, 'data', 'baseline', 'major_ids_clean.json');
        if (fs.existsSync(altPath)) {
            major_ids = JSON.parse(fs.readFileSync(altPath, 'utf8'));
        }
    }

    // ── Inject into sandbox ──
    ctx.itemMap = itemMap;
    ctx.idMap = idMap;
    ctx.itemLists = itemLists;
    ctx.sets = sets;
    ctx.none_items = none_items;
    ctx.tomeMap = tomeMap;
    ctx.tomeIDMap = tomeIDMap;
    ctx.tomeLists = tomeLists;
    ctx.none_tomes = none_tomes;
    ctx.DEC = enc_data;
    ctx.ENC = enc_data;
    ctx.ATREES = atrees;
    ctx.MAJOR_IDS = major_ids;

    return { itemMap, sets, tomeMap, none_items, none_tomes };
}

// ── URL Hash Decoding ────────────────────────────────────────────────────────

/**
 * Decode a solver URL hash into structured build + solver data.
 *
 * @param {vm.Context} ctx  - Sandbox with game data loaded.
 * @param {string} hashStr  - Everything after '#' in the URL.
 * @returns {object} Decoded build data.
 */
function decodeSolverUrl(ctx, hashStr) {
    // Strip leading '#' if present.
    if (hashStr.startsWith('#')) hashStr = hashStr.slice(1);

    // Split build vs solver sections.
    const sep = hashStr.indexOf('_');
    const buildSection = sep >= 0 ? hashStr.substring(0, sep) : hashStr;
    const solverSection = sep >= 0 ? hashStr.substring(sep + 1) : null;

    // Parse build section — use temporary globals to avoid string-escaping issues.
    ctx.__build_b64 = buildSection;
    ctx.__solver_b64 = solverSection;

    const result = vm.runInContext(`
        (function() {
            const bv = new BitVector(__build_b64, __build_b64.length * 6);
            const cursor = new BitVectorCursor(bv, 0);
            const versionId = decodeHeader(cursor);
            wynn_version_id = versionId;
            const [equipment, powders] = decodeEquipment(cursor);
            const tomes = decodeTomes(cursor);
            const skillpoints = decodeSp(cursor);
            const level = decodeLevel(cursor);

            // Determine player class from weapon.
            const weaponName = equipment[8];
            let playerClass = null;
            if (weaponName) {
                const weaponItem = itemMap.get(weaponName);
                if (weaponItem) {
                    playerClass = wep_to_class.get(weaponItem.type);
                }
            }

            let aspects = [];
            if (playerClass) {
                aspects = decodeAspects(cursor, playerClass);
            }

            const atree_data = cursor.consume();

            let solverParams = null;
            if (__solver_b64) {
                solverParams = decodeSolverParams(__solver_b64);
            }

            return {
                versionId, equipment, powders, tomes,
                skillpoints, level, playerClass, aspects,
                atree_data, solverParams,
            };
        })()
    `, ctx);

    delete ctx.__build_b64;
    delete ctx.__solver_b64;

    return {
        versionId: result.versionId,
        equipment: result.equipment,        // Array[9] of item names (or null for NONE)
        powders: result.powders,            // Array of powder strings
        tomes: result.tomes,                // Array of tome names (or null)
        skillpoints: result.skillpoints,    // Array[5] or null (auto)
        level: result.level,
        playerClass: result.playerClass,
        aspects: result.aspects,            // Array of [aspect, tier] or null entries
        atree_data: result.atree_data,      // BitVector for atree active nodes
        solverParams: result.solverParams,  // { roll_groups, sfree, combo_rows, restrictions, ... } or null
    };
}

// ── Atree Processing (extracted from atree.js) ──────────────────────────────

// default_abils definitions — copied from atree.js (lines 134-173).
// These reference default_spells which is defined in damage_calc.js (loaded into sandbox).
// We rebuild them from the sandbox's default_spells.

/**
 * Build the atree_merged Map from raw atree data + active node list.
 * This is a standalone version of atree_merge.compute_func (atree.js:454-572).
 *
 * @param {vm.Context} ctx        - Sandbox with game data loaded.
 * @param {string} playerClass    - e.g. "Warrior", "Mage"
 * @param {object[]} activeNodes  - Array of atree node objects (from decodeAtree)
 * @param {Map} buildStatMap      - The build's statMap (for majorID lookup)
 * @param {Array} aspects         - Decoded aspects array
 * @returns {Map} atree_merged — Map(abil_id → merged ability object)
 */
function buildAtreeMerged(ctx, playerClass, activeNodes, buildStatMap, aspects) {
    // Retrieve default_abils entries from the sandbox.
    // default_spells is defined in damage_calc.js (already loaded).
    const wep_types = { Mage: 'wand', Warrior: 'spear', Archer: 'bow', Assassin: 'dagger', Shaman: 'relik' };
    const wepType = wep_types[playerClass];

    const elem_mastery_abil = { display_name: 'Elemental Mastery', id: 998, properties: {}, effects: [] };
    const melee_spell = ctx.default_spells[wepType][0];
    const melee_abil = {
        display_name: `${playerClass} Melee`,
        id: 999,
        desc: `${playerClass} basic attack.`,
        properties: {},
        effects: [melee_spell],
    };
    const class_default_abils = [melee_abil, elem_mastery_abil];

    // Initialize merged abilities from defaults.
    const abils_merged = new Map();
    for (const abil of class_default_abils) {
        const tmp = structuredClone(abil);
        if (!('desc' in tmp)) tmp.desc = [];
        else if (!Array.isArray(tmp.desc)) tmp.desc = [tmp.desc];
        abils_merged.set(abil.id, tmp);
    }

    function merge_abil(abil) {
        if ('base_abil' in abil) {
            if (abils_merged.has(abil.base_abil)) {
                const base = abils_merged.get(abil.base_abil);
                if (abil.desc) {
                    if (Array.isArray(abil.desc)) base.desc = base.desc.concat(abil.desc);
                    else base.desc.push(abil.desc);
                }
                base.effects = base.effects.concat(abil.effects);
                for (const propname in abil.properties) {
                    if (propname in base.properties) {
                        base.properties[propname] += abil.properties[propname];
                    } else {
                        base.properties[propname] = abil.properties[propname];
                    }
                }
            }
        } else {
            const tmp = structuredClone(abil);
            if (!Array.isArray(tmp.desc)) tmp.desc = [tmp.desc];
            abils_merged.set(abil.id, tmp);
        }
    }

    // Build atree_state (Map of id → { active: bool }) from activeNodes.
    const atree_state = new Map();
    const activeIds = new Set(activeNodes.map(n => n.ability.id));
    // We need to mark all nodes in the full tree — but we only have active ones.
    // For merge, we just iterate active nodes.
    for (const node of activeNodes) {
        merge_abil(node.ability);
    }

    // Apply major IDs.
    const activeMajorIDs = buildStatMap ? (buildStatMap.get('activeMajorIDs') || []) : [];
    for (const majorIdName of activeMajorIDs) {
        if (majorIdName in ctx.MAJOR_IDS) {
            for (const abil of ctx.MAJOR_IDS[majorIdName].abilities) {
                if (abil['class'] === playerClass || abil['class'] === 'Any') {
                    if (abil.dependencies !== undefined) {
                        let dep_ok = true;
                        for (const dep_id of abil.dependencies) {
                            if (!activeIds.has(dep_id)) { dep_ok = false; break; }
                        }
                        if (!dep_ok) continue;
                    }
                    merge_abil(abil);
                }
            }
        }
    }

    // Apply aspects.
    if (aspects && ctx.aspectMap) {
        for (const entry of aspects) {
            if (!entry) continue;
            const [aspect, tier] = entry;
            if (!aspect || aspect.NONE || !aspect.tiers || !aspect.tiers[tier - 1]) continue;
            const tierData = aspect.tiers[tier - 1];
            if (!tierData.abilities) continue;
            for (const abil of tierData.abilities) {
                if (abil.dependencies !== undefined) {
                    let dep_ok = true;
                    for (const dep_id of abil.dependencies) {
                        if (!activeIds.has(dep_id)) { dep_ok = false; break; }
                    }
                    if (!dep_ok) continue;
                }
                merge_abil(abil);
            }
        }
    }

    return abils_merged;
}

/**
 * Extract slider and button default states from a merged ability tree.
 * Standalone version of atree_make_interactives — no DOM, just data.
 *
 * Sliders are initialised to their default value (from the atree JSON).
 * Buttons default to false (off).
 *
 * @param {Map} atree_merged - From buildAtreeMerged().
 * @returns {{ slider_states: Map<string,number>, button_states: Map<string,boolean> }}
 */
function extractAtreeInteractiveDefaults(atree_merged) {
    const slider_states = new Map();
    const button_states = new Map();
    const slider_meta = new Map();   // name → { max, default_val, overwritten }

    // Collect slider/button definitions, replicating the merge logic
    // from atree_make_interactives (atree.js:620-690).
    let to_process = [];
    for (const [, ability] of atree_merged) {
        for (const effect of ability.effects) {
            if (effect.type === 'stat_scaling' && effect.slider === true) {
                to_process.push([effect, ability]);
            }
            if (effect.type === 'raw_stat' && effect.toggle) {
                button_states.set(effect.toggle, false);
            }
        }
    }

    let unprocessed = [];
    const k = to_process.length;
    for (let i = 0; i < k; ++i) {
        for (const [effect, ability] of to_process) {
            if (effect.type !== 'stat_scaling' || !effect.slider) continue;
            const { slider_name, behavior = 'merge', slider_max = 0, slider_default = 0 } = effect;
            const slider_min = effect.slider_min ?? 0;
            const slider_step = effect.slider_step ?? 1;
            const has_off = slider_min > 0;
            const effective_default = has_off ? (slider_min - slider_step) : slider_default;

            if (slider_meta.has(slider_name)) {
                const info = slider_meta.get(slider_name);
                if (behavior === 'overwrite') {
                    if ('slider_max' in effect) info.max = slider_max;
                    if ('slider_default' in effect) info.default_val = slider_default;
                    info.overwritten = true;
                } else if (!info.overwritten) {
                    info.max += slider_max;
                    if ('slider_max_mult' in effect) {
                        info.max_mult = (info.max_mult ?? 1) * effect.slider_max_mult;
                    }
                    info.default_val += slider_default;
                }
            } else if (behavior === 'merge') {
                slider_meta.set(slider_name, {
                    max: slider_max,
                    default_val: effective_default,
                    real_min: slider_min,
                    overwritten: false,
                });
            } else {
                unprocessed.push([effect, ability]);
            }
        }
        if (unprocessed.length === to_process.length) break;
        to_process = unprocessed;
        unprocessed = [];
    }

    // Apply accumulated slider_max_mult factors (multiplicative phase).
    for (const [_, info] of slider_meta) {
        if (info.max_mult != null && info.max_mult !== 1) {
            info.max = Math.round(info.max * info.max_mult);
        }
    }

    // Set each slider to its default value.
    for (const [name, info] of slider_meta) {
        slider_states.set(name, info.default_val);
    }

    return { slider_states, button_states };
}

/**
 * Collect spells from merged abilities.
 * Standalone version of atree_collect_spells.compute_func (atree.js:832-980).
 *
 * @param {vm.Context} ctx           - Sandbox (for atree_translate, damageClasses).
 * @param {Map} atree_merged         - From buildAtreeMerged().
 * @returns {Map} spell_id → spell definition.
 */
function collectSpells(ctx, atree_merged) {
    const ret_spells = new Map();

    // First pass: replace_spell effects.
    for (const [abil_id, abil] of atree_merged.entries()) {
        for (const effect of abil.effects) {
            if (effect.type === 'replace_spell') {
                let ret_spell = ret_spells.get(effect.base_spell);
                if (ret_spell) {
                    for (const key in effect) {
                        ret_spell[key] = structuredClone(effect[key]);
                    }
                } else {
                    ret_spell = structuredClone(effect);
                    ret_spells.set(effect.base_spell, ret_spell);
                }
                for (const part of ret_spell.parts) {
                    if ('hits' in part) {
                        for (const idx in part.hits) {
                            part.hits[idx] = ctx.atree_translate(atree_merged, part.hits[idx]);
                        }
                    }
                }
            }
        }
    }

    // Accumulate powder_special deferred effects for apply_deferred_powder_special_effects.
    const _pending_powder_special = [];

    // Second pass: add_spell_prop + convert_spell_conv.
    for (const [abil_id, abil] of atree_merged.entries()) {
        for (const effect of abil.effects) {
            switch (effect.type) {
            case 'replace_spell':
                continue;
            case 'add_spell_prop': {
                const { base_spell, target_part = null, cost = 0, behavior = 'merge' } = effect;
                if (base_spell === 'powder_special') {
                    _pending_powder_special.push(effect);
                    continue;
                }
                if (!ret_spells.has(base_spell)) continue;
                const ret_spell = ret_spells.get(base_spell);

                if ('cost' in ret_spell) ret_spell.cost += cost;
                if (target_part === null) continue;

                let found_part = false;
                for (const part of ret_spell.parts) {
                    if (part.name !== target_part) continue;

                    if ('multipliers' in effect) {
                        for (const [idx, v] of effect.multipliers.entries()) {
                            if (behavior === 'overwrite') part.multipliers[idx] = v;
                            else part.multipliers[idx] += v;
                        }
                    } else if ('max_hp_heal_pct' in effect) {
                        if (behavior === 'overwrite') part.max_hp_heal_pct = effect.max_hp_heal_pct;
                        else part.max_hp_heal_pct += effect.max_hp_heal_pct;
                    } else if ('hits' in effect) {
                        for (const [idx, _v] of Object.entries(effect.hits)) {
                            const v = ctx.atree_translate(atree_merged, _v);
                            if (behavior === 'overwrite') part.hits[idx] = v;
                            else {
                                if (idx in part.hits) part.hits[idx] += v;
                                else part.hits[idx] = v;
                            }
                        }
                    }
                    if ('hide' in effect) part.display = false;
                    if ('ignored_mults' in effect) {
                        if ('ignored_mults' in part) part.ignored_mults.push(effect.ignored_mults);
                        else part.ignored_mults = effect.ignored_mults;
                    }
                    found_part = true;
                    break;
                }
                if (!found_part && behavior === 'merge') {
                    const spell_part = structuredClone(effect);
                    spell_part.name = target_part;
                    if ('hits' in spell_part) {
                        for (const idx in spell_part.hits) {
                            spell_part.hits[idx] = ctx.atree_translate(atree_merged, spell_part.hits[idx]);
                        }
                    }
                    if ('hide' in effect) spell_part.display = false;
                    ret_spell.parts.push(spell_part);
                }
                if ('display' in effect) ret_spell.display = effect.display;
                continue;
            }
            case 'convert_spell_conv': {
                const { base_spell, target_part, conversion } = effect;
                const ret_spell = ret_spells.get(base_spell);
                if (!ret_spell) continue;
                const elem_idx = ctx.damageClasses.indexOf(conversion);
                const filter = target_part === 'all';
                for (const part of ret_spell.parts) {
                    if (filter || part.name === target_part) {
                        if ('multipliers' in part) {
                            let total_conv = 0;
                            for (let i = 1; i < 6; ++i) total_conv += part.multipliers[i];
                            const new_conv = [part.multipliers[0], 0, 0, 0, 0, 0];
                            new_conv[elem_idx] = total_conv;
                            part.multipliers = new_conv;
                        }
                    }
                }
                continue;
            }
            }
        }
    }

    // Resolve mana_derived_from.
    for (const spell of ret_spells.values()) {
        if ('mana_derived_from' in spell) {
            const parent = ret_spells.get(spell.mana_derived_from);
            if (parent && 'cost' in parent) {
                spell.cost = parent.cost;
            }
        }
    }

    // Attach deferred powder_special effects so apply_deferred_powder_special_effects works.
    ret_spells._powder_special_effects = _pending_powder_special;

    return ret_spells;
}

/**
 * Collect raw stat bonuses from atree (standalone atree_raw_stats.compute_func).
 *
 * @param {vm.Context} ctx
 * @param {Map} atree_merged
 * @returns {Map} stat → value
 */
function collectRawStats(ctx, atree_merged) {
    const ret = new Map();
    for (const [abil_id, abil] of atree_merged.entries()) {
        if (abil.effects.length === 0) continue;
        for (const effect of abil.effects) {
            if (effect.type === 'raw_stat') {
                if (effect.toggle) continue;
                for (const bonus of effect.bonuses) {
                    if (bonus.type === 'stat') {
                        ctx.merge_stat(ret, bonus.name, bonus.value);
                    }
                }
            }
        }
    }
    return ret;
}

/**
 * Decode the atree BitVector into active node objects using the raw atree JSON.
 *
 * @param {vm.Context} ctx
 * @param {string} playerClass
 * @param {object} atree_data - BitVector from URL decode
 * @returns {object[]} Array of active atree node objects
 */
function decodeActiveNodes(ctx, playerClass, atree_data) {
    ctx.__cls_tmp = playerClass;
    ctx.__bits_tmp = atree_data;

    const activeNodes = vm.runInContext(`
        (function() {
            const atree_raw = ATREES[__cls_tmp];
            if (!atree_raw) return [];
            const atree_map = new Map();
            let atree_head;
            for (const i of atree_raw) {
                atree_map.set(i.id, { children: [], ability: i });
                if (i.parents.length === 0) atree_head = atree_map.get(i.id);
            }
            for (const i of atree_raw) {
                const node = atree_map.get(i.id);
                const parents = [];
                for (const parent_id of node.ability.parents) {
                    const parent_node = atree_map.get(parent_id);
                    parent_node.children.push(node);
                    parents.push(parent_node);
                }
                node.parents = parents;
            }
            const sccs = make_SCC_graph(atree_head, atree_map.values());
            const topo = [];
            for (const scc of sccs) {
                for (const node of scc.nodes) {
                    delete node.visited;
                    delete node.assigned;
                    delete node.scc;
                    topo.push(node);
                }
            }
            if (topo.length === 0 || !__bits_tmp || __bits_tmp.length === 0) {
                return topo.length > 0 ? [topo[0]] : [];
            }
            return decodeAtree(topo, __bits_tmp);
        })()
    `, ctx);

    delete ctx.__cls_tmp;
    delete ctx.__bits_tmp;

    return activeNodes;
}

// ── TestRunner ───────────────────────────────────────────────────────────────

class TestRunner {
    constructor(suiteName) {
        this.name = suiteName;
        this._pass = 0;
        this._fail = 0;
        this._warnings = [];
    }

    assert(cond, msg) {
        if (cond) {
            this._pass++;
        } else {
            this._fail++;
            console.error(`  FAIL: ${msg}`);
        }
    }

    /** Assert |actual - expected| / max(|expected|, 1) <= tolerance */
    assertClose(actual, expected, tolerance, msg) {
        const denom = Math.max(Math.abs(expected), 1);
        const relErr = Math.abs(actual - expected) / denom;
        if (relErr <= tolerance) {
            this._pass++;
        } else {
            this._fail++;
            console.error(`  FAIL: ${msg} (got ${actual}, expected ~${expected}, relErr=${relErr.toFixed(4)})`);
        }
    }

    assertGe(actual, threshold, msg) {
        if (actual >= threshold) {
            this._pass++;
        } else {
            this._fail++;
            console.error(`  FAIL: ${msg} (got ${actual}, expected >= ${threshold})`);
        }
    }

    assertLe(actual, threshold, msg) {
        if (actual <= threshold) {
            this._pass++;
        } else {
            this._fail++;
            console.error(`  FAIL: ${msg} (got ${actual}, expected <= ${threshold})`);
        }
    }

    warn(msg) {
        this._warnings.push(msg);
        console.warn(`  WARN: ${msg}`);
    }

    summary() {
        console.log(`\n[${this.name}] ${this._pass} passed, ${this._fail} failed, ${this._warnings.length} warnings`);
        return { pass: this._pass, fail: this._fail, warnings: this._warnings.length };
    }
}

// ── Snapshot Helpers ─────────────────────────────────────────────────────────

function computeFileHash(filePath) {
    const data = fs.readFileSync(filePath);
    return crypto.createHash('sha256').update(data).digest('hex');
}

function loadSnapshot(name) {
    const p = path.join(SNAP_DIR, name + '.snap.json');
    const snap = JSON.parse(fs.readFileSync(p, 'utf8'));
    // Default name to filename if missing.
    if (!snap.name) snap.name = name;
    return snap;
}

/**
 * Check if a snapshot needs its auto-generated fields populated.
 * Returns true if atree_hash or locked_items are missing/empty.
 */
function snapshotNeedsGeneration(snap) {
    return !snap.atree_hash || !snap.created;
}

/**
 * Hash a statMap (Map) into a hex digest.  Deterministic: entries are sorted
 * by key, and values are JSON-stringified.
 */
function _hashStatMap(sm) {
    const entries = [...sm.entries()].sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return crypto.createHash('sha256').update(JSON.stringify(entries)).digest('hex');
}

/**
 * Build a locked_items object for snapshot storage.
 * Maps slot (or index) → { name, stat_hash } for each locked/equipped item.
 */
function extractLockedItemStats(items) {
    const out = {};
    for (const [key, item] of Object.entries(items)) {
        const sm = item.statMap || item;
        const name = sm.get?.('displayName') ?? sm.get?.('name') ?? '(unknown)';
        out[key] = { name, stat_hash: _hashStatMap(sm) };
    }
    return out;
}

/**
 * Build locked_items from a decoded URL's equipment array (for combo tests).
 * Resolves each name against the provided itemMap/expandItem and hashes stats.
 */
function extractEquipmentStats(decoded, ctx) {
    const out = {};
    const equipNames = decoded.equipment || [];
    for (let i = 0; i < equipNames.length; i++) {
        const name = equipNames[i];
        const itemObj = (name && ctx.itemMap.has(name)) ? ctx.itemMap.get(name) : ctx.none_items[i];
        const sm = ctx.expandItem(itemObj);
        out[i] = { name: name || `(none@${i})`, stat_hash: _hashStatMap(sm) };
    }
    return out;
}

function saveSnapshot(name, data) {
    data.created = new Date().toISOString();
    // locked_items is set by the caller before saving.
    data.compress_hash = computeFileHash(path.join(REPO_ROOT, 'data', 'baseline', 'compressed', 'compress.json'));
    data.atree_hash = computeFileHash(path.join(REPO_ROOT, 'data', LATEST_VERSION, 'atree.json'));
    const p = path.join(SNAP_DIR, name + '.snap.json');
    fs.writeFileSync(p, JSON.stringify(data, null, 2) + '\n');
    console.log(`Snapshot saved: ${p}`);
}

/**
 * Check snapshot freshness.
 *
 * - Atree: file hash (always checked).
 * - Locked items: per-item stat hash comparison.  If any locked item's stats
 *   changed, a warning names the affected slot/item.
 * - Compress (item file): file hash, but ONLY checked when the snapshot has
 *   free (unlocked) slots — i.e. solver search tests that enumerate pools.
 *   Combo tests with all items locked skip this check entirely.
 */
function checkSnapshotFreshness(snap, runner, currentLockedStats, hasFreeSlots) {
    // Atree hash
    const curAtree = computeFileHash(path.join(REPO_ROOT, 'data', LATEST_VERSION, 'atree.json'));
    if (snap.atree_hash && snap.atree_hash !== curAtree) {
        runner.warn(`Atree data changed since snapshot "${snap.name}" was created.`);
    }

    // Locked item stat hashes
    if (currentLockedStats && snap.locked_items) {
        for (const [key, saved] of Object.entries(snap.locked_items)) {
            const cur = currentLockedStats[key];
            if (!cur) {
                runner.warn(`"${snap.name}" locked slot ${key} ("${saved.name}"): item no longer present.`);
            } else if (cur.stat_hash !== saved.stat_hash) {
                runner.warn(`"${snap.name}" locked slot ${key} ("${saved.name}"): item stats changed.`);
            }
        }
    }

    // Compress hash — only when there are free slots (pool enumeration).
    if (hasFreeSlots && snap.compress_hash) {
        const curCompress = computeFileHash(path.join(REPO_ROOT, 'data', 'baseline', 'compressed', 'compress.json'));
        if (snap.compress_hash !== curCompress) {
            runner.warn(`Game data (data/baseline/compressed/compress.json) changed since snapshot "${snap.name}" was created.`);
        }
    }
}

// ── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
    createSandbox,
    loadGameData,
    decodeSolverUrl,
    buildAtreeMerged,
    collectSpells,
    collectRawStats,
    decodeActiveNodes,
    TestRunner,
    loadSnapshot,
    saveSnapshot,
    snapshotNeedsGeneration,
    checkSnapshotFreshness,
    extractLockedItemStats,
    extractEquipmentStats,
    extractAtreeInteractiveDefaults,
    computeFileHash,
    REPO_ROOT,
    SNAP_DIR,
    LATEST_VERSION,
};
