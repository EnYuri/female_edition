import { test } from "node:test";
import assert from "node:assert/strict";

import {
  feRewriteSnapshotCSSURLs,
  feParseCssImports,
  feAssembleInlinedStyleBlock,
} from "../scripts/fe-archive-css.js";

// ---------------------------------------------------------------------------
// feParseCssImports
// ---------------------------------------------------------------------------

test("feParseCssImports: bare-string form with layer()", () => {
  const [imp] = feParseCssImports('@import "modules/fe/styles/ui-font.css" layer(layouts);');
  assert.equal(imp.url, "modules/fe/styles/ui-font.css");
  assert.equal(imp.layer, "layouts");
  assert.equal(imp.media, "");
});

test("feParseCssImports: url() form, no layer", () => {
  const [imp] = feParseCssImports('@import url("https://cdn.example/font.css");');
  assert.equal(imp.url, "https://cdn.example/font.css");
  assert.equal(imp.layer, null);
});

test("feParseCssImports: layer() + media query keeps the media leftover", () => {
  const [imp] = feParseCssImports('@import "a.css" layer(modules) screen and (min-width: 40em);');
  assert.equal(imp.url, "a.css");
  assert.equal(imp.layer, "modules");
  assert.equal(imp.media, "screen and (min-width: 40em)");
});

test("feParseCssImports: multiple statements in document order", () => {
  const list = feParseCssImports(`
    @import "one.css" layer(layouts);
    @import "two.css" layer(modules);
    @import "three.css" layer(modules);
  `);
  assert.deepEqual(list.map((i) => i.url), ["one.css", "two.css", "three.css"]);
});

test("feParseCssImports: no imports returns empty", () => {
  assert.deepEqual(feParseCssImports(".foo { color: red }"), []);
});

// ---------------------------------------------------------------------------
// feRewriteSnapshotCSSURLs
// ---------------------------------------------------------------------------

test("feRewriteSnapshotCSSURLs: relative url() becomes absolute", () => {
  const out = feRewriteSnapshotCSSURLs(
    "@font-face{src:url(../font/x.ttf)}",
    "http://localhost:30000/modules/fe/styles/ui-font.css"
  );
  assert.match(out, /url\("http:\/\/localhost:30000\/modules\/fe\/font\/x\.ttf"\)/);
});

test("feRewriteSnapshotCSSURLs: data: url is left untouched", () => {
  const out = feRewriteSnapshotCSSURLs("a{background:url(data:image/gif;base64,AAAA)}", "http://x/y.css");
  assert.match(out, /url\("?data:image\/gif;base64,AAAA"?\)/);
});

// ---------------------------------------------------------------------------
// feAssembleInlinedStyleBlock
// ---------------------------------------------------------------------------

const base = "http://localhost:30000/";
const resolveAbs = (u) => new URL(u, base).href;

test("assemble: inlines each import wrapped in its @layer, order statement first", () => {
  const block = `
    @import "modules/fe/styles/ui-font.css" layer(layouts);
    @import "modules/fe/styles/chat.css" layer(modules);
  `;
  const css = {
    "http://localhost:30000/modules/fe/styles/ui-font.css": "body{font-family:X}",
    "http://localhost:30000/modules/fe/styles/chat.css": ".m{color:red}",
  };
  const { text, rebuilt } = feAssembleInlinedStyleBlock(block, {
    resolveAbs,
    getInlinedCss: (abs) => css[abs] ?? null,
  });
  assert.equal(rebuilt, true);
  // Layer order locked up front, in first-seen order.
  assert.match(text, /^@layer layouts, modules;/);
  // Each body wrapped in its own named layer.
  assert.match(text, /@layer layouts \{\nbody\{font-family:X\}\n\}/);
  assert.match(text, /@layer modules \{\n\.m\{color:red\}\n\}/);
  // layouts block precedes modules block.
  assert.ok(text.indexOf("font-family:X") < text.indexOf("color:red"));
});

test("assemble: layer ORDER is preserved even when the first sheet fails to inline", () => {
  // If layouts (first) can't be inlined but modules can, a naive rebuild would
  // reference `modules` before `layouts` and INVERT the cascade. The leading
  // @layer statement must still declare layouts before modules.
  const block = `
    @import "modules/fe/styles/ui-font.css" layer(layouts);
    @import "modules/fe/styles/chat.css" layer(modules);
  `;
  const { text } = feAssembleInlinedStyleBlock(block, {
    resolveAbs,
    getInlinedCss: (abs) =>
      abs.endsWith("chat.css") ? ".m{color:red}" : null, // ui-font.css fails
  });
  assert.match(text, /^@layer layouts, modules;/);
  // The failed one is kept as a network import (absolute), before the @layer block.
  assert.match(text, /@import "http:\/\/localhost:30000\/modules\/fe\/styles\/ui-font\.css" layer\(layouts\);/);
  const importIdx = text.indexOf('@import "http://localhost:30000/modules/fe/styles/ui-font.css"');
  const blockIdx = text.indexOf("@layer modules {");
  assert.ok(importIdx < blockIdx, "network @import must precede the @layer{} block");
});

test("assemble: nested @import inside an inlined body is hoisted to the top", () => {
  const block = '@import "modules/fe/styles/ui-font.css" layer(layouts);';
  const inlined =
    '@import url("https://cdn.example/neodgm.css");\n@font-face{font-family:X;src:url("http://localhost:30000/modules/fe/font/x.ttf")}';
  const { text } = feAssembleInlinedStyleBlock(block, {
    resolveAbs,
    getInlinedCss: () => inlined,
  });
  // The nested CDN import is hoisted out of the @layer block...
  const nestedIdx = text.indexOf('@import "https://cdn.example/neodgm.css";');
  const layerIdx = text.indexOf("@layer layouts {");
  assert.ok(nestedIdx !== -1, "nested import must be hoisted");
  assert.ok(nestedIdx < layerIdx, "hoisted @import must precede the @layer{} block");
  // ...and must NOT remain inside the layer body.
  const body = text.slice(layerIdx);
  assert.ok(!body.includes("neodgm.css"), "nested @import must not stay inside @layer{}");
  assert.match(body, /@font-face\{font-family:X/);
});

test("assemble: media-qualified import stays a network import (never inlined)", () => {
  const block = '@import "modules/fe/print.css" layer(modules) print;';
  const { text } = feAssembleInlinedStyleBlock(block, {
    resolveAbs,
    getInlinedCss: () => "should-not-be-used",
  });
  assert.match(text, /@import "http:\/\/localhost:30000\/modules\/fe\/print\.css" layer\(modules\) print;/);
  assert.ok(!text.includes("should-not-be-used"));
});

test("assemble: a block with real rules (not pure imports) is left untouched", () => {
  const block = '@import "a.css" layer(modules);\n.real{color:blue}';
  const { text, rebuilt } = feAssembleInlinedStyleBlock(block, {
    resolveAbs,
    getInlinedCss: () => "x{}",
  });
  assert.equal(rebuilt, false);
  assert.equal(text, block);
});

test("assemble: comments between imports still count as a pure import block", () => {
  const block = '/* header */\n@import "a.css" layer(modules);\n/* trailer */';
  const { rebuilt } = feAssembleInlinedStyleBlock(block, {
    resolveAbs,
    getInlinedCss: (abs) => (abs.endsWith("a.css") ? "x{}" : null),
  });
  assert.equal(rebuilt, true);
});

test("assemble: no imports at all -> not rebuilt", () => {
  const { rebuilt } = feAssembleInlinedStyleBlock(".foo{}", { resolveAbs, getInlinedCss: () => null });
  assert.equal(rebuilt, false);
});
