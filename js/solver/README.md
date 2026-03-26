# WynnSolver

WynnSolver is a build optimizer for the Wynncraft MMO, built on top of the [WynnBuilder](https://wynnbuilder.github.io) codebase. Given a weapon, locked items, ability tree, tomes, boosts, and a damage combo, it searches all combinations of the remaining equipment slots to find the build that maximizes combo damage while satisfying configurable stat restrictions.

The solver lives at `/solver/index.html` and is a fully client-side static page — no build step, no server. It shares all game data, utility libraries, and the computation graph infrastructure with WynnBuilder.

---

## Todo

### Bugs
#### Combo


#### UI


### Necessary Improvements


### Polish
#### UI
- Ensure the red and blue solver messages appear at appropriate times. Red requires testing with a poor cpu, and blue probably isn't showing soon enough.

#### Combo


### Testing
- Test tstack builds
- Add more complicated scenarios to test_dominance.js
- Add more tests
- Testing setup to measure the time it takes to find a build, across many builds. This would be used to test priority weighting changes.
    - Better yet, what's the score for the best build found in N minutes, and how many checked/feasible/met reqs in that time

### Long term
- Handle the variable attack speed
- Mana abilities missing:
    - Arcanist Manastorm
    - Boltslinger Recycling
    - Trapper? Mana Trap
    - Acrobat weightless
    - Summoner Aura
    - Rift Paradox
- Add healing stuff to atree
    - Rejuvenating Skin
    - Dawn (lb ult)
    - Beyond Salvation (fallen ult)?
    - Heavenly Trumpet
- Verify Sanguine Strike bleeding is accounted for
- Weighted multi-target solving
- Major IDs and adding mana/health considerations to items
- Premade archetype combo selectors
- Automatic combo sequencing - tracking state-dependent effects across a combo sequence (clone counts consumed by Bamboozle after Vanish, etc.) would require a lot of work
- Tree-assembler: "I want ability X, Y, and Z, give me a tree that gets all 3 if possible"

- Consider:
> CPS thingy into damage solver as sometimes people (idk all, but at least i will) slow down/accelerate their cycle depends on their situation, like sustain or burst

> at some point (prolly by the time you make combos more advanced/add weighting to build rankings) you should probably also add a combo feature where the build calculates dpm in amount of times the combo can be performed in a minute including dt (because some builds may not quite sustain but still have really high dps, and the dt might not be that bad)
> Here's where its coming from: I used to choose items off wynnatlas by basically putting in the formula for damage in a minute with the item added. My formula basically took this form: 60/time it takes to cast the combo * damage the combo does 
the time it takes to cast the combo once was basically calculated using 1+mana deficit from 1 second of casting the combo / composite mana gain per second and sometimes that formula gave you builds that couldn't actually cast the combo (usually takes one second) 60 times, usually 55-60 though but currently there's no accounting for how downtime actually affects dps in the solver, so those builds will either not get punished if they are above the deficit minimum or be filtered out even if they have higher dpm
> basically: sustain isn't always the most important property of a build, some builds that almost sustain are better than those that do because they have a lot more damage