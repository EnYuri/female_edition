import { feLocalize } from "./fe-i18n.js";
// Archive HTML-snapshot production for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Owns the "self-contained HTML file" concern:
// stylesheet inlining (@import + <link> phases), data-URL font embedding, image
// embedding + dedup, blob assembly, and the download/external-browser paths.
// Split out so the archive entry module keeps the render/print orchestration.
//
// The three shared low-level utils it needs (feEscapeAttr, feGetFoundryBaseHref,
// feRunArchiveDocumentOperation) live in fe-archive-output.js so both this module
// and the entry module import them from there — avoiding a circular import.
import { MODULE_ID, S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";
import {
  feFreezeMessageBackgroundsForPrint,
  feDownscaleImagesForPrint,
} from "./fe-archive-image.js";
import {
  feInjectExportFontReadyBootstrap,
  feNormalizeArchiveShellLayout,
  feNormalizeArchiveMessageLayout,
  feIsElement,
  feEscapeAttr,
  feGetFoundryBaseHref,
  feRunArchiveDocumentOperation,
  feBuildArchiveTitleText,
} from "./fe-archive-output.js";

import {
  feRewriteSnapshotCSSURLs,
  feParseCssImports,
  feAssembleInlinedStyleBlock,
} from "./fe-archive-css.js";
import {
  feUpgradePortraitsForExport,
  feEmbedImagesInNode,
  fePrepareBodyForHTMLSnapshot,
  feSerializeBodyToParts,
} from "./fe-archive-assets.js";
import {
  FE_EXPORT_EMBED_CONCURRENCY,
  feFetchAsDataURLCapped,
  feFetchWithTimeout,
  feSnapshotAssetIsSameOrigin,
  feSnapshotFetchCredentials,
  feSnapshotIsAllowedFontCdn,
} from "./fe-archive-fetch.js";
import {
  feBuildEmbeddedCookieRunFontCSS,
} from "./fe-archive-fonts.js";


// ===========================================================================
// Constants (export-snapshot only)
// ===========================================================================

const FE_EXPORT_STYLESHEET_FETCH_TIMEOUT = 8000;
const FE_EXPORT_STYLESHEET_MAX_BYTES = 2_000_000;
const FE_EXPORT_STYLESHEET_TOTAL_BYTES = 10_000_000;

// CSS `url()` asset embedding (see feEmbedSnapshotCssAssets).
//
// Font cap must cover the module's own font/ faces (CookieRun .otf are 929-978KB) and
// the largest CDN face we can select (Mona12-Bold.woff2, 1_304_316B). Keep at parity
// with MAX_PER_FILE_BYTES_COOKIE in feBuildEmbeddedCookieRunFontCSS. Do NOT raise past
// ~1.4MB to catch Geurimilgi (6.3MB TTF) — base64 expansion is an OOM risk there, and
// the "커스텀 폰트 임베드" setting already routes it through a separate 7MB allowance.
//
// The tight image cap is deliberate: chat-relevant art (small SVGs, badge webps) fits,
// while decorative sheet banners never visible in a message fall out for free.
const FE_EXPORT_ASSET_FONT_MAX_BYTES = 1_400_000;
const FE_EXPORT_ASSET_IMAGE_MAX_BYTES = 160_000;
// SEPARATE totals, not one shared pool — otherwise fonts (~4.3MB for the Mona family
// alone) crowd out images. A missing face is unreadable text; a missing image is
// cosmetic. Only faces the document actually uses are fetched, so the headroom exists
// so a late-admitted font is not dropped by a budget earlier faces already spent.
const FE_EXPORT_ASSET_FONT_TOTAL_BYTES = 12_000_000;
const FE_EXPORT_ASSET_IMAGE_TOTAL_BYTES = 8_000_000;
const FE_EXPORT_ASSET_FONT_EXT_RE = /\.(?:woff2?|ttf|otf|eot)(?:[?#]|$)/i;
const FE_EXPORT_ASSET_IMAGE_EXT_RE = /\.(?:svg|png|webp|jpe?g|gif|avif)(?:[?#]|$)/i;

// Cross-origin webfont embedding. Three of ui-font.css's six font modes (NeoDGM Pro,
// Mona, Galmuri) load from a CDN, so a same-origin-only snapshot fell back to a system
// face offline while the local CookieRun/Geurimilgi modes embedded fine.
//
// The gate is an explicit HOST ALLOWLIST, never "any cross-origin URL" — a snapshot must
// not become a crawler for whatever host a stylesheet names. jsdelivr qualifies because
// ui-font.css chose it and it answers with `Access-Control-Allow-Origin: *`.
//
// Three deliberate narrowings: fonts only (a missing image is cosmetic); woff2 only
// (webfont CSS lists woff2/woff/ttf as a ladder no modern browser walks past the first
// rung of); and only families `document.fonts` reports as actually loaded (see
// feCollectLoadedFontFamilies) — the modes are mutually exclusive, so otherwise a
// CookieRun export would still carry ~4.3MB of unused Mona.
const FE_EXPORT_ASSET_WOFF2_RE = /\.woff2(?:[?#]|$)/i;
const FE_EXPORT_FONT_FACE_RE = /@font-face\s*\{([^}]*)\}/gi;
const FE_EXPORT_FONT_FAMILY_DECL_RE = /(?:^|[;{])\s*font-family\s*:\s*([^;}]+)/i;
// Same shape as feRewriteSnapshotCSSURLs' matcher — kept local so the two stay
// independently readable; this one only READS urls, it never rewrites in place.
const FE_EXPORT_CSS_URL_RE = /url\(\s*(["']?)([^"')]+)\1\s*\)/gi;
// The same thing as it appears in SERIALIZED HTML, where a style attribute's inner
// quotes are entity-escaped: `style="background: url(&quot;http://…&quot;)"`. Group 1
// is the whole quote token so the replacement can put back what it found.
const FE_EXPORT_HTML_STYLE_URL_RE = /url\(\s*(&quot;|&#0?39;|["'])?([^"')]+?)\1?\s*\)/gi;
// A serialized `style="…"` attribute. outerHTML always emits double quotes and
// entity-escapes any inner `"`, so `[^"]*` cannot run past the attribute's end.
const FE_EXPORT_HTML_STYLE_ATTR_RE = /style="([^"]*)"/gi;


// ===========================================================================
// Resource fetch + filename helpers
// ===========================================================================


function feSanitizeExportFilename(name, fallback = "chat-log") {
  return (
    String(name || "")
      .replaceAll(/[^a-zA-Z0-9ㄱ-힝\-_. ]+/g, "_")
      .trim()
      .slice(0, 80) || fallback
  );
}

/**
 * Serialize an element's attributes back into an HTML attribute string.
 *
 * Returns `""` or a string with a LEADING SPACE (` lang="ko" class="…"`), so it can
 * be interpolated straight into `<html%s>` / `<body%s>`.
 *
 * Used for the saved file's `<html>` and `<body>` open tags — the snapshot must
 * preserve `lang`, `class` and every `data-*` the live document carried, because
 * the inlined stylesheets resolve their variables against exactly those.
 */
function feSerializeElementAttributes(el) {
  try {
    const attrs = Array.from(el?.attributes ?? []).map((a) => {
      const n = String(a?.name ?? "");
      const v = feEscapeAttr(String(a?.value ?? ""));
      return n ? `${n}="${v}"` : "";
    }).filter(Boolean);
    return attrs.length ? " " + attrs.join(" ") : "";
  } catch {
    return "";
  }
}


// ===========================================================================
// HTML Snapshot Export  (blob build, download, external browser)
// ===========================================================================

// Fetch one same-origin stylesheet's text under the per-file size cap.
// Returns { cssText, bytes } or null. Shared by both inlining phases below.
async function feFetchSnapshotStylesheet(absolute) {
  try {
    const fetched = await feFetchWithTimeout(
      absolute,
      { credentials: feSnapshotFetchCredentials(absolute) },
      FE_EXPORT_STYLESHEET_FETCH_TIMEOUT,
      async (response) => {
        if (!response.ok) return null;
        const declaredBytes = Number(response.headers.get("content-length") || 0);
        if (Number.isFinite(declaredBytes) && declaredBytes > FE_EXPORT_STYLESHEET_MAX_BYTES) return null;
        return { cssText: await response.text() };
      }
    );
    if (!fetched) return null;
    const bytes = new TextEncoder().encode(fetched.cssText).byteLength;
    if (bytes > FE_EXPORT_STYLESHEET_MAX_BYTES) return null;
    return { cssText: fetched.cssText, bytes };
  } catch {
    return null;
  }
}

async function feInlineSnapshotStylesheets(headClone, doc, setMeta = () => {}) {
  const baseURL = doc?.baseURI || window.location.href;
  // Shared byte budget across BOTH phases so a huge core <link> can't crowd out
  // the module styles (Phase A runs first, so module CSS is admitted first).
  const budget = { admitted: 0 };
  const sameOrigin = (abs) => {
    try { return new URL(abs).origin === window.location.origin; } catch { return false; }
  };

  setMeta(feLocalize("FE.ChatArchive.Status.EmbeddingStyles"));

  // -----------------------------------------------------------------------
  // Phase A: module/system stylesheets that Foundry injects as
  // `@import "..." layer(...)` inside a <style> block (NOT as <link>s — see
  // fe-archive-css.js). Without this, the saved standalone HTML keeps raw
  // relative @imports that cannot resolve offline: every fe-* sheet (and the
  // fonts they apply) vanishes, breaking the layout and the PDF font embed.
  // -----------------------------------------------------------------------
  let styleBlocks = [];
  try {
    styleBlocks = Array.from(headClone?.querySelectorAll?.("style") ?? [])
      .filter((el) => /@import/i.test(el.textContent || ""));
  } catch {
    styleBlocks = [];
  }

  if (styleBlocks.length) {
    const resolveAbs = (raw) => {
      try { return new URL(raw, baseURL).href; } catch { return String(raw ?? ""); }
    };

    // Unique same-origin, non-media @import URLs across all blocks, first-seen order.
    const importOrder = [];
    const seen = new Set();
    for (const el of styleBlocks) {
      for (const imp of feParseCssImports(el.textContent || "")) {
        if (imp.media) continue;
        const abs = resolveAbs(imp.url);
        if (seen.has(abs)) continue;
        seen.add(abs);
        if (!sameOrigin(abs)) continue;
        importOrder.push(abs);
      }
    }

    const fetchedByUrl = new Map();
    const fetchInto = async (urls) => {
      let next = 0;
      const worker = async () => {
        while (true) {
          const i = next++;
          if (i >= urls.length) return;
          const abs = urls[i];
          const got = await feFetchSnapshotStylesheet(abs);
          if (got) fetchedByUrl.set(abs, got);
        }
      };
      await Promise.all(Array.from({ length: Math.min(4, urls.length) }, () => worker()));
    };
    await fetchInto(importOrder);

    // SECOND ROUND — nested imports. ui-font.css reaches the NeoDGM Pro webfont
    // through `@import url("https://cdn.jsdelivr.net/…/style.css")`, a URL that
    // cannot be known until ui-font.css itself has been fetched, which is why this
    // cannot fold into the pass above. Without it feAssembleInlinedStyleBlock has
    // nothing to inline for that import and hoists it as a network @import, leaving
    // the saved file dependent on the CDN for that font mode.
    //
    // Only allowlisted webfont hosts are followed, and only one level deep: a
    // stylesheet reached this way is third-party, and chasing its imports
    // recursively would be an unbounded walk of someone else's CSS graph.
    const nestedOrder = [];
    for (const abs of importOrder) {
      const got = fetchedByUrl.get(abs);
      if (!got) continue;
      for (const imp of feParseCssImports(got.cssText)) {
        if (imp.media || imp.layer) continue;
        let nestedAbs = "";
        try { nestedAbs = new URL(imp.url, abs).href; } catch { continue; }
        if (seen.has(nestedAbs)) continue;
        seen.add(nestedAbs);
        if (!feSnapshotIsAllowedFontCdn(nestedAbs)) continue;
        nestedOrder.push(nestedAbs);
      }
    }
    if (nestedOrder.length) await fetchInto(nestedOrder);
    const nestedSet = new Set(nestedOrder);

    // Admit in first-seen order so the byte cap cannot race the cascade order.
    // Nested imports come last: they are leaves, and a byte budget spent on one
    // must never cost a top-level sheet that other rules depend on.
    const inlinedByUrl = new Map();
    for (const abs of [...importOrder, ...nestedOrder]) {
      const got = fetchedByUrl.get(abs);
      if (!got || budget.admitted + got.bytes > FE_EXPORT_STYLESHEET_TOTAL_BYTES) continue;
      inlinedByUrl.set(abs, feRewriteSnapshotCSSURLs(got.cssText, abs));
      budget.admitted += got.bytes;
    }

    for (const el of styleBlocks) {
      try {
        const { text, rebuilt, mixed } = feAssembleInlinedStyleBlock(el.textContent || "", {
          resolveAbs,
          getInlinedCss: (abs) => (inlinedByUrl.has(abs) ? inlinedByUrl.get(abs) : null),
          // Nested imports may resolve ONLY to the allowlisted webfont sheets. Handing
          // the full map here would inline a same-origin sheet's body a second time
          // whenever one stylesheet @imports another that is also top-level.
          getNestedInlinedCss: (abs) =>
            nestedSet.has(abs) && inlinedByUrl.has(abs) ? inlinedByUrl.get(abs) : null,
        });
        // A non-rebuilt block is left intact but still gets its relative
        // @import/url() refs absolutized so it loads online.
        //
        // A MIXED block (imports inlined in place, real rules left where they were)
        // needs that same pass: only the inlined bodies were url-rewritten, against
        // their own sheet URL — the residual rules Foundry wrote inline never were.
        // Re-running it over the whole block is safe because absolutizing an
        // already-absolute url() is a no-op.
        if (rebuilt) el.textContent = mixed ? feRewriteSnapshotCSSURLs(text, baseURL) : text;
        else el.textContent = feRewriteSnapshotCSSURLs(el.textContent || "", baseURL);
      } catch {
        // Leave the block untouched if assembly throws.
      }
    }
  }

  // -----------------------------------------------------------------------
  // Phase B: real <link rel="stylesheet"> elements (mostly core CSS).
  // -----------------------------------------------------------------------
  let links = [];
  try {
    links = Array.from(headClone?.querySelectorAll?.('link[rel="stylesheet"]') ?? []);
  } catch {
    links = [];
  }
  if (!links.length) return;

  let nextIndex = 0;
  const results = new Array(links.length).fill(null);

  const worker = async () => {
    while (true) {
      const index = nextIndex++;
      if (index >= links.length) return;
      const link = links[index];
      try {
        if (link.getAttribute("data-fe-disabled-link") === "1" || link.getAttribute("media") === "not all") continue;
        const href = link.getAttribute("href");
        if (!href) continue;
        const absolute = new URL(href, baseURL).href;
        if (!sameOrigin(absolute)) continue;
        const got = await feFetchSnapshotStylesheet(absolute);
        if (got) results[index] = { absolute, cssText: got.cssText, bytes: got.bytes };
      } catch {
        // Keep the original <link> when a stylesheet cannot be captured.
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(4, links.length) }, () => worker()));

  // Admission and replacement stay in document order so the byte cap cannot
  // race and the original cascade order is preserved exactly.
  for (let index = 0; index < links.length; index += 1) {
    const result = results[index];
    if (!result || budget.admitted + result.bytes > FE_EXPORT_STYLESHEET_TOTAL_BYTES) continue;
    try {
      const link = links[index];
      const style = doc.createElement("style");
      style.setAttribute("data-fe-inline-stylesheet", result.absolute);
      const media = link.getAttribute("media");
      if (media) style.setAttribute("media", media);
      style.textContent = feRewriteSnapshotCSSURLs(result.cssText, result.absolute);
      link.replaceWith(style);
      budget.admitted += result.bytes;
    } catch {
      // A failed replacement leaves the original link intact.
    }
  }
}


/**
 * The font families the archive document actually resolved, lowercased.
 *
 * `document.fonts` is a live FontFaceSet whose entries carry a `status` of
 * "unloaded" / "loading" / "loaded" / "error". By the time a snapshot is built the
 * window has rendered the whole chat log, so a family that is "loaded" is one that
 * really painted glyphs, and one still "unloaded" is a face the browser never
 * needed — the lazy-load behaviour of @font-face makes this precise rather than a
 * heuristic.
 *
 * Returns an empty set on any failure, which the callers treat as "embed nothing
 * extra" — i.e. the pre-existing same-origin-only behaviour.
 */
function feCollectLoadedFontFamilies(doc) {
  const out = new Set();
  try {
    for (const face of doc?.fonts ?? []) {
      if (face?.status !== "loaded") continue;
      const family = String(face.family ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (family) out.add(family);
    }
  } catch {
    return out;
  }
  return out;
}

/**
 * Cross-origin webfont URLs that may be embedded: every woff2 named by an
 * `@font-face` whose `font-family` is in `loadedFamilies` and whose host is on the
 * allowlist. Returns a Set of absolute URLs exactly as written in the CSS.
 */
function feCollectSnapshotCdnFontUrls(styleEls, loadedFamilies) {
  const allow = new Set();
  if (!loadedFamilies?.size) return allow;

  for (const el of styleEls) {
    const text = el?.textContent || "";
    if (!text.includes("@font-face")) continue;
    FE_EXPORT_FONT_FACE_RE.lastIndex = 0;
    for (let face = FE_EXPORT_FONT_FACE_RE.exec(text); face !== null; face = FE_EXPORT_FONT_FACE_RE.exec(text)) {
      const body = face[1] || "";
      const familyMatch = FE_EXPORT_FONT_FAMILY_DECL_RE.exec(body);
      if (!familyMatch) continue;
      const family = String(familyMatch[1] ?? "").trim().replace(/^["']|["']$/g, "").toLowerCase();
      if (!family || !loadedFamilies.has(family)) continue;

      FE_EXPORT_CSS_URL_RE.lastIndex = 0;
      for (let m = FE_EXPORT_CSS_URL_RE.exec(body); m !== null; m = FE_EXPORT_CSS_URL_RE.exec(body)) {
        const url = String(m[2] ?? "").trim();
        if (!FE_EXPORT_ASSET_WOFF2_RE.test(url)) continue;
        if (!feSnapshotIsAllowedFontCdn(url)) continue;
        allow.add(url);
      }
    }
  }
  return allow;
}

/**
 * Shared fetch/dedup/budget state for the asset-embedding passes.
 *
 * Created once per snapshot and handed to BOTH passes so a URL referenced from a
 * <style> block and from an inline style attribute is fetched once and embedded
 * once, and so the byte budgets are global rather than per-pass.
 */
function feCreateSnapshotAssetStore() {
  const embedded = new Map(); // url string (as written) -> data URL
  const spent = { font: 0, image: 0 };

  const admit = async (urls, kind) => {
    const fresh = urls.filter((u) => !embedded.has(u));
    if (!fresh.length) return;
    const perFileCap = kind === "font" ? FE_EXPORT_ASSET_FONT_MAX_BYTES : FE_EXPORT_ASSET_IMAGE_MAX_BYTES;
    const totalCap = kind === "font" ? FE_EXPORT_ASSET_FONT_TOTAL_BYTES : FE_EXPORT_ASSET_IMAGE_TOTAL_BYTES;

    let next = 0;
    const results = new Array(fresh.length).fill(null);
    const worker = async () => {
      while (true) {
        const i = next++;
        if (i >= fresh.length) return;
        // Cannot pre-check the budget here (workers race); admission below is what
        // enforces it, and a fetch we then decline costs only bandwidth.
        try {
          results[i] = await feFetchAsDataURLCapped(fresh[i], perFileCap);
        } catch {
          results[i] = null;
        }
      }
    };
    await Promise.all(
      Array.from({ length: Math.min(FE_EXPORT_EMBED_CONCURRENCY, fresh.length) }, () => worker())
    );

    // Admission stays in first-seen order so it is deterministic across runs.
    for (let i = 0; i < fresh.length; i += 1) {
      const got = results[i];
      if (!got?.dataUrl) continue;
      if (spent[kind] + got.bytes > totalCap) continue;
      embedded.set(fresh[i], got.dataUrl);
      spent[kind] += got.bytes;
    }
  };

  return { embedded, spent, admit };
}

/**
 * Split a list of candidate URLs into font/image groups, dropping anything that is
 * already self-contained, cross-origin, or not a recognised asset type.
 */
function feClassifySnapshotAssetUrls(urls, cdnFontAllow = null) {
  const fonts = [];
  const images = [];
  const seen = new Set();
  for (const raw of urls) {
    const value = String(raw ?? "").trim();
    if (!value || value.startsWith("data:") || value.startsWith("blob:") || value.startsWith("#")) continue;
    if (seen.has(value)) continue;
    seen.add(value);
    if (!feSnapshotAssetIsSameOrigin(value)) {
      // The ONLY cross-origin escape hatch, and it is pre-vetted: membership in
      // `cdnFontAllow` already means allowlisted host + woff2 + a family the
      // document loaded (feCollectSnapshotCdnFontUrls). Nothing is re-decided here.
      if (cdnFontAllow?.has(value)) fonts.push(value);
      continue;
    }
    if (FE_EXPORT_ASSET_FONT_EXT_RE.test(value)) fonts.push(value);
    else if (FE_EXPORT_ASSET_IMAGE_EXT_RE.test(value)) images.push(value);
  }
  return { fonts, images };
}

async function feEmbedSnapshotCssAssets(headClone, doc, setMeta = () => {}, store = null) {
  const assets = store || feCreateSnapshotAssetStore();
  let styleEls = [];
  try {
    styleEls = Array.from(headClone?.querySelectorAll?.("style") ?? []);
  } catch {
    return;
  }
  if (!styleEls.length) return;

  // ---- Collect: unique candidate URLs, in first-seen order, classified. ----
  const found = [];
  for (const el of styleEls) {
    const text = el.textContent || "";
    if (!text.includes("url(")) continue;
    FE_EXPORT_CSS_URL_RE.lastIndex = 0;
    for (let m = FE_EXPORT_CSS_URL_RE.exec(text); m !== null; m = FE_EXPORT_CSS_URL_RE.exec(text)) {
      found.push(m[2]);
    }
  }
  // Cross-origin webfonts are opt-in per URL and decided here, from the SAME style
  // elements — the allowlist has to be built against the CSS that is actually in the
  // snapshot, not against the live document's sheets.
  //
  // Settle the font set first. The allowlist reads `status === "loaded"`, and a face
  // still "loading" would be read as "unused" and silently dropped from the saved
  // file. The print path already waits (feWaitForFonts before window.print()); the
  // HTML-save path never did, and normally does not need to — the window has been on
  // screen since the user opened it — so this is a cheap guard, not a real wait.
  try {
    const ready = doc?.fonts?.ready;
    if (ready) await Promise.race([ready, new Promise((resolve) => setTimeout(resolve, 1500))]);
  } catch {
    // A rejected/absent FontFaceSet just means we classify on what is loaded now.
  }
  const cdnFontAllow = feCollectSnapshotCdnFontUrls(styleEls, feCollectLoadedFontFamilies(doc));
  const { fonts, images } = feClassifySnapshotAssetUrls(found, cdnFontAllow);
  if (!fonts.length && !images.length) return;

  setMeta(feLocalize("FE.ChatArchive.Status.EmbeddingCssAssets"));

  // Fonts FIRST so a large decorative image can never crowd out a face whose
  // absence would leave unreadable text. (They have separate budgets now, so this
  // is ordering for latency/predictability rather than for contention.)
  await assets.admit(fonts, "font");
  await assets.admit(images, "image");

  if (!assets.embedded.size) return;

  // ---- Substitute. A data URL contains no unescaped `)`, so re-emitting it in
  // quotes keeps the declaration parseable. ----
  for (const el of styleEls) {
    const text = el.textContent || "";
    if (!text.includes("url(")) continue;
    try {
      el.textContent = text.replace(FE_EXPORT_CSS_URL_RE, (match, quote, raw) => {
        const dataUrl = assets.embedded.get(String(raw ?? "").trim());
        return dataUrl ? `url("${dataUrl}")` : match;
      });
    } catch {
      // Leave the block untouched — the absolute URLs it still holds are the
      // pre-existing behaviour, not a regression.
    }
  }
}

/**
 * Embed the `url()` assets referenced from INLINE STYLE ATTRIBUTES in the serialized
 * body, and return the rewritten parts.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE <style> PASS (measured 2026-08-12 on
 * "Chat Log – Death Wish Blues"):
 * feMirrorLiveMessageStyles copies the live sidebar's COMPUTED styles onto cloned
 * messages as an inline `!important` style attribute, and `background-image` is one
 * of the mirrored properties. A computed background-image serializes as an ABSOLUTE
 * URL, so a cloned dice roll carries
 *     style="… background: url(&quot;http://localhost:30000/icons/svg/d20-grey.svg&quot;) … !important"
 * Being inline and `!important`, that beats dnd5e's own rule — whose die art the
 * <style> pass DID embed as a data URL. Offline the inline URL 404s, so the die
 * shapes behind d4/d6/d8/d10/d12/d20 simply disappear while everything around them
 * looks correct. The <style> pass could not see it: it only reads <style> text.
 *
 * Operates on the SERIALIZED HTML STRINGS, not the DOM. Rewriting the live archive
 * document's style attributes would need an undo path (the popup stays open and the
 * user keeps looking at it); a string pass has nothing to restore and cannot leak.
 *
 * ONLY ABSOLUTE same-origin URLs are embedded. A relative one in an inline style is
 * unresolvable here on purpose: those come from CSS CUSTOM PROPERTIES, whose values
 * are copied as raw token streams and are relative to the STYLESHEET that declared
 * them, not to the document. dnd5e's `--dnd5e-*: url(ui/texture-gray1.webp)` really
 * means `systems/dnd5e/ui/texture-gray1.webp`, and resolving it against the document
 * base would silently embed the wrong file (or 404). They keep working online via
 * <base href>, exactly as before.
 */
async function feEmbedSnapshotInlineStyleAssets(bodyParts, setMeta = () => {}, store = null) {
  const parts = Array.isArray(bodyParts) ? bodyParts : [];
  if (!parts.length || !store) return parts;

  // Scan/rewrite ONLY inside `style="…"` attribute values — never bare `url(` in the
  // body text. A <style> ELEMENT is a raw-text node where `&quot;` is NOT decoded, so
  // emitting an entity-quoted url() into one would produce a broken declaration.
  // Restricting both phases to the attribute makes the escaping unambiguous.
  const found = [];
  for (const part of parts) {
    const text = String(part ?? "");
    if (!text.includes("url(")) continue;
    FE_EXPORT_HTML_STYLE_ATTR_RE.lastIndex = 0;
    for (let a = FE_EXPORT_HTML_STYLE_ATTR_RE.exec(text); a !== null; a = FE_EXPORT_HTML_STYLE_ATTR_RE.exec(text)) {
      const value = a[1];
      if (!value.includes("url(")) continue;
      FE_EXPORT_HTML_STYLE_URL_RE.lastIndex = 0;
      for (let m = FE_EXPORT_HTML_STYLE_URL_RE.exec(value); m !== null; m = FE_EXPORT_HTML_STYLE_URL_RE.exec(value)) {
        found.push(m[2]);
      }
    }
  }
  const { fonts, images } = feClassifySnapshotAssetUrls(found);
  if (!fonts.length && !images.length) return parts;

  setMeta(feLocalize("FE.ChatArchive.Status.EmbeddingInlineAssets"));
  await store.admit(fonts, "font");
  await store.admit(images, "image");
  if (!store.embedded.size) return parts;

  return parts.map((part) => {
    const text = String(part ?? "");
    if (!text.includes("url(")) return part;
    try {
      return text.replace(FE_EXPORT_HTML_STYLE_ATTR_RE, (attrMatch, value) => {
        if (!value.includes("url(")) return attrMatch;
        const rewritten = value.replace(FE_EXPORT_HTML_STYLE_URL_RE, (match, quote, raw) => {
          const dataUrl = store.embedded.get(String(raw ?? "").trim());
          if (!dataUrl) return match;
          // Always entity-escaped: we are inside a double-quoted HTML attribute, so a
          // literal `"` would terminate it and leak the rest of the declaration into
          // the markup. A data URL itself contains no `"`, `)` or `&`.
          return `url(&quot;${dataUrl}&quot;)`;
        });
        return rewritten === value ? attrMatch : `style="${rewritten}"`;
      });
    } catch {
      return part;
    }
  });
}

async function feBuildArchiveHTMLSnapshotBlob(win, titleText = "Chat Log", { meta, bodyRoot = null } = {}) {
  if (!win || win.closed) throw new Error("Archive window is closed");
  const setMeta = typeof meta === "function" ? meta : () => {};

  const doc = win.document;
  const snapshotRoot = feIsElement(bodyRoot) ? bodyRoot : doc.body;
  const scopedBody = snapshotRoot !== doc.body;
  const bodyAttrs = feSerializeElementAttributes(doc.body);
  const serializeSnapshotRoot = () => {
    const parts = feSerializeBodyToParts(snapshotRoot);
    return scopedBody ? [`<body${bodyAttrs}>`, ...parts, "</body>"] : parts;
  };

  // IMPORTANT (memory):
  // Do NOT deep-clone the full <html> tree for large logs.
  // Cloning thousands of chat messages can easily OOM Chromium/Electron.
  // Instead, clone only <head> (small) and serialize <body> directly.

  // ---
  // Head snapshot
  // ---
  const headClone = (doc.head ? doc.head.cloneNode(true) : doc.createElement("head"));

  // A scoped inline snapshot originates from Foundry's real application
  // document, whose <head> contains boot/module scripts. The archive needs its
  // styles and metadata, never executable application code. Popup/iframe heads
  // are already purpose-built, but applying this only to scoped snapshots keeps
  // the distinction explicit and prevents a saved chat file from booting Foundry.
  if (scopedBody) {
    try {
      headClone.querySelectorAll?.('script, noscript, link[rel="modulepreload"], link[rel="preload"][as="script"]')
        .forEach((el) => el.remove());
    } catch {}
  }

  // Ensure a stable <base> so relative URLs resolve when opening as file://
  try {
    const baseHref = (() => {
      try {
        const b = doc.querySelector?.("base")?.getAttribute?.("href") || doc.querySelector?.("base")?.href;
        if (b) return String(b);
      } catch {}
      return feGetFoundryBaseHref();
    })();

    let baseEl = headClone.querySelector?.("base");
    if (!baseEl) {
      baseEl = doc.createElement("base");
      headClone.prepend(baseEl);
    }
    baseEl.setAttribute?.("href", baseHref);
  } catch {}

  // Ensure title is correct
  try {
    let t = headClone.querySelector?.("title");
    if (!t) {
      t = doc.createElement("title");
      headClone.appendChild(t);
    }
    t.textContent = titleText;
  } catch {}

  // Make stylesheet hrefs absolute (helps when opening as file://)
  try {
    const baseForLinks = doc.baseURI ?? window.location.href;
    headClone.querySelectorAll?.('link[rel="stylesheet"]').forEach((l) => {
      try {
        const href = l.getAttribute("href");
        if (!href) return;
        l.setAttribute("href", new URL(href, baseForLinks).href);
      } catch {}
    });
  } catch {}

  // Preserve runtime stylesheet toggles in the saved HTML snapshot.
  // (HTMLLinkElement.disabled does not serialize.)
  try {
    const enableFonts = (() => {
      try {
        return !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS);
      } catch {
        return true;
      }
    })();

    if (!enableFonts) {
      const needleAbs = `/modules/${MODULE_ID}/styles/ui-font.css`;
      const needleRel = `modules/${MODULE_ID}/styles/ui-font.css`;
      headClone.querySelectorAll?.('link[rel="stylesheet"]').forEach((l) => {
        try {
          const href = l.getAttribute("href") || "";
          if (href.includes(needleAbs) || href.includes(needleRel)) l.remove();
        } catch {}
      });
    }
  } catch {}

  await feInlineSnapshotStylesheets(headClone, doc, setMeta);

  // Must run AFTER inlining (it operates on the inlined CSS text) and BEFORE the
  // embedded-font <style> is appended below — that block is already data: URLs and
  // its cross-origin NeoDGM @import is not ours to touch.
  //
  // The store is shared with feEmbedSnapshotInlineStyleAssets after the body is
  // serialized, so an asset referenced from both a <style> block and a mirrored
  // inline style attribute is fetched once and counted against the budget once.
  const assetStore = feCreateSnapshotAssetStore();
  await feEmbedSnapshotCssAssets(headClone, doc, setMeta, assetStore);

  // Embed custom fonts (optional).
  if (feSetting(S.EXPORT_EMBED_FONTS)) {
    try {
      setMeta(feLocalize("FE.ChatArchive.Status.EmbeddingFonts"));
      const fontCss = await feBuildEmbeddedCookieRunFontCSS();
      if (fontCss) {
        const styleEl = doc.createElement("style");
        styleEl.id = "fe-export-embedded-fonts";
        styleEl.textContent = fontCss;
        headClone.appendChild(styleEl);
        feInjectExportFontReadyBootstrap(headClone, doc);
      }
    } catch (err) {
      console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feBuildArchiveHTMLSnapshotBlob"), err);
    }
  }

  // ---
  // Body snapshot
  // ---
  let bodyParts = [""];
  const embedFonts = !!feSetting(S.EXPORT_EMBED_FONTS);
  const liveLogEl = snapshotRoot.matches?.("#fe-chat-export-log, #chat-log, ol.chat-log")
    ? snapshotRoot
    : snapshotRoot.querySelector?.("#fe-chat-export-log, #chat-log, ol.chat-log");
  const restoreBg = feFreezeMessageBackgroundsForPrint(win, liveLogEl);
  const restoreShell = feNormalizeArchiveShellLayout(doc, { restore: true, root: scopedBody ? snapshotRoot : null });
  const restoreLayout = feNormalizeArchiveMessageLayout(snapshotRoot, { restore: true });
  try {
    if (feSetting(S.EXPORT_EMBED_IMAGES)) {
      // Image embedding mutates img src/srcset to data: URLs. Apply in-place + revert
      // afterwards instead of cloning the entire body (cloning a large log doubles
      // the DOM tree in V8 heap right when we're about to allocate a giant outerHTML
      // string and a Blob).
      //
      // Declared OUT here, not inside the try: the fallback below runs on the LIVE
      // archive document, so an exception thrown anywhere between the upgrade and the
      // inner finally would otherwise leave every portrait permanently swapped to its
      // export bitmap (and marked data-fe-export-portrait) in the window the user is
      // still looking at, with no reference left to undo it.
      let portraitRestore = () => {};
      try {
        // Portraits first: re-resample each one from its ORIGINAL file at export
        // resolution. The data: URL currently on the element is sized for THIS screen
        // (size × dpr — 64px on a dpr-1 machine) and turns blocky the moment the saved
        // file is printed or zoomed. See feUpgradePortraitsForExport.
        portraitRestore = await feUpgradePortraitsForExport(snapshotRoot, { meta: setMeta }) || (() => {});
        setMeta(feLocalize("FE.ChatArchive.Status.EmbeddingImages"));
        // keepSelfContainedSrc: a portrait already showing a data: URL (the upgrade above,
        // or — only when the upgrade could not run at all, e.g. a dead source or a spent
        // budget — the live HQ result) stays as-is. A source the upgrade merely could not
        // IMPROVE on no longer lands here: it is pinned to its original file and marked, so
        // this keeps its hands off it entirely.
        // Restoring the original file path would push a full-resolution
        // image into the embed budget (and past its per-image cap), which is how
        // portraits ended up as absolute Foundry URLs — broken for every reader
        // but the exporter.
        const prepRestore = fePrepareBodyForHTMLSnapshot(snapshotRoot, { embedFonts, keepSelfContainedSrc: true });
        // P4: downscale images to small data: URLs BEFORE embedding. feEmbedImagesInNode
        // skips anything already `data:`, so this both shrinks the embedded payload
        // (far more images fit under the byte budget → better offline fidelity) and
        // cuts the saved-file size. maxTotalBytes guards against ballooning the HTML;
        // groups beyond the budget keep their original src and fall through to the
        // remote/embed path below. useBlobURL:false → real data: URLs that serialize.
        // Shared image-byte budget for the saved HTML. Pre-embed downscaling
        // spends part of it (dsStats.bytesUsed); feEmbedImagesInNode gets only
        // what's left so downscaled + leftover-embedded images never exceed it.
        // Shared ceiling for downscaled + embedded bytes. Overflowing it is not "a
        // smaller file", it is images that only load on this machine (the saved HTML
        // falls back to an absolute http://<foundry-host>/ src).
        // 12MB → 24MB → 250MB. The last raise is an explicit user decision
        // (2026-08-12): size does not matter, offline completeness does. Sized to
        // carry 4-5x the 1900-message log measured that day — see the matching note
        // on MAX_TOTAL_BYTES in feEmbedImagesInNode for the measurement.
        const HTML_EMBED_TOTAL_BYTES = 250_000_000;
        const dsStats = {};
        let downscaleRestore = () => {};
        try {
          const embedLogEl = snapshotRoot.matches?.("#fe-chat-export-log, #chat-log, ol.chat-log")
            ? snapshotRoot
            : snapshotRoot.querySelector?.("#fe-chat-export-log, #chat-log, ol.chat-log");
          if (embedLogEl) {
            downscaleRestore = await feDownscaleImagesForPrint(win, embedLogEl, {
              meta: setMeta,
              useBlobURL: false,
              maxTotalBytes: HTML_EMBED_TOTAL_BYTES,
              stats: dsStats,
              dprCap: 1.5,
              minDpr: 1.0,
              webpQuality: 0.85,
              jpegQuality: 0.88,
              avatarDprCap: 1.5,
              avatarWebpQuality: 0.82,
              avatarJpegQuality: 0.84,
              maxSide: 1600,
              concurrency: 4,
              // Portraits restored to their original file path are mid-load here;
              // the grouping loop skips `!complete` images, so they would escape
              // downscaling entirely and reach the embed pass at full resolution.
              waitForPendingMs: 8000,
            });
          }
        } catch (e) {
          console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feBuildArchiveHTMLSnapshotBlob2"), e);
        }
        const embedRestore = await feEmbedImagesInNode(snapshotRoot, {
          meta: setMeta,
          maxTotalBytes: Math.max(0, HTML_EMBED_TOTAL_BYTES - (dsStats.bytesUsed || 0)),
        });
        // Duplicated portrait bitmaps are NOT a problem left to solve here: the embed
        // pass ends in feDeduplicateInlineDataUrlsInNode, which keeps one copy of each
        // distinct data: URL and strips `src` from the rest, restoring them on open via
        // a tiny data-fe-img-ref bootstrap. VERIFIED 2026-08-05 on a 137-message export:
        // 134 portraits, 7 distinct bitmaps, "Deduplicated 127 inline image(s) (~3.0MB
        // saved)", and the saved file renders 134/134. A second sharing mechanism was
        // written here (one CSS background rule per bitmap) and removed — running after
        // the dedup pass it saw seven groups of one and never emitted a single rule.
        try {
          bodyParts = serializeSnapshotRoot();
        } finally {
          try { embedRestore?.(); } catch {}
          try { downscaleRestore?.(); } catch {}
          try { prepRestore?.(); } catch {}
          try { portraitRestore?.(); } catch {}
          // Consumed. A throw from serializeSnapshotRoot() runs this finally AND
          // then the fallback branch below, which owns the same closure — without
          // this the undo ran twice. It is idempotent today (the second pass
          // re-writes already-restored srcs over an emptied blob-URL set), so this
          // is not a live bug; it is removing the reliance on that.
          portraitRestore = () => {};
        }
      } catch (err) {
        console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feBuildArchiveHTMLSnapshotBlob3"), err);
        // Fallback: still produce a valid snapshot. Self-contained portrait srcs
        // are kept for the same reason as the main path above.
        const restore = fePrepareBodyForHTMLSnapshot(snapshotRoot, { embedFonts, keepSelfContainedSrc: true });
        try {
          bodyParts = serializeSnapshotRoot();
        } finally {
          try { restore(); } catch {}
          try { portraitRestore?.(); } catch {}
        }
      }
    } else {
      const restore = fePrepareBodyForHTMLSnapshot(snapshotRoot, { embedFonts });
      try {
        bodyParts = serializeSnapshotRoot();
      } finally {
        try { restore(); } catch {}
      }
    }
  } finally {
    try { restoreLayout(); } catch {}
    try { restoreShell(); } catch {}
    try { restoreBg(); } catch {}
  }

  // Inline `style="… url(…) …"` assets, embedded on the SERIALIZED strings so there
  // is nothing to restore in the still-open archive document. Must run after the
  // body is serialized, for the obvious reason that that is when the strings exist.
  try {
    bodyParts = await feEmbedSnapshotInlineStyleAssets(bodyParts, setMeta, assetStore);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feBuildArchiveHTMLSnapshotBlob4"), err);
  }

  // ---
  // HTML wrapper (preserve attributes like lang/class)
  // ---
  const htmlEl = doc.documentElement;
  const htmlAttrs = feSerializeElementAttributes(htmlEl);

  return new Blob(
    ["<!doctype html>\n", `<html${htmlAttrs}>`, "\n", headClone.outerHTML, "\n", ...bodyParts, "\n</html>"],
    { type: "text/html;charset=utf-8" }
  );
}

async function feDownloadArchiveHTML(win, titleText = "Chat Log", { bodyRoot = null } = {}) {
  if (!win || win.closed) return false;
  return feRunArchiveDocumentOperation(win.document, () => feDownloadArchiveHTMLUnlocked(win, titleText, { bodyRoot }));
}

async function feDownloadArchiveHTMLUnlocked(win, titleText = "Chat Log", { bodyRoot = null } = {}) {
  const metaEl = win.document.getElementById("fe-chat-export-meta");
  const originalMeta = (() => {
    try {
      return metaEl?.textContent ?? "";
    } catch {
      return "";
    }
  })();

  const safeName = feSanitizeExportFilename(titleText);

  const filename = `${safeName}.html`;

  const setMeta = (t) => {
    try {
      if (metaEl) metaEl.textContent = t;
    } catch {}
  };

  try {
    const doc = win.document;

    setMeta(feLocalize("FE.ChatArchive.Status.PreparingHtml"));
    const blob = await feBuildArchiveHTMLSnapshotBlob(win, titleText, { meta: setMeta, bodyRoot });

    setMeta(feLocalize("FE.ChatArchive.Status.Downloading"));
    const url = URL.createObjectURL(blob);
    const a = doc.createElement("a");
    a.href = url;
    a.download = filename;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return true;
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feDownloadArchiveHTMLUnlocked"), err);
    return false;
  } finally {
    setMeta(originalMeta);
  }
}

// ---------------------------------------------------------------------------
// Inline Export — download from current (non-popup) document
// ---------------------------------------------------------------------------

async function feDownloadExportHTMLFromCurrentDocument() {
  try {
    const container = document.getElementById("fe-chat-export-container");
    if (!container) return false;

    const titleText = feBuildArchiveTitleText();
    // Reuse the popup/desktop snapshot pipeline, but serialize only the export
    // subtree. Head styles and body theme classes are retained; unrelated live
    // Foundry UI and out-of-range chat DOM never enter the saved file.
    return await feDownloadArchiveHTML(window, titleText, { bodyRoot: container });
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ArchiveSnapshot.feDownloadExportHTMLFromCurrentDocument"), err);
    return false;
  }
}


export {
  feDownloadArchiveHTML,
  feBuildEmbeddedCookieRunFontCSS,
  feDownloadExportHTMLFromCurrentDocument,
};
