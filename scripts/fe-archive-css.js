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
 * @returns {{ text: string, rebuilt: boolean }}  `rebuilt` is false when the block is
 *        NOT a pure import list (it then must be left as-is / only URL-absolutized by
 *        the caller — we never risk mangling a block that also holds real rules).
 */
export function feAssembleInlinedStyleBlock(originalText, { resolveAbs, getInlinedCss } = {}) {
  const src = String(originalText ?? "");
  const parsed = feParseCssImports(src);
  if (!parsed.length) return { text: src, rebuilt: false };

  // A "pure import block" is one whose only content is @import statements (plus
  // whitespace/comments). Anything else means real rules live here too — do not
  // touch it, or we could reorder/lose them.
  let residual = src;
  for (const imp of parsed) residual = residual.replace(imp.raw, "");
  residual = residual.replace(/\/\*[\s\S]*?\*\//g, "").trim();
  if (residual) return { text: src, rebuilt: false };

  const resolve = typeof resolveAbs === "function" ? resolveAbs : (u) => u;
  const inline = typeof getInlinedCss === "function" ? getInlinedCss : () => null;

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
      // Nested @import (e.g. a webfont CDN inside ui-font.css) is invalid inside an
      // @layer {} block and must precede all rules — hoist it out to the top.
      const nested = feParseCssImports(inlined);
      let body = inlined;
      for (const n of nested) {
        body = body.replace(n.raw, "");
        hoistImports.push(feFormatImportStatement(n.url, n.layer, n.media));
      }
      body = body.trim();
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
