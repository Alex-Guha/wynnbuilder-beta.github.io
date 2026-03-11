/**
 * Centralized game rule constants.
 * Values derived from Wynncraft game mechanics.
 */

// ── Skill Points ──────────────────────────────────────────────────────────────
const SP_TOTAL_CAP = 200;           // Max assignable skill points
const SP_PER_ATTR_CAP = 100;        // Max skill points per attribute
const SP_GUILD_TOME_STD = 204;      // SP budget with standard guild tome (+4)
const SP_GUILD_TOME_RARE = 205;     // SP budget with rare guild tome (+5)
const SP_PERCENTAGE_RATE = 0.9908;  // Geometric series rate for SP→% conversion
const SP_PERCENTAGE_INPUT_CAP = 150;// SP input cap for percentage conversion

// ── Player Stats ──────────────────────────────────────────────────────────────
const MAX_PLAYER_LEVEL = 121;

// ── Mana ─────────────────────────────────────────────────────────────────────
const BASE_MANA_REGEN = 25;        // Base mana regen per 5 seconds (all classes)
