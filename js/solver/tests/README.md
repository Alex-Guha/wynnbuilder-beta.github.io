# Solver & Combo Test Framework

Headless test framework for the WynnBuilder solver and combo systems.
Runs in Node.js without a browser — no DOM, no npm dependencies.

## Prerequisites

- **Node.js >= 18** (via nvm: `nvm use 18`) (latest node version recommended for speed)

## Running Tests

```bash
# Run the full suite
node js/solver/tests/run_all.js

# Run individual test files
node js/solver/tests/test_dominance.js
node js/solver/tests/test_combo_damage.js
node js/solver/tests/test_solver_search.js           # all solver snapshots
node js/solver/tests/test_solver_search.js archer     # only snapshots matching "archer"
node js/solver/tests/test_solver_search.js archer shaman  # multiple filters
node js/solver/tests/test_enum_order.js
node js/solver/tests/test_mana_sim.js
node js/solver/tests/test_skillpoints.js              # skillpoint calculation
node js/solver/tests/test_skillpoints.js --update     # mass-update expected values
```

## Test Files

| File | Tests |
|------|-------|
| `test_dominance.js` | Dominance pruning logic (bidirectional, SP, NONE items) |
| `test_enum_order.js` | Unified level-based enumeration algorithm |
| `test_combo_damage.js` | Combo damage/healing cross-validation (builder vs solver paths) |
| `test_mana_sim.js` | Mana simulation: fast path vs full `simulate_combo_mana_hp` cross-check |
| `test_skillpoints.js` | `calculate_skillpoints` correctness against hand-made and random test cases |
| `test_solver_search.js` | Full solver pipeline: pools, weights, pruning, worker enumeration |

Supporting files:

| File | Purpose |
|------|---------|
| `harness.js` | VM sandbox, game data loader, URL decoder, atree processor, assertion library, snapshot helpers |
| `worker_thread.js` | Node.js `worker_threads` adapter that wraps the solver's Web Worker for headless parallel execution |
| `run_all.js` | Discovers and runs all `test_*.js` files, aggregates pass/fail/warn counts |
| `gen_sp_cases.js` | Random test case generator for `test_skillpoints.js` |
| `test_skillpoints.json` | Test case data for `test_skillpoints.js` (hand-made + generated) |

## Adding a Skillpoint Test Case

Test cases live in `test_skillpoints.json`. Each case specifies 8 equipment
items + a weapon by name, and the expected skillpoint results.

### Test case format

```json
{
    "name": "my_test",
    "items": ["Helmet", "Chestplate", "Leggings", "Boots", "Ring1", "Ring2", "Bracelet", "Necklace"],
    "weapon": "Weapon Name",
    "sp_budget": 200,
    "expected": {
        "assign": [0, 0, 0, 0, 0],
        "total": [0, 0, 0, 0, 0],
        "total_assigned": 0
    }
}
```

- **items**: 8 equipment names in slot order. Use `null` or NONE names
  (`"No Helmet"`, `"No Chestplate"`, etc.) for empty slots.
- **weapon**: Weapon name, or `null`/`"No Weapon"` for none.
- **sp_budget** *(optional)*: Max total assignable SP. Defaults to Infinity.
- **expected**: One of:
  - `null` — not yet computed (emits a warning, not a failure).
  - `"infeasible"` — `calculate_skillpoints` should return null.
  - `{ assign, total, total_assigned }` — exact expected values.

Hand-made cases are preserved when regenerating random cases (only `random_*`
names get replaced).

### Generating random cases

```bash
node js/solver/tests/gen_sp_cases.js 20                    # 20 random cases (expected=null)
node js/solver/tests/gen_sp_cases.js 20 --feasible-only    # only feasible builds
node js/solver/tests/gen_sp_cases.js 20 --fill-expected    # also compute expected values
node js/solver/tests/gen_sp_cases.js 20 --append           # append instead of replacing random_ cases
node js/solver/tests/gen_sp_cases.js 20 --level 80-121     # restrict item level range
```

### Mass-updating expected values

When the skillpoint system changes and the current code is known correct:

```bash
node js/solver/tests/test_skillpoints.js --update
```

This recomputes all expected values from the current `calculate_skillpoints`
and writes them back to `test_skillpoints.json`. **Do not run this while the
code has known bugs** — the point is to snapshot known-correct behavior.

## Adding a Combo Damage Test Case

Combo tests are **self-validating cross-checks** — they compute each combo row's
damage via two independent code paths (builder vs solver) and verify the
results match. No hardcoded expected values needed, and they are immune to
game data updates.

1. **Set up the build** in the solver page.

2. **Copy the URL hash** — everything after `#` in the URL.

3. **Create a snapshot** at `js/solver/tests/snapshots/combo_<name>.snap.json`:

```json
{
  "name": "combo_<name>",
  "url_hash": "<paste the full hash here>"
}
```

4. **Run**: `node js/solver/tests/test_combo_damage.js`

The test decodes the URL, reconstructs the build (items, SP, atree, spells,
combo rows with boosts), then for each combo row evaluates damage via:
- **Builder path**: `calculateSpellDamage` → per-element min/max/crit arrays → crit-weighted average
- **Solver path**: `computeSpellDisplayAvg` from `pure/spell.js`

Both receive the same boosted stats and modified spell (after boost application
and spell prop overrides). The test verifies they produce matching totals at
floating-point precision.

## Adding a Solver Search Test Case

Solver search tests run the full pipeline headlessly: pool building, sensitivity
weights, dominance pruning, priority sorting, partitioning, and parallel worker
enumeration via `worker_threads`. They assert the solver finds builds scoring
at or above a known threshold.

1. Set up the build with the items you want locked and the combo/restrictions.
2. Copy the URL hash.
3. Create `js/solver/tests/snapshots/solver_<name>.snap.json`:

```json
{
  "name": "solver_<name>",
  "description": "Brief description of the test case",
  "url_hash": "<paste hash>",
  "scoring_target": "combo_damage",
  "expected_min_score": 50000,
  "time_limit_seconds": 60
}
```

- `scoring_target`: Any valid scoring target (e.g. `combo_damage`, `ehp`, `poison`).
- `expected_min_score`: The solver must find a build scoring at least this much.
- `time_limit_seconds`: Max wall-clock time for the search (default 60).

The test decodes the URL, builds item pools, runs sensitivity analysis and
pruning, partitions work, spawns `worker_threads` workers, and merges results.

## Data Staleness Detection

Snapshots track freshness at three levels:

- **Locked items** (`locked_items`): each locked/equipped item stores its name
  and a SHA-256 hash of its full statMap. If an item's stats change in game
  data, the hash will differ and a warning names the affected slot.
- **Item file** (`compress_hash`): SHA-256 of `compress.json`, checked for
  snapshots with free (unlocked) slots — i.e. solver search tests that enumerate
  item pools. Combo tests (all items locked) skip this check since the
  locked-item hashes already cover their items.
- **Atree data** (`atree_hash`): SHA-256 of `atree.json`, always checked.

When something changes, a **warning** (not failure) is emitted:

```
WARN: "combo_mage_monster" locked slot 3 ("Garda"): item stats changed.
WARN: Game data (compress.json) changed since snapshot "solver_mage_monster_2free" was created.
```

To update after game data changes:

1. Re-open the build in the browser (the URL hash still works).
2. Verify the new damage numbers / scores.
3. Update `expected_min_score` in the snapshot if needed.
4. Re-save the snapshot to update hashes (use `saveSnapshot()` from `harness.js`).

## Troubleshooting

### "Cannot find module './harness'"
Run from the repo root: `node js/solver/tests/test_combo_damage.js`

### "node: command not found" or wrong version
Use nvm: `nvm use 18 && node js/solver/tests/run_all.js`

### Test passes but with data staleness warning
The game data changed since the snapshot was created. Re-validate expected
values in the browser and update the snapshot.

### "spell X not found in spellMap"
The combo references a spell that the atree didn't produce. Check that the
URL hash has the correct atree nodes activated for those spells.
