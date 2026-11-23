import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SORT_JS = readFileSync(new URL("../scripts/fe-filepicker-sort.js", import.meta.url), "utf8");
const RETRO_CSS = readFileSync(new URL("../styles/fe-retro-common.css", import.meta.url), "utf8");

test("the FilePicker sort direction icon stays visible on the retro hover surface", () => {
  assert.match(SORT_JS, /className = "ui-control icon fa-solid fe-fp-sort-dir"/);
  assert.match(SORT_JS, /fa-arrow-up-short-wide/);
  assert.match(SORT_JS, /fa-arrow-down-wide-short/);

  const base = RETRO_CSS.match(/body\.fe-retro-theme #file-picker \.fe-fp-sort-dir\s*\{([^}]+)\}/)?.[1] ?? "";
  const hover = RETRO_CSS.match(/body\.fe-retro-theme #file-picker \.fe-fp-sort-dir:hover:not\(:disabled\)\s*\{([^}]+)\}/)?.[1] ?? "";
  assert.match(base, /\bcolor:\s*var\(--fe-ac-70\) !important/);
  assert.match(hover, /background-color:\s*var\(--fe-ac-12\) !important/);
  assert.match(hover, /border-color:\s*var\(--fe-ac-70\) !important/);
  assert.match(hover, /(?:^|;)\s*color:\s*var\(--fe-ac-90\) !important/);
});
