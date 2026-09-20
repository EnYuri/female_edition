// Tripwire: every named import in scripts/ resolves to a real export.
//
// Foundry serves scripts/ directly with no build step and no bundler, so nothing
// checks the import graph before the browser does — a named import of a symbol that
// has moved to another module fails at RUNTIME, as a blank feature and one console
// line, often only on the code path that first touches it.
//
// ESLint cannot see this: no-undef is per-file, and `import { gone } from "./x.js"`
// defines `gone` locally no matter what x.js actually exports. This test closes that
// gap for the whole module, which matters most right after a refactor moves a
// function between files.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";

const SCRIPTS = new URL("../scripts/", import.meta.url);
const files = readdirSync(SCRIPTS).filter((f) => f.endsWith(".js"));
const source = new Map(files.map((f) => [f, readFileSync(new URL(f, SCRIPTS), "utf8")]));

/**
 * Strip comments from a specifier list.
 *
 * Both `export { … }` and `import { … }` blocks in this codebase carry explanatory
 * comments between the names. Splitting the raw text on "," glues a comment onto the
 * name that follows it, which reads as a missing export — a false positive that cost
 * one round of "fixing" code that was already correct.
 */
const stripComments = (s) => s.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");

/** Names a module exports, via `export function/const/let/class` or `export { … }`. */
function exportsOf(src) {
  const out = new Set();
  for (const m of src.matchAll(/^export\s+(?:async\s+)?(?:function|class|const|let|var)\s+([\w$]+)/gm)) out.add(m[1]);
  for (const m of src.matchAll(/^export\s*\{([^}]*)\}/gms)) {
    for (const spec of stripComments(m[1]).split(",")) {
      const name = spec.trim().split(/\s+as\s+/).pop().trim();
      if (name) out.add(name);
    }
  }
  // `export * from "./x.js"` re-exports everything — record the source to follow.
  for (const m of src.matchAll(/^export\s*\*\s*from\s*["']\.\/([\w.-]+)["']/gm)) out.add("*" + m[1]);
  return out;
}

const exportMap = new Map([...source].map(([f, src]) => [f, exportsOf(src)]));

/** Resolve a name through `export *` chains. */
function provides(file, name, seen = new Set()) {
  if (seen.has(file)) return false;
  seen.add(file);
  const ex = exportMap.get(file);
  if (!ex) return false;
  if (ex.has(name)) return true;
  for (const e of ex) {
    if (e.startsWith("*") && provides(e.slice(1), name, seen)) return true;
  }
  return false;
}

test("every named import in scripts/ resolves to an export", () => {
  const broken = [];
  for (const [file, src] of source) {
    for (const m of src.matchAll(/^import\s*\{([^}]*)\}\s*from\s*["']\.\/([\w.-]+)["']/gms)) {
      const target = m[2];
      if (!existsSync(new URL(target, SCRIPTS))) {
        broken.push(`${file}: imports from missing module "./${target}"`);
        continue;
      }
      for (const spec of stripComments(m[1]).split(",")) {
        const name = spec.trim().split(/\s+as\s+/)[0].trim();
        if (!name) continue;
        if (!provides(target, name)) broken.push(`${file}: "${name}" is not exported by ./${target}`);
      }
    }
  }
  assert.deepEqual(broken, []);
});

test("every default/namespace import target exists", () => {
  const broken = [];
  for (const [file, src] of source) {
    for (const m of src.matchAll(/^import\s+(?!\{)(?:[\w$*]|\s|as)+from\s*["']\.\/([\w.-]+)["']/gm)) {
      if (!existsSync(new URL(m[1], SCRIPTS))) broken.push(`${file}: missing module "./${m[1]}"`);
    }
    for (const m of src.matchAll(/^import\s*["']\.\/([\w.-]+)["']/gm)) {
      if (!existsSync(new URL(m[1], SCRIPTS))) broken.push(`${file}: missing module "./${m[1]}"`);
    }
  }
  assert.deepEqual(broken, []);
});

test("module.json's esmodules all exist", () => {
  const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8"));
  const missing = (manifest.esmodules ?? []).filter(
    (p) => !existsSync(new URL(`../${p}`, import.meta.url)),
  );
  assert.deepEqual(missing, []);
});
