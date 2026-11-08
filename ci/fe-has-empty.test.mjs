import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";

// Measured live on v14.370 / Chrome: a stylesheet with `:empty` (or
// `:not(:empty)`) INSIDE a `:has()` argument makes every keystroke in the
// ProseMirror chat input restyle a large part of the document - 78 ms per key
// with the retro theme off, 155 ms with it on, against 1 ms without. `:empty`
// OUTSIDE `:has()` is harmless and is not flagged here.

const ROOT = new URL("../", import.meta.url);
const DIRS = ["styles", "tidy-classic/styles", "tidy-classic/dist"];

function cssFiles() {
  const out = [];
  for (const dir of DIRS) {
    const abs = new URL(`${dir}/`, ROOT);
    if (!existsSync(abs)) continue;
    for (const name of readdirSync(abs)) if (name.endsWith(".css")) out.push(join(dir, name));
  }
  return out;
}

// Returns the balanced argument text of every `:has(` in the source.
function hasArguments(css) {
  const args = [];
  let from = 0;
  for (;;) {
    const at = css.indexOf(":has(", from);
    if (at < 0) return args;
    let depth = 0;
    let i = at + 4;
    for (; i < css.length; i++) {
      if (css[i] === "(") depth++;
      else if (css[i] === ")" && --depth === 0) break;
    }
    args.push({ at, text: css.slice(at + 5, i) });
    from = at + 5;
  }
}

test("the parser sees :empty only inside :has()", () => {
  assert.deepEqual(hasArguments("a:has(> b:not(:empty)) c:empty").map(a => a.text), ["> b:not(:empty)"]);
  assert.equal(hasArguments("a:has(b) > c:empty").some(a => a.text.includes(":empty")), false);
});

test("no module stylesheet puts :empty inside :has()", () => {
  const offenders = [];
  for (const file of cssFiles()) {
    // Blank comments out in place (newlines kept) so reported line numbers match the file.
    const css = readFileSync(new URL(file.replaceAll("\\", "/"), ROOT), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, c => c.replace(/[^\n]/g, " "));
    for (const { at, text } of hasArguments(css)) {
      if (!text.includes(":empty")) continue;
      const line = css.slice(0, at).split("\n").length;
      offenders.push(`${file}:${line}  :has(${text})`);
    }
  }
  assert.deepEqual(offenders, []);
});
