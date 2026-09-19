import { feRegisterSetting } from "./fe-settings-data.js";
/**
 * Custom condition injections for dnd5e.
 *
 * We register into CONFIG.DND5E.conditionTypes so dnd5e can build the corresponding
 * Active Effect & HUD integration (v5+ behavior).
 *
 * Intentionally does NOT mutate CONFIG.statusEffects.
 *
 * Cross-version note (v13 + v14):
 *   v14 migrated EffectChangeData#mode (numeric enum) → #type (string enum).
 *   We emit BOTH on each change: v14 reads `type`, v13 reads `mode` and ignores
 *   the unknown extra key.
 *
 *   The `type` strings MUST match CONST.ACTIVE_EFFECT_CHANGE_TYPES exactly, which
 *   is lowercase ("override", not "OVERRIDE"). An unrecognized type is NOT an
 *   error — core treats arbitrary type strings as system/module-defined and falls
 *   through to the custom handler, so a wrong-case type makes the change silently
 *   do nothing. Emitting `type` also SUPPRESSES core's own mode→type migration
 *   (BaseActiveEffect.migrateData only fills `type` in when absent), so there is
 *   no safety net behind a wrong value here.
 *
 * Cross-version note (dnd5e 5.x + 6.0):
 *   dnd5e 6.0 moved the movement speeds into a `speeds` sub-object:
 *   `system.attributes.movement.walk` -> `system.attributes.movement.speeds.walk`.
 *   Measured on 6.0.1: BOTH keys still drive the value, because `MovementField._shim`
 *   leaves a setter on the old name — but that setter logs a deprecation and is slated
 *   for removal in dnd5e 7.0, at which point the old key silently stops doing anything.
 *   `feMovementKey` therefore probes the SCHEMA (the thing that actually decides), never
 *   `game.system.version`.
 */

// Keys mirror the (deprecated since v14) CONST.ACTIVE_EFFECT_MODES numeric enum,
// which v13 still requires; values mirror CONST.ACTIVE_EFFECT_CHANGE_TYPES.
const FE_AE_MODE_TO_TYPE = Object.freeze({
  0: "custom",
  1: "multiply",
  2: "add",
  3: "downgrade",
  4: "upgrade",
  5: "override",
});

const FE_AE_MODE_OVERRIDE = 5;

function feBuildAEChange(key, modeNumber, value, priority = 20) {
  const type = FE_AE_MODE_TO_TYPE[modeNumber] ?? "override";
  return { key, mode: modeNumber, type, value, priority };
}

/**
 * The Active Effect change key for one movement speed, spelled for the running dnd5e.
 *
 * The probe is the actor schema itself: on 6.0 `attributes.movement.speeds` is a real
 * field and on 5.x it does not exist, so the first one that resolves is the right one.
 * Falls back to the 5.x spelling if the data models are not reachable, which is the
 * behaviour this module had before 6.0 existed.
 */
function feMovementKey(type) {
  // `dnd5e.dataModels.actor.NPCData.schema` is a static built at class-definition time, so
  // it is populated before ANY init hook — unlike `CONFIG.Actor.dataModels`, which dnd5e
  // fills from its own `init` listener and would make this depend on hook order. The
  // CONFIG path is kept only as a fallback.
  const schema =
    globalThis.dnd5e?.dataModels?.actor?.NPCData?.schema ??
    CONFIG?.Actor?.dataModels?.npc?.schema;
  const modern = schema?.getField?.("attributes.movement.speeds");
  return modern
    ? `system.attributes.movement.speeds.${type}`
    : `system.attributes.movement.${type}`;
}

function feBuildConditions() {
  const mkOverride = (key, value) => feBuildAEChange(key, FE_AE_MODE_OVERRIDE, value, 20);

  return [
    {
      id: "condfemalemating",
      name: "MYCOND.CondFemaleMating",
      img: "systems/dnd5e/icons/svg/statuses/charmed.svg",
      statuses: ["condfemalemating"],
      changes: [
        mkOverride(feMovementKey("walk"), 0),
        mkOverride(feMovementKey("fly"), 0),
        mkOverride(feMovementKey("swim"), 0),
        mkOverride(feMovementKey("climb"), 0),
        mkOverride(feMovementKey("burrow"), 0),
        mkOverride("flags.midi-qol.disadvantage.attack.all", 1),
        mkOverride("flags.midi-qol.disadvantage.ability.save.int", 1),
        mkOverride("flags.midi-qol.disadvantage.ability.save.wis", 1),
        mkOverride("flags.midi-qol.disadvantage.ability.save.cha", 1),
      ]
    },
    {
      // Simple marking condition (no mechanical effects)
      id: "mark",
      name: "MYCOND.Mark",
      img: "systems/dnd5e/icons/svg/statuses/marked.svg",
      statuses: ["mark"],
      changes: []
    }
  ];
}

Hooks.once("init", () => {
  feRegisterSetting("injectCustomConditions");

  const types = CONFIG?.DND5E?.conditionTypes;
  if (!types) return;
  if (!game.settings.get("female_edition", "injectCustomConditions")) return;

  for (const c of feBuildConditions()) {
    // Avoid clobbering an existing system/module condition with the same id.
    if (types[c.id]) continue;
    types[c.id] = {
      name: c.name,
      img: c.img,
      statuses: c.statuses,
      changes: c.changes
      // hud: false
    };
  }
});
