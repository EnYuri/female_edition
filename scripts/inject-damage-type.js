Hooks.once("init", () => {
  const config = CONFIG?.DND5E;
  if (!config) return;

  const extra = {
    female_poison: { label: "MYDMG.FemalePoison", icon: "systems/dnd5e/icons/svg/statuses/bloodied.svg" },
    female_psychic: { label: "MYDMG.FemalePsychic", icon: "systems/dnd5e/icons/svg/statuses/cursed.svg" },
    female_bludgeoning: { label: "MYDMG.FemaleBludgeoning", icon: "systems/dnd5e/icons/svg/statuses/grappled.svg" },
    female_thunder: { label: "MYDMG.FemaleThunder", icon: "systems/dnd5e/icons/svg/statuses/stunned.svg" },
    female_lightning: { label: "MYDMG.FemaleLightning", icon: "systems/dnd5e/icons/svg/statuses/paralyzed.svg" },
    female_force: { label: "MYDMG.FemaleForce", icon: "systems/dnd5e/icons/svg/statuses/charmed.svg" },
    female_radiant: { label: "MYDMG.FemaleRadiant", icon: "systems/dnd5e/icons/svg/cleric.svg" },
    female_fire: { label: "MYDMG.FemaleFire", icon: "systems/dnd5e/icons/svg/sorcerer.svg" }
  };

  const registerInto = (table) => {
    if (!table || typeof table !== "object") return;
    for (const [key, data] of Object.entries(extra)) {
      // Avoid silently overwriting an existing system/module registration.
      if (table[key]) continue;
      table[key] = data;
    }
  };

  // 피해 타입 목록
  registerInto(config.damageTypes);

  // 환경/시트/모듈에 따라 별도 목록
  for (const k of ["damageResistanceTypes", "damageImmunityTypes", "damageVulnerabilityTypes"]) {
    registerInto(config[k]);
  }
});
