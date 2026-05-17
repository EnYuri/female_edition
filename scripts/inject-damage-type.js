// inject-damage-type.js — Custom dnd5e damage types with user-configurable names.
// Guarded by CONFIG?.DND5E presence. Standalone — no imports.

const _MOD = "female_edition";

const _DMG_ENTRIES = [
  { key: "female_poison",      idx: 1, icon: "systems/dnd5e/icons/svg/statuses/bloodied.svg"  },
  { key: "female_psychic",     idx: 2, icon: "systems/dnd5e/icons/svg/statuses/cursed.svg"    },
  { key: "female_bludgeoning", idx: 3, icon: "systems/dnd5e/icons/svg/statuses/grappled.svg"  },
  { key: "female_thunder",     idx: 4, icon: "systems/dnd5e/icons/svg/statuses/stunned.svg"   },
  { key: "female_lightning",   idx: 5, icon: "systems/dnd5e/icons/svg/statuses/paralyzed.svg" },
  { key: "female_force",       idx: 6, icon: "systems/dnd5e/icons/svg/statuses/charmed.svg"   },
  { key: "female_radiant",     idx: 7, icon: "systems/dnd5e/icons/svg/cleric.svg"             },
  { key: "female_fire",        idx: 8, icon: "systems/dnd5e/icons/svg/sorcerer.svg"           },
];

const _DMG_TABLES = [
  "damageTypes",
  "damageResistanceTypes",
  "damageImmunityTypes",
  "damageVulnerabilityTypes",
];

function _settingKey(idx) { return `dmgCustom${idx}`; }

function _applyLabel(dmgKey, label) {
  const config = CONFIG?.DND5E;
  if (!config) return;
  for (const tableName of _DMG_TABLES) {
    const entry = config[tableName]?.[dmgKey];
    if (entry) entry.label = label;
  }
}

Hooks.once("init", () => {
  const config = CONFIG?.DND5E;
  if (!config) return;

  // 1. Register settings first so get() works immediately after.
  for (const { key, idx } of _DMG_ENTRIES) {
    game.settings.register(_MOD, _settingKey(idx), {
      name: `[DND5e] 커스텀 피해 타입 ${idx} 이름`,
      hint: "이 슬롯에 표시될 피해 타입 이름. 비워두면 번호로 표시됩니다.",
      scope: "world",
      config: true,
      restricted: true,
      type: String,
      default: String(idx),
      onChange: (value) => _applyLabel(key, value.trim() || String(idx)),
    });
  }

  // 2. Register damage types into all CONFIG.DND5E tables using stored names.
  for (const { key, idx, icon } of _DMG_ENTRIES) {
    const stored = game.settings.get(_MOD, _settingKey(idx));
    const label  = (stored ?? "").trim() || String(idx);
    const entry  = { label, icon };

    for (const tableName of _DMG_TABLES) {
      const table = config[tableName];
      if (!table || typeof table !== "object") continue;
      if (table[key]) continue; // never overwrite an existing registration
      table[key] = entry;
    }
  }
});
