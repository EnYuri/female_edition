// dx3rd-fvtt (LichSOMA) is a SEPARATE system from the emanim lineage that
// FE_DX3RD_SYSTEM_IDS serves — it only shares the game's roots. These tests pin
// that separation: it must never join the family gate, it opts into individual
// features on its own, and the one shared stylesheet surface (fe-dx3rd-compat.css
// §13/§14, core chat DOM only) is the only place both scope classes meet.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  FE_DX3RD_SYSTEM_IDS,
  FE_DX3RD_FVTT_SYSTEM_ID,
  S,
  feIsDx3rdFvttSystemId,
  feIsDx3rdSystemId,
} from "../scripts/fe-constants.js";
import { feMessageHasChatCardContent } from "../scripts/fe-render-state.js";
import { feSetRetroThemeClass } from "../scripts/fe-style.js";
import { feIsSystemCombatNoticeContent } from "../scripts/fe-util.js";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const DX3RD_COMPAT_CSS = read("../styles/fe-dx3rd-compat.css");
const FVTT_COMPAT_CSS = read("../styles/fe-dx3rd-fvtt-compat.css");
const MODULE_JSON = JSON.parse(read("../module.json"));
const TRACKER_JS = read("../scripts/fe-combat-tracker.js");
const RUI_JS = read("../scripts/fe-dx3rd-resource-ui.js");
const PORTRAIT_JS = read("../scripts/fe-chat-portrait.js");
const CHAT_ENHANCE_JS = read("../scripts/fe-chat-enhance.js");

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

function applyScopeClasses(systemId, retro) {
  globalThis.game = {
    system: { id: systemId },
    user: { isGM: true },
    settings: { get: (_moduleId, key) => (key === S.UI_RETRO_THEME ? retro : false) },
  };
  const classList = fakeClassList();
  feSetRetroThemeClass({ body: { classList } });
  return classList;
}

test("dx3rd-fvtt is its own system, never a member of the emanim family gate", () => {
  assert.equal(FE_DX3RD_FVTT_SYSTEM_ID, "dx3rd-fvtt");
  assert.equal(FE_DX3RD_SYSTEM_IDS.includes("dx3rd-fvtt"), false);
  assert.equal(feIsDx3rdSystemId("dx3rd-fvtt"), false);
  assert.equal(feIsDx3rdFvttSystemId("dx3rd-fvtt"), true);
  for (const id of FE_DX3RD_SYSTEM_IDS) assert.equal(feIsDx3rdFvttSystemId(id), false, id);
  assert.equal(feIsDx3rdFvttSystemId(null), false);
});

test("dx3rd-fvtt gets its own scope classes, not the emanim retro marker", () => {
  const retro = applyScopeClasses("dx3rd-fvtt", true);
  assert.equal(retro.contains("fe-retro-system-dx3rd-fvtt"), true);
  assert.equal(retro.contains("fe-system-dx3rd-fvtt"), true);
  assert.equal(retro.contains("fe-retro-system-dx3rd"), false);

  // The light-base re-ink (§A) must work with retro OFF.
  const plain = applyScopeClasses("dx3rd-fvtt", false);
  assert.equal(plain.contains("fe-system-dx3rd-fvtt"), true);
  assert.equal(plain.contains("fe-retro-system-dx3rd-fvtt"), false);

  // …and the emanim lineage never picks up the fvtt classes.
  const emanim = applyScopeClasses("dx3rd-emanim", true);
  assert.equal(emanim.contains("fe-retro-system-dx3rd"), true);
  assert.equal(emanim.contains("fe-retro-system-dx3rd-fvtt"), false);
  assert.equal(emanim.contains("fe-system-dx3rd-fvtt"), false);
});

test("dx3rd-fvtt item cards and info boxes are chat cards; BEM children alone are not", () => {
  assert.equal(feMessageHasChatCardContent('<div class="dx3rd-box" data-dx3rd-box-id="x"></div>'), true);
  assert.equal(feMessageHasChatCardContent('<div class="dx3rd-info dx3rd-info--error"></div>'), true);
  assert.equal(feMessageHasChatCardContent('<span class="dx3rd-box__head"></span>'), false);
  assert.equal(feMessageHasChatCardContent('<span class="dx3rd-info__text"></span>'), false);
});

test("dx3rd-fvtt system / scene notices are classified like the combat notices", () => {
  globalThis.game = { system: { id: "dx3rd-fvtt" } };
  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-combat-msg">Round 1</div>'), true);
  assert.equal(
    feIsSystemCombatNoticeContent('<div class="dx3rd-system dx3rd-system--hp-damage"><div class="dx3rd-system__body"></div></div>'),
    true,
  );
  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-open-scene-msg"><div class="dx3rd-open-scene-msg__title">A</div></div>'), true);
  // A BEM child on its own, or the `li` marker class, is not the notice root.
  assert.equal(feIsSystemCombatNoticeContent('<span class="dx3rd-system__text">x</span>'), false);
  assert.equal(feIsSystemCombatNoticeContent('<li class="dx3rd-system-message"></li>'), false);
  assert.equal(feIsSystemCombatNoticeContent('<div class="dx3rd-info">x</div>'), false);
});

test("the import-free portrait copy lists the same notice classes", () => {
  for (const cls of ["dx3rd-system", "dx3rd-open-scene-msg"]) {
    assert.match(PORTRAIT_JS, new RegExp(`"${cls}",`));
  }
  assert.match(PORTRAIT_JS, /CP_SYSTEM_COMBAT_NOTICE_CONTENT_RE\s*=\s*\n\s*\/<\[\^>\]\*\\b\(\?:dx3rd-combat-\(\?:msg\|start-msg\|end-msg\)\|dx3rd-system\|dx3rd-open-scene-msg\)\(\?=\["'\\s\]\)\/i;/);
});

test("only fe-dx3rd-compat.css §13/§14 (core chat DOM) carry the fvtt scope class", () => {
  const start = DX3RD_COMPAT_CSS.indexOf(" * § 13  accent color variables");
  const end = DX3RD_COMPAT_CSS.indexOf(" * § 15  chat cards");
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const shared = DX3RD_COMPAT_CSS.slice(start, end);

  // Every emanim retro selector in the shared range also names the fvtt class.
  assert.equal(/body\.fe-retro-theme\.fe-retro-system-dx3rd\b/.test(shared), false);
  assert.match(shared, /body\.fe-retro-theme:is\(\.fe-retro-system-dx3rd, \.fe-retro-system-dx3rd-fvtt\)/);

  // Outside it, the fvtt class must not appear in a selector (comments aside).
  const outside = (DX3RD_COMPAT_CSS.slice(0, start) + DX3RD_COMPAT_CSS.slice(end)).replace(/\/\*[\s\S]*?\*\//g, "");
  assert.equal(outside.includes("dx3rd-fvtt"), false);
});

test("fe-dx3rd-fvtt-compat.css is layered and never reads emanim markup", () => {
  const entry = MODULE_JSON.styles.find((s) => (s?.src ?? s) === "styles/fe-dx3rd-fvtt-compat.css");
  assert.deepEqual(entry, { src: "styles/fe-dx3rd-fvtt-compat.css", layer: "layouts" });

  const rules = FVTT_COMPAT_CSS.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const foreign of [".dx3rd-emanim", ".double-cross-3rd", ".dx3rd-item-chat", ".dx3rd-item-info", "fe-retro-system-dx3rd "]) {
    assert.equal(rules.includes(foreign), false, foreign);
  }
  // Every rule is scoped to one of this system's own body classes.
  for (const block of rules.split("}").map((b) => b.trim()).filter(Boolean)) {
    const selector = block.slice(0, block.indexOf("{"));
    for (const part of selector.split(/,\s*\n\s*body/)) {
      assert.match(part, /fe-(?:retro-)?system-dx3rd-fvtt/, part.trim().slice(0, 80));
    }
  }
});

test("§A re-inks only messages that actually sit on a painted light base", () => {
  const a1 = FVTT_COMPAT_CSS.slice(FVTT_COMPAT_CSS.indexOf("/* A1"), FVTT_COMPAT_CSS.indexOf("/* A2"));
  // Painted chat base = .fe-has-user-color and not a round marker (chat-bg-stripper §1f).
  assert.match(a1, /\.fe-chat-bg-light:not\(\.fe-retro-theme\)/);
  assert.match(a1, /\.fe-has-user-color:not\(\.fe-system-msg\)/);
  assert.match(a1, /\.fe-sysmsg-bg-light:not\(\.fe-retro-theme\)/);
  assert.equal((a1.match(/:not\(\.fe-round-marker-chat\)/g) ?? []).length, 2);
  // Notices are round markers → never painted → never re-inked by §A.
  const sectionA = FVTT_COMPAT_CSS.slice(FVTT_COMPAT_CSS.indexOf("/* A1"), FVTT_COMPAT_CSS.indexOf(" * § B"));
  const ruleText = sectionA.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const notice of [".dx3rd-system", ".dx3rd-combat-msg", ".dx3rd-open-scene-msg"]) {
    assert.equal(ruleText.includes(notice), false, notice);
  }
});

test("GM speak-as-self leaves dx3rd-fvtt's own (roll-less) messages' speaker alone", () => {
  // Pseudo-roll judgments have no rolls but their buttons read speaker.actor.
  const fn = CHAT_ENHANCE_JS.slice(
    CHAT_ENHANCE_JS.indexOf("function feApplyGmSpeakAsSelf"),
    CHAT_ENHANCE_JS.indexOf("message.updateSource({ speaker:"),
  );
  assert.match(fn, /if \(feIsDx3rdFvttSystemId\(game\.system\?\.id\)\) \{/);
  assert.match(fn, /data\?\.flags\?\.\[FE_DX3RD_FVTT_SYSTEM_ID\] \?\? message\?\.flags\?\.\[FE_DX3RD_FVTT_SYSTEM_ID\]/);
  // …and the skip runs BEFORE the rolls guard, which cannot cover a roll-less message.
  assert.ok(fn.indexOf("FE_DX3RD_FVTT_SYSTEM_ID]") < fn.indexOf("msgRolls.length > 0 && speaker?.actor"));
});

test("features opt dx3rd-fvtt in individually", () => {
  // Battle tracker: its nextTurn opens a player-local action-end dialog.
  assert.match(
    TRACKER_JS,
    /function feCtUsesLocalPlayerTurnEndWorkflow\(\) \{\s*const systemId = game\.system\?\.id;\s*return feIsDx3rdSystemId\(systemId\) \|\| feIsDx3rdFvttSystemId\(systemId\);/,
  );
  // Status panel, with the system's own nominal encroachment max.
  assert.match(RUI_JS, /function _isSupported\(\)\s*\{ return _isDx3rd\(\) \|\| _isDx3rdFvtt\(\) \|\| _isDnd5e\(\); \}/);
  assert.match(RUI_JS, /const max = _isDx3rdFvtt\(\) \? Number\(e\.max\) : NaN;/);
});
