/**
 * Custom condition injections for dnd5e.
 *
 * We register into CONFIG.DND5E.conditionTypes so dnd5e can build the corresponding
 * Active Effect & HUD integration (v5+ behavior).
 *
 * Intentionally does NOT mutate CONFIG.statusEffects.
 */

const CONDITIONS = [
  {
    id: "condfemalemating",
    name: "MYCOND.CondFemaleMating",
    img: "systems/dnd5e/icons/svg/statuses/charmed.svg",
    statuses: ["condfemalemating"],
    changes: [
      { key: "system.attributes.movement.walk", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.fly", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.swim", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.climb", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.burrow", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },

      { key: "flags.midi-qol.disadvantage.attack.all", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 },
      { key: "flags.midi-qol.disadvantage.ability.save.int", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 },
      { key: "flags.midi-qol.disadvantage.ability.save.wis", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 },
      { key: "flags.midi-qol.disadvantage.ability.save.cha", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 }
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

Hooks.once("init", () => {
  const types = CONFIG?.DND5E?.conditionTypes;
  if (!types) return;

  for (const c of CONDITIONS) {
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
