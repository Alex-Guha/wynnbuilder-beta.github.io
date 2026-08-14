/**
 * File containing utility functions relevant to the builder page, as well as the setup code (at the very bottom).
 */

let edit_id_field_counter = 0;
let edited_ids = []

function resetFields(){
    for (const i of powder_inputs) {
        setValue(i, "");
    }
    for (const i of equipment_inputs) {
        setValue(i, "");
    }
    for (const i of tomeInputs) {
        setValue(i, "");
    }
    setValue("str-skp", "0");
    setValue("dex-skp", "0");
    setValue("int-skp", "0");
    setValue("def-skp", "0");
    setValue("agi-skp", "0");
    for (const special_name of specialNames) {
        for (let i = 1; i < 8; i++) { //toggle all pressed buttons of the same powder special off
            //name is same, power is i
            let elem = document.getElementById(special_name.replace(" ", "_")+'-'+i);
            if (elem.classList.contains("toggleOn")) {
                elem.classList.remove("toggleOn");
            }
        }
    }
    for (const [key, value] of damageMultipliers) {
        let elem = document.getElementById(key + "-boost")
        if (elem.classList.contains("toggleOn")) {
            elem.classList.remove("toggleOn");
        }
    }
    for (const elem of skp_order) {
        document.getElementById(elem + "_boost_armor").value = 0;
        document.getElementById(elem + "_boost_armor").style.background = `linear-gradient(to right, #AAAAAA, #AAAAAA 0%, #AAAAAA 100%)`;
        document.getElementById(elem + "_boost_armor_label").textContent = `% ${damageClasses[skp_order.indexOf(elem)+1]} Damage Boost: 0`;
    }

    const nodes_to_reset = equip_inputs.concat(powder_nodes).concat(edit_input_nodes).concat([powder_special_input, boosts_node, armor_powder_node]);
    for (const node of nodes_to_reset) {
        node.mark_dirty();
    }

    for (const node of nodes_to_reset) {
        node.update();
    }

    setValue("level-choice", String(MAX_PLAYER_LEVEL));
    location.hash = "";
}

// toggleButton is defined in js/core/utils.js
// init_autocomplete is defined in js/ui/autocomplete.js

function collapse_element(elmnt) {
    elem_list = document.querySelector(elmnt).children;
    if (elem_list) {
        for (elem of elem_list) {
            if (elem.classList.contains("no-collapse")) { continue; }   
            if (elem.style.display == "none") {
                elem.style.display = "";
            } else {
                elem.style.display = "none";
            }  
        }
    }
    // macy quirk
    window.dispatchEvent(new Event('resize'));
    // weird bug where display: none overrides??
    document.querySelector(elmnt).style.removeProperty('display');
}

let var_stats_map = new Map();
let var_stats_rev_map = new Map();
let var_stats_names = [];
function init_var_stat_maps() {
    for (let id of rolledIDs) {
        if (idPrefixes[id]) {
            let name = idPrefixes[id].split(':')[0];
            var_stats_names.push(name);
            var_stats_map.set(id, name);
            var_stats_rev_map.set(name, id);
        }
    }
}

function create_edited_stat() {
    let data = {};
    let row = make_elem("div", ["row"], {style: "margin-bottom: 1rem;"});
    data.div = row;

    let search_input = make_elem("input",
        ["col", "border-dark", "text-light", "dark-5", "rounded", "scaled-font", "form-control"],
        {id: "filter-input-" + edit_id_field_counter, type: "text", placeholder: "ID name"}
    );
    edit_id_field_counter++;
    row.appendChild(search_input);
    data.input_elem = search_input;

    let value = make_elem("input",
        ["col", "border-dark", "text-light", "dark-5", "rounded", "scaled-font", "form-control"],
        {placeholder: "Current"}
    );
    data.value_elem = value;
    row.appendChild(value);

    let base = make_elem("div",
        ["col", "border-dark", "text-light", "dark-5", "rounded", "scaled-font", "form-control"],
        {textContent: "Original: "}
    );
    row.appendChild(base);
    
    let trash = make_elem("img", ["col-auto", "m-0", "p-0", "img-fluid"], {src: "../media/icons/trash.svg", style: "height: 2rem;"});
    trash.addEventListener("click", function() {
        edited_ids.splice(Array.from(row.parentElement.children).indexOf(row), 1);
        row.remove();
        // clean up the row's link so it stops contributing once removed
        if (data.stat_node) {
            edit_agg_node.remove_link(data.stat_node);
            edit_input_nodes.splice(edit_input_nodes.indexOf(data.stat_node), 1);

            data.stat_node.remove_link(edit_id_output);
            const idx = edit_id_output.notify_nodes.indexOf(data.stat_node);
            if (idx !== -1) edit_id_output.notify_nodes.splice(idx, 1);

            edit_agg_node.mark_dirty().update();
        }
    });
    row.appendChild(trash);
    
    data.base_elem = base;

    data.stat_node = null; // the single node for this row, created once

    search_input.addEventListener("input", (event) => {
        const stat_id = var_stats_rev_map.get(search_input.value);
        if (!stat_id || !player_build) return;

        value.id = stat_id;
        base.id = stat_id + '-base';
        value.value = player_build.statMap.get(stat_id);
        base.textContent = "Original: " + player_build.statMap.get(stat_id);

        // create the node only once
        if (data.stat_node === null) {
            data.stat_node = new SumNumberInputNode(search_input.id + '-stat-input', value);
            edit_agg_node.link_to(data.stat_node, stat_id);
            edit_input_nodes.push(data.stat_node);
            
            // Mirror what EditableIDSetterNode's constructor does for its original nodes,
            // so a build reset/reload can find and refresh this node too.
            data.stat_node.link_to(edit_id_output);
            data.stat_node.fail_cb = true;
            edit_id_output.notify_nodes.push(data.stat_node);
        } else {
            edit_agg_node.inputs.get(data.stat_node.name).translation = stat_id;
        }

        edit_agg_node.mark_dirty().update();
        data.stat_node.mark_dirty().update();
    });

    document.getElementById("edit-stat-container").appendChild(row);
    edited_ids.push(data);
    init_stat_dropdown(data);
    return data;
}

function init_stat_dropdown(stat_block) {
    let field_choice = stat_block.input_elem;
    stat_block.autoComplete = new autoComplete({
        data: {
            src: var_stats_names,
        },  
        threshold: 0,
        selector: "#" + field_choice.id,
        wrapper: false,
        resultsList: {
            maxResults: 100,
            tabSelect: true,
            noResults: true,
            class: "search-box dark-7 rounded-bottom px-2 fw-bold dark-shadow-sm",
            element: (list, data) => {
                let position = field_choice.getBoundingClientRect();
                list.style.top = position.bottom + window.scrollY +"px";
                list.style.left = position.x+"px";
                list.style.width = "fit-content";
                list.style.maxHeight = position.height * 4 +"px";
                list.style.whiteSpace = "nowrap"; 
                if (!data.results.length) {
                    const message = make_elem('li', ['scaled-font'], {textContent: "No results found!"});
                    list.prepend(message);
                };
            },
        },
        resultItem: {
            class: "scaled-font search-item",
            selected: "dark-5",
        },
        events: {
            input: {
                selection: (event) => {
                    if (event.detail.selection.value) {
                        event.target.value = event.detail.selection.value;
                        field_choice.dispatchEvent(new Event('input'));
                    };
                },
            },
        }
    });
}

async function init() {
    console.log("builder.js init");

    // Other "main" stuff
    // Spell dropdowns
    for (const eq of equipment_keys) {
        document.querySelector("#"+eq+"-tooltip").addEventListener("click", () => collapse_element('#'+eq+'-tooltip'));
    }
    // Hover popup on item icons (desktop only). Tomes already have their own hover via TomeHoverRenderNode.
    initItemHoverPopups(equipment_keys);
    //  Armor Specials
    for (let i = 0; i < 5; ++i) {
        const powder_special = powderSpecialStats[i];
        const elem_name = damageClasses[i+1];   // skip neutral
        const elem_char = skp_elements[i];      // TODO: merge?
        const skp_name = skp_order[i];          // TODO: merge?
        const boost_parent = document.getElementById(skp_name+'-boost');
        const slider_id = skp_name+'_boost_armor';
        const label_name = "% " + elem_name + " Dmg Boost";
        const slider_container = gen_slider_labeled({label_name: label_name, max: powder_special.cap, id: slider_id, color: elem_colors[i]});
        boost_parent.appendChild(slider_container);
        document.getElementById(slider_id).addEventListener("change", (_) => armor_powder_node.mark_dirty().update() );
    }

    // Masonry setup
    try {
        let masonry = Macy({
            container: "#masonry-container",
            columns: 1,
            mobileFirst: true,
            breakAt: {
                1200: 4,
            },
            margin: {
                x: 20,
                y: 20,
            }
        });

        let search_masonry = Macy({
            container: "#search-results",
            columns: 1,
            mobileFirst: true,
            breakAt: {
                1200: 4,
            },
            margin: {
                x: 20,
                y: 20,
            }
        });
    } catch (e) {
        console.log("Could not initialize macy components. Maybe you're offline?");
        console.log(e);
    }
    const skillpoints = await decodeHash();

    try {
        init_autocomplete();
    } catch (e) {
        console.log("Could not initialize autocomplete. Maybe you're offline?");
        console.log(e);
    }
    builder_graph_init(skillpoints);
    for (const item_node of item_final_nodes) {
        // console.log(item_node);
        if (item_node.get_value() === null) {
            // likely DB load failure...
            if (confirm('One or more items failed to load correctly. This could be due to a corrupted build link, or (more likely) a database load failure. Would you like to reload?')) {
                hardReload();
            }
            break;
        }
    }
    init_var_stat_maps();
}

window.onerror = function(message, source, lineno, colno, error) {
    const friendly = _atree_friendly_error_msg();
    document.getElementById('err-box').textContent = friendly ?? message;
    document.getElementById('stack-box').textContent = friendly ? '' : (error?.stack ?? '');
};

/**
 * If the ability tree currently has a hard validation error, the build/spell
 * pipeline will produce null values that downstream nodes can't handle —
 * resulting in raw JS exceptions surfacing in the error box. Detect that case
 * and return a friendly message instead of leaking the JS error.
 */
function _atree_friendly_error_msg() {
    try {
        if (typeof atree_validate === 'undefined' || !atree_validate?.value) return null;
        const [hard_error] = atree_validate.value;
        if (!hard_error) return null;
        return 'Ability tree is in an invalid state. Fix the errors highlighted in the ATree panel and try again.';
    } catch (_) {
        return null;
    }
}

(async function() {
    await init();
})();
