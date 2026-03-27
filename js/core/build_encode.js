// ── Shared globals (used by both build_encode.js and build_decode.js) ─────────

let player_build;
let build_powders;

let atree_data = null;
// Temporary storage for old-version ATREES during cross-version upgrade.
// Set by loadOlderVersion(), consumed by decodeHash().
let _old_ATREES = null;

// ── ID lookup helpers ────────────────────────────────────────────────────────

function getItemNameFromID(id) {
    return idMap.get(id);
}

function getTomeNameFromID(id) {
    let res = tomeIDMap.get(id);
    if (res === undefined) { console.log('WARN: Deleting unrecognized tome, id=' + id); return ""; }
    return res;
}

// ── Shared constants (used by both encode and decode) ────────────────────────

/** An indication that the vector is in binary format. */
const VECTOR_FLAG = 0xC;

/** The length, in bits, of the version field of the header. */
const VERSION_BITLEN = 10;

/**
 * A map of the indexes of the powderable items in the equipment array
 * and their corresponding index in the build powders array.
 */
const powderables = new Map([0, 1, 2, 3, 8].map((x, i) => [x, i]));

/** Length, in chars, of the custom binary string */
const CUSTOM_STR_LENGTH_BITLEN = 12;

// ── Encoding functions ───────────────────────────────────────────────────────

/**
 * Encode the build's tomes and return the resulting vector.
 * @param {Tome[]} tomes
 */
function encodeTomes(tomes) {
    const tomesVec = new EncodingBitVector(0, 0);
    if (tomes.every(t => t.statMap.has("NONE"))) {
        tomesVec.appendFlag("TOMES_FLAG", "NO_TOMES");
    } else {
        tomesVec.appendFlag("TOMES_FLAG", "HAS_TOMES");
        for (const tome of tomes) {
            if (tome.statMap.get("NONE")) {
                tomesVec.appendFlag("TOME_SLOT_FLAG", "UNUSED")
            } else {
                tomesVec.appendFlag("TOME_SLOT_FLAG", "USED")
                tomesVec.append(tome.statMap.get("id"), ENC.TOME_ID_BITLEN);
            }
        }
    }
    return tomesVec;
}

/**
 * Collect identical powder elements, keeping their original order in place.
 * @WARN(orgold, in-game vers' 2.1.6): Do not change tier order; This affects powder specials.
 *
 * - T6 E6 T6 E6       => T6 T6 E6 E6
 * - T6 T4 T6 T4       => T6 T4 T6 T4 (Preserves tier order)
 * - F6 A6 F6 T6 T6 A6 => F6 F6 A6 A6 T6 T6
 *
 * @param {number[]} powders - An array of powder IDs for a given item.
 */
function collectPowders(powders) {
    let powderChunks = ENC.POWDER_ELEMENTS.map(e => []);
    let order = ENC.POWDER_ELEMENTS.map(e => -1);
    let currOrder = 0;
    for (const powder of powders) {
        const elementIdx = Math.floor(powder / ENC.POWDER_TIERS);
        if (order[elementIdx] < 0) {
            powderChunks[currOrder].push(powder);
            order[elementIdx] = currOrder;
            currOrder += 1;
        } else {
            powderChunks[order[elementIdx]].push(powder);
        }
    }
    return powderChunks;
}

/**
 * Encode the powders for a given equipment piece and return the resulting vector.
 * Powder encoding is detailed in `ENCODING.md`.
 *
 * @param {number[]} powderset - an array of powders IDs for a given item.
 * @param {number} version - The data version.
 */
function encodePowders(powderset, version) {
    const powdersVec = new EncodingBitVector(0, 0);

    if (powderset.length === 0) {
        powdersVec.appendFlag("EQUIPMENT_POWDERS_FLAG", "NO_POWDERS");
        return powdersVec;
    }

    const collectedPowders = collectPowders(powderset); // Collect repeating powders

    powdersVec.appendFlag("EQUIPMENT_POWDERS_FLAG", "HAS_POWDERS");

    let previousPowder = -1;
    for (let powderChunk of collectedPowders) {
        let i = 0;
        let powder = undefined;
        while (i < powderChunk.length) {
            powder = powderChunk[i];
            if (previousPowder >= 0) {
                powdersVec.appendFlag("POWDER_REPEAT_OP", "NO_REPEAT");
                if (powder % ENC.POWDER_TIERS === previousPowder % ENC.POWDER_TIERS) {
                    powdersVec.appendFlag("POWDER_REPEAT_TIER_OP", "REPEAT_TIER");
                    const numElements = ENC.POWDER_ELEMENTS.length;
                    const powderElement = Math.floor(powder / ENC.POWDER_TIERS);
                    const previousPowderElement = Math.floor(previousPowder / ENC.POWDER_TIERS);
                    const elementWrapper = mod(powderElement - previousPowderElement, numElements) - 1;
                    powdersVec.append(elementWrapper, ENC.POWDER_WRAPPER_BITLEN);
                } else {
                    powdersVec.appendFlag("POWDER_REPEAT_TIER_OP", "CHANGE_POWDER");
                    powdersVec.appendFlag("POWDER_CHANGE_OP", "NEW_POWDER");
                    powdersVec.append(encodePowderIdx(powder, ENC.POWDER_TIERS), ENC.POWDER_ID_BITLEN);
                }
            } else {
                powdersVec.append(encodePowderIdx(powder, ENC.POWDER_TIERS), ENC.POWDER_ID_BITLEN);
            }
            while (++i < powderChunk.length && powderChunk[i] == powder) {
                powdersVec.appendFlag("POWDER_REPEAT_OP", "REPEAT")
            }
            previousPowder = powder;
        }
    }
    powdersVec.appendFlag("POWDER_REPEAT_OP", "NO_REPEAT");
    powdersVec.appendFlag("POWDER_REPEAT_TIER_OP", "CHANGE_POWDER");
    powdersVec.appendFlag("POWDER_CHANGE_OP", "NEW_ITEM")

    return powdersVec;
}

/**
 * Return the appropriate equipment flag given an item.
 * @param {Item | Craft | Custom} eq
 * @returns number
 */
function getEquipmentKind(eq) {
    if (eq.statMap.get("custom")) {
        return ENC.EQUIPMENT_KIND.CUSTOM;
    } else if (eq.statMap.get("crafted")) {
        return ENC.EQUIPMENT_KIND.CRAFTED;
    } else {
        return ENC.EQUIPMENT_KIND.NORMAL;
    }
}

/**
 * Encode all wearable equipment and return the resulting vector.
 *
 * @param {Array<Item | Craft | Custom>} equipment - An array of the equipment to encode
 * @param {number[]} powders - An array of powder ids for each powderable item
 * @param {number} version - encoding version
 * @returns {EncodingBitVector}
 */
function encodeEquipment(equipment, powders, version) {
    const equipmentVec = new EncodingBitVector(0, 0);

    for (const [idx, eq] of equipment.entries()) {
        const equipmentKind = getEquipmentKind(eq);
        equipmentVec.append(equipmentKind, ENC.EQUIPMENT_KIND.BITLEN);
        switch (equipmentKind) {
            case ENC.EQUIPMENT_KIND.NORMAL: {
                let eqID = 0;
                if (eq.statMap.get("NONE") !== true) {
                    eqID = eq.statMap.get("id") + 1;
                }
                equipmentVec.append(eqID, ENC.ITEM_ID_BITLEN);
                break;
            }
            case ENC.EQUIPMENT_KIND.CRAFTED: {
                const craftedHash = eq.statMap.get("hash").substring(3);
                // Legacy versions start with their first bit set
                if (Base64.toInt(craftedHash[0]) & 0x1 === 1) {
                    equipmentVec.merge([encodeCraft(eq)]);
                } else {
                    equipmentVec.appendB64(craftedHash);
                }
                break;
            }
            case ENC.EQUIPMENT_KIND.CUSTOM: {
                const customHash = eq.statMap.get("hash").substring(3);
                // Legacy versions start with their first bit set
                if (Base64.toInt(customHash[0]) & 0x1 === 1) {
                    const newCustom = encodeCustom(eq, true);
                    equipmentVec.append(newCustom.length / 6, CUSTOM_STR_LENGTH_BITLEN);
                    equipmentVec.merge([newCustom]);
                } else {
                    equipmentVec.append(customHash.length, CUSTOM_STR_LENGTH_BITLEN);
                    equipmentVec.appendB64(customHash);
                }
                break;
            }
        }

        // Encode powders
        if (powderables.has(idx)) {
            equipmentVec.merge([encodePowders(powders[powderables.get(idx)], version)]);
        }
    }
    return equipmentVec;
}

/**
 * Encode skillpoints.
 * The term "manual assignment" refers to skillpoints manually assigned in **Wynnbuilder** and not in **Wynncraft**.
 *
 * Assigned skillpoints are in the range [-2**ENC.MAX_SP_BITLEN, 2**ENC.MAX_SP_BITLEN).
 * @param {number[]} finalSp - Array of skillpoints after manual assignment from the user in `etwfa` order.
 * @param {number[]} originalSp - Array of skillpoints before manual assignment from the user in `etwfa` order.
 * @param {number} version - Encoding version
 * @returns {EncodingBitVector}
 */
function encodeSp(finalSp, originalSp, version) {
    const spDeltas = zip2(finalSp, originalSp).map(([x, y]) => x - y);
    const spBitvec = new EncodingBitVector(0, 0);

    if (spDeltas.every(x => x === 0)) {
        // No manually assigned skillpoints, let the builder handle the rest.
        spBitvec.appendFlag("SP_FLAG", "AUTOMATIC")
    } else {
        // We have manually assigned skillpoints
        spBitvec.appendFlag("SP_FLAG", "ASSIGNED");
        for (const [i, sp] of finalSp.entries()) {
            if (spDeltas[i] === 0) {
                // The specific element has no manually assigned skillpoints
                spBitvec.appendFlag("SP_ELEMENT_FLAG", "ELEMENT_UNASSIGNED");
            } else {
                // The specific element has manually assigned skillpoints
                spBitvec.appendFlag("SP_ELEMENT_FLAG", "ELEMENT_ASSIGNED");
                // Truncate to fit within the specified range.
                const truncSp = sp & ((1 << ENC.MAX_SP_BITLEN) - 1)
                spBitvec.append(truncSp, ENC.MAX_SP_BITLEN);
            }
        }
    }

    return spBitvec;
}

/**
 * Encode the build's level.
 * Encoding:
 * - Max level - encode a LEVEL_FLAG.MAX flag.
 * - Any other level - encode a LEVEL_FLAG.OTHER flag, then endcode the level in LEVEL_BITLEN bits.
 *
 * @param {number} level - The build's level.
 * @param {version} version - The data verison.
 */
function encodeLevel(level, version) {
    const levelVec = new EncodingBitVector(0, 0);
    if (level === ENC.MAX_LEVEL) {
        levelVec.appendFlag("LEVEL_FLAG", "MAX");
    } else {
        levelVec.appendFlag("LEVEL_FLAG", "OTHER");
        levelVec.append(level, ENC.LEVEL_BITLEN)
    }
    return levelVec;
}

/**
 * Encode aspects.
 * @param {AspectSpec[]} aspects - an array of aspects.
 * @param {number} version - the data version.
 */
function encodeAspects(aspects, version) {
    const aspectsVec = new EncodingBitVector(0, 0);

    if (aspects.every(([aspect, _]) => aspect.NONE === true)) {
        aspectsVec.appendFlag("ASPECTS_FLAG", "NO_ASPECTS");
    } else {
        aspectsVec.appendFlag("ASPECTS_FLAG", "HAS_ASPECTS");
        for (const [aspect, tier] of aspects) {
            if (aspect.NONE === true) {
                aspectsVec.appendFlag("ASPECT_SLOT_FLAG", "UNUSED");
            } else {
                aspectsVec.appendFlag("ASPECT_SLOT_FLAG", "USED");
                aspectsVec.append(aspect.id, ENC.ASPECT_ID_BITLEN);
                aspectsVec.append(tier - 1, ENC.ASPECT_TIER_BITLEN);
            }
        }
    }

    return aspectsVec;
}

/**
 * Encode a header with metadata about the build.
 * The flag and the version length are hardcoded because
 * they are decoded before any data loading.
 *
 * @param {number} encoding_version - The version to encode.
 */
function encodeHeader(encoding_version) {
    const headerVec = new EncodingBitVector(0, 0);

    // Legacy versions used versions 0..11 in decimal to encode.
    // In order to differentiate with minimal sacrifice, encode
    // the first character to be > 11.
    headerVec.append(VECTOR_FLAG, 6);
    headerVec.append(encoding_version, VERSION_BITLEN);
    return headerVec;
}

/**
 * Encodes the build according to the spec in `ENCODING.md` and returns the resulting BitVector.
 *
 * @param {Build} build - The calculated player build.
 * @param {Array<Array<number>>} powders - An array of powdersets for each item.
 * @param {number[]} skillpoints - An array of the skillpoint values to encode.
 * @param {Object} atree - An object representation of the ability tree.
 * @param {Object} atree_state - An object representation of the ability tree state.
 * @param {AspectSpec[]} aspects - An array of aspects.
 * @returns {EncodingBitVector}
 */
function encodeBuild(build, powders, skillpoints, atree, atree_state, aspects) {
    if (!build) return;

    const finalVec = new EncodingBitVector(0, 0);

    const vecs = [
        encodeHeader(wynn_version_id),
        encodeEquipment([...build.equipment, build.weapon], powders, wynn_version_id),
        encodeTomes(build.tomes, powders, wynn_version_id),
        encodeSp(skillpoints, build.total_skillpoints, wynn_version_id),
        encodeLevel(build.level, wynn_version_id),
        encodeAspects(aspects, wynn_version_id),
        encodeAtree(atree, atree_state, wynn_version_id),
    ]

    finalVec.merge(vecs)

    return finalVec;
}

// ── Atree encode/decode ──────────────────────────────────────────────────────
// Both live here because build_encode.js loads first and decodeAtree is needed
// by build_decode.js, builder_graph.js, and solver.js.

/**
 * Ability tree encode and decode functions
 *
 * Based on a traversal, basically only uses bits to represent the nodes that are on (and "dark" outgoing edges).
 * credit: SockMower
 */

/**
 * Return: BitVector
 */
function encodeAtree(atree, atree_state) {
    let retVec = new BitVector(0, 0);

    function traverse(head, atree_state, visited, ret) {
        for (const child of head.children) {
            if (visited.has(child.ability.id)) { continue; }
            visited.set(child.ability.id, true);
            if (atree_state.get(child.ability.id).active) {
                ret.append(1, 1);
                traverse(child, atree_state, visited, ret);
            }
            else {
                ret.append(0, 1);
            }
        }
    }

    traverse(atree[0], atree_state, new Map(), retVec);
    return retVec;
}

/**
 * Return: List of active nodes
 */
function decodeAtree(atree, bits) {
    let i = 0;
    let ret = [];
    ret.push(atree[0]);
    function traverse(head, visited, ret) {
        for (const child of head.children) {
            if (visited.has(child.ability.id)) { continue; }
            visited.set(child.ability.id, true);
            if (bits.readBit(i)) {
                i += 1;
                ret.push(child);
                traverse(child, visited, ret);
            }
            else {
                i += 1;
            }
        }
    }
    traverse(atree[0], new Map(), ret);
    return ret;
}

// ── Utility functions ────────────────────────────────────────────────────────

function getFullURL() {
    return window.location.href;
}

function useCopyButton(id, text, default_text) {
    copyTextToClipboard(text);
    setText(id, "Copied!");
    setTimeout(() => setText(id, default_text), 1000);
}

function copyBuild() {
    useCopyButton("copy-button", getFullURL(), "Copy short");
}

function shareBuild(build) {
    if (!build) return;

    let lines = [
        getFullURL(),
        "> Wynnbuilder build:",
        ...build.equipment.map(x => `> ${x.statMap.get("displayName")}`),
        `> ${build.weapon.statMap.get("displayName")} [${build_powders[4].map(x => powderNames.get(x)).join("")}]`
    ];

    if (!build.tomes.every(tome => tome.statMap.has("NONE"))) {
        lines.push("> (Has Tomes)")
    }

    const text = lines.join('\n');
    useCopyButton("share-button", text, "Copy for sharing");
}

// ── Legacy encode (documentation only) ───────────────────────────────────────

/**
 *  Stores the entire build in a string using B64 encoding.
 *  Here only for documentation purposes.
 */
function encodeBuildLegacy(build, powders, skillpoints, atree, atree_state, aspects) {

    if (build) {
        let build_string;

        //V6 encoding - Tomes
        //V7 encoding - ATree
        //V8 encoding - wynn version
        //V9 encoding - lootrun tome
        //V10 encoding - marathon, mysticism, and expertise tomes
        //V11 encoding - Aspects
        build_version = 11;
        build_string = "";
        tome_string = "";

        for (const item of build.items) {
            if (item.statMap.get("custom")) {
                let custom = "CI-" + encodeCustom(item, true);
                build_string += Base64.fromIntN(custom.length, 3) + custom;
                //build_version = Math.max(build_version, 5);
            } else if (item.statMap.get("crafted")) {
                build_string += "CR-" + encodeCraftLegacy(item);
            } else if (item.statMap.get("category") === "tome") {
                let tome_id = item.statMap.get("id");
                //if (tome_id <= 60) {
                // valid normal tome. ID 61-63 is for NONE tomes.
                //build_version = Math.max(build_version, 6);
                //}
                tome_string += Base64.fromIntN(tome_id, 2);
            } else {
                build_string += Base64.fromIntN(item.statMap.get("id"), 3);
            }
        }

        for (const skp of skillpoints) {
            build_string += Base64.fromIntN(skp, 2); // Maximum skillpoints: 2048
        }
        build_string += Base64.fromIntN(build.level, 2);
        for (const _powderset of powders) {
            let n_bits = Math.ceil(_powderset.length / 6);
            build_string += Base64.fromIntN(n_bits, 1); // Hard cap of 378 powders.
            // Slice copy.
            let powderset = _powderset.slice();
            while (powderset.length != 0) {
                let firstSix = powderset.slice(0, 6).reverse();
                let powder_hash = 0;
                for (const powder of firstSix) {
                    powder_hash = (powder_hash << 5) + 1 + powder; // LSB will be extracted first.
                }
                build_string += Base64.fromIntN(powder_hash, 5);
                powderset = powderset.slice(6);
            }
        }
        build_string += tome_string;

        for (const [aspect, tier] of aspects) {
            build_string += Base64.fromIntN(aspect.id, 2);
            build_string += Base64.fromIntN(tier, 1);
        }

        if (atree.length > 0 && atree_state.get(atree[0].ability.id).active) {
            //build_version = Math.max(build_version, 7);
            const bitvec = encodeAtree(atree, atree_state);
            build_string += bitvec.toB64();
        }

        return build_version.toString() + "_" + build_string;
    }
}

// ── Solver params encoding ───────────────────────────────────────────────────

/**
 * Separator character between build hash and solver hash in the URL fragment.
 * '_' is not in the WynnBuilder Base64 alphabet (0-9A-Za-z+-), so it's safe.
 */
const SOLVER_HASH_SEP = '_';

/** Write a signed integer as 2's complement into an EncodingBitVector. */
function _encode_signed(bv, value, bits) {
    const mask = (1 << bits) - 1;
    bv.append(value & mask, bits);
}

/**
 * Restriction value size classes for variable-width encoding.
 * [2] size_class selects the bit width for the value field:
 *   0 →  6-bit unsigned (0 to 63)
 *   1 →  8-bit signed   (±127)
 *   2 → 16-bit signed   (±32,767)
 *   3 → 26-bit signed   (±33,554,431)
 */
const _RESTR_VALUE_BITS = [6, 8, 16, 26];
const _RESTR_VALUE_SIGNED = [false, true, true, true];

/** Pick the smallest size class that can represent `value`. */
function _restr_size_class(value) {
    if (value >= 0 && value <= 63) return 0;
    if (value >= -127 && value <= 127) return 1;
    if (value >= -32767 && value <= 32767) return 2;
    return 3;
}

/**
 * Timing size classes (per value, unsigned):
 *   SC 0: 3-bit ×20  → 0.00–0.35s  (covers defaults 0.3, 0.1)
 *   SC 1: 5-bit int  → 0–31s
 *   SC 2: 6-bit ×20  → 0.00–3.15s
 *   SC 3: 10-bit ×100 → 0.00–10.23s
 */
const _TIMING_BITS = [3, 5, 6, 10];
const _TIMING_DIVISOR = [20, 1, 20, 100];

function _timing_size_class(seconds) {
    const v20 = Math.round(seconds * 20);
    if (v20 >= 0 && v20 <= 7) return 0;
    const vi = Math.round(seconds);
    if (vi >= 0 && vi <= 31) return 1;
    if (v20 >= 0 && v20 <= 63) return 2;
    return 3;
}

function _encode_timing(bv, seconds, sc) {
    const div = _TIMING_DIVISOR[sc];
    const bits = _TIMING_BITS[sc];
    const raw = Math.min((1 << bits) - 1, Math.max(0, Math.round(seconds * div)));
    bv.append(raw, bits);
}

/**
 * Default values for solver fixed-header fields.
 * Fields matching their default are omitted from the binary via a presence bitmask.
 */
const _SOLVER_DEFAULTS = {
    roll: 85,            // ROLL_DEFAULT (v2 backward compat)
    roll_groups: { damage: 85, mana: 100, healing: 85, misc: 85 },
    sfree: 0,
    dir_enabled: 0x1F,   // all 5 SP directions enabled
    lvl_min: 1,
    // lvl_max: MAX_PLAYER_LEVEL — resolved at runtime
    nomaj: false,
    gtome: 0,
    dtime: false,
    mana_disabled: false,
};

/**
 * Encode solver-specific parameters into a Base64 string for the URL hash.
 * Version 1 binary format — compact binary with default elision.
 *
 * Binary layout (EncodingBitVector):
 *   [3]   version (110 = v6)
 *   [10]  field_present bitmask (1 = non-default, field encoded below)
 *          bit 0: roll_groups (default {85,100,85,85})
 *          bit 1: sfree      (default 0)
 *          bit 2: dir        (default 0x1F)
 *          bit 3: lvl_min    (default 1)
 *          bit 4: lvl_max    (default MAX_PLAYER_LEVEL)
 *          bit 5: nomaj      (default false)
 *          bit 6: gtome      (default 0)
 *          bit 7: dtime      (default false)
 *          bit 8: mana_disabled (default false) — bare flag, no payload
 *          bit 9: (reserved — was flat_mana in v5, removed in v6)
 *   --- conditional fixed fields (only if presence bit = 1) ---
 *   NOTE: Bit widths below have corresponding range constants in
 *         constants.js (e.g. COMBO_QTY_MAX, BOOST_SLIDER_MAX,
 *         MAX_RESTRICTION_ROWS, MAX_COMBO_ROWS, MAX_BLACKLIST_ROWS).
 *         Keep them in sync.
 *   [28]  roll_groups: 4×7 bits (damage, mana, healing, misc) each 0-100
 *   [8]   sfree mask
 *   [5]   dir_enabled bitmask
 *   [7]   lvl_min - 1 (0 to MAX_PLAYER_LEVEL-1)
 *   [7]   lvl_max - 1 (0 to MAX_PLAYER_LEVEL-1)
 *   [1]   nomaj
 *   [2]   gtome
 *   [1]   dtime
 *   (bit 8: no payload — presence bit itself is the value)
 *   (bit 9: reserved — was flat_mana in v5, removed in v6)
 *   [4]   restriction_count (0-15)
 *     Per restriction:
 *       [7]   stat_index (index into RESTRICTION_STATS)
 *       [1]   op (0=ge, 1=le)
 *       [2]   size_class (0=6-bit unsigned, 1=8-bit signed, 2=16-bit signed, 3=26-bit signed)
 *       [6/8/16/26]  value
 *   [8]   combo_row_count (0-255)
 *     Per combo row:
 *       [7]   spell_node_id
 *       [7]   qty (0-127)
 *       [1]   mana_excl
 *       [1]   dmg_excl
 *       [1]   has_hits
 *       [16]  hits×100 (only if has_hits=1, 0-655.35 hits)
 *       [4]   boost_count (0-15)
 *       Per boost:
 *         [7]   node_id
 *         [2]   effect_pos (0-3)
 *         [1]   has_value (0=toggle, 1=slider)
 *         [10]  value (only if has_value=1, 0-1023; v1-v3: 7-bit, 0-127)
 *   [4]   blacklist_count (0-15)
 *     Per blacklist entry:
 *       [14]  item_id (0-16383)
 *
 * @param {Object} params
 * @param {Object} params.roll_groups - Per-group roll percentages {damage, mana, healing, misc} (0-100 each)
 * @param {number} params.sfree - Bitmask of solver-free slots (8 bits)
 * @param {number} params.dir_enabled - Bitmask of enabled SP directions (5 bits)
 * @param {number} params.lvl_min - Minimum item level (1-MAX_PLAYER_LEVEL)
 * @param {number} params.lvl_max - Maximum item level (1-MAX_PLAYER_LEVEL)
 * @param {boolean} params.nomaj - No-Major-ID filter
 * @param {number} params.gtome - Guild tome (0=off, 1=standard, 2=rare)
 * @param {boolean} params.dtime - Allow downtime flag
 * @param {boolean} params.mana_disabled - Mana calculation disabled
 * @param {Array} params.restrictions - [{stat_index, op, value}]
 * @param {Array} params.combo_rows - [{spell_node_id, qty, mana_excl, dmg_excl, has_hits, hits, boosts: [{node_id, effect_pos, has_value, value}]}]
 * @param {Array} params.blacklist_ids - [item_id, ...]
 * @returns {string} Base64 string for appending after SOLVER_HASH_SEP
 */
function encodeSolverParams(params) {
    const bv = new EncodingBitVector(0, 0);
    const max_lvl = (typeof MAX_PLAYER_LEVEL !== 'undefined') ? MAX_PLAYER_LEVEL : 121;

    // Version: 3 bits (v6 = 110)
    bv.append(6, 3);

    // ── Presence bitmask (10 bits) ──
    // v3: bit 0 → roll_groups (4×7 bits), replaces v2's single roll field
    const rg = params.roll_groups || _SOLVER_DEFAULTS.roll_groups;
    const roll_dmg  = Math.max(0, Math.min(100, rg.damage  ?? 85));
    const roll_mana = Math.max(0, Math.min(100, rg.mana    ?? 100));
    const roll_heal = Math.max(0, Math.min(100, rg.healing ?? 85));
    const roll_misc = Math.max(0, Math.min(100, rg.misc    ?? 85));
    const sfree = params.sfree & 0xFF;
    const dir = params.dir_enabled & 0x1F;
    const lvl_min = Math.max(0, Math.min(max_lvl - 1, (params.lvl_min || 1) - 1));
    const lvl_max = Math.max(0, Math.min(max_lvl - 1, (params.lvl_max || max_lvl) - 1));
    const nomaj = params.nomaj ? 1 : 0;
    const gtome = params.gtome & 0x3;
    const dtime = params.dtime ? 1 : 0;
    const mana_disabled = params.mana_disabled ? 1 : 0;

    let presence = 0;
    const rd = _SOLVER_DEFAULTS.roll_groups;
    if (roll_dmg !== rd.damage || roll_mana !== rd.mana || roll_heal !== rd.healing || roll_misc !== rd.misc) presence |= (1 << 0);
    if (sfree !== _SOLVER_DEFAULTS.sfree) presence |= (1 << 1);
    if (dir !== _SOLVER_DEFAULTS.dir_enabled) presence |= (1 << 2);
    if (lvl_min !== (_SOLVER_DEFAULTS.lvl_min - 1)) presence |= (1 << 3);
    if (lvl_max !== (max_lvl - 1)) presence |= (1 << 4);
    if (nomaj !== 0) presence |= (1 << 5);
    if (gtome !== _SOLVER_DEFAULTS.gtome) presence |= (1 << 6);
    if (dtime !== 0) presence |= (1 << 7);
    if (mana_disabled) presence |= (1 << 8);

    bv.append(presence, 10);

    // ── Conditional fixed fields ──
    if (presence & (1 << 0)) {
        bv.append(roll_dmg, 7);
        bv.append(roll_mana, 7);
        bv.append(roll_heal, 7);
        bv.append(roll_misc, 7);
    }
    if (presence & (1 << 1)) bv.append(sfree, 8);
    if (presence & (1 << 2)) bv.append(dir, 5);
    if (presence & (1 << 3)) bv.append(lvl_min, 7);
    if (presence & (1 << 4)) bv.append(lvl_max, 7);
    if (presence & (1 << 5)) bv.append(nomaj, 1);
    if (presence & (1 << 6)) bv.append(gtome, 2);
    if (presence & (1 << 7)) bv.append(dtime, 1);
    // bit 8 (mana_disabled): bare flag — no payload bits
    // bit 9: reserved (was flat_mana in v5, removed in v6)

    // ── Restrictions ──
    const restrictions = params.restrictions || [];
    bv.append(Math.min(15, restrictions.length), 4);
    for (let i = 0; i < Math.min(15, restrictions.length); i++) {
        const r = restrictions[i];
        bv.append(r.stat_index & 0x7F, 7);
        bv.append(r.op & 1, 1);
        const sc = _restr_size_class(r.value);
        bv.append(sc, 2);
        if (_RESTR_VALUE_SIGNED[sc]) {
            _encode_signed(bv, r.value, _RESTR_VALUE_BITS[sc]);
        } else {
            bv.append(Math.max(0, r.value), _RESTR_VALUE_BITS[sc]);
        }
    }

    // ── Combo rows ──
    const combo_rows = params.combo_rows || [];
    bv.append(Math.min(255, combo_rows.length), 8);
    for (let i = 0; i < Math.min(255, combo_rows.length); i++) {
        const row = combo_rows[i];
        bv.append(row.spell_node_id & 0x7F, 7);
        bv.append(Math.min(127, row.qty || 0), 7);
        bv.append(row.mana_excl ? 1 : 0, 1);
        bv.append(row.dmg_excl ? 1 : 0, 1);

        // v2: DPS hits field (has_hits bit + 16-bit hits×100).
        const has_hits = row.has_hits ? 1 : 0;
        bv.append(has_hits, 1);
        if (has_hits) {
            bv.append(Math.min(65535, Math.max(0, Math.round((row.hits || 0) * 100))), 16);
        }

        const boosts = row.boosts || [];
        bv.append(Math.min(15, boosts.length), 4);
        for (let j = 0; j < Math.min(15, boosts.length); j++) {
            const b = boosts[j];
            bv.append(b.node_id & 0x7F, 7);
            bv.append(b.effect_pos & 0x3, 2);
            bv.append(b.has_value ? 1 : 0, 1);
            if (b.has_value) {
                bv.append(Math.min(1023, Math.max(0, b.value || 0)), 10);
            }
        }

        // v5: per-row timing (cast_time + delay). Elide when both match defaults
        // (melee default cast_time is 0; spell default is SPELL_CAST_TIME).
        const is_melee_row = (row.spell_node_id & 0x7F) === 0;
        const default_ct = is_melee_row ? 0 : SPELL_CAST_TIME;
        const has_timing = (row.cast_time !== undefined && row.delay !== undefined
            && !(row.cast_time === default_ct && row.delay === SPELL_CAST_DELAY)) ? 1 : 0;
        bv.append(has_timing, 1);
        if (has_timing) {
            const ct_sc = _timing_size_class(row.cast_time);
            bv.append(ct_sc, 2);
            _encode_timing(bv, row.cast_time, ct_sc);
            const dl_sc = _timing_size_class(row.delay);
            bv.append(dl_sc, 2);
            _encode_timing(bv, row.delay, dl_sc);
        }
    }

    // ── Blacklist ──
    const blacklist_ids = params.blacklist_ids || [];
    bv.append(Math.min(15, blacklist_ids.length), 4);
    for (let i = 0; i < Math.min(15, blacklist_ids.length); i++) {
        bv.append(blacklist_ids[i] & 0x3FFF, 14);
    }

    return bv.toB64();
}
