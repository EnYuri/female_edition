// Tripwires for LANCER support. None of these fail loudly in the browser: a lost
// scope class, a missing `!important` on a palette variable or an unmatched card
// root all just leave LANCER looking the way it did before, with no error.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { FE_LANCER_SYSTEM_IDS, S, feIsLancerSystemId } from "../scripts/fe-constants.js";
import { feMessageHasChatCardContent } from "../scripts/fe-render-state.js";
import { feSetRetroThemeClass } from "../scripts/fe-style.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const COMPAT_CSS = read("styles/fe-lancer-compat.css");
const FONT_CSS = read("styles/ui-font.css");
const MANIFEST = JSON.parse(read("module.json"));
const TRACKER = read("scripts/fe-combat-tracker.js");
const TRACKER_HBS = read("templates/fe-combat-tracker.hbs");
const KO = JSON.parse(read("lang/ko.json"));

const ORIGINAL_GAME = globalThis.game;
afterEach(() => {
  if (ORIGINAL_GAME === undefined) delete globalThis.game;
  else globalThis.game = ORIGINAL_GAME;
});

function fakeClassList() {
  const values = new Set();
  return {
    contains: (value) => values.has(value),
    toggle(value, force) {
      if (force) values.add(value);
      else values.delete(value);
    },
  };
}

function runRetroClass(systemId, retro) {
  globalThis.game = {
    system: { id: systemId },
    user: { isGM: true },
    settings: { get: (_moduleId, key) => (key === S.UI_RETRO_THEME ? retro : undefined) },
  };
  const classList = fakeClassList();
  feSetRetroThemeClass({ body: { classList } });
  return classList;
}

test("the LANCER gate matches only the lancer package", () => {
  assert.deepEqual(FE_LANCER_SYSTEM_IDS, ["lancer"]);
  assert.equal(feIsLancerSystemId("lancer"), true);
  assert.equal(feIsLancerSystemId("dnd5e"), false);
  assert.equal(feIsLancerSystemId(null), false);
});

// fe-system-lancer carries the font variables, the chat ink and the archive mirror,
// all of which must work with retro OFF.
test("fe-system-lancer is retro-independent; fe-retro-system-lancer is retro-gated", () => {
  const off = runRetroClass("lancer", false);
  assert.equal(off.contains("fe-system-lancer"), true);
  assert.equal(off.contains("fe-retro-system-lancer"), false);

  const on = runRetroClass("lancer", true);
  assert.equal(on.contains("fe-system-lancer"), true);
  assert.equal(on.contains("fe-retro-system-lancer"), true);

  const other = runRetroClass("dnd5e", true);
  assert.equal(other.contains("fe-system-lancer"), false);
  assert.equal(other.contains("fe-retro-system-lancer"), false);
});

// LANCER's palette is NORMAL declarations in layer(system). From any other layer,
// or without !important, a re-declared variable simply loses.
test("the compat sheet is layered as layouts and its palette variables are !important", () => {
  const entry = MANIFEST.styles.find((s) => (s?.src ?? s) === "styles/fe-lancer-compat.css");
  assert.ok(entry, "fe-lancer-compat.css is not registered in module.json");
  assert.equal(entry.layer, "layouts");

  const start = COMPAT_CSS.indexOf("body.fe-retro-theme.fe-retro-system-lancer {");
  assert.notEqual(start, -1);
  const block = COMPAT_CSS.slice(start, COMPAT_CSS.indexOf("}", start));
  for (const v of ["--primary-color", "--light-text", "--dark-text", "--background-color", "--lancer-light-app-bg", "--darken-1"]) {
    assert.match(block, new RegExp(`${v}:[^;]+!important;`), `${v} lost its !important`);
  }
});

test("the LANCER font variables are re-pointed with !important and honour the card-font toggle", () => {
  assert.match(FONT_CSS, /body\.fe-fonts-enabled\.fe-system-lancer \{\s*--header-font-family: var\(--fe-font-primary\) !important;\s*--main-font-family: var\(--fe-ui-font-family\) !important;/);
  assert.match(FONT_CSS, /\.fe-system-lancer:not\(\.fe-chatcard-custom-font\)[\s\S]{0,200}\.message-content > \.card:is\(\.clipped, \.clipped-bot, \.clipped-top\)/);
  assert.match(FONT_CSS, /\.fe-system-lancer\.fe-chatcard-custom-font[\s\S]{0,200}\.message-content > \.card:is\(\.clipped, \.clipped-bot, \.clipped-top\)/);
});

// LANCER's compcon `!important` lives in layer(system), which every layouts-layer
// `!important` of ours outranks. Without §6b, `fas cci …` (token-tooltip-alt) and
// `<button class="icon cci …">` (LANCER's tracker) paint CookieRun's boxed-X .notdef.
test("LANCER icon fonts are restored after the FA rule, above the button-inherit rule", () => {
  const sec = FONT_CSS.indexOf("6b) Non-FA icon fonts");
  assert.ok(sec > FONT_CSS.indexOf("6) Font Awesome icon fixes"), "§6b must come after §6 (equal-tier ties go to the later rule)");
  const body = FONT_CSS.slice(sec);
  assert.match(body, /:is\(\[class\^="cci-"\], \[class\*=" cci-"\]\)\[class\]\[class\]::before[\s\S]{0,200}font-family: "compcon" !important;/);
  assert.match(body, /:is\(\.mdi, \.mdi-set\)\[class\]\[class\]::before[\s\S]{0,120}font-family: "Material Design Icons" !important;/);
  // Same host-only shape, same two paths (tidy-classic / betternpcsheet5e).
  assert.match(body, /\.ra\[class\]\[class\]::before[\s\S]{0,120}font-family: "RPGAwesome" !important;/);
  // §6 folds duotone into classic, which flattens core's two-tone icons.
  assert.match(body, /:is\(\.fa-duotone, \.fad\)\[class\]::after[\s\S]{0,80}var\(--fa-family-duotone,/);
  // The archive's ungated `.chat-message *` rule takes `.ra` too.
  assert.match(read("styles/fe-chat-archive.css"), /#fe-chat-export-container \.ra \{\s*font-family: "RPGAwesome" !important;/);
});

// Every templates/chat/*.hbs root in LANCER 3.x is one of these three.
test("LANCER card roots classify as chat cards; a bare .card does not", () => {
  for (const cls of ["card clipped", "card clipped-bot", "card clipped-top"]) {
    assert.equal(feMessageHasChatCardContent(`<div class="${cls}" style="margin: 0px;">x</div>`), true, cls);
  }
  assert.equal(feMessageHasChatCardContent(`<div class="card">x</div>`), false);
  assert.equal(feMessageHasChatCardContent(`<div class="cardboard clipped">x</div>`), false);
});

test("the battle tracker adapts to LANCER activations", () => {
  // The activate overlay exists and is wired to the click and dblclick guards.
  assert.match(TRACKER_HBS, /\{\{#if canActivate\}\}[\s\S]*data-ct-activate="1"/);
  assert.match(TRACKER, /closest\?\.\("\[data-ct-activate\]"\)[\s\S]{0,200}feCtActivateFor/);
  assert.match(TRACKER, /if \(ev\.target\.closest\?\.\("\[data-ct-activate\]"\)\) return;/);
  // It shares ">>"'s spot and belongs only to the current-round card.
  assert.match(TRACKER, /canActivate: !roundOffset && !canEndTurn && feCtCanActivate\(/);
  // Only while nobody is active — the system's own `turn: null` state.
  assert.match(TRACKER, /if \(combat\.turn !== null && combat\.turn !== undefined\) return false;/);
  // Initiative is forced to 0 there, so its menu entries are withheld.
  assert.match(TRACKER, /if \(isGM && !lancer\) items\.push\(\s*\{ action: "set-initiative"/);
  assert.ok(KO["FECT.Ctx.Activate"]);
});
