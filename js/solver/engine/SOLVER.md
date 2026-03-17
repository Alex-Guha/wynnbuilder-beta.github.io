# Solver Search — Logic Flow

This document describes the abstract logic of the WynnSolver search pipeline, from user click to ranked results. The code spans four files: `engine/search.js` (main thread orchestration), `engine/item_priority.js` (sensitivity weights, dominance pruning, priority scoring), `engine/worker.js` (per-worker enumeration), and `engine/worker_shims.js` (DOM-free incremental stat helpers).

The solver searches through a priority-ordered tree for builds that maximize a scoring target. Item priority is determined by **sensitivity-based weights**: the main thread builds a baseline build, perturbs each stat, and measures how much the score changes. Items with stats that strongly influence the score are ranked higher. This ensures the best builds surface early in the level-based enumeration.

---

## High-Level Picture

```
User clicks "Solve"
        │
        ▼
1. Collect snapshot (weapon, atree, combo, boosts, restrictions)
2. Build item pools (filter by level, SP direction, major-IDs, blacklist)
3. Compute sensitivity-based weights (baseline → perturb → measure)
4. Classify dominance stats from sensitivity signs → prune dominated items
5. Sort pools by priority score (sensitivity-weighted item scoring)
6. Partition search space across N web workers
7. Each worker runs a synchronous level-based enumeration over its slice
        │  (every 5 000 candidates)
        ├──── progress message → main thread aggregates interim top-5
        └──── done message     → work-stealing: send next partition or finish
        │
        ▼
8. Merge top-5 from all workers → fill best build into UI, show ranked list
```

---

## Step 1 — Snapshot (`_build_solver_snapshot`)

Before spawning any workers the main thread reads every piece of mutable state that influences scoring and freezes it into a plain-object snapshot. This avoids race conditions if the user edits fields during a search.

Key pieces captured:
- **Weapon** and **level** — from solver item input nodes.
- **Tomes** and **guild tome** — from solver tome input nodes; guild tome provisions are included in its statMap (the assignable SP budget is always 200).
- **Atree state** — `atree_raw` (raw stat bonuses from the tree), `atree_merged` (full ability tree), and serialized `button_states` / `slider_states` (toggle/slider DOM state flattened to plain Maps so workers can clone them).
- **Static boosts** — merged from the Active Boosts panel.
- **Radiance boost** — floating multiplier (1.0–1.4) based on Radiance / Divine Honor / Shine / Judgement toggles.
- **Parsed combo** — the ordered list of `{qty, spell, boost_tokens, dmg_excl, mana_excl, recast_penalty_per_cast}` rows. `dmg_excl` skips the row in damage scoring; `mana_excl` skips it in mana cost calculation. Powder-special spells are synthesised and inserted. Pseudo-spell rows (`cancel_bakals`, `mana_reset`) are included for state tracking. **Recast penalties** are precomputed per-row based on the combo sequence (consecutive same-spell casts incur +5 mana per recast).
- **Boost registry** — built from `build_combo_boost_registry`; maps boost token names to their stat/prop contributions.
- **Scoring target** — from `#solver-target` dropdown: `combo_damage` (default), `ehp`, `ehp_no_agi`, `total_hp`, `hpr`, `ehpr`, `total_healing`, `spd`, `poison`, `lb`, `xpb`.
- **Mana constraint** — `combo_time` (seconds), `allow_downtime` flag, and `flat_mana` (additional mana per cycle).
- **Blood Pact** — when active (`hp_casting = true`), spells cost HP instead of mana. The snapshot includes `health_config` (extracted from atree) so workers can dynamically compute blood pact bonuses and corruption percentages per candidate. Calculated boost tokens (Blood Pact %, Corrupted) are stripped from parsed_combo rows — workers recompute them dynamically.
- **Spell base costs** — `spell_base_costs` for final spell cost restrictions.
- **Restrictions** — from `get_restrictions()`: level range, build direction, no-major-ID flag, stat thresholds.

---

## Step 2 — Item Pool Building (`_build_item_pools`)

For each free slot (helmet, chestplate, leggings, boots, ring, bracelet, necklace) the main thread filters `itemMap` to a candidate pool:

1. **Level range** — `lvl_min ≤ item.lvl ≤ lvl_max`.
2. **Major-ID filter** — if "No Major ID" is on, items with any major ID are excluded.
3. **Build direction** — if a SP type is disabled (e.g. Dexterity off), items that *require* that SP type are excluded. Build directions can be auto-disabled based on locked items' SP provisions (`auto_update_build_directions`).
4. **Blacklist** — items in the user's blacklist are excluded.
5. **Roll mode** — each item's `maxRolls` are adjusted by the per-group roll percentages (damage/mana/healing/misc groups, each 0-100%). The pool is thus pre-baked.
6. **Illegal sets** — sets whose 2-piece bonus has `illegal: true` (e.g. Morph) are tracked so the enumeration can reject combinations containing two different items from the same such set.
7. **Exclusive-set lock pruning** — if a locked item belongs to an exclusive set, all other items from that set are removed from all pools (only one item per exclusive set can appear in a build, and the locked one is guaranteed to occupy the slot).
8. A **NONE item** is prepended to every pool so "leave slot empty" is a valid candidate.

Locked slots (items the user pinned manually) are collected separately and removed from the pools — they do not vary during search.

---

## Step 3 — Sensitivity-Based Weight Computation (`_compute_sensitivity_weights`)

This is the core of the item priority system. Instead of hand-tuned heuristic weights, the solver measures how much each stat actually contributes to the scoring target for the current build configuration.

### 3a. Baseline construction

1. Build a **baseline statMap** from locked items + weapon + tomes using the worker's `_init_running_statmap` + `_finalize_leaf_statmap` functions (ensures consistency with the search worker).
2. Run **greedy SP allocation** on the baseline: call `calculate_skillpoints` for minimum assignment, then greedily distribute remaining SP budget using geometric step-down (20 → 4 → 1) to maximize the scoring target.
3. **Assemble combo stats**: inject SP, classDef, atree_raw, radiance scaling, atree scaling, static boosts.
4. Evaluate **baseline score** using the same `_eval_score` dispatch as the worker.

### 3b. Stat perturbation

For each of ~80 **perturbable stats** (damage, defense, mana, spell cost, utility stats):
1. Compute a **pool-calibrated delta**: the median absolute value of that stat across all items in all pools. Falls back to hardcoded defaults when fewer than 3 items have the stat.
2. **Perturb** the baseline combo stats by +delta.
3. Evaluate the perturbed score.
4. **Sensitivity** = `(perturbed_score - baseline_score) / delta`.

Perturbation is done at the combo_base level (post-atree, post-radiance), which is valid for additive stats — the item's contribution flows through linearly.

### 3c. SP provision sensitivities

For each of the 5 SP types, perturb total_sp[i] by the pool-calibrated SP delta and measure score change. Dampened by `_SP_SENSITIVITY_DAMPEN` (0.4) because SP provisions don't translate 1:1 to actual allocated SP.

### 3d. Augmentation (`_augment_sensitivity_weights`)

- **Constraint bonuses**: for each `≥` restriction on a direct stat with a deficit vs. the baseline, add a bonus proportional to `deficit / threshold × max_weight × _CONSTRAINT_WEIGHT_FRACTION`.
- **Mana sustainability**: when `combo_time > 0` and mana is tight (estimated deficit > 0), add priority-only bonuses for `mr`, `ms` (if melee), `maxMana`, and int SP sensitivity.

### 3e. Fallback

If baseline score is zero for `combo_damage` target (e.g. no combo rows), falls back to `_build_dmg_weights_legacy` — hand-tuned heuristic weights.

---

## Step 4 — Dominance Pruning (`_prune_dominated_items`)

### Dominance stat classification (`_build_dominance_stats`)

Uses the sign of sensitivity weights to classify stats:
- Sensitivity > threshold → **higher-is-better** set
- Sensitivity < -threshold → **lower-is-better** set
- |Sensitivity| < threshold → **excluded** (not monotonic enough for safe pruning)

Threshold = `max_abs_sensitivity × 0.005`.

Additional classification rules:
- `≥` restriction stats → higher; `≤` restriction stats → lower
- Spell cost stats (`spRaw/spPct` for used spells) → lower when mana constrained
- `mr`/`ms` → higher only when mana is tight
- `atkTier` excluded from dominance when both melee-DPS and mana/lifesteal constraints are active (conflicting objectives)
- Stats in both sets → removed from both (non-monotonic)

### Pruning

Item B is dominated by item A when:
1. Every **higher-is-better** stat: `A ≥ B`
2. Every **lower-is-better** stat: `A ≤ B`
3. SP requirements: `A.reqs[i] ≤ B.reqs[i]` for all i (A is cheaper to equip)
4. SP provisions: `A.skillpoints[i] ≥ B.skillpoints[i]` for all i (A grants more SP)

**Exclusive set guard**: an item from an exclusive set cannot dominate items outside that set (the dominator might not be available due to exclusive-set limits).

NONE items are never pruned. Set-bonus interactions are not modelled. Typically reduces pool sizes by 20-40%.

---

## Step 5 — Priority Scoring & Pool Sorting (`_prioritize_pools`)

Each item's priority score = `Σ (item_stat × sensitivity_weight)` + `Σ (skp_provision × sp_sensitivity)` + `Σ (mana_stat × priority_only_weight)`.

Negative stats with positive weights correctly reduce score (no `v > 0` guard). Pools are sorted descending by priority score, with NONE items moved to the end.

---

## Step 6 — Work Partitioning (`_partition_work`)

The search space is split into fine-grained partitions (4× the worker count) to enable **work-stealing**: idle workers pick up partitions that slower workers haven't started yet.

Partition types:

| Situation | Type | Balance method |
|-----------|------|----------------|
| Both rings free | `ring` — partition the ring1 outer index | Triangular load balancing |
| One ring free | `ring_single` — ring pool sliced evenly | Equal-chunk slicing |
| No free rings | `slot` — largest free armor/accessory pool | Equal-chunk slicing |
| No free slots | `full` — single partition | N/A |

---

## Step 7 — Worker Protocol

### Init message (main → worker, once per worker)
Heavy structured-clone payload: serialized pools, locked items, weapon/tome/guild-tome statMaps, atree state, combo rows, boost registry, sets data, scoring target, combo time/downtime/flat_mana, hp_casting/health_config, restrictions, ring_pool, none_item_sms, etc. The first partition is embedded directly so the worker starts immediately.

### Run message (main → worker, subsequent partitions)
Lightweight: `{type:'run', partition, worker_id}`. Reuses stored `_cfg`.

### Progress message (worker → main)
Sent every 5 000 candidates. Contains `checked`, `feasible`. Top-5 data only included when it has changed (version tracking).

### Done message (worker → main)
Sent when a partition finishes. Main thread calls `_on_partition_done`, which accumulates results and dispatches the next partition from the queue.

---

## Step 8 — Unified Level-Based Enumeration (`_run_level_enum`)

### Setup (one-time per partition)

1. **Free slots** — all unlocked slots (armor + accessories + rings) are collected into a unified `free_slots` array, sorted ascending by pool size. Rings are included alongside armor/accessories (no separate outer loop).

2. **Running statMap** — a `Map` pre-loaded with level base HP and fixed items (locked equips + tomes + weapon). Free items are added/removed in-place during enumeration.

3. **Illegal-set tracker** — lightweight counter detecting when two items from the same exclusive set are simultaneously placed.

4. **Mid-tree SP pruning state** — for each free slot's pool, the element-wise max SP provision is precomputed. Suffix sums (`_sp_suffix_max_prov`) allow O(1) optimistic upper-bound checks during enumeration.

5. **Maximum level** — `L_max = Σ (pool_size[slot] − 1)` over all free slots.

### Unified enumeration (`enumerate(slot_idx, remaining_L)`)

For each level `L` from 0 to `L_max`, `enumerate` assigns rank offsets to free slots such that their sum equals exactly `L`:

- **L = 0**: visits the single combination `(pool[0], pool[0], …, pool[0])` — the globally best build first.
- **L = k**: visits all combinations where the sum of per-slot pool indices equals k.

**Ring symmetry**: when both rings are free, they appear as two entries in `free_slots` (ring1 before ring2, same pool). Ring2's offset is constrained to `≥ ring1_placed_offset`, deduplicating symmetric pairs `(i,j)` vs `(j,i)`.

**Ring partitioning**: for `ring` partitions, ring1's offset range is restricted to `[partition.start, partition.end)`. For `ring_single` partitions, the single free ring's range is restricted. For `slot` partitions, the named slot's pool is sliced.

**Last-slot constraint**: when `slot_idx == N_free − 1`, the item is placed at exactly `offset = remaining_L`, preventing duplicate evaluations.

For each item at each slot:
1. **Illegal-set check** — skip if the tracker reports a conflict.
2. **Place** — `_place_item` (updates running statMap) + `_sp_place_free_item` (updates running SP state).
3. **Mid-tree SP prune** — `_sp_mid_tree_feasible(next_depth)`: checks whether the remaining unplaced slots can possibly provide enough SP provisions to meet the running max effective requirement within the SP budget. Uses suffix-sum of max pool provisions as an optimistic upper bound. Prunes the entire subtree if infeasible.
4. **Recurse** — `enumerate(slot_idx + 1, remaining_L − offset)`.
5. **Backtrack** — `_unplace_item` + `_sp_unplace_free_item`.

---

## Step 9 — Leaf Evaluation (`_evaluate_leaf`)

Reached when all free slots have been filled.

### Gate 0: Fast constraint precheck
Rejects builds that can't meet simple additive stat thresholds (`≥` constraints), using only the incremental running statMap + precomputed fixed offsets (atree_raw + static_boosts). Also checks EHP/EHP-no-agi/total-HP prechecks using optimistic upper bounds (assumes max def/agi SP, no defMult penalties). Essentially free (O(1) per constraint).

Stats excluded from simple precheck: `ehp`, `ehp_no_agi`, `total_hp`, `ehpr`, `hpr`, skill points, `finalSpellCost1-4`.

### Gate 1: SP feasibility (`calculate_skillpoints`)
Calls the shared `calculate_skillpoints` function with the 8 equipment statMaps + guild tome + weapon. Returns `[base_sp, total_sp, assigned_sp, activeSetCounts]` or `null` if infeasible.

### Greedy SP allocation (`_greedy_allocate_sp`)
After minimum SP is assigned, remaining budget is greedily distributed to maximize the scoring target. Uses geometric step-down (20 → 4 → 1) for O(50-95) trials worst case. Each trial assembles combo stats and evaluates the score.

### Stat assembly
`_finalize_leaf_statmap`: applies set bonuses, sets up damMult/defMult/healMult maps, collects majorIds. Uses pre-allocated scratch Maps to eliminate GC churn.

`_assemble_combo_stats`: injects total_sp + classDef, merges atree_raw, applies radiance scaling, runs atree_compute_scaling, merges static_boosts. Also uses scratch Maps.

### Gate 2: Stat thresholds (full)
Checks all restrictions against fully assembled stats. EHP, EHP-no-agi, total HP, EHPR, HPR computed via `getDefenseStats`. Final spell costs computed via `getSpellCost`. This is the authoritative check (Gate 0 is a cheap pre-filter).

### Gate 3: Mana / HP constraint (`_eval_combo_mana_check`)
**Standard mana mode** (`hp_casting = false`): computes start_mana, spell costs (with int reduction + recast penalties + Transcendence), mana regen, mana steal. Rejects based on `allow_downtime` setting.

**Blood Pact mode** (`hp_casting = true`): runs `simulate_combo_mana_hp` to simulate the full combo with HP costs. Rejects if any row would kill the player (HP insufficient for blood cost). The simulation result is cached (`_cached_hp_sim`) and reused by the damage scorer to inject dynamic blood pact bonus tokens.

### Scoring (`_eval_score`)
Dispatches based on `scoring_target`:
- **`combo_damage`**: calls `compute_combo_damage_totals` (unified function in pure.js) with all combo rows, boost registry, and atree. Blood Pact builds inject dynamically-computed blood pact bonus and corruption % tokens per row from the cached simulation.
- **`total_healing`**: per-row `computeSpellHealingTotal`.
- **`ehp`**: `getDefenseStats()[1][0]` (agility-weighted).
- **`ehp_no_agi`**: `getDefenseStats()[1][1]`.
- **`total_hp`**: `getDefenseStats()[0]`.
- **`hpr`**: `getDefenseStats()[2]`.
- **`ehpr`**: `getDefenseStats()[3][0]`.
- **`spd`, `poison`, `lb`, `xpb`**: reads named stat directly.

### Top-5 heap
If the score beats the current 5th-best, the candidate is inserted. Only item names are stored (not full statMaps) to minimize clone cost for progress messages.

---

## Step 10 — Result Aggregation (main thread)

### Interim updates (every 5 seconds)
Progress timer aggregates checked/feasible counts, merges interim top-5 from all workers (both completed partitions and in-flight), fills best build into UI, refreshes results panel.

### Final merge (`_on_all_workers_done`)
1. Aggregate final checked/feasible counts.
2. Merge top-5 from all workers' cumulative lists.
3. Reconstruct full `Item` objects from stored names (via `itemMap`; handles crafted/custom items via `CR-`/`CI-` hashes).
4. Load best build into UI; display ranked results panel.
5. Show summary line; run debug re-evaluation if `SOLVER_DEBUG_COMBO` is enabled.

### Result panel
Each top-5 result is a clickable row. New-tab links open URLs with the result's build hash + current solver params.

---

## Key Optimisations

| Technique | Where | Effect |
|-----------|-------|--------|
| Sensitivity-based weights | `_compute_sensitivity_weights` | Measures actual score contribution per stat; replaces hand-tuned heuristics with data-driven priority ordering |
| Sensitivity-based dominance | `_build_dominance_stats` | Classifies stats by sensitivity sign; only monotonic stats used for pruning, avoiding false positives |
| Level-based enumeration | `_run_level_enum` | Evaluates globally best build (L=0) first; each level is one rank-step further from optimal |
| Unified ring + armor enumeration | `enumerate` | Rings participate in the same level-offset system as armor; symmetry enforced via `ring2 offset ≥ ring1 offset` |
| Mid-tree SP pruning | `_sp_mid_tree_feasible` | Prunes subtrees where SP requirements provably exceed budget, using suffix-sum of max pool provisions |
| Incremental statMap | `_init_running_statmap` + `_incr_add/remove_item` | Avoids full stat rebuild at every leaf |
| Scratch Map reuse | `_scratch_finalize`, `_scratch_combo_base`, etc. | Pre-allocated Maps reused across leaves; eliminates GC churn |
| Pool sort (smallest first) | `free_slots.sort(...)` | Most-constrained slots at shallower depths |
| Work-stealing partitions | 4× worker count | Keeps all cores busy when partition sizes are unequal |
| Illegal-set tracker | `_make_illegal_tracker()` | O(1) per-item check for exclusive set conflicts |
| Exclusive-set lock pruning | `start_solver_search` | Items from locked exclusive sets removed from all pools |
| Fast constraint precheck | `_fast_constraint_precheck` + `_fast_ehp_precheck` | Rejects leaves before SP work using precomputed fixed offsets |
| Pool-calibrated perturbation deltas | `_compute_pool_deltas` | Sensitivity perturbations use representative item magnitudes, not arbitrary constants |
| Combined mana: regen + steal + recast | `_eval_combo_mana_check` | Full mana model including INT bonus, mana steal, recast penalties, Transcendence |
| Blood Pact simulation caching | `_cached_hp_sim` | HP simulation result reused between mana gate and damage scoring |

---

## Key Weaknesses

### Score-blind enumeration
The level-based enumeration visits combinations in order of sum-of-rank-offsets (best-first within each level), but has no branch-and-bound pruning based on the current best score. Every combination at every level is fully evaluated — there is no early exit when remaining levels cannot possibly produce a better result. The search is exhaustive with good visitation order; mid-tree SP pruning is the only form of subtree elimination.

---

## High priority improvements

### Improve build enumeration order
Our current level based enumeration scheme is described in worker.js. We might be able to tweak this system to slightly favor helmet/chestplate/leggings/boots before the accessories. More often than not, the armor items provide significantly more stats than the accessories. This means exploring deeper into the accessory pools per helmet/chestplate/leggings/boots combination, looking for items that help make the skill points work out. This is only really relevant for helmet/chestplate/leggings/boots combinations that have skill point issues, so we can do this a bit more cleverly. Actually, we can probably reorder the worker queue a bit as well, considering the skill point feasibility.

### Optimize.
Feasible leaf calculations are kinda slow right now.

---

## Potential Improvements

### Weighted multi-objective scoring
Replace the single score with a weighted sum of multiple objectives: `w₁ × damage + w₂ × EHP + w₃ × mana_sustain + ...`. Users specify weights. This makes the solver useful for tank, support, or hybrid builds without changing the search algorithm — only the leaf scoring function changes.

### Tome optimisation
Tomes are currently fixed inputs (user-specified). Including tomes in the search space would require expanding the pool to ~7 additional slots (each with their own item pool), multiplying the search space significantly. A separate inner loop or a post-pass heuristic (swap tomes given a fixed armor build) would be more tractable than a full joint search.

### GPU parallelisation
Each leaf evaluation is independent and the scoring function (combo damage calc) is a fixed arithmetic pipeline. This is structurally suited to GPU compute (WebGPU). SP feasibility is no longer a blocker for vectorisation. The remaining challenge is porting the atree scaling and combo boost logic to GPU-friendly data structures.

---

## Debug Toggles (`debug_toggles.js`)

All default to `false`. Flip in `js/solver/debug_toggles.js`:

| Flag | Subsystem | Output |
|------|-----------|--------|
| `SOLVER_DEBUG_PRIORITY` | item_priority.js (main) | Effective weights, priority scores, pool ordering (top 20 per slot) |
| `SOLVER_DEBUG_DOMINANCE` | item_priority.js (main) | Per-slot pruning counts, dominator/dominatee pairs, stat comparisons |
| `SOLVER_DEBUG_SENSITIVITY` | item_priority.js (main) | Baseline stats/score, per-stat sensitivities sorted by magnitude, SP sensitivities, constraint/mana bonuses, dominance classification |
| `SOLVER_DEBUG_WORKER` | worker.js (worker 0) | Leaf breakdown: precheck/ehp/sp/threshold/mana/hp rejection counts, SP prune count, scored count, leaf timing |
| `SOLVER_DEBUG_COMBO` | node.js, search.js, worker.js, pure.js | Full row-by-row combo damage computation, sim results, per-cast damage, totals. Re-evaluates global top-1 on main thread with debug logging |
