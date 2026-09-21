// Tripwires for the battle tracker family. Every assertion here stands for a
// failure that is SILENT in the browser: nothing throws, nothing logs, the feature
// just stops doing one thing.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const ENTRY = read("scripts/fe-combat-tracker.js");
const CORE = read("scripts/fe-combat-tracker-core.js");
const DBP = read("scripts/fe-combat-tracker-dbp.js");
const CSS = read("styles/fe-combat-tracker.css");
const HPMASK = read("scripts/fe-hp-mask.js");
const RUI = read("scripts/fe-dx3rd-resource-ui.js");
const HBS = read("templates/fe-combat-tracker.hbs");

// The entry is the only file that knows the renderer, and core's scheduler is what
// the dbp module and every hook call. Lose the registration and the tracker renders
// once (the direct feCtRender at install) and then never again — no error anywhere.
test("the entry registers its renderer with core's scheduler", () => {
  assert.match(ENTRY, /feCtSetRenderer\(feCtRender\)/);
  assert.match(CORE, /export function feCtSetRenderer\(/);
  assert.match(CORE, /export function feCtScheduleRender\(/);
});

// The whole point of the split. A back-edge would be a cycle, and an ES module
// cycle here resolves to `undefined` bindings at call time rather than an error.
test("the tracker family's imports form a DAG", () => {
  const imports = (src) => [...src.matchAll(/from\s+"\.\/(fe-combat-tracker[\w-]*)\.js"/g)].map((m) => m[1]);
  assert.deepEqual(imports(CORE), [], "core must import nothing from the family");
  assert.deepEqual(imports(DBP), ["fe-combat-tracker-core"]);
  assert.deepEqual(
    [...new Set(imports(ENTRY))].sort(),
    ["fe-combat-tracker-core", "fe-combat-tracker-dbp"]
  );
});

// The dbp module's animation state is its own. Exporting the Maps would put the
// rules about when a stamp is seeded or dropped back in the caller's file, where
// they go stale.
test("the tracker reaches dbp animation state only through the accessors", () => {
  for (const map of ["_dbpAnim", "_dbpPops", "_dbpHit", "_dbpLastHp"]) {
    assert.ok(!ENTRY.includes(map), `${map} must not be referenced from the entry`);
    assert.ok(!new RegExp(`export[^\\n]*\\b${map}\\b`).test(DBP), `${map} must not be exported`);
  }
  for (const fn of ["feDbpPruneState", "feDbpHasHpBaseline", "feDbpSeedHpBaseline", "feDbpHitDelay"]) {
    assert.match(DBP, new RegExp(`export function ${fn}\\(`));
    assert.ok(ENTRY.includes(fn), `${fn} is the entry's only route to that state`);
  }
});

// The strip hangs 40px past its own box at the bottom (the spill that lets the
// active card's glow escape the panel) and is pointer-events:auto, so it covers the
// control bar's row. Without a higher stacking position every button click lands on
// the strip and the panel is dead — and because the covering area is transparent,
// nothing looks wrong.
test("the control bar outranks the strip's spill in the stacking order", () => {
  const rule = (sel) => {
    const i = CSS.indexOf(sel);
    assert.notEqual(i, -1, `${sel} rule not found`);
    return CSS.slice(i, CSS.indexOf("}", i));
  };
  const bar = rule(".fe-ct-controlbar {");
  const strip = rule("#fe-combat-tracker .fe-ct-combatants {");
  const z = (block) => Number(/z-index:\s*(\d+)/.exec(block)?.[1] ?? NaN);
  assert.match(bar, /position:\s*relative/, "z-index needs a positioned box");
  assert.ok(z(bar) > z(strip), `control bar z-index ${z(bar)} must beat the strip's ${z(strip)}`);
});

// Written on the reel instead, the value has to inherit into all 11 digit cells
// every frame — measured at ~6x the style-recalc cost for the same pixels. The
// @property registration is what stops the propagation, and it only helps because
// the value is set on the element that reads it.
test("the dial offset is written on the strip, with inheritance off", () => {
  assert.match(CSS, /@property --fe-dbp-d\s*\{[^}]*inherits:\s*false/);
  assert.match(DBP, /querySelectorAll\("\[data-dbp-roll\] > \.fe-dbp-strip"\)/);
});

// Two renders taken at different moments of the same spin must produce identical
// HTML, or feCtRender's rebuild-skip never fires and the spin stutters again.
test("per-frame dial state stays out of the template", () => {
  // Comments may name it; only emitted markup matters.
  const HBS = read("templates/fe-combat-tracker.hbs").replace(/\{\{!--[\s\S]*?--\}\}/g, "");
  assert.ok(!HBS.includes("--fe-dbp-d"), "the offset must not be emitted into markup");
  assert.match(ENTRY, /if \(html !== _ctLastHtml\)/);
});

// One bit, one flag. The dbp module owning a second actor flag is what let the same
// actor be secret in the tracker and public in the status panel, and the failure is
// silent in the worst way: HP the GM believes is hidden is on screen.
test("hidden HP rides on the shared mask flag, and absent means masked", () => {
  assert.ok(!/(?:get|set|unset)Flag/.test(DBP), "the dbp module must not own an actor flag");
  assert.match(DBP, /import \{ feHpMasked \} from "\.\/fe-hp-mask\.js"/);
  assert.match(RUI, /from "\.\/fe-hp-mask\.js"/);
  // Absent → masked. A `!!getFlag(...)` reader, or revealing by unsetting the flag,
  // would make every untouched actor public.
  assert.match(HPMASK, /getFlag\?\.\(MODULE_ID, FE_HP_MASK_FLAG\) !== false/);
  assert.ok(!HPMASK.includes("unsetFlag"), "revealing must write an explicit false");
  assert.match(HPMASK, /setFlag\(MODULE_ID, FE_HP_MASK_FLAG, next\)/);
});

// The hidden dial's drums are parked on characters the data chooses (all "?", or a
// real leading digit), so a rename of that field renders an empty bezel with no error.
test("the hidden dial's glyphs come from the data", () => {
  const HBS = read("templates/fe-combat-tracker.hbs").replace(/\{\{!--[\s\S]*?--\}\}/g, "");
  assert.match(HBS, /\{\{#each dbp\.hp\.glyphs\}\}/);
  assert.match(DBP, /glyphs,/);
  // The hidden dial keeps the revealed dial's width, so the reading never jumps when an
  // actor is revealed or a spin starts — and the digit-count hint keeps working on a 4-
  // or 5-drum dial instead of going silent above 99.
  assert.match(DBP, /feDbpHiddenCells\(raw\.value, feDbpDigits\(raw\.max\)\)/);
  assert.match(DBP, /new Array\(glyphs\.length\)\.fill\("\?"\)/, "max drums follow the value drums");
  assert.match(DBP, /new Array\(digits\)\.fill\("\?"\)/);
  // The partial-reveal mode may only ever write a literal "0" — the drums it opens are
  // the leading zeros ABOVE the value's own digits, so writing anything derived from the
  // value there would leak the value itself.
  const fn = DBP.slice(DBP.indexOf("function feDbpHiddenCells"));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.deepEqual([...body.matchAll(/cells\[[^\]]+\]\s*=\s*([^;]+);/g)].map((m) => m[1]), ['"0"']);
});

// feCtSetting falls back to FE_DEFAULTS on a throw, so a key the family reads but never
// registers reads its default forever: the checkbox saves, nothing happens, no error.
test("every tracker setting the family reads is registered by the entry", () => {
  const keys = new Set();
  for (const src of [ENTRY, CORE, DBP]) {
    for (const [, key] of src.matchAll(/feCtSetting\(S\.([A-Z_]+)/g)) keys.add(key);
  }
  assert.ok(keys.size > 5);
  const registered = new Set([...ENTRY.matchAll(/feRegisterSetting\(S\.([A-Z_]+)/g)].map((m) => m[1]));
  for (const key of keys) assert.ok(registered.has(key), `S.${key} is read but never registered`);
});

// The plain HP bar and the dial are two disclosures of the same secret. The bar used to
// draw the exact ratio for a masked actor while the dial beside it said nothing.
test("the plain HP bar respects the per-actor mask", () => {
  assert.match(ENTRY, /function feCtShowHpBar\(/);
  assert.match(ENTRY, /hp: feCtShowHpBar\(c\.actor\) \?/);
  const fn = ENTRY.slice(ENTRY.indexOf("function feCtShowHpBar("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /feHpMasked\(actor\)/);
  assert.match(body, /S\.COMBAT_TRACKER_HIDDEN_PARTIAL/);
});

// The row used to be gated on `dbp.effects.length`, so the first condition applied to
// a combatant INSERTED it and the card grew mid-combat. Nothing throws if the guard
// comes back — the layout just starts jumping again on a hook nobody is watching.
test("the status row is reserved whether or not there are effects", () => {
  const HBS = read("templates/fe-combat-tracker.hbs").replace(/\{\{!--[\s\S]*?--\}\}/g, "");
  assert.ok(!HBS.includes("dbp.effects.length"), "the effects row must not be conditional");
  assert.match(HBS, /<div class="fe-dbp-effects">/);
  assert.match(CSS, /\.fe-dbp-effects \{[^}]*min-height:\s*var\(--fe-dbp-icon/);
});

// The active card's zoom grows downward into the strip's bottom spill; the anchor is
// the translate that puts it there. The hit shake replaces the whole transform
// property, so a keyframe that forgets the anchor snaps the card back to a centred
// zoom for the length of the hit — 460ms of the card jumping, with no error.
test("the active card's zoom is anchored, in the rule and in every shake keyframe", () => {
  assert.match(CSS, /--fe-ct-zoom-anchor:\s*-4\.545%/);
  const zoomed = [...CSS.matchAll(/scale\(var\(--fe-ct-zoom[^)]*\)\)(\s*translateY\(var\(--fe-ct-zoom-anchor)?/g)];
  assert.ok(zoomed.length >= 9, `expected every zoom composition, found ${zoomed.length}`);
  for (const m of zoomed) assert.ok(m[1], "a zoom composition without the anchor");
});

// pixel-border.png is sliced at 10px. Rendering the border at any other width
// resamples the slashes and the frame comes apart — the failure is purely visual,
// and it looked "close enough" at 8px for a long time.
test("the retro pixel frame is drawn 1:1 with its own slice", () => {
  const i = CSS.indexOf(".fe-ct-combatants-wrap::after");
  assert.notEqual(i, -1);
  const block = CSS.slice(i, CSS.indexOf("}", i));
  const slice = /border-image:[^;]*\.png"\)\s*(\d+)\s*\/\s*(\d+)px/.exec(block);
  assert.ok(slice, "border-image shorthand not found");
  assert.equal(slice[1], slice[2], "slice and render width must match");
  assert.equal(slice[2], "10", "pixel-border.png is sliced at 10px");
  assert.match(block, /border: 10px solid/);
  assert.match(block, /inset: -10px/);
});

// Retro drums are shaded with doubled-position stops so every band is flat. A single
// position anywhere turns that band back into a ramp and the pixel look is gone.
test("the retro dial's shading is stepped, not interpolated", () => {
  const i = CSS.indexOf("body.fe-retro-theme .fe-dbp-reel {");
  assert.notEqual(i, -1, "the retro reel rule is missing");
  const block = CSS.slice(i, CSS.indexOf("\n}", i));
  // Depth-aware split: a stop's colour is a var(--fe-ac-NN, #hex), which carries its
  // own comma, so a plain split on "," would cut the stops in half.
  const open = block.indexOf("linear-gradient(");
  assert.notEqual(open, -1, "the drum face must still be painted by a gradient");
  const parts = [];
  let depth = 0;
  let current = "";
  for (const ch of block.slice(block.indexOf("(", open) + 1)) {
    if (ch === "(") depth++;
    else if (ch === ")") {
      if (depth === 0) break;
      depth--;
    }
    if (ch === "," && depth === 0) { parts.push(current); current = ""; }
    else current += ch;
  }
  parts.push(current);
  const stops = parts.slice(1).map((part) => part.trim()).filter(Boolean);
  assert.equal(stops.length, 5, "the cylinder is five flat bands: dark/mid/lit/mid/dark");
  for (const stop of stops) {
    const positions = stop
      .replace(/var\([^)]*\)|transparent|#[0-9a-f]+/gi, "")
      .trim().split(/\s+/).filter(Boolean);
    assert.equal(positions.length, 2, `a stop with one position ramps across its band: ${stop}`);
  }
});


// The status panel stands down while the tracker shows HP. Every part of this is
// silent if it breaks: the predicate lives in core (importing the ENTRY from the panel
// would be a cycle, and an ES-module cycle resolves to undefined bindings rather than
// to an error), and the live toggle rides a hook because feRegisterSetting takes
// exactly ONE onChange per key — the tracker already owns those keys, so without the
// hook the panel would not come back until a reload.
test("the status panel yields to the tracker through core, not through the entry", () => {
  assert.match(CORE, /export function feCtDisplaysHp\(/);
  const fn = CORE.slice(CORE.indexOf("export function feCtDisplaysHp("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /feCtEnabled\(\)/, "a tracker that is off is not showing anything");
  assert.match(body, /feCtOriginalActive\(\)/, "nor is one that yielded to Carousel");
  assert.match(body, /S\.COMBAT_TRACKER_SHOW_HP/);
  assert.match(body, /feCtDbpEnabled\(\)/);

  assert.match(RUI, /from "\.\/fe-combat-tracker-core\.js"/);
  assert.ok(
    !/from "\.\/fe-combat-tracker(-dbp)?\.js"/.test(RUI),
    "the panel must import the FLOOR only — the entry would be a cycle"
  );
  assert.match(RUI, /S\.DX3RD_RUI_YIELD_TO_TRACKER/);
  assert.match(RUI, /combatTrackerHpDisplay/, "the live toggle needs the tracker's hook");
  // The stand-down is TEMPORARY: it lasts the encounter and no longer, so the panel has
  // to follow the combat's whole life, and it may not rebuild every card on hooks that
  // fire per turn when the answer has not moved.
  assert.match(CORE, /export function feCtCombatOnScreen\(/);
  assert.match(body, /feCtCombatOnScreen\(\)/, "the yield must end when the combat does");
  for (const hook of ["createCombat", "deleteCombat", "updateCombat",
    "createCombatant", "deleteCombatant"]) {
    assert.ok(RUI.includes(`"${hook}"`), `${hook} must reach the yield sync`);
  }
  assert.match(RUI, /if \(yielding === _ruiYieldState\) return;/, "per-turn rebuilds must be dropped");
  assert.match(ENTRY, /Hooks\.callAll\(FE_CT_HP_DISPLAY_HOOK\)/);
  // Every setting feCtDisplaysHp reads has to announce itself, or the panel's answer
  // goes stale until reload.
  for (const key of ["COMBAT_TRACKER_ENABLED", "COMBAT_TRACKER_SHOW_HP",
    "COMBAT_TRACKER_DYNAMIC_PORTRAIT", "COMBAT_TRACKER_ASPECT"]) {
    const at = ENTRY.indexOf(`feRegisterSetting(S.${key},`);
    assert.notEqual(at, -1, key);
    const next = ENTRY.indexOf("feRegisterSetting(", at + 1);
    const handler = ENTRY.slice(at, next === -1 ? undefined : next);
    assert.ok(
      /feCtHpDisplayChanged|FE_CT_HP_DISPLAY_HOOK/.test(handler),
      `${key} changes feCtDisplaysHp's answer but never announces it`
    );
  }
});

// The bar style replaces the dial outright: the dial is the ELSE branch (so the two can
// never both be drawn), and the plain bar under the portrait stands down as well rather
// than saying the same thing twice, less precisely.
test("the bar HP style short-circuits the dial", () => {
  const HBS = read("templates/fe-combat-tracker.hbs").replace(/\{\{!--[\s\S]*?--\}\}/g, "");
  assert.match(HBS, /\{\{#if dbp\.hp\.bar\}\}/);
  assert.match(HBS, /\{\{else if dbp\.hp\}\}/, "the dial must become the else branch, not a sibling");
  assert.match(HBS, /--fe-dbp-bar-pct:\{\{dbp\.hp\.pct\}\}%/);
  assert.match(CSS, /\.fe-dbp-bar-fill \{[\s\S]*?width:\s*var\(--fe-dbp-bar-hold, var\(--fe-dbp-bar-pct/);
  assert.match(CORE, /export function feCtDbpHpStyle\(/);

  const fn = ENTRY.slice(ENTRY.indexOf("function feCtShowHpBar("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /feCtDbpHpStyle\(\) === "bar"/, "the plain bar must yield to the panel's bar");
});

// The bar has its own animation, and it is the DIAL's contract with a different
// applier: nothing about an animation's progress may live in the markup, or a render
// fired by an unrelated hook would freeze the reading at whatever the template last
// said. Which applier owns a running animation is captured on the entry, not read per
// frame, so switching the style mid-animation cannot orphan it.
test("the bar's roll follows the dial's contract, and locks left to right", () => {
  const HBS = read("templates/fe-combat-tracker.hbs").replace(/\{\{!--[\s\S]*?--\}\}/g, "");
  assert.match(HBS, /data-dbp-bar-roll="1"/);
  assert.match(HBS, /class="fe-dbp-bar-cur">\{\{dbp\.hp\.cur\}\}<\/span>\{\{dbp\.hp\.rest\}\}/);

  const anim = DBP.slice(DBP.indexOf("function feDbpBeginHpAnim("));
  const animBody = anim.slice(0, anim.indexOf("\n}"));
  assert.match(animBody, /bar: feCtDbpHpStyle\(\) === "bar"/, "the applier must be captured on the entry");

  // 0.27s between locks, leftmost first: j = 0 gets the EARLIEST lock time, so the
  // multiplier has to count down from the end of the string, not up from its start.
  // `length - j` rather than `length - 1 - j` leaves the rightmost place one whole
  // interval of settled reading before the closing rerender replaces the node.
  assert.match(DBP, /const DBP_BAR_LOCK_MS = 270;/);
  assert.match(
    DBP,
    /anim\.dur - \(target\.length - j\) \* DBP_BAR_LOCK_MS/,
    "the lock schedule must run left to right and finish before the clock does"
  );

  // Purity. A Math.random() in the scramble would re-roll every digit on any frame a
  // render happened to land on, which reads as a stutter rather than as a scramble.
  const roll = DBP.slice(DBP.indexOf("function feDbpBarDigit("), DBP.indexOf("function feDbpBarFillAt("));
  assert.ok(!roll.includes("Math.random"), "the scramble must be a pure function of (anim, now)");

  // Both drive points. The ticker is the per-frame one; the render one is what stops a
  // bar rebuilt mid-animation from painting its resting reading for a frame.
  assert.match(DBP, /if \(bars\) \{/);
  assert.match(DBP, /feDbpApplyBarRoll\(root, now\)/);
  assert.match(ENTRY, /feDbpApplyBarRoll\(root, nowMs\)/);
  // The end of the animation has to come back through a rerender: that is what drops
  // the marker and hands the caption back to the template.
  assert.match(DBP, /if \(anim\.hidden \|\| anim\.bar\) needRender = true;/);
  // The fill's hold may not be written into the property the TEMPLATE owns: they share
  // one style attribute, so the hold would destroy the resting value it falls back to.
  assert.ok(
    !/setProperty\("--fe-dbp-bar-pct"/.test(DBP),
    "the fill hold must not clobber the template's resting percentage"
  );
});

// The bar is a second disclosure of the same secret, so it may not invent its own
// policy: the dial's leading-zero rule and the plain bar's ratio rule are both the one
// partial-disclosure setting, and a bar drawn full for a masked actor would hand out
// exactly what the dial beside it is carefully withholding.
test("the bar HP style reuses the dial's secrecy policy", () => {
  const fn = DBP.slice(DBP.indexOf("function feDbpBarHp("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  assert.match(body, /S\.COMBAT_TRACKER_HIDDEN_PARTIAL/);
  assert.match(body, /feDbpHiddenCells\(/, "the caption must come from the dial's own cells");
  assert.match(body, /pct: partial \? raw\.pct : 0/, "no fill without partial disclosure");
  assert.match(body, /anim\?\.hidden === true/, "a spin that started hidden stays hidden");
});

// ONE separator, in three places that cannot see each other: the dial's glyph drum
// (markup), the bar's caption (JS) and the ink metric's glyph set (JS). A solidus
// reads as a 7 at dial size in several of the faces this module ships with, so the
// character itself is the fix — and a file left behind would show the old one right
// next to the new one.
test("the value/max separator is one character, shared by both readings", () => {
  const sep = "·";
  assert.match(DBP, /const DBP_SEP = "·";/, "the separator must be a named constant");
  assert.ok(
    DBP.includes("rest: `${DBP_SEP}${Math.round(raw.max)}`"),
    "the bar caption must read the constant"
  );
  assert.ok(
    DBP.includes('const DBP_INK_GLYPHS = DBP_SEP + "?";'),
    "the ink metric must measure the separator the dial actually shows"
  );
  assert.ok(
    HBS.includes(`<span class="fe-dbp-reel is-glyph"><span class="fe-dbp-strip"><span>${sep}</span></span></span>`),
    "the dial's glyph drum must carry the same character"
  );
  assert.ok(!/rest: `\//.test(DBP), "no solidus left in a caption");
});

// The per-actor mask is ONE flag with two doors (the status panel's sheet button and
// this menu). GM only: an entry a player could see would advertise that there is
// something to hide, and the flag governs the status panel too, so a player toggle
// would hand them the numbers outright.
test("the combatant menu can toggle the actor's HP mask, GM only", () => {
  assert.match(ENTRY, /import \{ feHpMasked, feToggleHpMask \} from "\.\/fe-hp-mask\.js";/);
  assert.match(ENTRY, /action: "toggle-hp-mask"/);
  const at = ENTRY.indexOf('action: "toggle-hp-mask"');
  const before = ENTRY.slice(Math.max(0, at - 400), at);
  assert.match(before, /if \(isGM && c\.actor\)/, "the entry must be gated on the GM and on an actor");
  assert.match(before, /feHpMasked\(c\.actor\)/, "the label must follow the current state");
  assert.match(ENTRY, /case "toggle-hp-mask":\s*await feToggleHpMask\(c\.actor\);/);
  // One flag, one writer — the menu may not grow its own.
  assert.match(HPMASK, /export async function feToggleHpMask\(/);
});
