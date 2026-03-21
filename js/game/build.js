/** 
 * This file defines a class representing the player Build.
 *
 * Keeps track of equipment list, equip order, skillpoint assignment (initial),
 * Aggregates item stats into a statMap to be used in damage calculation.
 */

/*
 * Class that represents a wynn player's build.
 */
class Build {
    
    /**
     * @description Construct a build.
     * @param {Number} level : Level of the player.
     * @param {String[]} items: List of equipment names that make up the build.
     *                    In order: Helmet, Chestplate, Leggings, Boots, Ring1, Ring2, Brace, Neck, Tomes [x7].
     * @param {Item} weapon: Weapon that this build is using.
     * @param {List[Item]} _wynn_order_equipment: Equipment to consider for skillpoint
     *                    calculation, in wynn order (boots->helmet, ring1->neck, tome)
     */
    constructor(level, equipment, tomes, weapon, _wynn_order_equipment){

        if (level < 1) { //Should these be constants?
            this.level = 1;
        } else if (level > MAX_PLAYER_LEVEL) {
            this.level = MAX_PLAYER_LEVEL;
        } else if (level <= MAX_PLAYER_LEVEL && level >= 1) {
            this.level = level;
        } else if (typeof level === "string") {
            this.level = level;
        } else {
            console.warn("Build: unexpected level value", level);
            this.level = 1;
        }
        document.getElementById("level-choice").value = this.level;

        this.availableSkillpoints = levelToSkillPoints(this.level);
        this.items = equipment.concat([...tomes, weapon]);
        this.equipment = equipment;
        this.tomes = tomes
        this.weapon = weapon;

        // calc skillpoints requires statmaps only
        let result = calculate_skillpoints(_wynn_order_equipment.map((x) => x.statMap), this.weapon.statMap);
        if (!result) {
            // Impossible build (single attr > SP_PER_ATTR_CAP). Use zeroed fallback.
            this.base_skillpoints = [0, 0, 0, 0, 0];
            this.total_skillpoints = [0, 0, 0, 0, 0];
            this.assigned_skillpoints = 0;
            this.activeSetCounts = new Map();
        } else {
            // How many skillpoints the player had to assign (5 numbers)
            this.base_skillpoints = result[0];
            // How many skillpoints the build ended up with (5 numbers)
            this.total_skillpoints = result[1];
            // How many skillpoints assigned (1 number, sum of base_skillpoints)
            this.assigned_skillpoints = result[2];
            this.activeSetCounts = result[3];
        }

        this.initBuildStats();
    }  

    /*  Get all stats for this build. Stores in this.statMap.
        @pre The build itself should be valid. No checking of validity of pieces is done here.
    */
    initBuildStats(){
        const statMap = createBaseStatmap(this.level);

        // Accumulate item stats
        for (const item of this.items){
            const item_stats = item.statMap;
            const maxRolls = item_stats.get("maxRolls");
            if (maxRolls) {
                for (const [id, value] of maxRolls) {
                    if (STATMAP_STATIC_ID_SET.has(id)) continue;
                    statMap.set(id, (statMap.get(id) || 0) + value);
                }
            }
            for (const staticID of STATMAP_STATIC_IDS) {
                const v = item_stats.get(staticID);
                if (v) statMap.set(staticID, statMap.get(staticID) + v);
            }
        }

        applySetBonuses(statMap, this.activeSetCounts, sets);
        finalizeStatmap(statMap, this.weapon.statMap, this.items.map(i => i.statMap));

        this.statMap = statMap;
    }
}
