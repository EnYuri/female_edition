Hooks.once("init", () => {

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

  // 피해 타입 목록
  Object.assign(CONFIG.DND5E.damageTypes, extra);

  // 환경/시트/모듈에 따라 별도 목록
  for (const k of ["damageResistanceTypes", "damageImmunityTypes", "damageVulnerabilityTypes"]) {
    if (CONFIG.DND5E[k]) Object.assign(CONFIG.DND5E[k], extra);
  }
});
