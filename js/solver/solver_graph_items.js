
// BaseItemInputNode is defined in shared_graph_nodes.js

/**
 * Solver-specific item input node. Extends BaseItemInputNode with roll mode
 * application (MAX / 75% / AVG / MIN) on matched items.
 *
 * Signature: ItemInputNode() => Item | null
 */
class ItemInputNode extends BaseItemInputNode {
    _on_match(item) {
        // Apply roll mode: Build.initBuildStats() always reads maxRolls, so we
        // replace maxRolls with getRolledValue(min, max) for each rolled stat.
        if (current_roll_mode !== ROLL_MODES.MAX) {
            const minR = item.statMap.get('minRolls');
            const maxR = item.statMap.get('maxRolls');
            if (minR && maxR) {
                const rolledMap = new Map();
                for (const [id, maxVal] of maxR.entries()) {
                    rolledMap.set(id, getRolledValue(minR.get(id) ?? 0, maxVal));
                }
                item.statMap.set('maxRolls', rolledMap);
            }
        }
        return item;
    }
}

// PowderInputNode is defined in shared_graph_nodes.js

// BaseItemDisplayNode, _TIER_CLASSES, _TIER_SHADOW_CLASSES defined in shared_graph_nodes.js
// ItemPowderingNode is defined in shared_graph_nodes.js

/**
 * Solver item display: extends BaseItemDisplayNode with lock/slot styling.
 * Signature: SolverItemDisplayNode(item: Item) => null
 */
class SolverItemDisplayNode extends BaseItemDisplayNode {
    constructor(name, eq) {
        super(name, eq);
        this.slot_elem = document.getElementById(eq + '-dropdown') || null;
        this.lock_elem = document.getElementById(eq + '-lock')     || null;
    }

    _update_lock_icon() {
        if (!this.lock_elem) return;
        const is_free = this.input_field.dataset.solverFilled === 'true';
        this.lock_elem.style.display = '';
        this.lock_elem.innerHTML = is_free ? UNLOCK_SVG : LOCK_SVG;
        this.lock_elem.classList.toggle('solver-lock-free', is_free);
        this.lock_elem.title = is_free ? 'Slot free \u2014 solver will search (click to lock)' :
                                         'Slot locked \u2014 solver will keep empty (click to unlock)';
    }

    _on_empty(_item) {
        if (this.slot_elem) this.slot_elem.classList.remove('slot-locked', 'slot-unlocked', 'slot-solver', 'slot-selected');
        const is_free = this.input_field.dataset.solverFilled === 'true';
        if (this.slot_elem) this.slot_elem.classList.add(is_free ? 'slot-unlocked' : 'slot-locked');
        this._update_lock_icon();
        return null;
    }

    _on_display(item) {
        if (this.slot_elem) this.slot_elem.classList.remove('slot-locked', 'slot-unlocked', 'slot-solver', 'slot-selected');
        const is_free = this.input_field.dataset.solverFilled === 'true';
        if (this.slot_elem) this.slot_elem.classList.add(is_free ? 'slot-solver' : 'slot-locked');
        this._update_lock_icon();
        if (!this.lock_elem) return;
        // Override title for filled slots
        if (!is_free) {
            this.lock_elem.title = 'Slot locked \u2014 solver will keep this item (click to unlock)';
        }
    }
}

/**
 * Renders the item tooltip when the item changes. Clears tooltip for empty slots.
 * Signature: SolverItemTooltipNode(item: Item) => null
 */
class SolverItemTooltipNode extends ComputeNode {
    constructor(name, tooltip_id) {
        super(name);
        this.tooltip_id = tooltip_id;
        this.fail_cb = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();
        const tooltip = document.getElementById(this.tooltip_id);
        if (!tooltip) return null;

        if (!item || item.statMap.has('NONE')) {
            tooltip.style.display = 'none';
            setHTML(this.tooltip_id, '');
            return null;
        }
        displayExpandedItem(item.statMap, this.tooltip_id);
        // Keep tooltip hidden until user clicks; displayExpandedItem may make it visible.
        tooltip.style.display = 'none';
        return null;
    }
}

/**
 * Updates the weapon image background-position and DPS display.
 * Signature: SolverWeaponDisplayNode(item: Item) => null
 */
class SolverWeaponDisplayNode extends ComputeNode {
    constructor(name) {
        super(name);
        this.image     = document.getElementById('weapon-img');
        this.dps_field = document.getElementById('weapon-dps');
        this.fail_cb   = true;
    }

    compute_func(input_map) {
        const [item] = input_map.values();
        if (!item || item.statMap.has('NONE')) return null;

        const type = item.statMap.get('type');
        if (type && itemBGPositions[type]) {
            this.image.style.backgroundPosition = itemBGPositions[type];
        }
        let dps = get_base_dps(item.statMap);
        if (isNaN(dps)) { dps = (Array.isArray(dps) ? dps[1] : 0); if (isNaN(dps)) dps = 0; }
        this.dps_field.textContent = Math.round(dps);
        return null;
    }
}
