// ===========================================================================
// fe-archive-css.js — pure CSS helpers for the archive HTML snapshot.
//
// Sub-module of fe-chat-archive.js. No Foundry/DOM globals, no imports — every
// export here is a pure string transform so it can be unit-tested with
// `node --test` (see ci/fe-archive-css.test.mjs).
//
// WHY THIS EXISTS (the bug it fixes):
// Foundry does NOT serve module/system stylesheets as <link> elements. Its game
// view template (templates/views/layouts/main.hbs) emits them as
//     <style>
//       @import "modules/<id>/styles/foo.css" layer(layouts);
//       @import "modules/<id>/styles/bar.css" layer(modules);
//       ...
//     </style>
// A module style with no explicit manifest `layer` still gets a default layer
// ("modules" for modules, "system" for systems) — so EVERY female_edition sheet
// lives inside one of these @import blocks, never as a <link>.
//
// The archive's <link>-only inliner therefore missed all of them: the saved HTML
// kept the raw `@import "modules/…"` with a relative URL that cannot resolve in a
// standalone file:// document (and, even online, loses the documented cascade-
// layer !important precedence). The result was "CSS 규칙 파괴" plus fonts that
// never applied (so Chromium's PDF export embedded nothing).
//
// feAssembleInlinedStyleBlock rebuilds such a block: it inlines each import's
// fetched CSS wrapped in `@layer <name> { … }` (preserving layer membership), and
// emits a leading `@layer a, b, c;` statement so the *order* of the layers is
// locked exactly as the originals established it — independent of which imports
// succeeded, failed, or had to stay as network fallbacks.
// ===========================================================================

/**
 * Rewrite every `url(...)` and `@import "..."` reference in a CSS text to an
 * absolute URL resolved against `stylesheetURL`. data:/blob:/# refs pass through.
 *
 * Pure. Used both for fetched <link> CSS and for inlined @import bodies.
 */
export function feRewriteSnapshotCSSURLs(cssText, stylesheetURL) {
  const resolve = (raw) => {
    const value = String(raw ?? "").trim();
    if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("#")) return value;
    try {
      return new URL(value, stylesheetURL).href;
    } catch {
      return value;
    }
  };

  let css = String(cssText ?? "");
  css = css.replace(/url\(\s*(["']?)([^"')]+)\1\s*\)/gi, (_match, quote, raw) => {
    const q = quote || '"';
    return `url(${q}${resolve(raw)}${q})`;
  });
  css = css.replace(/(@import\s+)(["'])([^"']+)\2/gi, (_match, prefix, quote, raw) => {
    return `${prefix}${quote}${resolve(raw)}${quote}`;
  });
  return css;
}

/**
 * Parse the `@import` statements out of a CSS text.
 *
 * Handles both the bare-string form (`@import "x.css" layer(a);`) and the url()
 * form (`@import url("x.css") layer(a) screen;`). Returns, in document order:
 *   { raw, index, url, layer, media }
 * where `raw` is the full matched statement (including the trailing `;`), `layer`
 * is the layer name or null, and `media` is any leftover media-query text (may be "").
 *
 * Pure.
 */
export function feParseCssImports(cssText) {
  const text = String(cssText ?? "");
  // URL is either url( "x" ) / url( x )  OR  a bare quoted string. Then any
  // trailing tokens (layer(...) and/or a media query) up to the terminating `;`.
  const re = /@import\s+(?:url\(\s*(["']?)([^"')]+)\1\s*\)|(["'])([^"']+)\3)\s*([^;]*);/gi;
  const out = [];
  for (let m = re.exec(text); m !== null; m = re.exec(text)) {
    const url = String(m[2] ?? m[4] ?? "").trim();
    const trailing = String(m[5] ?? "").trim();
    const layerMatch = /\blayer\(\s*([\w-]+)\s*\)/i.exec(trailing);
    const layer = layerMatch ? layerMatch[1] : null;
    const media = trailing.replace(/\blayer\(\s*[\w-]+\s*\)/i, "").trim();
    out.push({ raw: m[0], index: m.index, url, layer, media });
  }
  return out;
}

/**
 * Serialize one `@import` back into a network-fallback statement (kept when the
 * target could not be inlined, so it still works while Foundry is online).
 */
function feFormatImportStatement(url, layer, media) {
  const layerPart = layer ? ` layer(${layer})` : "";
  const mediaPart = media ? ` ${media}` : "";
  return `@import "${url}"${layerPart}${mediaPart};`;
}

// `String#replace` with a STRING pattern treats `$&`, `$1`, `` $` `` etc. in the
// REPLACEMENT specially. A stylesheet body is arbitrary text and does contain `$`
// (e.g. `content: "$"`), so every substitution here goes through a function
// replacer, which is exempt from that expansion.
function feReplaceOnce(haystack, needle, replacement) {
  return haystack.replace(needle, () => replacement);
}

/**
 * Resolve one already-inlined stylesheet body, folding in whatever nested
 * `@import`s it can and collecting the rest for the caller to hoist.
 * Shared by the pure-import rebuild and the in-place mixed-block path.
 */
function feBuildInlinedImportBody(inlined, { resolve, inlineNested, hoistImports }) {
  let body = String(inlined ?? "");
  for (const n of feParseCssImports(body)) {
    const nestedAbs = resolve(n.url);
    const nestedCss = n.media || n.layer ? null : inlineNested(nestedAbs);
    if (nestedCss != null) {
      body = feReplaceOnce(body, n.raw, nestedCss);
      continue;
    }
    body = feReplaceOnce(body, n.raw, "");
    hoistImports.push(feFormatImportStatement(nestedAbs, n.layer, n.media));
  }
  return body.trim();
}

/**
 * In-place variant for a block that mixes `@import`s with real rules. Each
 * inlinable import is swapped for its body (wrapped in the layer it declared);
 * everything else in the block is left byte-identical.
 *
 * The one ordering hazard, and why imports are hoisted rather than left alone:
 * `@import` is only honoured before any style rule. Replacing an EARLIER import
 * with its `@layer {}` body would therefore silently kill a LATER import that had
 * to stay a network reference. So every non-inlined import is moved to the very
 * top of the block (valid — only `@charset` and `@layer` statements may precede an
 * import, and both are already fine there). Their relative cascade position is
 * unaffected because Foundry qualifies each with `layer(...)`, and the block's
 * own `@layer a, b, c;` statement fixes that order independently of source order.
 *
 * Returns `mixed: true` so the caller still absolutizes the residual rules' urls.
 */
function feAssembleMixedStyleBlock(src, parsed, { resolve, inline, inlineNested }) {
  const hoistImports = [];
  let out = src;
  let inlinedAny = false;

  for (const imp of parsed) {
    const abs = resolve(imp.url);
    const inlined = imp.media ? null : inline(abs);
    if (inlined == null) {
      out = feReplaceOnce(out, imp.raw, "");
      hoistImports.push(feFormatImportStatement(abs, imp.layer, imp.media));
      continue;
    }
    const body = feBuildInlinedImportBody(inlined, { resolve, inlineNested, hoistImports });
    out = feReplaceOnce(out, imp.raw, imp.layer ? `@layer ${imp.layer} {\n${body}\n}` : body);
    inlinedAny = true;
  }

  // Nothing could be inlined — hand the block back untouched rather than rewriting
  // it for no gain. The caller's absolutize-only path is exactly the old behaviour.
  if (!inlinedAny) return { text: src, rebuilt: false };

  const text = hoistImports.length ? `${hoistImports.join("\n")}\n${out}` : out;
  return { text, rebuilt: true, mixed: true };
}

/**
 * Rebuild a `<style>` block that consists solely of `@import` rules (Foundry's
 * module/system style block) into a self-contained, layer-order-preserving block.
 *
 * @param {string} originalText  The block's current textContent.
 * @param {object} opts
 * @param {(rawUrl: string) => string} opts.resolveAbs   Resolve an import URL to absolute.
 * @param {(absUrl: string) => (string|null)} opts.getInlinedCss  Return the already-
 *        fetched-and-url-rewritten CSS for an absolute URL, or null if it must stay a
 *        network import (cross-origin, over budget, media-qualified, or fetch failed).
 * @param {(absUrl: string) => (string|null)} [opts.getNestedInlinedCss]  Same, but consulted
 *        ONLY for imports found INSIDE an inlined body. Separate from getInlinedCss on
 *        purpose: the caller's top-level map also holds every same-origin sheet, so
 *        reusing it here would inline a sheet's body a SECOND time whenever one
 *        stylesheet @imports another that is itself top-level. Omit it and nested
 *        imports all hoist, which is the historical behaviour.
 * @returns {{ text: string, rebuilt: boolean }}  `rebuilt` is false when the block is
 *        NOT a pure import list (it then must be left as-is / only URL-absolutized by
 *        the caller — we never risk mangling a block that also holds real rules).
 */
export function feAssembleInlinedStyleBlock(originalText, { resolveAbs, getInlinedCss, getNestedInlinedCss } = {}) {
  const src = String(originalText ?? "");
  const parsed = feParseCssImports(src);
  if (!parsed.length) return { text: src, rebuilt: false };

  const resolve = typeof resolveAbs === "function" ? resolveAbs : (u) => u;
  const inline = typeof getInlinedCss === "function" ? getInlinedCss : () => null;
  const inlineNested = typeof getNestedInlinedCss === "function" ? getNestedInlinedCss : () => null;

  // A "pure import block" is one whose only content is @import statements (plus
  // whitespace/comments). The full rebuild below reorders freely, so it is only
  // valid for those.
  let residual = src;
  for (const imp of parsed) residual = residual.replace(imp.raw, "");
  residual = residual.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  // MIXED block — real rules live here too, so a rebuild could reorder or lose
  // them. This used to bail out entirely, which meant the block's @imports stayed
  // raw `http://<foundry-host>/…` URLs and their CSS never entered the saved file.
  //
  // That is not a rare shape: Foundry v14 emits SYSTEM styles as one <style> that
  // holds `@layer system, layouts, modules;` + the system's @imports + an inline
  // `@layer system { … }` block. Measured on a dx3rd-emanim export (2026-08-12):
  // the saved HTML contained ZERO of dx3rd's own rules — `.two-columns`,
  // `.item-name-toggle`, `.dx3rd-item-chat .item-header` all 0 occurrences — so
  // every item chat card lost its layout and rendered as bare stacked divs. It
  // only looked fine in the PDF because that renders while Foundry is running and
  // the localhost @import still resolves.
  //
  // Substitute IN PLACE instead: nothing moves, so residual rules keep their exact
  // position and cascade order.
  if (residual) return feAssembleMixedStyleBlock(src, parsed, { resolve, inline, inlineNested });

  // Layer order is fixed by first appearance — emit it up front so the cascade
  // order is identical no matter which imports end up inlined vs. kept as links.
  const layerOrder = [];
  for (const imp of parsed) {
    if (imp.layer && !layerOrder.includes(imp.layer)) layerOrder.push(imp.layer);
  }

  const hoistImports = []; // network fallbacks + nested imports (must precede @layer blocks)
  const layerBlocks = [];  // inlined bodies, in original order

  for (const imp of parsed) {
    const abs = resolve(imp.url);
    const inlined = imp.media ? null : inline(abs);
    if (inlined != null) {
      // Nested @import — e.g. ui-font.css imports the NeoDGM Pro webfont CSS from a
      // CDN. Try to inline it IN PLACE first: that CSS is nothing but @font-face
      // rules, and inlining them is the only way the saved file renders that face
      // offline (a hoisted @import needs the network). @font-face is layer-agnostic,
      // so living inside the surrounding @layer block changes nothing.
      //
      // A nested import that carries its OWN layer() is never inlined — honouring it
      // would need a nested @layer block whose order relative to the parent's is not
      // something this function can establish. It hoists, like before.
      //
      // Hoisting stays the fallback for everything else, because `@import` is invalid
      // inside `@layer {}` and must precede all rules.
      const body = feBuildInlinedImportBody(inlined, { resolve, inlineNested, hoistImports });
      layerBlocks.push(imp.layer ? `@layer ${imp.layer} {\n${body}\n}` : body);
    } else {
      // Keep as a network import so the saved HTML still styles correctly online.
      hoistImports.push(feFormatImportStatement(abs, imp.layer, imp.media));
    }
  }

  const parts = [];
  if (layerOrder.length) parts.push(`@layer ${layerOrder.join(", ")};`);
  parts.push(...hoistImports, ...layerBlocks);
  return { text: parts.join("\n"), rebuilt: true };
}
