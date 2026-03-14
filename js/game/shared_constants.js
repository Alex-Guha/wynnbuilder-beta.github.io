/**
 * Shared constants used by both the Builder and Solver pages.
 *
 * This file defines equipment slot names, tome/aspect field IDs,
 * derived input-element IDs, and slot-category groupings.
 * It must be loaded BEFORE builder_constants.js or constants.js.
 */

// ── Item slot definitions ────────────────────────────────────────────────────

let equipment_fields = [
    "helmet",
    "chestplate",
    "leggings",
    "boots",
    "ring1",
    "ring2",
    "bracelet",
    "necklace",
    "weapon"
];

let equipment_names = [
    "Helmet",
    "Chestplate",
    "Leggings",
    "Boots",
    "Ring 1",
    "Ring 2",
    "Bracelet",
    "Necklace",
    "Weapon"
];

let tome_fields = [
    "weaponTome1",
    "weaponTome2",
    "armorTome1",
    "armorTome2",
    "armorTome3",
    "armorTome4",
    "guildTome1",
    "lootrunTome1",
    "gatherXpTome1",
    "gatherXpTome2",
    "dungeonXpTome1",
    "dungeonXpTome2",
    "mobXpTome1",
    "mobXpTome2"
];

let aspect_fields = [
    "aspect1",
    "aspect2",
    "aspect3",
    "aspect4",
    "aspect5",
];

// ── Derived input element ID arrays ──────────────────────────────────────────

let equipment_inputs    = equipment_fields.map(x => x + "-choice");
let tomeInputs          = tome_fields.map(x => x + "-choice");
let aspectInputs        = aspect_fields.map(x => x + "-choice");
let aspectTierInputs    = aspect_fields.map(x => x + "-tier-choice");

// ── Powder-accepting slots ───────────────────────────────────────────────────

let powder_inputs = [
    "helmet-powder",
    "chestplate-powder",
    "leggings-powder",
    "boots-powder",
    "weapon-powder",
];

// ── Slot category groupings ──────────────────────────────────────────────────

let weapon_keys      = ['dagger', 'wand', 'bow', 'relik', 'spear'];
let armor_keys       = ['helmet', 'chestplate', 'leggings', 'boots'];
let accessory_keys   = ['ring1', 'ring2', 'bracelet', 'necklace'];
let powderable_keys  = ['helmet', 'chestplate', 'leggings', 'boots', 'weapon'];
let equipment_keys   = ['helmet', 'chestplate', 'leggings', 'boots', 'ring1', 'ring2', 'bracelet', 'necklace', 'weapon'];
let tome_keys        = ['weaponTome1', 'weaponTome2', 'armorTome1', 'armorTome2', 'armorTome3', 'armorTome4',
                        'guildTome1', 'lootrunTome1', 'gatherXpTome1', 'gatherXpTome2',
                        'dungeonXpTome1', 'dungeonXpTome2', 'mobXpTome1', 'mobXpTome2'];
