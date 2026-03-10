// ── Data loading ─────────────────────────────────────────────────────────────

/**
 * Load the latest version of hte data.
 * if the user has already opened the site before,
 * this saves bandwidth by using locally stored data.
 */
async function loadLatestVersion() {
    const latestVerName = wynn_version_names[WYNN_VERSION_LATEST];

    const loadPromises = [
        load_atree_data(latestVerName),
        load_major_id_data(latestVerName),
        item_loader.load_init(),
        ingredient_loader.load_init(),
        tome_loader.load_init(),
        aspect_loader.load_init(),
        load_encoding_constants(latestVerName)
    ];

    await Promise.all(loadPromises);
}

/**
 * Load an older version of the data, decoded from the build's hash.
 */
async function loadOlderVersion() {
    const updateMsg = 'This build was created in an older version of wynncraft '
                + `(${wynn_version_names[wynn_version_id]} < ${wynn_version_names[WYNN_VERSION_LATEST]}). `
                + 'Would you like to update to the latest version? Updating may break the build and ability tree.';

    const decodingVersion = wynn_version_id;
    // Upgrade the build to the latest version
    if (confirm(updateMsg)) {
        wynn_version_id = WYNN_VERSION_LATEST;

        // Load old atree data from the build's version so we can migrate active
        // nodes to the new tree structure later (in decodeHash / decodeHashLegacy).
        _load_old_atree_data(wynn_version_names[decodingVersion]);

        await loadLatestVersion();
    } else {
        const verName = wynn_version_names[wynn_version_id];

        await Promise.all([
            load_atree_data(verName),
            load_major_id_data(verName),
            item_loader.load_init(verName),
            ingredient_loader.load_init(verName),
            tome_loader.load_init(verName),
            aspect_loader.load_init(verName),
            load_encoding_constants(verName)
        ]);
    }
}

async function _load_old_atree_data(version_str) {
    const getUrl = window.location;
    let baseUrl = `${getUrl.protocol}//${getUrl.host}${SITE_BASE}/`;
    let url = `${baseUrl}/data/${version_str}/atree.json`;
    _old_ATREES = await (await fetch(url)).json();
}

// ── Decoding functions ───────────────────────────────────────────────────────

/**
 * Decode the header portion of an encoded build.
 * @param {BitVectorCursor} cursor - a cursor into the BitVector representation of the build.
 * @returns {number}
 */
function decodeHeader(cursor) {
    const binaryFlag = cursor.advanceBy(6);
    return cursor.advanceBy(VERSION_BITLEN);
}

/**
 * Decode the powders portion of an encoded build, for a given item.
 *
 * @param {BitVectorCursor} cursor - a cursor into the BitVector representation of the build.
 * @returns {number[]}
 *
 * TODO(@orgold): Refactor this code to not use 3 nested switch cases
 */
function decodePowders(cursor) {
    // HAS_POWDERS flag is true, so we know there's at least 1 powder.
    let powders = [decodePowderIdx(cursor.advanceBy(DEC.POWDER_ID_BITLEN), DEC.POWDER_TIERS)];
    let prevPowder = powders[0];
    outer: while (true) {
        repeat: switch (cursor.advanceBy(DEC.POWDER_REPEAT_OP.BITLEN)) {
            // Repeat the previous powders
            case DEC.POWDER_REPEAT_OP.REPEAT: {
                powders.push(prevPowder);
                break;
            }
            // Don't repeat previous powder
            case DEC.POWDER_REPEAT_OP.NO_REPEAT: {
                switch (cursor.advanceBy(DEC.POWDER_REPEAT_TIER_OP.BITLEN)) {
                    // Decode a new powder
                    case DEC.POWDER_REPEAT_TIER_OP.REPEAT_TIER: {
                        const powderWrap = cursor.advanceBy(DEC.POWDER_WRAPPER_BITLEN);
                        const prevPowderElem = Math.floor(prevPowder / DEC.POWDER_TIERS);
                        const prevPowderTier = prevPowder % DEC.POWDER_TIERS;
                        const newPowderElem = (prevPowderElem + powderWrap + 1) % DEC.POWDER_ELEMENTS.length;
                        const newPowder = newPowderElem * DEC.POWDER_TIERS + prevPowderTier;
                        powders.push(newPowder);
                        break repeat;
                    };
                    case DEC.POWDER_REPEAT_TIER_OP.CHANGE_POWDER: {
                        switch (cursor.advanceBy(DEC.POWDER_CHANGE_OP.BITLEN)) {
                            case DEC.POWDER_CHANGE_OP.NEW_POWDER: {
                                powders.push(decodePowderIdx(cursor.advanceBy(DEC.POWDER_ID_BITLEN), DEC.POWDER_TIERS));
                                break repeat;
                            }
                            // Stop decoding powders
                            case DEC.POWDER_CHANGE_OP.NEW_ITEM: break outer;

                        };
                    }
                }
                break;
            }
        }
        prevPowder = powders.at(-1);
    }
    powders = powders.map(x => powderNames.get(x)).join("")
    return powders;
}

/**
 * Decode the equipment portion of an encoded build, including powders, and return both.
 *
 * @param {BitVectorCursor} cursor - a cursor into the BitVector representation of the build.
 * @returns {[Array<Item | Cusotm | Craft>, number[]]}
 *
 * TODO(@orgold): Refactor this code to not use 3 nested switch cases
 */
function decodeEquipment(cursor) {
    const equipments = [];
    const powders = []
    for (let i = 0; i < DEC.EQUIPMENT_NUM; ++i) {
        const kind = cursor.advanceBy(DEC.EQUIPMENT_KIND.BITLEN);
        // Decode equipment kind
        switch (kind) {
            case DEC.EQUIPMENT_KIND.NORMAL: {
                const id = cursor.advanceBy(DEC.ITEM_ID_BITLEN);
                if (id === 0) {
                    equipments.push(null);
                } else {
                    equipments.push(idMap.get(id - 1));
                }
                break;
            }
            case DEC.EQUIPMENT_KIND.CRAFTED: {
                let craft = decodeCraft({cursor: cursor});
                equipments.push(craft.hash);
                break;
            }
            case DEC.EQUIPMENT_KIND.CUSTOM: {
                const customLengthBits = cursor.advanceBy(CUSTOM_STR_LENGTH_BITLEN) * 6;
                let custom = decodeCustom({cursor: cursor.spawn(customLengthBits)});
                equipments.push(custom.statMap.get("hash"));
                // Skip the length of the custom because we spawned a new cursor, so the original didn't mutate.
                cursor.skip(customLengthBits);
                break;
            }
        }

        // If applicable, decode the powders for the current item
        if (!powderables.has(i)) continue;
        if (cursor.advanceBy(DEC.EQUIPMENT_POWDERS_FLAG.BITLEN) === DEC.EQUIPMENT_POWDERS_FLAG.HAS_POWDERS) {
            powders.push(decodePowders(cursor));
        } else {
            powders.push("");
        }
    }
    return [equipments, powders];
}

/**
 * Decode the tome portion of an encoded build.
 *
 * @param {BitVectorCursor} cursor - a cursor into the BitVector representation of the build.
 * @returns {Tome[]}
 */
function decodeTomes(cursor) {
    let tomes = [];
    switch (cursor.advanceBy(DEC.TOMES_FLAG.BITLEN)) {
        case DEC.TOMES_FLAG.NO_TOMES: break;
        case DEC.TOMES_FLAG.HAS_TOMES: {
            for (let i = 0; i < DEC.TOME_NUM; ++i) {
                switch (cursor.advanceBy(DEC.TOME_SLOT_FLAG.BITLEN)) {
                    case DEC.TOME_SLOT_FLAG.UNUSED: tomes.push(null); break;
                    case DEC.TOME_SLOT_FLAG.USED: tomes.push(tomeIDMap.get(cursor.advanceBy(DEC.TOME_ID_BITLEN))); break;
                }
            }
        }
    }
    return tomes;
}

/**
 * Decode the skillpoint portion of an encoded build.
 *
 * @param {BitVectorCursor} cursor - a cursor into the BitVector representation of the build.
 * @returns {number[]}
 */
function decodeSp(cursor) {
    const skillpoints = [];
    switch (cursor.advanceBy(DEC.SP_FLAG.BITLEN)) {
        case DEC.SP_FLAG.AUTOMATIC: return null;
        case DEC.SP_FLAG.ASSIGNED: {
            for (let i = 0; i < DEC.SP_TYPES; ++i) {
                switch (cursor.advanceBy(DEC.SP_ELEMENT_FLAG.BITLEN)) {
                    case DEC.SP_ELEMENT_FLAG.ELEMENT_ASSIGNED: {
                        // Sign extend the n-bit sp to 32 bits, read as 2's complement
                        const extension = 32 - DEC.MAX_SP_BITLEN;
                        let skp = cursor.advanceBy(DEC.MAX_SP_BITLEN) << extension >> extension;
                        skillpoints.push(skp);
                        break;
                    }
                    case DEC.SP_ELEMENT_FLAG.ELEMENT_UNASSIGNED: {
                        skillpoints.push(null);
                        break;
                    }
                }
            }
        }
    }
    return skillpoints;
}

/**
 * Decode the build's level.
 */
function decodeLevel(cursor) {
    const flag = cursor.advanceBy(DEC.LEVEL_FLAG.BITLEN);
    switch (flag) {
        case DEC.LEVEL_FLAG.MAX: return DEC.MAX_LEVEL;
        case DEC.LEVEL_FLAG.OTHER: return cursor.advanceBy(DEC.LEVEL_BITLEN);
        default:
            throw new Error(`Encountered unknown flag when parsing level!`)
    }
}

function decodeAspects(cursor, cls) {
    const flag = cursor.advanceBy(DEC.ASPECTS_FLAG.BITLEN);
    const aspects = [];
    switch (flag) {
        case DEC.ASPECTS_FLAG.NO_ASPECTS: break;
        case DEC.ASPECTS_FLAG.HAS_ASPECTS: {
            for (let i = 0; i < DEC.NUM_ASPECTS; ++i) {
                switch (cursor.advanceBy(DEC.ASPECT_SLOT_FLAG.BITLEN)) {
                    case DEC.ASPECT_SLOT_FLAG.UNUSED: {
                        aspects.push(null);
                        break;
                    }
                    case DEC.ASPECT_SLOT_FLAG.USED: {
                        const aspectID = cursor.advanceBy(DEC.ASPECT_ID_BITLEN);
                        const aspectTier = cursor.advanceBy(DEC.ASPECT_TIER_BITLEN);
                        const aspectSpec = aspect_id_map.get(cls)?.get(aspectID);
                        if (aspectSpec) {
                            aspects.push([aspectSpec.displayName, aspectTier + 1]);
                        } else {
                            console.warn(`Unknown aspect ID ${aspectID} for class ${cls}, skipping`);
                            aspects.push(null);
                        }
                        break;
                    }
                }
            }
        }
    }
    return aspects;
}

// ── Main decoder ─────────────────────────────────────────────────────────────

async function handleLegacyHash(urlTag) {
    // Legacy versioning using search query "?v=XX" in the URL itself.
    // Grab the version of the data from the search parameter "?v=" in the URL
    wynn_version_id = getDataVersionLegacy();

    // wynn_version 18 is the last version that supports legacy encoding.
    return await decodeHashLegacy(urlTag);
}

/**
 * Decode the URL and populate all item fields.
 */
async function decodeHash() {
    let urlTag = window.location.hash.slice(1);

    // Strip solver params section if present (appended after SOLVER_HASH_SEP).
    // This keeps the builder backwards-compatible with solver URLs.
    const sep = urlTag.indexOf(SOLVER_HASH_SEP);
    if (sep >= 0) {
        urlTag = urlTag.substring(0, sep);
    }

    if (!urlTag) {
        await loadLatestVersion();
        return null;
    }

    // Binary encoding encodes the first character of the hash to be > 11 (or > B in Base64). if it isn't, fallback to legacy parsing.
    if (Base64.toInt(urlTag[0]) <= 11) { return await handleLegacyHash(urlTag); }

    // Binary encoding, Create the BitVector from the URL.
    // The vector length is actually automatically calculated in the constructor but it's here just in case.
    const vec = new BitVector(urlTag, urlTag.length * 6);
    const cursor = new BitVectorCursor(vec, 0);

    // The version of the data.
    wynn_version_id = decodeHeader(cursor);

    // Load the correct data for the provided version, includes encoding data.
    // The reason we differentiate is that most of the heavy data can be loaded
    // locally if the version is the latest version.
    if (wynn_version_id !== WYNN_VERSION_LATEST) {
        await loadOlderVersion();
    } else if (wynn_version_id === WYNN_VERSION_LATEST) {
        await loadLatestVersion();
    }

    // Decode all build information from the BitVector.
    const [equipment, powders] = decodeEquipment(cursor);
    const tomes = decodeTomes(cursor);
    const skillpoints = decodeSp(cursor);
    const level = decodeLevel(cursor);

    // Get the class from the weapon to read aspects
    let weaponType;
    const weaponName = equipment[8];
    switch (weaponName.slice(0, 3)) {
        case "CI-": weaponType = decodeCustom({hash: weaponName.substring(3)}).statMap.get("type"); break;
        case "CR-": weaponType = decodeCraft({hash: weaponName.substring(3)}).statMap.get("type"); break;
        default: weaponType = itemMap.get(weaponName).type;
    }
    const playerClass = wep_to_class.get(weaponType);

    const aspects = decodeAspects(cursor, playerClass);

    // This provides the data for atree population, no other explicit step
    // needed in the decoder
    atree_data = cursor.consume();

    // Cross-version atree migration: if we loaded old ATREES during a version
    // upgrade, decode the bits against the OLD tree structure to recover the
    // correct active node IDs, then store them as an array.  Downstream
    // consumers (solver.js, builder_graph.js) will detect the array and
    // activate nodes by ID rather than positional decoding.
    if (_old_ATREES !== null && atree_data.length > 0) {
        try {
            const old_atree = get_sorted_class_atree(_old_ATREES, playerClass);
            const active_nodes = decodeAtree(old_atree, atree_data);
            atree_data = active_nodes.map(n => n.ability.id);
            console.log("[decode] Cross-version atree: recovered", atree_data.length, "active node IDs");
        } catch (e) {
            console.warn("[decode] Cross-version atree decode failed, clearing atree:", e);
            atree_data = [];
        }
        _old_ATREES = null;
    }

    // Populate all input fields apart from skillpoints, which need to be populated after build calculation
    for (const [i, eq] of equipment.entries()) { setValue(equipment_inputs[i], eq); } // Equipment
    for (let [i, powderset] of powders.entries()) { setValue(powder_inputs[i], powderset); } // Powders
    for (const [i, tome] of tomes.entries()) { setValue(tomeInputs[i], tome); } // Tomes
    setValue("level-choice", level); // Level

    // Aspects
    for (const [i, aspectAndTier] of aspects.entries()) {
        if (aspectAndTier !== null) {
            const [aspect, tier] = aspectAndTier;
            setValue(aspectInputs[i], aspect);
            setValue(aspectTierInputs[i], tier);
        }
    }

    return skillpoints;
}

// ── Legacy decoding ──────────────────────────────────────────────────────────

/**
 * Get the data version from the search parameters of the URL.
 * Should only be called if the encoding version is >= 8.
 */
function getDataVersionLegacy() {
    // parse query parameters
    // https://stackoverflow.com/questions/901115/how-can-i-get-query-string-values-in-javascript
    const urlParams = new URLSearchParams(window.location.search);
    const versionID = urlParams.get('v');
    let wynnVersion = parseInt(versionID); // Declared in load_item.js
    if (isNaN(wynnVersion) || wynnVersion > LAST_LEGACY_VERSION || wynnVersion < 0) {
        // TODO: maybe make the NAN try to use the human readable version?
        // NOTE: Failing silently... do we want to raise a loud error?
        console.log("Explicit version not found or invalid, using latest version");
        wynnVersion = LAST_LEGACY_VERSION;
    }
    else {
        console.log(`Build link for wynn version ${wynnVersion} (${wynn_version_names[wynnVersion]})`);
    }
    return wynnVersion;
}

/**
 * The legacy version of decodePowders.
 */
function decodePowdersLegacy(powder_info) {
    // TODO: Make this run in linear instead of quadratic time... ew
    let powdering = [];
    for (let i = 0; i < 5; ++i) {
        let powders = "";
        let n_blocks = Base64.toInt(powder_info.charAt(0));
        // console.log(n_blocks + " blocks");
        powder_info = powder_info.slice(1);
        for (let j = 0; j < n_blocks; ++j) {
            let block = powder_info.slice(0,5);
            let six_powders = Base64.toInt(block);
            for (let k = 0; k < 6 && six_powders != 0; ++k) {
                powders += powderNames.get(decodePowderIdx((six_powders & 0x1f) - 1, 6));
                six_powders >>>= 5;
            }
            powder_info = powder_info.slice(5);
        }
        powdering[i] = powders;
    }
    return [powdering, powder_info];
}

// The last data version supported by legacy encoding.
LAST_LEGACY_VERSION = 18

/*
 * Decode legacy hashes.
 *
 * Populate fields based on url, and calculate build.
 * TODO: THIS CODE IS GOD AWFUL result of being lazy
 * fix all the slice() and break into functions or do something about it... its inefficient, ugly and error prone
 */
async function decodeHashLegacy(url_tag) {
    //default values
    let equipment = [null, null, null, null, null, null, null, null, null];
    let tomes = [null, null, null, null, null, null, null, null];
    let powdering = ["", "", "", "", ""];
    let info = url_tag.split("_");
    let version = info[0];
    // Whether skillpoints are manually updated. True if they should be set to something other than default values
    let skillpoints = [null, null, null, null, null];
    let level = 106;

    let version_number = parseInt(version);
    let data_str = info[1];

    if (version_number >= 8) {
        wynn_version_id = getDataVersionLegacy();
    } else {
        // Change the default to oldest. (A time before v8)
        wynn_version_id = 0;
    }

    // the deal with this is because old versions should default to 0 (oldest wynn item version), and v8+ defaults to latest.
    // its ugly... but i think this is the behavior we want...
    await loadOlderVersion();

    //equipment (items)
    // TODO: use filters
    if (version_number < 4) {
        let equipments = info[1];
        for (let i = 0; i < 9; ++i ) {
            let equipment_str = equipments.slice(i*3,i*3+3);
            equipment[i] = getItemNameFromID(Base64.toInt(equipment_str));
        }
        data_str = equipments.slice(27);
    }
    else if (version_number == 4) {
        let info_str = data_str;
        let start_idx = 0;
        for (let i = 0; i < 9; ++i ) {
            if (info_str.charAt(start_idx) === "-") {
                equipment[i] = "CR-"+info_str.slice(start_idx+1, start_idx+18);
                start_idx += 18;
            }
            else {
                let equipment_str = info_str.slice(start_idx, start_idx+3);
                equipment[i] = getItemNameFromID(Base64.toInt(equipment_str));
                start_idx += 3;
            }
        }
        data_str = info_str.slice(start_idx);
    }
    else if (version_number <= 11) {
        let info_str = data_str;
        let start_idx = 0;
        for (let i = 0; i < 9; ++i ) {
            if (info_str.slice(start_idx,start_idx+3) === "CR-") {
                equipment[i] = info_str.slice(start_idx, start_idx+20);
                start_idx += 20;
            } else if (info_str.slice(start_idx+3,start_idx+6) === "CI-") {
                let len = Base64.toInt(info_str.slice(start_idx,start_idx+3));
                equipment[i] = info_str.slice(start_idx+3,start_idx+3+len);
                start_idx += (3+len);
            } else {
                let equipment_str = info_str.slice(start_idx, start_idx+3);
                equipment[i] = getItemNameFromID(Base64.toInt(equipment_str));
                start_idx += 3;
            }
        }
        data_str = info_str.slice(start_idx);
    }
    //constant in all versions
    for (let i in equipment) {
        setValue(equipment_inputs[i], equipment[i]);
    }

    //level, skill point assignments, and powdering
    if (version_number == 0) {
        // do nothing! lol
    } else if (version_number == 1) {
        let powder_info = data_str;
        let res = decodePowdersLegacy(powder_info);
        powdering = res[0];
    } else if (version_number == 2) {
        let skillpoint_info = data_str.slice(0, 10);
        for (let i = 0; i < 5; ++i ) {
            skillpoints[i] = Base64.toIntSigned(skillpoint_info.slice(i*2,i*2+2));
        }

        let powder_info = data_str.slice(10);
        let res = decodePowdersLegacy(powder_info);
        powdering = res[0];
    } else if (version_number <= 11){
        level = Base64.toInt(data_str.slice(10,12));
        setValue("level-choice",level);
        let skillpoint_info = data_str.slice(0, 10);
        for (let i = 0; i < 5; ++i ) {
            skillpoints[i] = Base64.toIntSigned(skillpoint_info.slice(i*2,i*2+2));
        }

        let powder_info = data_str.slice(12);

        let res = decodePowdersLegacy(powder_info);
        powdering = res[0];
        data_str = res[1];
    }
    // Tomes.
    if (version_number >= 6) {
        //tome values do not appear in anything before v6.
        if (version_number < 8) {
            for (let i = 0; i < 7; ++i) {
                let tome_str = data_str.charAt(i);
                let tome_name = getTomeNameFromID(Base64.toInt(tome_str));
                setValue(tomeInputs[i], tome_name);
            }
            data_str = data_str.slice(7);
        }
        else {
            // 2chr tome encoding to allow for more tomes.

            // Lootrun tome was added in v9.
            let num_tomes = 7;
            if (version_number <= 8) {
                num_tomes = 7;
            }
            //Marathon, Mysticism, & Expertise tomes were added in v10.
            else if (version_number <= 9) {
                num_tomes = 8;
            }
            else {
                num_tomes = 14;
            }
            for (let i = 0; i < num_tomes; ++i) {
                let tome_str = data_str.slice(2*i, 2*i+2);
                let tome_name = getTomeNameFromID(Base64.toInt(tome_str));
                setValue(tomeInputs[i], tome_name);
            }
            data_str = data_str.slice(num_tomes*2);
        }
    }

    // Aspects.
    if (version_number >= 11) {
        let item_type;
        if (equipment[8].slice(0, 3) == "CI-") { item_type = getCustomFromHash(equipment[8]).statMap.get("type"); }
        else if (equipment[8].slice(0, 3) == "CR-") { item_type = getCraftFromHash(equipment[8]).statMap.get("type"); }
        else { item_type = itemMap.get(equipment[8]).type };

        const player_class = wep_to_class.get(item_type);
        const class_aspects_by_id = aspect_id_map.get(player_class);
        for (let i = 0; i < num_aspects; ++i) {
            const aspect_id = Base64.toInt(data_str.slice(3*i, 3*i + 2));
            const aspect_tier = Base64.toInt(data_str.slice(3*i+2, 3*i + 3));
            if (aspect_id !== none_aspect.id) {
                setValue(aspectTierInputs[i], aspect_tier);
                setValue(aspectInputs[i], class_aspects_by_id.get(aspect_id).displayName);
            }
        }
        data_str = data_str.slice(num_aspects*3);
    }

    if (version_number >= 7) {
        // ugly af. only works since its the last thing. will be fixed with binary decode
        atree_data = new BitVector(data_str);

        // Cross-version atree migration (same logic as decodeHash)
        if (_old_ATREES !== null && atree_data.length > 0) {
            try {
                let item_type;
                if (equipment[8].slice(0, 3) == "CI-") { item_type = getCustomFromHash(equipment[8]).statMap.get("type"); }
                else if (equipment[8].slice(0, 3) == "CR-") { item_type = getCraftFromHash(equipment[8]).statMap.get("type"); }
                else { item_type = itemMap.get(equipment[8]).type; }
                const pClass = wep_to_class.get(item_type);
                const old_atree = get_sorted_class_atree(_old_ATREES, pClass);
                const active_nodes = decodeAtree(old_atree, atree_data);
                atree_data = active_nodes.map(n => n.ability.id);
                console.log("[decode-legacy] Cross-version atree: recovered", atree_data.length, "active node IDs");
            } catch (e) {
                console.warn("[decode-legacy] Cross-version atree decode failed, clearing atree:", e);
                atree_data = [];
            }
            _old_ATREES = null;
        }
    }
    else {
        atree_data = null;
    }

    for (let i in powder_inputs) {
        setValue(powder_inputs[i], powdering[i]);
    }

    return skillpoints;
}

// ── Solver params decoding ───────────────────────────────────────────────────

/**
 * Decode solver-specific parameters from a Base64 string
 * (the portion of the URL hash after SOLVER_HASH_SEP).
 *
 * Mirror of encodeSolverParams(). See that function for the binary layout.
 *
 * @param {string} b64_str - Base64-encoded solver params
 * @returns {Promise<Object|null>} Decoded params, or null on failure
 */
async function decodeSolverParams(b64_str) {
    if (!b64_str) return null;

    try {
        const bv = new BitVector(b64_str, b64_str.length * 6);
        const cursor = new BitVectorCursor(bv, 0);

        // Fixed fields (48 bits)
        const roll = cursor.advanceBy(7);  // 0-100 percentage
        const sfree = cursor.advanceBy(8);
        const dir_enabled = cursor.advanceBy(5);
        const lvl_min = cursor.advanceBy(7) + 1;
        const lvl_max = cursor.advanceBy(7) + 1;
        const nomaj = cursor.advanceBy(1) === 1;
        const gtome = cursor.advanceBy(2);
        const dtime = cursor.advanceBy(1) === 1;
        const ctime = cursor.advanceBy(10);

        // Restrictions text (uncompressed UTF-8)
        const restr_len = cursor.advanceBy(12);
        let restrictions_text = '';
        if (restr_len > 0) {
            const restr_bytes = new Uint8Array(restr_len);
            for (let i = 0; i < restr_len; i++) restr_bytes[i] = cursor.advanceBy(8);
            restrictions_text = new TextDecoder().decode(restr_bytes);
        }

        // Combo (deflate-compressed)
        const combo_len = cursor.advanceBy(16);
        let combo_text = '';
        if (combo_len > 0) {
            const combo_bytes = new Uint8Array(combo_len);
            for (let i = 0; i < combo_len; i++) combo_bytes[i] = cursor.advanceBy(8);
            try {
                const ds = new DecompressionStream('deflate-raw');
                const writer = ds.writable.getWriter();
                writer.write(combo_bytes);
                writer.close();
                const decompressed = await _read_stream_bytes(ds.readable);
                combo_text = new TextDecoder().decode(decompressed);
            } catch (_) {
                // Fallback: try interpreting as uncompressed
                combo_text = new TextDecoder().decode(combo_bytes);
            }
        }

        // Blacklist text (backward-compatible: missing in older URLs)
        let blacklist_text = '';
        if (cursor.endIdx - cursor.currIdx >= 12) {
            const bl_len = cursor.advanceBy(12);
            if (bl_len > 0) {
                const bl_bytes = new Uint8Array(bl_len);
                for (let i = 0; i < bl_len; i++) bl_bytes[i] = cursor.advanceBy(8);
                blacklist_text = new TextDecoder().decode(bl_bytes);
            }
        }

        // Flat mana per cycle (backward-compatible: missing in older URLs)
        let flat_mana = 0;
        if (cursor.endIdx - cursor.currIdx >= 8) {
            flat_mana = cursor.advanceBy(8);
        }

        return { roll, sfree, dir_enabled, lvl_min, lvl_max, nomaj, gtome, dtime, ctime,
                 restrictions_text, combo_text, blacklist_text, flat_mana };
    } catch (e) {
        console.warn('[decode] decodeSolverParams failed:', e);
        return null;
    }
}
