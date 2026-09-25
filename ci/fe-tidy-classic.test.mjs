import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Every file under `dir`, recursively, as absolute paths. */
function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) out.push(...walk(child));
    else out.push(fileURLToPath(child));
  }
  return out;
}

/**
 * `tidy-classic/` is a vendored fork of Tidy 5e Sheets 12.5.5 — the last release that
 * shipped the Classic layout, which upstream deleted in 14.x along with its support.
 *
 * Several of the arrangements below look like arbitrary detail and are not:
 *   - Settings register under `female_edition` because tidy5e-sheet 14 is still installed
 *     and owns the `tidy5e-sheet` settings namespace.
 *   - Document flags DELIBERATELY stay on `tidy5e-sheet` so existing actors keep their
 *     favourites, pins and section config.
 *   - The `tidyClassic-` key prefix is what keeps GM priority from force-pushing every
 *     player's sheet layout.
 *   - Stylesheet ORDER is what makes the de-duplicated global sheet correct.
 * This suite fails if any of them drift.
 */

const root = new URL("../", import.meta.url);
const read = (p) => readFileSync(new URL(p, root), "utf8");

const manifest = JSON.parse(read("module.json"));
const constants = read("tidy-classic/src/constants.ts");
const main = read("tidy-classic/src/main.svelte.ts");
const adapter = read("tidy-classic/src/foundry/foundry-adapter.ts");
const gmPriority = read("scripts/fe-gm-priority.js");

const BUNDLE = "tidy-classic/dist/tidy-classic.js";
const CSS_GLOBAL = "tidy-classic/styles/tidy5e-classic-global.css";
const CSS_BUILT = "tidy-classic/dist/tidy-classic.css";

const stylePath = (entry) => (typeof entry === "string" ? entry : entry?.src);

test("the built Classic bundle and both stylesheets are registered", () => {
  assert.ok(manifest.esmodules.includes(BUNDLE), "bundle missing from esmodules");
  const styles = manifest.styles.map(stylePath);
  assert.ok(styles.includes(CSS_GLOBAL), "global stylesheet missing");
  assert.ok(styles.includes(CSS_BUILT), "built stylesheet missing");
});

test("committed build output exists — Foundry loads it with no build step", () => {
  for (const p of [BUNDLE, CSS_BUILT]) {
    assert.ok(existsSync(new URL(p, root)), `${p} is not committed`);
  }
});

test("upstream and vendored licences ship with the fork", () => {
  for (const p of [
    "tidy-classic/LICENSE.txt",
    "tidy-classic/NOTICE.md",
    "tidy-classic/public/rpg-awesome/LICENSE.md",
  ]) {
    assert.ok(existsSync(new URL(p, root)), `${p} is not committed`);
  }
});

test("upstream ambient and type-only declarations stay restored", () => {
  for (const p of [
    "tidy-classic/src/events/custom-event-types.d.ts",
    "tidy-classic/src/foundry/dnd5e.dataModels.fields.types.d.ts",
    "tidy-classic/src/foundry/foundry-and-system.d.ts",
    "tidy-classic/src/foundry/foundry.data.fields.types.d.ts",
    "tidy-classic/src/vite-env.d.ts",
  ]) {
    assert.ok(existsSync(new URL(p, root)), `${p} is not committed`);
  }

  assert.match(
    read("tidy-classic/src/foundry/foundry-and-system.d.ts"),
    /declare global \{[\s\S]*var game: any;/,
    "the Foundry globals declaration was replaced",
  );
  assert.match(
    read("tidy-classic/src/foundry/foundry.data.fields.types.d.ts"),
    /declare module 'foundry\.data\.fields'/,
  );

  const tsconfig = JSON.parse(read("tidy-classic/tsconfig.json"));
  assert.equal(tsconfig.compilerOptions.target, "ES2024");
  assert.ok(tsconfig.compilerOptions.lib.includes("ESNext"));

  const stubs = walk(new URL("tidy-classic/src/", root)).filter(
    (path) => path.endsWith(".ts") && readFileSync(path, "utf8").includes("Type-only stub"),
  );
  assert.equal(stubs.length, 0, `type stubs returned: ${stubs.join(", ")}`);
});

test("the global stylesheet is registered BEFORE the built one", () => {
  // The global sheet had every rule the build re-emits removed from it. That is only safe
  // while the build's identical copy lands later in the cascade; flip the order and the
  // removed declarations are simply gone.
  const styles = manifest.styles.map(stylePath);
  assert.ok(styles.indexOf(CSS_GLOBAL) < styles.indexOf(CSS_BUILT));
});

test("neither tidy stylesheet is layered, matching tidy5e-sheet 14", () => {
  // Unlayered => Foundry's `modules` layer, same tier tidy5e-sheet 14 lands in, which is
  // what lets our layer(layouts) retro overrides keep winning with !important.
  for (const entry of manifest.styles) {
    if (typeof entry === "string") continue;
    assert.ok(
      entry.src !== CSS_GLOBAL && entry.src !== CSS_BUILT,
      `${entry.src} must not declare a layer`,
    );
  }
});

test("flags keep the tidy5e-sheet namespace but settings do not", () => {
  assert.match(constants, /MODULE_ID:\s*'tidy5e-sheet'/);
  assert.match(constants, /SETTINGS_NAMESPACE:\s*'female_edition'/);
  assert.match(constants, /SETTINGS_KEY_PREFIX:\s*'tidyClassic-'/);
});

test("every settings accessor goes through the female_edition namespace", () => {
  // A single `game.settings.*(CONSTANTS.MODULE_ID, …)` left behind would collide with
  // tidy5e-sheet 14's registration of the same key.
  const settingsCalls = adapter.match(/game\.settings\.\w+\(\s*CONSTANTS\.MODULE_ID/g);
  assert.equal(settingsCalls, null, "a settings call still uses MODULE_ID");
  assert.match(adapter, /game\.settings\.register\(\s*CONSTANTS\.SETTINGS_NAMESPACE/);
  assert.match(adapter, /getTidySettingKey/);
});

test("Classic reset deletes only its registered world settings", () => {
  const reset = read("tidy-classic/src/settings/ResetSettingsDialog.ts");
  assert.match(reset, /CONSTANTS\.SETTINGS_NAMESPACE\}\.\$\{CONSTANTS\.SETTINGS_KEY_PREFIX/);
  assert.match(reset, /game\.settings\.settings\.get\(setting\.key\)\?\.scope === 'world'/);
  assert.doesNotMatch(reset, /startsWith\(`\$\{CONSTANTS\.MODULE_ID\}/);
  assert.match(reset, /callback: \(\) => ResetSettingsDialog\.resetClassicWorldSettings\(\)/);
  assert.match(reset, /await ResetSettingsDialog\.resetClassicWorldSettings\(\)/);
});

test("open Classic sheets rerender when their own settings change", () => {
  const mixin = read("tidy-classic/src/mixins/SvelteApplicationMixin.svelte.ts");
  assert.match(mixin, /CONSTANTS\.SETTINGS_NAMESPACE\}\.\$\{CONSTANTS\.SETTINGS_KEY_PREFIX/);
  assert.doesNotMatch(mixin, /setting\.key\.startsWith\(`\$\{CONSTANTS\.MODULE_ID\}/);
  assert.match(mixin, /this\.#debouncedRerenderForSettings\(\)/);
});

test("Classic owns a distinct custom-element tag when official Tidy is active", () => {
  const source = walk(new URL("tidy-classic/src/", root))
    .filter((path) => path.endsWith(".svelte"))
    .map((path) => readFileSync(path, "utf8"))
    .join("\n");
  assert.doesNotMatch(source, /tidy-gold-header-underline/);
  assert.match(source, /tag: 'fe-tidy-classic-gold-underline'/);
  assert.match(read(BUNDLE), /customElements\.define\("fe-tidy-classic-gold-underline"/);
});

test("GM priority and the per-world store both skip tidy keys", () => {
  assert.match(gmPriority, /FE_TIDY_CLASSIC_KEY_PREFIX\s*=\s*"tidyClassic-"/);
  // Both sweeps take every registered client-scope key in our namespace, so BOTH need the
  // guard — not just the GM-priority one.
  const guards = gmPriority.match(/if \(feIsTidyClassicSettingKey\(key\)\) return false;/g);
  assert.equal(guards?.length, 2, "expected the guard in both key filters");
});

test("only Classic sheets are registered, under the agreed label", () => {
  assert.match(main, /CLASSIC_SHEET_LABEL = 'Tidy 5e Sheet-Classic'/);
  // Registering Quadrone too would duplicate every entry tidy5e-sheet 14 already provides.
  assert.doesNotMatch(main, /registerSheet\([^)]*Quadrone/s);
  for (const cls of [
    "Tidy5eCharacterSheet",
    "Tidy5eNpcSheet",
    "Tidy5eVehicleSheet",
    "Tidy5eItemSheetClassic",
    "Tidy5eContainerSheetClassic",
    "Tidy5eGroupSheetClassic",
    "Tidy5eEncounterSheetClassic",
  ]) {
    assert.ok(main.includes(cls), `${cls} is no longer registered`);
  }
});

test("the recovered global stylesheet carries neither scoped nor Quadrone rules", () => {
  const css = read(CSS_GLOBAL);
  // Scoped rules: our build emits its own hashes, so the shipped ones could never match.
  assert.doesNotMatch(css, /\.svelte-[a-zA-Z0-9]{5,}/);
  // Quadrone rules: tidy5e-sheet 14 ships its own and would be fought over the same nodes.
  assert.doesNotMatch(css, /[^a-zA-Z0-9_-]quadrone[^a-zA-Z0-9_-]/);
});

test("tidy's own translations are registered and kept out of the FE one-file rule", () => {
  const tidyLangs = manifest.languages.filter((l) => l.path.startsWith("tidy-classic/"));
  assert.ok(tidyLangs.length >= 1, "tidy translations not registered");
  for (const entry of tidyLangs) {
    assert.ok(existsSync(new URL(entry.path, root)), `${entry.path} missing`);
  }
  const feKo = manifest.languages.filter(
    (l) => l.lang === "ko" && !l.path.startsWith("tidy-classic/"),
  );
  assert.equal(feKo.length, 1, "female_edition's own Korean file must stay single");
});

test("tidy flags never go through core's scope-validating helpers", () => {
  // `getFlagScopes()` accepts only ACTIVE package ids. Our flags stay under
  // `tidy5e-sheet` to preserve existing actor data, but that module is expected to be
  // disabled — it is the one whose Classic layout this fork replaces. Calling
  // `Document#getFlag` there throws inside `_prepareContext` and no sheet renders.
  const flags = read("tidy-classic/src/foundry/TidyFlags.ts");
  assert.doesNotMatch(flags, /flagged\.(get|set|unset)Flag\(/);
  assert.match(flags, /flagged\.flags\?\.\[CONSTANTS\.MODULE_ID\]/);

  // The user-preference services write the same namespace and must route through them.
  for (const p of [
    "tidy-classic/src/features/user-preferences/SheetPreferencesService.ts",
    "tidy-classic/src/features/user-preferences/UserPreferencesService.ts",
  ]) {
    assert.doesNotMatch(read(p), /game\.user\.setFlag\(/, `${p} bypasses TidyFlags`);
  }
});

test("the fork does not whisper Tidy 5e's own announcements", () => {
  // Upstream greeted the GM as Tidy 5e Sheets and, on v14, announced that the Classic
  // sheets had been removed from it. Both are wrong from here: this is not that module,
  // and the Classic sheets are what it exists to keep.
  assert.ok(
    !existsSync(
      new URL("tidy-classic/src/features/notifications/TidyNotificationsManager.ts", root),
    ),
    "the notifications manager is back",
  );
  assert.doesNotMatch(main, /^import .*TidyNotificationsManager/m);
  assert.doesNotMatch(main, /TidyNotificationsManager\.onReady\(\)/);

  // The migration-available whisper is headed with `TIDY5E.ModuleName` and went the same
  // way. Nothing in the fork should post to chat on its own behalf at all.
  assert.doesNotMatch(main, /handleMigrationNotification\(\)/);
  assert.doesNotMatch(main, /ChatMessage\.create/);
});

test("dnd5e 6.0's moved schema paths are read through the compat shim", () => {
  // `system.bonuses.<type>.attack` became `system.rolls.attack.<type>.bonus`, and
  // dnd5e's own `shimBonusData` skips exactly these (`if (!container) continue;`), so a
  // direct read is a TypeError that takes out the whole sheet context.
  const compat = read("tidy-classic/src/foundry/dnd5e-compat.ts");
  assert.match(compat, /rolls\.attack\.\$\{actionType\}\.bonus/);
  assert.match(compat, /bonuses\.\$\{actionType\}\.attack/);

  for (const p of [
    "tidy-classic/src/utils/formula.ts",
    "tidy-classic/src/foundry/foundry-adapter.ts",
    "tidy-classic/src/sheets/quadrone/Tidy5eNpcSheetQuadrone.svelte.ts",
  ]) {
    assert.doesNotMatch(
      read(p).replace(/^\s*(\/\/|\*).*$/gm, ""),
      /bonuses[.?[\]'"\w]*\.(mwak|rwak|msak|rsak)\b/,
      `${p} still reads a 5.x bonus path directly`,
    );
  }
});

test("item rarity is written through the shim, not as system.rarity", () => {
  // 6.0 turned `system.rarity` into a getter over the `system.rarities` SetField. The old
  // key is not in the schema and is dropped silently — the select moves, nothing saves.
  const compat = read("tidy-classic/src/foundry/dnd5e-compat.ts");
  assert.match(compat, /system\.rarities/);
  assert.match(compat, /schema\?\.fields\?\.rarities|schema\.fields\.rarities/);

  // The generic Select has to offer the hook, or the sheets below have nothing to pass.
  const select = read("tidy-classic/src/components/inputs/Select.svelte");
  assert.match(select, /buildUpdate\s*\?\s*buildUpdate\(resolved\)/);

  // `system.rarity` on 6.0 is a PROTOTYPE getter over the set, so it is lost by any
  // structured copy of `system` — the select has to read it off the live document or it
  // falls back to its blank option and every pick looks like it did not stick.
  assert.match(compat, /system\.rarities\?\.first\?\.\(\)/);

  // Upstream folded the per-sheet select into ItemRarityInput: on 6.0 it renders a
  // <multi-select> that writes `system.rarities` directly (the real schema path), and
  // on older systems it falls back to the shim-routed Select. Pin BOTH branches.
  const rarityInput = read("tidy-classic/src/components/inputs/ItemRarityInput.svelte");
  assert.match(rarityInput, /'system\.rarities':\s*el\.value/);
  assert.match(
    rarityInput,
    /field="system\.rarity"\s*\n\s*buildUpdate=\{\(rarity\) => buildItemRarityUpdate/,
  );

  for (const name of [
    "Consumable",
    "Container",
    "Equipment",
    "Loot",
    "Tool",
    "Weapon",
  ]) {
    const sheet = read(`tidy-classic/src/sheets/classic/item/${name}Sheet.svelte`);
    assert.match(
      sheet,
      /<ItemRarityInput\s/,
      `${name}Sheet does not render the shim-routed ItemRarityInput`,
    );
    assert.doesNotMatch(
      sheet,
      /system\.rarity\b|system\.rarities\b/,
      `${name}Sheet wires its own rarity write instead of ItemRarityInput`,
    );
  }
});

test("v14's deprecated relative-UUID method is never called directly", () => {
  // `ClientDocument#getRelativeUUID` forwards to `foundry.utils.buildRelativeUuid` and logs a
  // deprecation every time. The character sheet resolves one per item per `_prepareItems`
  // and every favourite control asks again per render, so it was hundreds of warnings per
  // sheet open. v13 has no `buildRelativeUuid`, hence the probe in core-compat.
  const compat = read("tidy-classic/src/foundry/core-compat.ts");
  assert.match(compat, /foundry\.utils as any\)\.buildRelativeUuid/);

  const offenders = [];
  for (const file of walk(new URL("tidy-classic/src/", root))) {
    if (!/\.(ts|svelte)$/.test(file) || file.endsWith("core-compat.ts")) continue;
    const body = readFileSync(file, "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (!/\.getRelativeUUID\(/.test(line)) continue;
      // Our own two static helpers of the same name are fine; they call through.
      if (/(this|AttributePins|SheetPinsProvider)\.getRelativeUUID\(/.test(line)) continue;
      if (/static getRelativeUUID\(/.test(line)) continue;
      offenders.push(`${file}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], "direct getRelativeUUID calls are back");
});

test("damage-type separators are filtered before the keyed each", () => {
  // dnd5e 6.0's WeaponData#getSheetData interleaves two `{ rule: true }` entries, both
  // without a `value`. Keying the checkbox list on `value` collided on them and Svelte 5
  // aborted the whole details tab with `each_key_duplicate`.
  const field = read("tidy-classic/src/sheets/classic/item/parts/FieldDamage.svelte");
  assert.match(field, /let damageTypeOptions = \$derived\(/);
  assert.match(field, /\{#each damageTypeOptions as \{ value, label, selected \} \(value\)\}/);
  assert.doesNotMatch(field, /\{#each types as /);
});

test("the classic actor sheet's render override tolerates a missing frame", () => {
  // core's _onSheetChange closes the old application and re-renders through the new sheet
  // class, so the override can land with `this.element` already undefined.
  const base = read("tidy-classic/src/sheets/classic/Tidy5eActorSheetClassicV2Base.svelte.ts");
  assert.match(base, /const warning = this\.element\?\.querySelector\(/);
});

test("roll modes never go through the deprecated CONST.DICE_ROLL_MODES", () => {
  // v14 deprecated it (removal in v16) AND changed the values: publicroll/gmroll/blindroll/
  // selfroll became public/gm/blind/self. Every property on the old constant is a logging
  // getter, so one settings pass printed five warnings. v13 accepts only the old names and
  // v14 accepts both, which is why the compat helper probes CONFIG.ChatMessage.modes.
  const compat = read("tidy-classic/src/foundry/core-compat.ts");
  assert.match(compat, /CONFIG as any\)\.ChatMessage\?\.modes/);
  assert.match(compat, /export function normalizeRollMode/);

  const offenders = [];
  for (const file of walk(new URL("tidy-classic/src/", root))) {
    if (!/\.(ts|svelte)$/.test(file) || file.endsWith("core-compat.ts")) continue;
    const body = readFileSync(file, "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (line.includes("DICE_ROLL_MODES")) offenders.push(`${file}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], "CONST.DICE_ROLL_MODES is back");
});

test("forced deletions never use the legacy \"-=key\" spelling", () => {
  // v14 replaced the "-=key": null special key with foundry.data.operators.ForcedDeletion
  // and logs a compatibility warning for the old spelling (removal in v16). v13 has no
  // operators at all, so the probe in core-compat is the only thing that answers on both.
  const compat = read("tidy-classic/src/foundry/core-compat.ts");
  assert.match(compat, /foundry as any\)\.data\?\.operators\?\.ForcedDeletion/);
  assert.match(compat, /export function markDeleted/);
  assert.match(compat, /export function buildDeletion/);

  const offenders = [];
  for (const file of walk(new URL("tidy-classic/src/", root))) {
    if (!/\.(ts|svelte)$/.test(file) || file.endsWith("core-compat.ts")) continue;
    const body = readFileSync(file, "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (/["'`]-=/.test(line)) offenders.push(`${file}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], "a legacy -= deletion key is back");
});

test("movement speeds and sense ranges are read through the dnd5e shim", () => {
  // dnd5e moved both into sub-objects and kept OWN-accessor shims on the old names:
  // senses.<k> -> senses.ranges.<k> (shim removed in dnd5e 6.1) and movement.<k> ->
  // movement.speeds.<k> (removed in 7.0). Both reads are silent today, so the day they
  // stop working every speed and sense just vanishes from the sheet with no error.
  const compat = read("tidy-classic/src/foundry/dnd5e-compat.ts");
  assert.match(compat, /export function getMovementSpeed/);
  assert.match(compat, /export function getSenseRange/);
  assert.match(compat, /export function getSenseLabel/);
  assert.match(compat, /movement\?\.speeds \? movement\.speeds\[key\]/);
  assert.match(compat, /senses\?\.ranges \? senses\.ranges\[key\]/);

  const offenders = [];
  for (const file of walk(new URL("tidy-classic/src/sheets/classic/", root))) {
    if (!/\.(ts|svelte)$/.test(file)) continue;
    const body = readFileSync(file, "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (/\bsenses\[k\w*\]/.test(line)) offenders.push(`${file}:${i + 1} (senses)`);
      if (/\bmovement\.(walk|burrow|climb|fly|jump|swim)\b/.test(line)) {
        offenders.push(`${file}:${i + 1} (movement)`);
      }
    }
  }
  assert.deepEqual(offenders, [], "a classic sheet reads a moved dnd5e path directly");
});

test("the Quadrone-only module integrations are not registered", () => {
  // Tasha's Cauldron and the MCDM Class Bundle exist upstream only to register a QUADRONE
  // item sheet under the shared `TIDY5E.Tidy5eItemSheetQuadrone` label. tidy5e-sheet 14
  // still ships both, so keeping ours would put a second, identically-labelled entry in
  // the sheet picker for the same item type.
  const registry = read("tidy-classic/src/integration/integration.ts");
  for (const name of ["DndTashasCauldron", "McdmClassBundle"]) {
    assert.doesNotMatch(registry, new RegExp(name), `${name} integration is back`);
    assert.equal(
      existsSync(fileURLToPath(new URL(`tidy-classic/src/integration/modules/${name}/`, root))),
      false,
      `${name} source is back`
    );
  }
  // The integrations that stay must not register Quadrone layouts either.
  const drakkenheim = read("tidy-classic/src/integration/modules/Drakkenheim/DrakkenheimCore.ts");
  assert.doesNotMatch(drakkenheim, /'quadrone'/);
});

test("sense labels survive dnd5e 6.0 turning the config into objects", () => {
  // CONFIG.DND5E.senses was `{ darkvision: "<i18n key>" }` on 5.x and is
  // `{ darkvision: { label, detectionMode } }` on 6.0. Upstream passed the value straight
  // to game.i18n.localize, which throws `key.split is not a function` on 6.0 and takes the
  // sheet's whole _prepareContext with it — but only once a sense is non-zero, since the
  // loop skips zeroes. Measured live on dnd5e 6.0.1: a darkvision of 60 was enough.
  const offenders = [];
  for (const file of walk(new URL("tidy-classic/src/sheets/classic/", root))) {
    if (!/\.(ts|svelte)$/.test(file)) continue;
    const body = readFileSync(file, "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (/i18n\.localize\(label\)/.test(line)) offenders.push(`${file}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, [], "a classic sheet localizes a senses config value directly");
});
