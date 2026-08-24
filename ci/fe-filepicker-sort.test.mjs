import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SORT_JS = readFileSync(new URL("../scripts/fe-filepicker-sort.js", import.meta.url), "utf8");
const RETRO_CSS = readFileSync(new URL("../styles/fe-retro-common.css", import.meta.url), "utf8");

test("the FilePicker sort direction icon stays visible on the retro hover surface", () => {
  assert.match(SORT_JS, /className = "ui-control icon fa-solid fe-fp-sort-dir"/);
  assert.match(SORT_JS, /fa-arrow-up-short-wide/);
  assert.match(SORT_JS, /fa-arrow-down-wide-short/);

  const start = RETRO_CSS.indexOf("/* FilePicker sort direction:");
  const end = RETRO_CSS.indexOf("body.fe-retro-theme .sound-controls", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const rules = RETRO_CSS.slice(start, end);
  assert.match(rules, /#file-picker \.fe-fp-sort-dir\s*\{[\s\S]*?color:\s*var\(--fe-ac-70\) !important/);
  assert.match(rules, /#file-picker \.fe-fp-sort-dir:hover:not\(:disabled\)\s*\{[\s\S]*?background-color:\s*var\(--fe-ac-12\) !important/);
  assert.match(rules, /border-color:\s*var\(--fe-ac-70\) !important/);
  assert.match(rules, /color:\s*var\(--fe-ac-90\) !important/);
});
