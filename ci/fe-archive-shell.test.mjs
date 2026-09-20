// Tripwires for the archive popup shell (templates/fe-archive-shell.hbs).
//
// The shell used to be a ~450-line template literal inside
// feRenderChatArchiveWindow. Moving it to a .hbs was verified byte-for-byte
// against the old literal in both theme branches at the time of the move; these
// tests pin the properties that verification relied on, so a later edit cannot
// quietly break the popup — which renders in a SEPARATE window where a mistake
// shows up as a blank page rather than as an error anyone sees.

import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import Handlebars from "handlebars";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

const SHELL_SRC = read("templates/fe-archive-shell.hbs");
const DOCUMENT_JS = read("scripts/fe-archive-document.js");

const LABELS = {
  collecting: "메시지를 수집하는 중…",
  downloadTooltip: 'HTML로 저장 ("자체 포함")',
  printTooltip: "인쇄 / PDF",
  print: "인쇄",
  close: "닫기",
};

const render = (overrides = {}) => Handlebars.compile(SHELL_SRC)({
  baseHref: "http://localhost:30000/",
  titleText: "Chat Log – World",
  headStyles: '<style>@import "modules/x/a.css" layer(modules);</style>',
  bodyClass: "vtt game system-dnd5e fe-print-chatlog fe-chat-archive fe-chat-archive-window",
  pixelTheme: false,
  archiveBg: "#ffffff",
  labels: LABELS,
  ...overrides,
});

test("the shell has no leftover JS template-literal interpolation", () => {
  // A `${...}` that survived the move renders as literal text into the popup.
  assert.doesNotMatch(SHELL_SRC, /\$\{/);
});

test("the shell renders a complete document in both theme branches", () => {
  for (const pixelTheme of [false, true]) {
    const html = render({ pixelTheme, archiveBg: pixelTheme ? "#000000" : "#ffffff" });
    assert.match(html, /^\s*<!doctype html>/i, `pixelTheme=${pixelTheme}: no doctype`);
    assert.match(html, /<\/html>/, `pixelTheme=${pixelTheme}: unterminated document`);
    // The render target the whole archive pipeline writes into.
    assert.match(html, /<ol id="fe-chat-export-log" class="chat-log"><\/ol>/);
    // The three controls feRenderChatArchiveWindow wires up by id.
    for (const id of ["fe-archive-download", "fe-archive-print", "fe-archive-close"]) {
      assert.match(html, new RegExp(`id="${id}"`), `pixelTheme=${pixelTheme}: missing #${id}`);
    }
    assert.match(html, /id="fe-chat-export-status"/);
    assert.match(html, /id="fe-chat-export-meta"/);
  }
});

test("the pixel-theme fallback stylesheet is gated on pixelTheme", () => {
  assert.doesNotMatch(render({ pixelTheme: false }), /data-fe-pixel-archive/);
  assert.match(render({ pixelTheme: true }), /<style data-fe-pixel-archive="1">/);
});

test("archiveBg reaches every surface that used to interpolate it", () => {
  // html/body + the sidebar, the chat tab and the log: four sites in the old literal.
  // A sentinel colour keeps the count clear of the pixel-theme block's own literals.
  for (const pixelTheme of [false, true]) {
    const html = render({ pixelTheme, archiveBg: "#123456" });
    assert.equal(
      (html.match(/background: #123456 !important;/g) ?? []).length,
      4,
      `pixelTheme=${pixelTheme}: archiveBg no longer reaches all four surfaces`,
    );
  }
});

test("headStyles is the ONLY raw interpolation; user-facing text is escaped", () => {
  // headStyles is markup by construction (feCollectHeadStylesHTML) and must not be
  // escaped, or every mirrored stylesheet arrives as visible text.
  assert.match(SHELL_SRC, /\{\{\{headStyles\}\}\}/);
  assert.equal((SHELL_SRC.match(/\{\{\{/g) ?? []).length, 1);

  // Everything else goes through {{ }}, which is what replaced the explicit
  // feEscapeHTML/feEscapeAttr calls the literal used to make.
  const html = render({
    titleText: '<script>x</script>',
    bodyClass: 'a" onload="x',
    labels: { ...LABELS, close: "<b>" },
  });
  assert.doesNotMatch(html, /<title><script>/);
  assert.match(html, /<title>&lt;script&gt;/);
  assert.doesNotMatch(html, /onload="x/);
  assert.match(html, /&lt;b&gt;/);
});

test("the inline stylesheet stays inline and unlayered", () => {
  // It is deliberately the WEAKEST !important tier in the document (see the .hbs
  // header). A @layer here, or a move into styles/, would promote it over the
  // layered sheets it is meant to lose to.
  assert.doesNotMatch(SHELL_SRC, /@layer/);
  // (a `<link>` is mentioned in a CSS comment, so match the actual element instead)
  assert.doesNotMatch(SHELL_SRC, /rel\s*=\s*"stylesheet"/);
});

test("feBuildArchiveDocument supplies every key the shell reads", () => {
  const used = new Set(
    [...SHELL_SRC.matchAll(/\{\{\{?#?if\s+([\w.]+)\}?\}\}|\{\{\{?([\w.]+)\}?\}\}/g)]
      .map((m) => (m[1] ?? m[2] ?? "").split(".")[0])
      .filter((n) => n && n !== "else"),
  );
  used.delete("");
  for (const key of used) {
    assert.match(
      DOCUMENT_JS,
      new RegExp(`\\b${key}[,:]`),
      `feBuildArchiveDocument never passes "${key}"`,
    );
  }
  // and it must fail loudly rather than write an empty document
  assert.match(DOCUMENT_JS, /if \(!html\) throw new Error/);
});
