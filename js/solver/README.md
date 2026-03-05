# WynnSolver

WynnSolver is a build optimizer for the Wynncraft MMO, built on top of the [WynnBuilder](https://wynnbuilder.github.io) codebase. Given a weapon, locked items, ability tree, tomes, boosts, and a damage combo, it searches all combinations of the remaining equipment slots to find the build that maximizes combo damage while satisfying configurable stat restrictions.

The solver lives at `/solver/index.html` and is a fully client-side static page — no build step, no server. It shares all game data, utility libraries, and the computation graph infrastructure with WynnBuilder.

---

## Running Locally

The page uses `fetch()` for JSON data files and requires an HTTP server (not `file://`):

```bash
python3 -m http.server 8000
# then open http://localhost:8000/solver/
```

---

## Codebase Overview

The solver is organized into several layers: page entry, UI logic, the reactive computation graph, the search orchestration, and the worker. Files are in `js/solver/` unless noted.

### Entry point

**`solver/index.html`** — page entry. Imports all shared WynnBuilder libraries (loaders, `computation_graph.js`, `damage_calc.js`, `skillpoints.js`, `build_utils.js`, `display.js`, `shared_game_stats.js`, `shared_spell_nodes.js`, `autocomplete.js`, `atree.js`, `aspects.js`, etc.) followed by all solver-specific scripts. Defines the full DOM layout: item slots, tomes, boosts, ability tree, aspect panel, combo, build stats, restrictions, and solver controls.

---

### Initialization & UI helpers

**`solver.js`** — page-level utilities: `copy_build_to_wynnbuilder()`, `copy_solver_url()`, `setRollMode()`, and `resetSolver()`. Also reads/writes solver-specific URL query params (combo, roll mode, guild tome, thread count, pruning toggle, etc.) on page load/save.

**`solver_constants.js`** — field name arrays (`equipment_fields`, `tome_fields`, `powderable_keys`), slot-index mappings (`_NONE_ITEM_IDX`, `_NONE_TOME_KEY`), roll mode constants, and SP attribute order.

---

### Computation graph

The solver uses the same push-based reactive DAG as WynnBuilder (`ComputeNode` in `computation_graph.js`). When any input changes, affected nodes recompute in topological order automatically. Node definitions are split across four files:

**`solver_graph_items.js`** — `ItemInputNode` (extends `BaseItemInputNode`, adds roll mode), `SolverItemDisplayNode` (extends `BaseItemDisplayNode`, adds lock/slot styling), `SolverItemTooltipNode`, `SolverWeaponDisplayNode`. Shared base classes, `PowderInputNode`, and `ItemPowderingNode` are in `shared_graph_nodes.js`.

**`solver_graph_build.js`** — `SolverSKPNode` (reads the SP arrays from the assembled Build and renders the read-only skill point display), `SolverBuildEncodeNode`, and `SolverURLUpdateNode`. `BuildAssembleNode` is now shared in `shared_graph_nodes.js`.

**`solver_graph_stat.js`** — `SolverBuildStatExtractNode` (extracts `build.statMap` + `classDef` into a plain Map), and `SolverBuildDisplayNode` (calls `displayBuildStats()` for summary/detailed views). `AggregateStatsNode` and `PlayerClassNode` are in `shared_graph_nodes.js`. Boost/radiance compute functions (`compute_boosts`, `compute_radiance`) are also shared. Boost button data (`damageMultipliers`) and defense stats (`getDefenseStats`) are in `shared_game_stats.js`.

**`solver_graph.js`** — `solver_graph_init()`, the wiring function that instantiates all of the above nodes and links them into the full DAG: item nodes → build assembly → stat extraction → radiance scaling → stat aggregation → display nodes and combo base stats.

---

### Combo system

**`solver_combo_node.js`** — `SolverComboTotalNode`, the main combo computation graph node. Listens to combo base stats, the parsed spell list, and the atree merge node. Computes and renders total combo damage. Manages selection-mode row lifecycle: reads/writes row data, refreshes spell and boost dropdowns when the atree changes, applies per-row boosts and spell property overrides, computes per-spell damage with expandable breakdown tooltips, tracks mana, and schedules URL updates.

**`solver_combo_ui.js`** — DOM construction helpers for combo selection rows. `_build_selection_row()` creates a full row element (quantity, spell picker, boost popup, mana/damage toggle dots, damage/heal display). Also provides the global helpers `combo_add_row()`, `combo_remove_row()`, `set_combo_mode()`, and `combo_toggle_downtime()`.

**`solver_combo_codec.js`** — combo serialization. `combo_data_to_text()` / `combo_text_to_data()` convert between the row data model and the multi-line text format. `combo_export()` / `combo_import()` copy/paste via the clipboard API. URL persistence is handled by the unified solver hash updater in `solver_graph_build.js`.

**`solver_combo_boost.js`** — the boost logic that operates per combo row:
- `build_combo_boost_registry(atree_merged, build)` — scans the active ability tree for raw-stat toggle nodes and stat-scaling slider nodes; appends weapon powder boost toggles (Curse, Courage, Wind Prison) and armor powder buff sliders (Rage, Kill Streak, Concentration, Endurance, Dodge).
- `renderSpellPopupHTML(full, crit_chance, spell_cost)` — builds HTML for per-spell damage breakdown popups.

---

### Restrictions

**`solver_restrictions.js`** — row-based restriction editor: add/remove rows, stat autocomplete, min/max selector, value field. `get_restrictions()` returns the full restrictions object (level range, SP direction, no-major-ID, guild tome, stat thresholds) consumed by the solver before search.

---

### Search orchestration (main thread)

**`solver_search.js`** — everything between "Solve" click and final result display:
- `_build_solver_snapshot()` — freezes all mutable state (weapon, atree, combo, boosts, restrictions) into a plain-object snapshot before spawning workers.
- `_build_item_pools()` — filters `itemMap` per free slot by level range, major-ID flag, SP direction, and roll mode. Prepends a NONE item to each pool. Tracks illegal-set pairs.
- `_prune_dominated_items()` — O(n²) per pool: removes items dominated on all scoring stats + SP reqs + SP provisions, typically shrinking pools by 20–40%.
- `_prioritize_pools()` — sorts each pool by a weighted priority score (`_build_dmg_weights` for damage-relevant stats, `_build_constraint_weights` for restriction stats) so the level-based enumerator in the worker evaluates the strongest items first.
- `_partition_work()` — splits the search space into 4× worker-count fine-grained partitions using triangular balancing for the ring double-loop and equal-chunk slicing for armor slots.
- Worker management: spawn workers, send init + run messages, collect progress/done messages, do work-stealing from the partition queue, merge top-5 results across workers, update UI every 5 seconds, display final summary.

---

### Worker

**`solver_pure.js`** — pure functions shared between the main thread and the Web Worker (loaded via `<script>` on the page and `importScripts` in the worker). Contains `computeSpellDisplayAvg()`, `computeSpellDisplayFull()`, `computeSpellHealingTotal()`, `apply_combo_row_boosts()`, `apply_spell_prop_overrides()`, `find_all_matching_boosts()`, `_apply_radiance_scale()`, and `_solver_sp_calc()`. Zero DOM references.

**`solver_worker.js`** — the Web Worker that runs a synchronous level-based enumeration over its assigned partition. Key internals:
- Maintains an incremental running `statMap` that is updated/reverted as items are placed/backtracked, avoiding a full rebuild at every leaf.
- Level-based enumeration: items in each pool are pre-sorted by priority score; the outer loop iterates `L = 0..L_max` where L is the sum of per-slot rank offsets. L=0 evaluates the globally best combination first; each subsequent level steps one rank further from optimal. This ensures strong builds surface early in interim results.
- Handles rings in a separate double-loop (same pool, unordered pairs) with partition slicing on the outer index.
- Multi-gate leaf evaluation: fast constraint precheck → `_solver_sp_calc` (combined SP feasibility + full calculation, single O(n) pass with early budget reject) → stat finalization (set bonuses, multiplier maps) → greedy SP allocation → restriction threshold check → mana check → combo damage scoring → top-5 heap update.

**`solver_worker_shims.js`** — DOM-free copies of functions the worker needs but that normally read/write the DOM:
- `worker_atree_scaling()` — replaces the DOM-reading atree scaling node using serialized button/slider states.
- `_init_running_statmap()` / `_incr_add_item()` / `_incr_remove_item()` / `_finalize_leaf_statmap()` — incremental stat accumulation functions for the search, avoiding full rebuilds at every leaf.

---

### Styles

**`css/solver-wide.css`** — all WynnSolver page styles. The solver reuses the shared `css/shared.css` for common layout primitives and defines its own styles here for sections, slot displays, the combo rows, the restrictions panel, the results panel, and the progress bar.

---

### Documentation

**`SOLVER.md`** (this directory) — detailed description of the search pipeline: snapshot collection, item pool building, work partitioning, worker protocol, DFS logic, leaf evaluation, result aggregation, key optimizations, known weaknesses, and potential improvements.

---

## Examples

These links require the app running at `http://localhost:8000`. Open them in a browser after starting the server.

**Inferno Trick-Shade:**
```
http://localhost:8000/solver/?combo=c%3AvZRNboMwEEb3nOI7AAucluzz02WkSj6BMUM7wtjImC4qHz6KlKip1R-VAtvx6D09L0YgYq-6yrl3Q4jY6cBvKhDk6HvPA0EGzy3lHy8H4ywN6QBSac8Na8ohezIGB9czDdhmAhGycy1h77rqXvI76sm2bGtD9XWJcKRqbJoBZerJcVK-pfpq_LJqTmGZCGXPFrsQlG7XUi7e-Lh-Y6pcvPFh_cZUuXjjZv3GVPl94zS--EPSPIYjNUa9-At1suAGvFvDM3lNNkAURVYi4jSawK8c_m-Z72NuRESIbPPzQZ8GFZ_LEVFc5mc&ctime=6&gtome=1&dir=dex%2Cagi&lvlmin=75&restr=mr%3Age%3A65%7Cehp%3Age%3A50000%7Cspd%3Age%3A10&dtime=1&sfree=240#CN0O0VTy0+oH2qhJzaNdsLm11v9Sb3MDlSfVUNIrnTWa1
```

**Monster Riftwalker:**
```
http://localhost:8000/solver/?combo=c%3AM7RQqFHwTS1JzS9SqFEIz8xLSU1RMDNQqFEw5DJUqFFwKi3Ky8xLVwjOTM_MwVBhqVCjEJKak1qQX1SCLgkA&ctime=9&roll=75pct&lvlmin=75&gtome=1&sfree=224&dtime=1&dir=dex#CN0O0VTg0+w8Yxr9KpBdoR4G1v9i20PDlSjZbEWs-jzo+T0
```

---

## Todo

### Bugs
#### Combo


#### UI


### Necessary Improvements
- Abilities like crep ray that cast over time need to be allowed special entry so the user can enter multiple instances of it with varying focus buffs

### Improve Solver
See SOLVER.md for details.


### Polish
#### UI
- Solver restrictions panel - the filter rows would benefit from better layout (aligned columns, cleaner autocomplete styling) and clearer labeling of the min/max selector.
    - "Filters", "Targets" w/ weighting option
#### Combo
- Modified Spell Mana Cost - Currently, spells like Eldritch Call and Bamboozle don't have automatic mana cost inference, since they modify other abilities.
- Automatic combo sequencing - tracking state-dependent effects across a combo sequence (clone counts consumed by Bamboozle after Vanish, etc.) would require a per-spell state machine for each ability interaction. This is a significant undertaking and was deferred from the initial design.

### Testing

#### Archetypes/Combos

The combo damage calculation has been tested against WynnBuilder output for some archetypes and bugs were found and fixed, but not all archetypes have been verified. Each archetype should be tested by loading the same build and buffs in both WynnSolver and WynnBuilder and comparing per-spell damage numbers. Archetypes that use prop-type sliders (e.g. Enkindled %), ability-name aliases (e.g. Mirror Image → Activate Clones), or powder special spells are the highest priority to verify.

#### Combo Mana Calculation

- Implicitly add MR/MS to priorities when "Allow Downtime" is not set.
- Verify that the mana calc handles tier drop and that the solver looks at these when optimizing. I.e. if mana steal is present, then it may be more optimal to add tier drop than more MS.