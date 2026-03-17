# WynnSolver

WynnSolver is a build optimizer for the Wynncraft MMO, built on top of the [WynnBuilder](https://wynnbuilder.github.io) codebase. Given a weapon, locked items, ability tree, tomes, boosts, and a damage combo, it searches all combinations of the remaining equipment slots to find the build that maximizes combo damage while satisfying configurable stat restrictions.

The solver lives at `/solver/index.html` and is a fully client-side static page — no build step, no server. It shares all game data, utility libraries, and the computation graph infrastructure with WynnBuilder.

---

## Todo

### Bugs
#### Combo


#### UI


### Necessary Improvements


### Improve Solver
- See SOLVER.md for details.


### Polish
#### UI
- Ensure the red and blue solver messages appear at appropriate times. Red requires testing with a poor cpu, and blue probably isn't showing soon enough.
- Clean the "Checked | Feasible \n Time | Time left | Warning" display up


#### Combo
- Add healing stuff to atree (Intoxicating Blood, Rejuvenating Skin, that kind of stuff)


### Testing
- Test tstack builds
- Add more complicated scenarios to test_dominance.js
- Add more tests

#### Archetypes/Combos

The combo damage calculation has been tested against WynnBuilder output for some archetypes and bugs were found and fixed, but not all archetypes have been verified. Each archetype should be tested by loading the same build and buffs in both WynnSolver and WynnBuilder and comparing per-spell damage numbers. Archetypes that use prop-type sliders (e.g. Enkindled %), ability-name aliases (e.g. Mirror Image → Activate Clones), or powder special spells are the highest priority to verify.

#### Combo Mana Calculation

### Long term
- Automatic combo sequencing - tracking state-dependent effects across a combo sequence (clone counts consumed by Bamboozle after Vanish, etc.) would require a lot of work
- Advanced mode, where the per-spell cast time and durations and spell hits and what not can be specified
- Premade archetype combo selectors
- Tree-assembler: "I want ability X, Y, and Z, give me a tree that gets all 3 if possible"