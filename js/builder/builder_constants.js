/**
 * Builder-specific constants and DOM listeners.
 * Shared slot/field definitions are in ../shared_constants.js (loaded first).
 */

const BUILD_VERSION = "7.0.20";


let editable_item_fields = [ "sdPct", "sdRaw", "mdPct", "mdRaw", "poison",
                             "fDamPct", "wDamPct", "aDamPct", "tDamPct", "eDamPct",
                             "fDefPct", "wDefPct", "aDefPct", "tDefPct", "eDefPct",
                             "hprRaw", "hprPct", "hpBonus", "atkTier", "ls",
                             "spPct1", "spRaw1", "spPct2", "spRaw2",
                             "spPct3", "spRaw3", "spPct4", "spRaw4" ];

let editable_elems = [];

for (let i of editable_item_fields) {
    let elem = document.getElementById(i);
    elem.addEventListener("change", (event) => {
        elem.classList.add("highlight");
    });
    editable_elems.push(elem);
}

for (let i of skp_order) {
    let elem = document.getElementById(i+"-skp");
    elem.addEventListener("change", (event) => {
        elem.classList.add("highlight");
    });
    editable_elems.push(elem);
}

function clear_highlights() {
    for (let i of editable_elems) {
        i.classList.remove("highlight");
    }
}


let tome_names = [
    "Weapon Tome",
    "Weapon Tome",
    "Armor Tome",
    "Armor Tome",
    "Armor Tome",
    "Armor Tome",
    "Guild Tome",
]
let build_fields = equipment_fields.map(x => x+"-tooltip");

let spell_disp = ['build-melee-stats', 'spell0-info', 'spell1-info', 'spell2-info', 'spell3-info'];
let other_disp = ['build-order', 'set-info', 'int-info'];

// raid_buff_map moved to ../shared_constants.js so the solver can reuse it.
