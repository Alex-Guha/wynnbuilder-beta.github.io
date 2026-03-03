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
    if (res === undefined) { console.log('WARN: Deleting unrecognized tome, id='+id); return ""; }
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
                    const elementWrapper = mod((powder - previousPowder) / ENC.POWDER_TIERS, numElements) - 1;
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
                let custom = "CI-"+encodeCustom(item, true);
                build_string += Base64.fromIntN(custom.length, 3) + custom;
                //build_version = Math.max(build_version, 5);
            } else if (item.statMap.get("crafted")) {
                build_string += "CR-"+encodeCraftLegacy(item);
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
                let firstSix = powderset.slice(0,6).reverse();
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

// ── Stream helper (used by solver params encoding/decoding) ──────────────────

/** Drain a ReadableStream into a single Uint8Array. */
async function _read_stream_bytes(stream) {
    const reader = stream.getReader();
    const chunks = [];
    for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((n, c) => n + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// ── Solver params encoding ───────────────────────────────────────────────────

/**
 * Separator character between build hash and solver hash in the URL fragment.
 * '_' is not in the WynnBuilder Base64 alphabet (0-9A-Za-z+-), so it's safe.
 */
const SOLVER_HASH_SEP = '_';

/**
 * Encode solver-specific parameters into a Base64 string for the URL hash.
 *
 * Binary layout (EncodingBitVector):
 *   [7]  roll percentage (0-100)
 *   [8]  sfree mask (solver-free equipment slots)
 *   [5]  dir_enabled bitmask (bit0=str, bit1=dex, ..., bit4=agi; 1=enabled)
 *   [7]  lvl_min - 1 (0-105, stored offset by 1)
 *   [7]  lvl_max - 1 (0-105, stored offset by 1)
 *   [1]  nomaj (no-major-ID filter)
 *   [2]  gtome (0=off, 1=standard, 2=rare)
 *   [1]  dtime (allow downtime)
 *   [10] ctime (combo time in seconds, 0-1023)
 *   --- 48 bits fixed ---
 *   [12] restrictions_byte_length (0 = no restrictions)
 *   [N*8] restrictions UTF-8 bytes ("stat:op:value|..." text)
 *   [16] combo_compressed_byte_length (0 = no combo)
 *   [N*8] combo deflate-raw compressed bytes
 *
 * @param {Object} params
 * @param {number} params.roll - Roll percentage (0-100)
 * @param {number} params.sfree - Bitmask of solver-free slots (8 bits)
 * @param {number} params.dir_enabled - Bitmask of enabled SP directions (5 bits)
 * @param {number} params.lvl_min - Minimum item level (1-106)
 * @param {number} params.lvl_max - Maximum item level (1-106)
 * @param {boolean} params.nomaj - No-Major-ID filter
 * @param {number} params.gtome - Guild tome (0=off, 1=standard, 2=rare)
 * @param {boolean} params.dtime - Allow downtime flag
 * @param {number} params.ctime - Combo time in seconds (0-1023)
 * @param {string} params.restrictions_text - Pipe-separated "key:op:value" restrictions
 * @param {string} params.combo_text - Multi-line combo text
 * @returns {Promise<string>} Base64 string for appending after SOLVER_HASH_SEP
 */
async function encodeSolverParams(params) {
    const bv = new EncodingBitVector(0, 0);

    // Roll percentage: 7 bits (0-100)
    bv.append(Math.max(0, Math.min(100, params.roll || 0)), 7);

    // sfree mask: 8 bits
    bv.append(params.sfree & 0xFF, 8);

    // dir_enabled: 5 bits (bit 0 = str, bit 4 = agi; 1 = enabled)
    bv.append(params.dir_enabled & 0x1F, 5);

    // lvl_min: 7 bits (stored as value - 1; 1-106 → 0-105)
    bv.append(Math.max(0, Math.min(105, (params.lvl_min || 1) - 1)), 7);

    // lvl_max: 7 bits
    bv.append(Math.max(0, Math.min(105, (params.lvl_max || 106) - 1)), 7);

    // nomaj: 1 bit
    bv.append(params.nomaj ? 1 : 0, 1);

    // gtome: 2 bits (0=off, 1=standard, 2=rare)
    bv.append(params.gtome & 0x3, 2);

    // dtime: 1 bit
    bv.append(params.dtime ? 1 : 0, 1);

    // ctime: 10 bits (0-1023)
    bv.append(Math.min(1023, Math.max(0, params.ctime || 0)), 10);

    // ── Variable-length sections ──

    // Restrictions text: uncompressed UTF-8, length-prefixed
    const restr_bytes = params.restrictions_text
        ? new TextEncoder().encode(params.restrictions_text)
        : new Uint8Array(0);
    bv.append(restr_bytes.length, 12); // max 4095 bytes
    for (const b of restr_bytes) bv.append(b, 8);

    // Combo text: deflate-compressed, length-prefixed
    let combo_bytes = new Uint8Array(0);
    if (params.combo_text && params.combo_text.trim()) {
        try {
            const input = new TextEncoder().encode(params.combo_text);
            const cs = new CompressionStream('deflate-raw');
            const writer = cs.writable.getWriter();
            writer.write(input);
            writer.close();
            combo_bytes = await _read_stream_bytes(cs.readable);
        } catch (_) {
            // Fallback: store uncompressed with high bit marker
            combo_bytes = new TextEncoder().encode(params.combo_text);
        }
    }
    bv.append(combo_bytes.length, 16); // max 65535 bytes
    for (const b of combo_bytes) bv.append(b, 8);

    return bv.toB64();
}
