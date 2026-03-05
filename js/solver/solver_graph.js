
function solver_graph_init() {

    // ── Level ────────────────────────────────────────────────────────────────
    const level_input = new InputNode('level-input', document.getElementById('level-choice'));

    // ── Build assembly (collects all item/tome nodes + level) ────────────────
    solver_build_node = new BuildAssembleNode('solver-make-build');
    solver_build_node.link_to(level_input);  // keyed as 'level-input' (node.name)

    // ── Equipment slots ──────────────────────────────────────────────────────
    for (const eq of equipment_fields) {
        const none_item = none_items[_NONE_ITEM_IDX[eq]];
        const input_field = document.getElementById(eq + '-choice');
        const raw_item_node = new ItemInputNode('solver-' + eq + '-input', input_field, none_item);
        solver_equip_input_nodes.push(raw_item_node);

        let item_node = raw_item_node;

        if (powderable_keys.includes(eq)) {
            const powder_field = document.getElementById(eq + '-powder');
            const powder_node = new PowderInputNode('solver-' + eq + '-powder', powder_field)
                .link_to(raw_item_node, 'item');
            solver_powder_nodes[eq] = powder_node;
            const powder_apply = new ItemPowderingNode('solver-' + eq + '-powder-apply')
                .link_to(powder_node, 'powdering')
                .link_to(raw_item_node, 'item');
            item_node = powder_apply;
        }

        solver_item_final_nodes.push(item_node);

        new SolverItemDisplayNode('solver-' + eq + '-display', eq).link_to(item_node);
        new SolverItemTooltipNode('solver-' + eq + '-tooltip', eq + '-tooltip').link_to(item_node);
        solver_build_node.link_to(item_node, eq);
    }

    // Weapon image + DPS (weapon is the last entry in equipment_fields at index 8)
    new SolverWeaponDisplayNode('solver-weapon-type-display').link_to(solver_item_final_nodes[8]);

    // ── Tome slots ───────────────────────────────────────────────────────────
    for (const eq of tome_fields) {
        const none_tome = none_tomes[_NONE_TOME_KEY[eq]];
        const input_field = document.getElementById(eq + '-choice');
        const item_node = new ItemInputNode('solver-' + eq + '-input', input_field, none_tome);

        solver_equip_input_nodes.push(item_node);
        solver_item_final_nodes.push(item_node);

        new SolverItemDisplayNode('solver-' + eq + '-display', eq).link_to(item_node);
        solver_build_node.link_to(item_node, eq);
    }

    // ── Skill-point display ──────────────────────────────────────────────────
    new SolverSKPNode().link_to(solver_build_node, 'build');

    // ── Phase 3: Class detection ─────────────────────────────────────────────
    const class_node = new PlayerClassNode('solver-class').link_to(solver_build_node, 'build');

    // ── Phase 3: Aspects ─────────────────────────────────────────────────────
    aspect_agg_node = new AspectAggregateNode('final-aspects');
    _solver_aspect_agg_node = aspect_agg_node;
    const aspects_dropdown = document.getElementById('aspects-dropdown');
    for (const field of aspect_fields) {
        const aspect_input_field = document.getElementById(field + '-choice');
        const aspect_tier_field = document.getElementById(field + '-tier-choice');
        const aspect_image_div = document.getElementById(field + '-img');
        const aspect_image_loc_div = document.getElementById(field + '-img-loc');

        new AspectAutocompleteInitNode(field + '-autocomplete', field)
            .link_to(class_node, 'player-class');

        const aspect_input = new AspectInputNode(field + '-input', aspect_input_field)
            .link_to(class_node, 'player-class');
        solver_aspect_input_nodes.push(aspect_input);

        new AspectInputDisplayNode(field + '-input-display', aspect_input_field, aspect_image_div)
            .link_to(aspect_input, 'aspect-spec');

        const aspect_tier_input = new AspectTierInputNode(field + '-tier-input', aspect_tier_field)
            .link_to(aspect_input, 'aspect-spec');

        new AspectRenderNode(field + '-render', aspect_image_loc_div, aspects_dropdown)
            .link_to(aspect_tier_input, 'tooltip-args');

        aspect_agg_node.link_to(aspect_tier_input, field + '-tiered');
    }

    // ── Phase 3: Ability tree ────────────────────────────────────────────────
    atree_node.link_to(class_node, 'player-class');
    atree_merge.link_to(solver_build_node, 'build');
    atree_merge.link_to(class_node, 'player-class');
    atree_merge.link_to(aspect_agg_node);
    atree_validate.link_to(level_input, 'level');

    // ── Phase 3: Stat aggregation pipeline ───────────────────────────────────

    // Extract build.statMap into a plain StatMap for aggregation
    const build_stat_node = new SolverBuildStatExtractNode()
        .link_to(solver_build_node, 'build');

    // Pre-scale aggregation: build stats + atree raw stat bonuses
    const pre_scale_agg = new AggregateStatsNode('solver-pre-scale-stats');
    pre_scale_agg.link_to(build_stat_node, 'build-stats');
    pre_scale_agg.link_to(atree_raw_stats, 'atree-raw-stats');

    // Radiance / Divine Honor scaling of the pre-scale stat total
    solver_radiance_node.link_to(pre_scale_agg, 'stats');

    // Atree scaling nodes need the radiance-scaled stats as their "scale-stats" input
    atree_scaling.link_to(solver_radiance_node, 'scale-stats');

    // Final stat aggregation: radiance-scaled stats + atree scaling deltas + boosts
    const stat_agg = new AggregateStatsNode('solver-final-stats');
    stat_agg.link_to(solver_radiance_node, 'pre-scaling');
    stat_agg.link_to(atree_scaling_stats, 'atree-scaling');
    stat_agg.link_to(solver_boosts_node, 'potion-boost');

    // Build stats display (populates Summary and Detailed tabs in the middle column)
    new SolverBuildDisplayNode()
        .link_to(solver_build_node, 'build')
        .link_to(stat_agg, 'stats');

    // ── Phase 4: Per-row combo ────────────────────────────────────────────────
    // combo_base_stats is stat_agg without solver_boosts_node so that per-row
    // boosts specified in the combo text/selection override them individually.
    const combo_base_stats = new AggregateStatsNode('solver-combo-base-stats');
    combo_base_stats.link_to(solver_radiance_node, 'pre-scaling');
    combo_base_stats.link_to(atree_scaling_stats, 'atree-scaling');

    solver_combo_total_node = new SolverComboTotalNode()
        .link_to(solver_build_node, 'build')
        .link_to(combo_base_stats, 'base-stats')
        .link_to(atree_collect_spells, 'spells')
        .link_to(atree_merge, 'atree-merged');

    // Close boost popups and locked damage popups when clicking outside them.
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.combo-boost-btn-wrap')) {
            document.querySelectorAll('.boost-popup').forEach(p => {
                p.style.display = 'none';
                p.style.position = '';
                p.style.top = '';
                p.style.left = '';
                p.style.width = '';
                p.style.maxWidth = '';
                p.style.right = '0';
            });
        }
        if (!e.target.closest('.combo-row-damage-wrap')) {
            document.querySelectorAll('.combo-row-damage-wrap.popup-locked')
                .forEach(w => w.classList.remove('popup-locked'));
        }
        if (!e.target.closest('.combo-mana-wrapper')) {
            document.querySelectorAll('.combo-mana-wrapper.popup-locked')
                .forEach(w => w.classList.remove('popup-locked'));
        }
    });

    // Click-to-lock for the mana tooltip.
    const mana_wrap = document.querySelector('.combo-mana-wrapper');
    if (mana_wrap) {
        mana_wrap.addEventListener('click', (e) => {
            if (e.target.closest('.combo-row-input')) return;   // don't toggle when clicking the input
            e.stopPropagation();
            mana_wrap.classList.toggle('popup-locked');
        });
    }

    // Recalc when the flat-mana input changes.
    const flat_mana_inp = document.getElementById('flat-mana-input');
    if (flat_mana_inp) {
        flat_mana_inp.addEventListener('input', () => {
            if (solver_combo_total_node) solver_combo_total_node.mark_dirty().update();
        });
    }

    // ── URL encoding ─────────────────────────────────────────────────────────
    const encode_node = new SolverBuildEncodeNode()
        .link_to(solver_build_node, 'build')
        .link_to(build_stat_node, 'build-stats')
        .link_to(atree_node, 'atree')
        .link_to(atree_state_node, 'atree-state')
        .link_to(aspect_agg_node, 'aspects');
    for (const eq of powderable_keys) {
        encode_node.link_to(solver_powder_nodes[eq], eq + '-powder');
    }
    new SolverURLUpdateNode()
        .link_to(encode_node, 'build-str');

    // ── Fire initial update cascade ──────────────────────────────────────────
    for (const node of solver_equip_input_nodes) {
        node.update();
    }
    level_input.update();

    for (const node of solver_aspect_input_nodes) {
        node.update();
    }

    graph_live_update = true;
}
