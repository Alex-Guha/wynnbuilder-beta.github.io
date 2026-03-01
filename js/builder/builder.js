/**
 * File containing utility functions relevant to the builder page, as well as the setup code (at the very bottom).
 */


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

async function init() {
    console.log("builder.js init");

    // Other "main" stuff
    // Spell dropdowns
    for (const eq of equipment_keys) {
        document.querySelector("#"+eq+"-tooltip").addEventListener("click", () => collapse_element('#'+eq+'-tooltip'));
    }
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
}

window.onerror = function(message, source, lineno, colno, error) {
    document.getElementById('err-box').textContent = message;
    document.getElementById('stack-box').textContent = error.stack;
};

(async function() {
    await init();
})();
