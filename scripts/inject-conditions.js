const CONDITION_ID = "condfemalemating";
const I18N = "MYCOND.CondFemaleMating";
const IMG  = "systems/dnd5e/icons/svg/statuses/charmed.svg";

Hooks.once("init", () => {

  CONFIG.DND5E.conditionTypes[CONDITION_ID] = {
    name: I18N,
    img: IMG,

    statuses: [CONDITION_ID],
    changes: [
      { key: "system.attributes.movement.walk",   mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.fly",    mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.swim",   mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.climb",  mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },
      { key: "system.attributes.movement.burrow", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 0, priority: 20 },

      { key: "flags.midi-qol.disadvantage.attack.all", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 },
      { key: "flags.midi-qol.disadvantage.ability.save.int", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 },
      { key: "flags.midi-qol.disadvantage.ability.save.wis", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 },
      { key: "flags.midi-qol.disadvantage.ability.save.cha", mode: CONST.ACTIVE_EFFECT_MODES.OVERRIDE, value: 1, priority: 20 }
    ],

    // 선택: HUD에 안 보이게 하고 싶으면
    // hud: false
  };
});

// ❌ removeExistingStatusEffect / CONFIG.statusEffects.push(...) / ready 훅 전부 제거