# Solver Search — Logic Flow

This document describes the abstract logic of the WynnSolver search pipeline, from user click to ranked results. The code spans three files: `engine/search.js` (main thread orchestration), `engine/worker.js` (per-worker DFS), and `engine/worker_shims.js` (DOM-free utility copies).

The current solver essentially searches through a priority-ordered tree for builds that maximize the solver target. Item priority is determined by solver constraints and item damage stats. This helps to ensure that the best builds are more likely to appear early.

---

## High-Level Picture

```
User clicks "Solve"
        │
        ▼
1. Collect snapshot (weapon, atree state, combo, boosts, restrictions)
2. Build item pools (filter by level, SP direction, major-IDs)
3. Prune dominated items from each pool (pre-search)
4. Partition search space across N web workers
5. Each worker runs a synchronous level-based enumeration over its slice
        │  (every 5 000 candidates)
        ├──── progress message → main thread aggregates interim top-5
        └──── done message     → work-stealing: send next partition or finish
        │
        ▼
6. Merge top-5 from all workers → fill best build into UI, show ranked list
```

---

## Step 1 — Snapshot (`_build_solver_snapshot`)

Before spawning any workers the main thread reads every piece of mutable state that influences scoring and freezes it into a plain-object snapshot. This avoids race conditions if the user edits fields during a search.

Key pieces captured:
- **Weapon** and **level** — from solver item input nodes.
- **Tomes** and **guild tome** — from solver tome input nodes; guild tome determines the SP budget (200 / 204 / 205).
- **Atree state** — `atree_raw` (raw stat bonuses from the tree), `atree_merged` (full ability tree), and serialized `button_states` / `slider_states` (toggle/slider DOM state flattened to plain Maps so workers can clone them).
- **Static boosts** — merged from the Active Boosts panel.
- **Radiance boost** — floating multiplier (1.0–1.3) based on Radiance / Divine Honor toggles.
- **Parsed combo** — the ordered list of `{qty, spell, boost_tokens, dmg_excl, mana_excl}` rows. `dmg_excl` skips the row in damage scoring; `mana_excl` skips it in mana cost calculation. Powder-special spells are synthesised and inserted here.
- **Boost registry** — built from `build_combo_boost_registry`; maps boost token names to their stat/prop contributions.
- **Scoring target** — from `#solver-target` dropdown: `combo_damage` (default), `ehp`, `total_healing`, `spd`, `poison`, `lb`, `xpb`.
- **Mana constraint** — `combo_time` (seconds) and `allow_downtime` flag; used at the leaf to reject builds whose mana budget doesn't sustain the combo.
- **Restrictions** — from `get_restrictions()`: level range, build direction (which SP types are used), no-major-ID flag, stat thresholds.

---

## Step 2 — Item Pool Building (`_build_item_pools`)

For each free slot (helmet, chestplate, leggings, boots, ring, bracelet, necklace) the main thread filters `itemMap` to a candidate pool:

1. **Level range** — `lvl_min ≤ item.lvl ≤ lvl_max`.
2. **Major-ID filter** — if "No Major ID" is on, items with any major ID are excluded.
3. **Build direction** — if a SP type is disabled (e.g. Dexterity off), items that *require* that SP type are excluded.
4. **Roll mode** — each item's `maxRolls` are adjusted by the selected roll mode (Max / 75% / Avg / Min) before the Item object is created; the pool is thus pre-baked.
5. **Illegal sets** — sets whose 2-piece bonus has `illegal: true` (e.g. Morph) are tracked so the DFS can reject combinations containing two different items from the same such set.
6. A **NONE item** is prepended to every pool so "leave slot empty" is a valid candidate.

Locked slots (items the user pinned manually) are collected separately and removed from the pools — they do not vary during search.

---

## Step 3 — Dominance Pruning (`_prune_dominated_items`)

After the pools are built, each pool is scanned for dominated items. Item B is dominated by item A when A is a strictly-at-least-as-good drop-in replacement in any build:

1. **Scoring stats** — for every stat in `_build_dmg_weights` (and any `ge` stat-threshold stats): `A.stat ≥ B.stat`.
2. **SP requirements** — `A.reqs[i] ≤ B.reqs[i]` for all five attributes (A is at least as easy to equip).
3. **SP provisions** — `A.skillpoints[i] ≥ B.skillpoints[i]` for all five attributes (A grants at least as much SP).

Any build containing B can substitute A and achieve an equal or better score. B is therefore removed from the pool permanently.

**NONE items are never pruned.** Set-bonus interactions are not modelled (an item in set X could theoretically be rescued by a set bonus), so this is an approximation — but removing obvious dominatees typically reduces pool sizes by 20–40% without meaningful loss of result quality.

Dominance pruning runs in O(n² × |check\_stats|) per pool on the main thread before workers are spawned, adding only a few milliseconds of setup time.

---

## Step 4 — Work Partitioning (`_partition_work`)

The search space is split into fine-grained partitions (4× the worker count) to enable **work-stealing**: idle workers pick up partitions that slower workers haven't started yet.

Partition strategy (first applicable wins):

| Situation | Partition target | Balance method |
|-----------|-----------------|----------------|
| Both rings free | Outer ring index `i` (inner `j` iterates `i..N`) | Triangular load balancing (each outer step covers `N−i` inner steps) |
| One ring free | Ring pool sliced evenly | Equal-chunk slicing |
| No free rings | Largest free armor/accessory pool | Equal-chunk slicing |

Each partition descriptor is `{type, slot?, start, end}`.

---

## Step 5 — Worker Protocol

### Init message (main → worker, once per worker)
Heavy structured-clone payload: serialized pools, locked items, weapon statMap, tome statMaps, guild tome statMap, atree state, combo rows, boost registry, sets data, scoring target, combo time/downtime settings, etc. The first partition is embedded directly so the worker starts immediately on receipt.

### Run message (main → worker, subsequent partitions)
Lightweight: just `{type:'run', partition, worker_id}`. The worker reuses the already-stored `_cfg` for all heavy data, only updating which slice of a pool to search.

### Progress message (worker → main)
Sent every 5 000 candidates. Contains `checked`, `feasible`, and the worker's current top-5 item name lists (not full objects, to minimise clone cost).

### Done message (worker → main)
Sent when a partition finishes. Contains final `checked`, `feasible`, and `top5`. The main thread calls `_on_partition_done`, which accumulates the results and dispatches the next partition from the queue (work-stealing).

---

## Step 6 — Level-Based Enumeration in the Worker (`_run_level_enum`)

### Setup (one-time per partition)

1. **Running statMap** — a `Map` pre-loaded with level base HP and the fixed items (locked equips + tomes + weapon). Free items are added and subtracted from this Map in-place during enumeration, avoiding a full rebuild at every leaf.

2. **Illegal-set tracker** — a lightweight counter that detects when two different items from the same illegal set are simultaneously in the partial build.

3. **Pool ordering** — free armor/accessory slots are sorted ascending by pool size (smallest pool iterated first). This ensures the most-constrained slots are enumerated at shallower recursion depths.

4. **Maximum level** — `L_max = Σ (pool_size[slot] − 1)` over all free armor/accessory slots. This is the highest sum-of-rank-offsets any combination can have.

### Ring iteration (outermost)

Rings are handled outside the main enumeration because both rings draw from the **same pool** and the pair must be unordered (ring1 index ≤ ring2 index). Three cases:

- **Both free** — double loop `i ≤ j`; ring1 = `pool[i]`, ring2 = `pool[j]`. Partition applies to the outer index `i`.
- **One locked** — single loop over the free ring pool.
- **Both locked** — skip ring iteration entirely, fall straight to armor enumeration.

Each ring is placed via `_place_item` (updates running statMap) and removed via `_unplace_item` on backtrack.

### Level-based enumeration over armor/accessory slots (`enumerate(slot_idx, remaining_L)`)

For each level `L` from 0 to `L_max`, `enumerate` assigns rank offsets to free armor/accessory slots such that their sum equals exactly `L`:

- **L = 0**: visits the single combination `(pool[0], pool[0], …, pool[0])` — the globally best build first.
- **L = 1**: visits all combinations with exactly one slot at pool index 1 and all others at 0.
- **L = k**: visits all combinations where the sum of per-slot pool indices equals k.

This ordering guarantees the strongest builds (closest to the top of every pool) are evaluated early. No heap or visited set is needed — memory is O(k) where k is the number of free slots.

**Last-slot constraint:** when `slot_idx == N_free − 1`, the item is placed at exactly `offset = remaining_L` (not `0..remaining_L`). This ensures each combination is visited at exactly one level, preventing duplicate evaluations.

For each item at each slot:
1. **Illegal-set check** — skip if the tracker reports a conflict with an already-placed item.
2. **Place** — `_place_item` updates `running_sm`.
3. **Recurse** — `enumerate(slot_idx + 1, remaining_L − offset)`.
4. **Backtrack** — `_unplace_item` restores `running_sm`.

---

## Step 7 — Leaf Evaluation (`_evaluate_leaf`)

Reached when all free armor/accessory slots have been filled. Five gates before scoring:

### Gate 0: Fast constraint precheck (`_fast_constraint_precheck`, `_fast_ehp_precheck`)
Runs before any SP work. For each `≥` restriction on a simple additive stat (e.g. `mr ≥ 10`, `hprRaw ≥ 200`), checks `running_sm.get(stat) ≥ adjusted_threshold` where `adjusted_threshold = user_threshold − fixed_contributions` (precomputed once at worker init from `atree_raw + static_boosts`). This is a conservative lower bound — it ignores radiance boost, atree scaling, and set bonuses, all of which can only increase the stat. Skills (`str`…`agi`) and `ehp` are excluded from the simple check.

For EHP constraints, an optimistic upper bound is computed: `totalHp / ehp_divisor` where `totalHp` comes from `running_sm` + fixed HP contributions, and `ehp_divisor` is precomputed assuming max def/agi skill points (100 each) and no extra `defMult` penalties. If even this generous estimate falls short, the candidate is rejected.

Both checks use only precomputed constants + a single Map lookup per constraint, making them essentially free compared to the gates that follow.

### Gate 1: Combined SP feasibility (`_solver_sp_calc`)
A single-pass SP check that replaces the former two-step `_sp_prefilter` + `calculate_skillpoints` pair. Computes the minimum SP assignment needed to meet all items' requirements using effective requirements (`req + own skillpoints` for non-crafted equipment, raw `req` for weapon/crafted), excludes weapon provisions from the bonus pool (matching the game mechanic where weapon SP doesn't reduce required assignment), and applies set bonuses to final SP. Includes early budget rejection mid-loop: if any single attribute's deficit exceeds 100 or the running total exceeds `sp_budget`, it returns `null` immediately without computing final SP or set counts. Returns `[assign, final_sp, total_assigned, set_counts]` on success.

### Stat assembly (`_finalize_leaf_statmap`)
Finalises the running statMap by:
1. Applying set bonuses for active sets (non-SP bonuses only).
2. Setting up `damMult`, `defMult`, `healMult` maps.
3. Collecting `majorIds` from all items.

Then `_assemble_combo_stats` layers on top:
1. Inject `total_sp` values and `classDef` multiplier.
2. Merge `atree_raw` stats.
3. Apply radiance scaling (multiplies positive values of ~70 affected stat IDs).
4. Run `worker_atree_scaling` to apply conditional/slider-driven atree bonuses.
5. Merge atree-scaling stats and static boosts (for threshold checking).

### Gate 2: Stat thresholds (full)
If the user set any restrictions (e.g. "EHP ≥ 50000", "hprRaw ≥ 200"), the fully assembled stats are checked. EHP is computed via `getDefenseStats`. Any violation rejects the candidate. (Gate 0 is a cheap pre-filter; this gate is the authoritative check using final stat values including radiance, atree scaling, set bonuses, and actual skill points.)

### Gate 3: Mana constraint (`_eval_combo_mana_check`)
Only active when `combo_time > 0`. Computes starting mana (100 + item mana + Int bonus), total spell cost (sum of `getSpellCost × qty` for rows not marked `mana_excl`), and mana regen over the combo time. If `allow_downtime` is false, the build is rejected when `start_mana − end_mana > 5` (mana deficit too high for sustainability). If `allow_downtime` is true, the build is rejected only if `end_mana ≤ 0`.

### Scoring (`_eval_score`)
Dispatches to the appropriate objective based on the snapshot's `scoring_target`:
- **`combo_damage`** (default): for each combo row not marked `dmg_excl`, applies boost tokens via `apply_combo_row_boosts`, applies spell property overrides via `apply_spell_prop_overrides`, then calls `computeSpellDisplayAvg` (which calls `calculateSpellDamage` internally and blends normal/crit by dexterity crit chance). Multiplies by quantity and sums.
- **`total_healing`**: same row loop but calls `computeSpellHealingTotal` for each row.
- **`ehp`**: reads EHP (agility-weighted) from `getDefenseStats(thresh_stats)[1][0]`.
- **`spd`, `poison`, `lb`, `xpb`**: reads the named stat directly from `thresh_stats`.

The total is the candidate's **score**.

### Top-5 heap
If the score beats the current 5th-best, the candidate is inserted and the list is re-sorted. Only item names are stored (not full statMaps) to minimise memory.

---

## Step 8 — Result Aggregation (main thread)

### Interim updates (every 5 seconds)
The main thread's progress timer checks each worker's latest `_cur_top5` (from the most recent progress message) and each worker's cumulative `top5` (from completed partitions). These are merged into a global top-5, the best build is loaded into the UI via `_fill_build_into_ui`, and the results panel is refreshed.

### Final merge (`_on_all_workers_done`)
When `active_count` drops to zero (all partitions finished):
1. Aggregate `checked` and `feasible` counts from all workers.
2. Merge top-5 from all workers' cumulative lists.
3. Reconstruct full `Item` objects from stored names (via `itemMap`).
4. Load the best build into the UI; display the ranked results panel.
5. Show a summary line (count, feasible, elapsed time).

### Result panel
Each of the top-5 results is shown as a clickable row. Clicking calls `_fill_build_into_ui` with that result. A new-tab link opens a URL whose hash encodes the full item set.

---

## Key Optimisations

| Technique | Where | Effect |
|-----------|-------|--------|
| Level-based enumeration | `_run_level_enum` | Evaluates the globally best build (L=0) first; each subsequent level is one rank-step further from optimal, so strong builds surface in interim results early |
| Item priority scoring | `_prioritize_pools` + `_build_dmg_weights` | Pools pre-sorted by damage/constraint relevance before search; top of each pool is the highest-priority item |
| Incremental statMap | `_init_running_statmap` + `_incr_add/remove_item` | Avoids full stat rebuild at every leaf |
| Combined SP calc | `_solver_sp_calc` (single pass) | Replaces the former two-step `_sp_prefilter` + `calculate_skillpoints` with a single pass using effective requirements and proper weapon exclusion; tighter rejection and less per-candidate work |
| Pool sort (smallest first) | `free_armor_slots.sort(...)` | Visits slots with fewer choices first |
| Work-stealing partitions | 4× worker count | Keeps all cores busy even when partition sizes are unequal |
| Illegal-set tracker | `_make_illegal_tracker()` | O(1) check per item for set-conflict rejection |
| Triangular ring partitioning | `_partition_work` | Equal work distribution for the (i,j) ring double-loop |
| Dominance pruning | `_prune_dominated_items` | Removes items dominated on all scoring stats + SP reqs/provisions before search; shrinks pools without losing optimality (set-bonus interactions not modelled) |
| Fast constraint precheck | `_fast_constraint_precheck` + `_fast_ehp_precheck` | Rejects leaves that can't meet `≥` stat thresholds using only the incremental running statMap + precomputed fixed offsets, before any SP or stat assembly work |

---

## Key Weaknesses

### Score-blind enumeration
The level-based enumeration visits combinations in order of sum-of-rank-offsets (best-first within each level), but it has no branch-and-bound pruning based on the current best score. Every combination at every level is fully evaluated — there is no early exit when remaining levels cannot possibly produce a better result. This means the search remains exhaustive, just with a better visitation order. Interim results are much stronger than before (L=0 is evaluated first), but the total work is unchanged.

### SP checked only at the leaf
The simplified SP system (no equip order) enables incremental tracking of `max_eff_req[i]` and `sum_prov[i]` during enumeration, which would allow mid-tree pruning of subtrees that can never meet the SP budget. Currently `_solver_sp_calc` is only called at the leaf.

### Ring slots are special-cased throughout
Because both rings draw from the same pool and the pair is unordered, rings are handled with a separate double-loop outside the generic `dfs()` function. This creates three code paths (both free, one free, both locked) and complicates partitioning. Armor slots benefit from the generic slot-ordering optimisation; rings cannot be trivially slotted into it.

---

## High priority improvements

### Memory consumption
Browser memory usage rises significantly the longer the solver runs, easily into the gigs. A user reported a browser crash for a large search, as well.

### Intelligent priority scoring
Order items by whatever is needed most in the build, focusing on fulfilling constraints first
i.e. (target ehp - current ehp) / current ehp vs (target MR - current MR) / current MR

### Tune item pool ordering
Develop a testing suite for `_build_dmg_weights` in `engine/search.js`.

### Make dominance pruning a bit more aggressive
Exclude stats that don't factor into the calc (depending on which those are), like poison or walk speed or mana steal, etc.

---

## Potential Improvements

### Integrate rings into generic slot ordering
Move ring iteration into the main `enumerate()` loop (treating rings as a single "ring pair" slot with a pool of `(i, j)` pairs). This would unify the three ring-case code paths, allow rings to participate in the smallest-first slot ordering and level-based enumeration, and simplify partitioning. The `i ≤ j` constraint and pool-level duplicate filtering would need to be encoded in the pair pool.

### Weighted multi-objective scoring
Replace the single combo-damage score with a weighted sum of multiple objectives: `w₁ × damage + w₂ × EHP + w₃ × mana_sustain + ...`. Users specify weights. This makes the solver useful for tank, support, or hybrid builds without changing the search algorithm — only the leaf scoring function changes.

### Tome optimisation
Tomes are currently fixed inputs (user-specified). Including tomes in the search space would require expanding the pool to ~7 additional slots (each with their own item pool), multiplying the search space significantly. A separate inner loop or a post-pass heuristic (swap tomes given a fixed armor build) would be more tractable than a full joint search.

### GPU parallelisation
Each leaf evaluation is independent and the scoring function (combo damage calc) is a fixed arithmetic pipeline. This is structurally suited to GPU compute (WebGPU). With the simplified SP system (O(n) linear scan instead of recursive backtracking), SP feasibility is no longer a blocker for vectorisation. The remaining challenge is porting the atree scaling and combo boost logic to GPU-friendly data structures.