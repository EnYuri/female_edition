// Tripwire: the archive document must receive every document-scoped style toggle.
//
// THE BUG THIS EXISTS FOR (found 2026-09-20). `feRenderChatArchiveWindow` kept its
// OWN hand-maintained copy of the toggle list that `feApplyVisualSettingsToDocument`
// applies to the live document. The two drifted: the archive's copy was missing
// `feSetHideMsgBorderUserColorClass` and `feSetForceNormalMsgColorClass`, while the
// CSS for BOTH of those classes names `#fe-chat-export-log` explicitly — i.e. the
// rules were written to cover the archive and had been dead there ever since.
//
// The list is now single-sourced as `feApplyStyleClassesToDocument`. These tests pin
// the invariant itself rather than the list, so a NEW toggle whose CSS reaches the
// archive cannot be added to only one place.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const STYLE_JS = read("scripts/fe-style.js");
const ENHANCE_JS = read("scripts/fe-chat-enhance.js");
const ARCHIVE_JS = read("scripts/fe-chat-archive.js");

/** Every `body.fe-*` class whose CSS rule targets the archive log. */
function archiveTargetedBodyClasses() {
  const out = new Map(); // class -> Set<stylesheet>
  const dir = new URL("../styles/", import.meta.url);
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".css"))) {
    const css = readFileSync(new URL(file, dir), "utf8");
    // every selector block (text up to its "{") that mentions the archive log
    for (const sel of css.matchAll(/[^{}]*#fe-chat-export-log[^{}]*\{/g)) {
      for (const m of sel[0].matchAll(/body\.(fe-[a-z0-9-]+)/g)) {
        if (!out.has(m[1])) out.set(m[1], new Set());
        out.get(m[1]).add(file);
      }
    }
  }
  return out;
}

/** fe-style.js functions that toggle body classes, with their first parameter. */
function styleSetters() {
  const fns = [...STYLE_JS.matchAll(/^function (fe[A-Za-z0-9_]+)\(([^)]*)\)\s*\{/gm)];
  const out = [];
  for (let i = 0; i < fns.length; i++) {
    const body = STYLE_JS.slice(fns[i].index, i + 1 < fns.length ? fns[i + 1].index : STYLE_JS.length);
    const classes = [...body.matchAll(/classList\??\.\s*toggle\(\s*"(fe-[a-z0-9-]+)"/g)].map((m) => m[1]);
    if (!classes.length) continue;
    const firstParam = fns[i][2].split(",")[0].trim();
    out.push({ name: fns[i][1], classes, docScoped: /^doc\b/.test(firstParam) });
  }
  return out;
}

/** The body of feApplyStyleClassesToDocument. */
function styleClassListBody() {
  const start = ENHANCE_JS.indexOf("function feApplyStyleClassesToDocument(");
  assert.notEqual(start, -1, "feApplyStyleClassesToDocument no longer exists");
  const end = ENHANCE_JS.indexOf("\n}", start);
  assert.notEqual(end, -1, "could not find the end of feApplyStyleClassesToDocument");
  return ENHANCE_JS.slice(start, end);
}

test("every doc-scoped toggle whose CSS reaches the archive is in the shared list", () => {
  const targeted = archiveTargetedBodyClasses();
  assert.ok(targeted.size > 5, "the CSS scan found suspiciously few archive-targeted classes");

  const listBody = styleClassListBody();
  const missing = [];
  for (const setter of styleSetters()) {
    if (!setter.docScoped) continue; // e.g. feSetBodyMergeClasses writes the LIVE body
    const hits = setter.classes.filter((c) => targeted.has(c));
    if (!hits.length) continue;
    if (!listBody.includes(`${setter.name}(doc)`)) {
      missing.push(`${setter.name} (owns ${hits.join(", ")} — styled in ${[...targeted.get(hits[0])].join(", ")})`);
    }
  }
  assert.deepEqual(missing, [], "toggles styled for #fe-chat-export-log but never applied to it");
});

test("the two toggles the drift lost are still in the shared list", () => {
  const listBody = styleClassListBody();
  assert.match(listBody, /feSetHideMsgBorderUserColorClass\(doc\)/);
  assert.match(listBody, /feSetForceNormalMsgColorClass\(doc\)/);
});

test("the archive calls the shared list instead of re-inlining it", () => {
  assert.match(ARCHIVE_JS, /feApplyStyleClassesToDocument\(win\.document\)/);
  // A re-inlined copy would show up as several feSet*Class calls against win.document.
  const inlined = [...ARCHIVE_JS.matchAll(/\bfeSet[A-Za-z0-9_]*(?:Class|Mode)\(win\.document\)/g)];
  assert.deepEqual(inlined.map((m) => m[0]), [], "the toggle list has been inlined into the archive again");
});

test("the live-only toggles stay OUT of the shared list", () => {
  const listBody = styleClassListBody();
  // feSetBodyMergeClasses ignores its argument and writes document.body; the archive
  // uses feSyncArchiveMergeBodyClasses for its own document.
  assert.doesNotMatch(listBody, /feSetBodyMergeClasses/);
  // feApplyCanvasTextFont mutates global PIXI config (CONFIG.canvasTextStyle /
  // CONFIG.defaultFontFamily) and redraws canvas text.
  assert.doesNotMatch(listBody, /feApplyCanvasTextFont/);
  // …but the live path must still run both.
  const visual = ENHANCE_JS.slice(ENHANCE_JS.indexOf("function feApplyVisualSettingsToDocument("));
  const visualBody = visual.slice(0, visual.indexOf("\n}"));
  assert.match(visualBody, /feApplyStyleClassesToDocument\(doc\)/);
  assert.match(visualBody, /feSetBodyMergeClasses\(\)/);
  assert.match(visualBody, /feApplyCanvasTextFont\(doc\)/);
});
