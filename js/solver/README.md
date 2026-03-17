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
- Rainbow and Standard guild tomes are handled a bit differently, resulting in different skill point displays (Remaining 0 vs -4 respectively). This can be confusing.


#### Combo
- Add healing stuff to atree (Intoxicating Blood, Rejuvenating Skin, that kind of stuff)


### Testing
- Testing framework ;-;
- Test tstack builds
- Add more complicated scenarios to test_dominance.js
- Add more tests

#### Combo Mana Calculation

### Long term
- Cast time/delay-based mana calc with an advanced mode, where the per-spell cast time and durations and spell hits and what not can be specified in greater detail and control
    - Mana abilities missing:
        - Arcanist Manastorm
        - Boltslinger Recycling
        - Trapper? Mana Trap
        - Acrobat weightless
        - Summoner Aura
- Automatic combo sequencing - tracking state-dependent effects across a combo sequence (clone counts consumed by Bamboozle after Vanish, etc.) would require a lot of work
- Premade archetype combo selectors
- Tree-assembler: "I want ability X, Y, and Z, give me a tree that gets all 3 if possible"