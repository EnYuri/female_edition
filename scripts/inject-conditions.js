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
 *   We emit BOTH on each change so whichever field dnd5e reads on the running
 *   core version, the value is present and consistent. Adding the extra key
 *   on v13 is harmless (the document schema simply ignores it).
 */

const FE_AE_MODE_TO_TYPE = Object.freeze({
  0: "CUSTOM",
  1: "MULTIPLY",
  2: "ADD",
  3: "DOWNGRADE",
  4: "UPGRADE",
  5: "OVERRIDE",
});

function feBuildAEChange(key, modeNumber, value, priority = 20) {
  const type = FE_AE_MODE_TO_TYPE[modeNumber] ?? "OVERRIDE";
  return { key, mode: modeNumber, type, value, priority };
}

function feBuildConditions() {
  const overrideMode = CONST?.ACTIVE_EFFECT_MODES?.OVERRIDE ?? 5;
  const mkOverride = (key, value) => feBuildAEChange(key, overrideMode, value, 20);

  return [
    {
      id: "condfemalemating",
      name: "MYCOND.CondFemaleMating",
      img: "systems/dnd5e/icons/svg/statuses/charmed.svg",
      statuses: ["condfemalemating"],
      changes: [
        mkOverride("system.attributes.movement.walk", 0),
        mkOverride("system.attributes.movement.fly", 0),
        mkOverride("system.attributes.movement.swim", 0),
        mkOverride("system.attributes.movement.climb", 0),
        mkOverride("system.attributes.movement.burrow", 0),
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
  game.settings.register("female_edition", "injectCustomConditions", {
    name: "[DND5e] 커스텀 컨디션 주입 활성화",
    hint: "이 모듈의 커스텀 컨디션을 dnd5e에 등록합니다. 변경 후 세계 새로고침이 필요합니다.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: false,
    requiresReload: true,
  });

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
