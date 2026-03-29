# WynnSolver

WynnSolver is a build optimizer for the Wynncraft MMO, built on top of the [WynnBuilder](https://wynnbuilder.github.io) codebase. Given a weapon, locked items, ability tree, tomes, boosts, and a damage combo, it searches all combinations of the remaining equipment slots to find the build that maximizes combo damage while satisfying configurable stat restrictions.

The solver lives at `/solver/index.html` and is a fully client-side static page — no build step, no server. It shares all game data, utility libraries, and the computation graph infrastructure with WynnBuilder.

---

# Todo

- looping combo portions
- True DPS calculation
- Weighted multi-target solving
- Let's add a new toggle to the combo section that appears when in advanced mode: "Debug". When in debug, 

### Necessary Improvements
- Testing setup to measure the time it takes to find a build, across many builds. This would be used to test priority weighting changes.
    - Better yet, what's the score for the best build found in N minutes, and how many checked/feasible/met reqs in that time

### Polish
#### UI
- Ensure the red and blue solver messages appear at appropriate times. Red requires testing with a poor cpu, and blue probably isn't showing soon enough.

#### Combo
- "Taking wall of smoke doesn't auto-bump the hits to 30 either", "It would be pretty complicated to fix too, because the entry doesn't know whether you specified 10 hits or jsut to use the max right now"
- Remove the melee cd from combo end time, detect melee at end and within cd of start, and add in the appropriate time


### Testing
- Add more complicated scenarios to test_dominance.js
- Solver +
    - Reckless Abandon
    - Tougher Skin
    - Seance
    - Radiant Devotee
    - Wisdom

### Long term
- Premade archetype combo selectors
- Tree-assembler: "I want ability X, Y, and Z, give me a tree that gets all 3 if possible"

- Consider:
> CPS thingy into damage solver as sometimes people (idk all, but at least i will) slow down/accelerate their cycle depends on their situation, like sustain or burst

> at some point (prolly by the time you make combos more advanced/add weighting to build rankings) you should probably also add a combo feature where the build calculates dpm in amount of times the combo can be performed in a minute including dt (because some builds may not quite sustain but still have really high dps, and the dt might not be that bad)
> Here's where its coming from: I used to choose items off wynnatlas by basically putting in the formula for damage in a minute with the item added. My formula basically took this form: 60/time it takes to cast the combo * damage the combo does 
the time it takes to cast the combo once was basically calculated using 1+mana deficit from 1 second of casting the combo / composite mana gain per second and sometimes that formula gave you builds that couldn't actually cast the combo (usually takes one second) 60 times, usually 55-60 though but currently there's no accounting for how downtime actually affects dps in the solver, so those builds will either not get punished if they are above the deficit minimum or be filtered out even if they have higher dpm
> basically: sustain isn't always the most important property of a build, some builds that almost sustain are better than those that do because they have a lot more damage


## Major Update: Automatic combo sequencing
- Duration rework
- tracking state-dependent effects across a combo sequence (clone counts consumed by Bamboozle after Vanish, etc.) would require a lot of work

### Systems
#### Abilities
- Pierce the Veil
- Acolyte Blood Pool
	- Sacrificial Shrine
	- Twisted Tether
	- Blood Rite
	- Fortified Formation
	- Lashing Lance, Sanguine Strike, Effuse
	- Eldritch Call
	- Blood Sorrow
	- Monument to Gloom
	- Aspect of Exsanguination
- Acolyte Bleeding
	- Many abilities, duration rework
	- Aspect of Lashing Fire
- Arcanist Manabank
	- Arcane Transfer
	- Arcane Power
	- Mythic Aspect
	- Aspect of Limitless Knowledge
- Paladin Holy Power
	- Sacred Surge
	- Luster Purge
	- Hallowed Blaze
	- Consecration
	- Buried Light
	- Mythic Aspect
- Battle Monk Discombobulate
- Battle Monk Generalist/Pressure
- Ritualist Awakened
	- Mythic Aspect

#### Majids
- Sorcery
- Madness
- Roving Assassin (shadestepper)
- Chaos Reach (acolyte)
- Cannulate (acolyte)
- Oneiro (arcanist)
- Perfect Recall (arcanist)
- Slow Boil (fallen)
- Vitriol (fallen)
- Split Second (invigorating wave)
- Alter Ego (ritualist awakened)


### Mana
#### Abilities
- Arcanist Manastorm
	- Aspect of Manaflux
- Boltslinger Recycling
- Trapper Mana Trap
- Acrobat weightless
- Summoner Aura
- Rift Paradox
	- Aspect of Futures Rewritten
- Ritu Masquerade
- Harvester
- Pool of Rejuvenation
- Manachism?
- Sunflare?
- Generalist

#### Majids
- Soul Eater
- Mana Surge - geh
- Transcendence


### Health
#### Abilities
- Rejuvenating Skin
	- Aspect of Rekindling
- Dawn (lb ult)
- Beyond Salvation (fallen ult) (overhealth)
- Heavenly Trumpet (overhealth)

#### Majids
- Divine Right (state-based implementation including overhealth)
- Lifestream (requires aco overhealth implementation)
- Phoenix-Born
- Fallout (self damage)
