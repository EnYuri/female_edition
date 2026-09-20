// Embedded font faces for the archive's saved HTML file.
//
// Sub-module of fe-chat-archive.js. Scope: THE FONT FACES the saved file carries.
// Builds one CSS string of data-URL @font-face rules plus the :root font-family
// variables that select them, memoized for the session.
//
// A saved archive is usually opened as file://, where the origin becomes "null"
// and remote font files are blocked by CORS — so a font that is not embedded here
// simply does not render in the file the user keeps.


// Memoized embedded-font CSS (built once per session).
import { feLocalize, feFormat } from "./fe-i18n.js";
import { MODULE_ID } from "./fe-constants.js";
import { feGetFoundryBaseHref } from "./fe-archive-output.js";
import { feFetchWithTimeout, feFetchAsDataURLCapped } from "./fe-archive-fetch.js";

let feEmbeddedFontCssPromise = null;
let feEmbeddedFontCssValue = null;

// ===========================================================================
// Font Embedding  (data-URL encode fonts for self-contained HTML export)
// ===========================================================================

export async function feBuildEmbeddedCookieRunFontCSS() {
  if (typeof feEmbeddedFontCssValue === "string") return feEmbeddedFontCssValue;
  if (feEmbeddedFontCssPromise) return feEmbeddedFontCssPromise;

  feEmbeddedFontCssPromise = (async () => {
  // Tries to fetch the CookieRun font files from the module and embed them as data: URLs.
  // On any uncaught error, record an empty string so subsequent calls skip retrying.
  try {
  // If files are not present, returns an empty string.
  //
  // IMPORTANT: Base64 embedding multi-megabyte fonts can easily crash Chromium/Electron
  // (OOM / STATUS_BREAKPOINT) due to base64 expansion + JS string memory overhead.
  // To keep exports reliable, we only embed when the server reports a small Content-Length.
  // CookieRun OTF files shipped with this module are ~0.9–1.0MB each.
  // Hakgyoansim Geurimilgi (TTF) is larger (~6MB).
  // We keep separate per-file caps to avoid accidentally embedding oversized TTF variants
  // of CookieRun while still allowing Geurimilgi to be included when the user explicitly
  // enables "embed custom fonts".
  const MAX_TOTAL_BYTES = 11_000_000; // binary before base64 expansion
  const MAX_PER_FILE_BYTES_COOKIE = 1_200_000;
  const MAX_PER_FILE_BYTES_GEUR = 7_000_000;
  let totalBytes = 0;

  const headSize = async (url) => {
    try {
      const res = await feFetchWithTimeout(url, { method: "HEAD", credentials: "include" });
      if (!res.ok) return null;
      const len = res.headers.get("content-length");
      const n = Number(len);
      return Number.isFinite(n) && n > 0 ? n : null;
    } catch {
      return null;
    }
  };

  const fetchFont = async (url, { perFileCap }) => {
    // Try to get a size estimate first.
    const size = await headSize(url);

    // Enforce caps using either the reported size, or a conservative streaming cap.
    const remaining = Math.max(0, MAX_TOTAL_BYTES - totalBytes);
    const cap = Math.max(0, Math.min(perFileCap, remaining));
    if (!cap) return null;

    if (size && (size > perFileCap || size > remaining)) return null;

    // Prefer the capped streaming fetch so exports still work on servers that:
    // - do not support HEAD
    // - omit Content-Length
    const got = await feFetchAsDataURLCapped(url, cap);
    if (!got?.dataUrl) return null;

    const bytes = size || got.bytes || 0;
    if (bytes && totalBytes + bytes > MAX_TOTAL_BYTES) return null;
    totalBytes += bytes;
    return got.dataUrl;
  };

  // MUST route through feGetFoundryBaseHref() so the server's routePrefix applies.
  // Root-absolute `/modules/…` 404s on any world behind a route prefix or proxy
  // subpath (invisible to a localhost GM), and a bare relative path resolves against
  // the archive popup's about:blank. Either way every face silently drops out.
  const fontUrl = (file) => {
    const rel = `modules/${MODULE_ID}/font/${file}`;
    try { return new URL(rel, feGetFoundryBaseHref()).href; } catch { return `/${rel}`; }
  };

  // Match ui-font.css unicode coverage (KR + basic Latin + Latin-1)
  const unicodeRange = "U+0020-007E, U+00A0-00FF, U+AC00-D7A3, U+1100-11FF, U+3130-318F";
  // OTF only. Each face also exists as a .ttf in a dev checkout, but the twins are
  // export-ignore'd (see .gitattributes) so they are absent from any distributed
  // install, and their cmap coverage is identical anyway — the old second candidate
  // could only ever cost one wasted fetch.
  const weights = [
    { weight: 400, file: "CookieRun%20Regular.otf" },
    { weight: 700, file: "CookieRun%20Bold.otf" },
    { weight: 900, file: "CookieRun%20Black.otf" },
  ];

  const faces = [];
  for (const w of weights) {
    const dataUrl = await fetchFont(fontUrl(w.file), {
      perFileCap: MAX_PER_FILE_BYTES_COOKIE,
    });
    if (!dataUrl) continue;

    faces.push(
      `@font-face{font-family:"FE CookieRun Embedded";src:url(${dataUrl}) format("opentype");font-weight:${w.weight};font-style:normal;unicode-range:${unicodeRange};font-display:block;}`
    );
  }

  // Optional: embed Hakgyoansim Geurimilgi.
  // If present, we embed it so saved file:// HTML keeps the same look.
  //
  // OTF ONLY, and the format matters here more than anywhere else. The typeface also
  // exists as a 6.3MB .ttf with byte-identical coverage (verified glyph-for-glyph:
  // 12640 glyphs, 11172/11172 Hangul syllables — the gap is CFF vs glyf encoding, not
  // content), and that .ttf is export-ignore'd out of the distributed zip. Even in a
  // dev checkout it is useless to this function: the embedder caps each file to keep
  // base64 expansion from OOMing Chromium/Electron, the TTF blows straight past that
  // cap, and a saved archive that picked it up failed to load the face at all
  // (document.fonts → "FE Geurimilgi: error"). The 730KB OTF sits under the cap, so it
  // also rides the GENERIC url() embedder and lands even when this opt-in is off.
  // Do not reintroduce a TTF candidate.
  let geurimilgiEmbedded = false;
  try {
    const geurimilgiData = await fetchFont(fontUrl("HakgyoansimGeurimilgi-R.otf"), {
      perFileCap: MAX_PER_FILE_BYTES_GEUR,
    });
    if (geurimilgiData) {
      faces.push(
        `@font-face{font-family:"FE Geurimilgi Embedded";src:url(${geurimilgiData}) format("opentype");font-weight:400;font-style:normal;unicode-range:${unicodeRange};font-display:block;}`
      );
      geurimilgiEmbedded = true;
    }
  } catch {}

  // The normal UI imports the official NeoDGM Pro webfont. Re-assert the same
  // import in standalone file:// archive HTML, whose copied module stylesheet
  // cannot resolve its original relative location. The CDN font response permits
  // cross-origin use, so the saved HTML remains lightweight while online.
  const neodgmRule = `
@import url("https://cdn.jsdelivr.net/gh/neodgm/neodgm-pro-webfont@1.020/neodgm_pro/style.css");
/* NeoDGM Pro webfont: route every font var to the imported face. */
body.fe-fonts-enabled.fe-neodgm-mode,
body.fe-neodgm-mode {
  --fe-font-primary: "NeoDunggeunmo Pro", monospace;
  --fe-font-geurimilgi: "NeoDunggeunmo Pro", monospace;
  --fe-font-secondary: "NeoDunggeunmo Pro", monospace;
  --fe-chat-font-family: "NeoDunggeunmo Pro", monospace;
  font-kerning: normal;
  font-variant-ligatures: common-ligatures;
  font-feature-settings: "kern" 1, "liga" 1, "clig" 1;
}
body.fe-fonts-enabled.fe-neodgm-mode * {
  font-kerning: normal !important;
  font-variant-ligatures: common-ligatures !important;
  font-feature-settings: "kern" 1, "liga" 1, "clig" 1 !important;
}`;

  // Even if optional local faces fail to load, preserve the NeoDGM Pro webfont
  // rule so the selected pixel-font mode does not silently fall back.
  if (!faces.length) {
    // Loud on purpose: an empty face list is not an error to the caller, so this state
    // is otherwise indistinguishable from a healthy export. Everything that can cause
    // it (route prefix, 404, size cap, fetch timeout) is invisible from outside, hence
    // naming the URL actually tried.
    console.warn(
      feLocalize("FE.Diagnostics.ArchiveSnapshot.feBuildEmbeddedCookieRunFontCSS") +
      feFormat("FE.Diagnostics.ArchiveSnapshot.feBuildEmbeddedCookieRunFontCSS2", { value1: fontUrl("CookieRun%20Regular.otf") })
    );
    // Do not cache the fallback-only result: local font requests may have failed
    // transiently, and a later export should get another chance to embed them.
    return neodgmRule;
  }

  // Geurimilgi routing for the mixed "쿠키런 + 그림일기" preset (small text / cards /
  // tooltips = Geurimilgi). If the face was embedded, the export MUST route the
  // geurimilgi var to it — otherwise that half of the mixed preset silently falls back
  // to a system font and only CookieRun shows ("하나만 적용" bug). If it could NOT be
  // embedded (over cap / fetch failed), keep the readable system stack.
  const geurimilgiSystemStack =
    `"Noto Sans KR", "Malgun Gothic", "Apple SD Gothic Neo", "Segoe UI", system-ui, -apple-system, sans-serif, var(--fe-symbol-fallback)`;
  const geurimilgiStack = geurimilgiEmbedded
    ? `"FE Geurimilgi Embedded", "FE Geurimilgi", ${geurimilgiSystemStack}`
    : geurimilgiSystemStack;

  const css = `
/* female_edition: embedded CookieRun fonts (offline HTML export) */
${neodgmRule}
${faces.join("\n")}

/* Prefer the embedded faces when opening the saved HTML as file://
 * (remote font files are often blocked by CORS because the origin becomes "null").
 */
:root {
  --fe-symbol-fallback:
    "Segoe UI Symbol",
    "Segoe UI Emoji",
    "Apple Color Emoji",
    "Noto Color Emoji";

  --fe-font-primary:
    "FE CookieRun Embedded",
    "FE CookieRun",
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  /* Geurimilgi: prefer the embedded face when it was embedded (the mixed
   * CookieRun+Geurimilgi preset needs BOTH faces); else fall back to a readable
   * system UI stack. Built in JS above as geurimilgiStack. */
  --fe-font-geurimilgi: ${geurimilgiStack};

  /* Secondary stack (small text / chat-card descriptions). Mirrors ui-font.css's
   * :root default — follows the geurimilgi stack (embedded face when available). */
  --fe-font-secondary: var(--fe-font-geurimilgi);

  --fe-chat-card-system-font-family:
    "Signika",
    system-ui,
    -apple-system,
    "Noto Sans KR",
    "Segoe UI",
    sans-serif,
    var(--fe-symbol-fallback);

  --font-primary: var(--fe-font-primary);
  --font-sans: var(--fe-font-primary);
  --font-serif: var(--fe-font-primary);
  --font-h1: var(--fe-font-primary);
  --font-h2: var(--fe-font-primary);
  --font-body: var(--fe-font-primary);

  /* dnd5e v5.2.x font vars (best-effort) */
  --dnd5e-font-roboto: var(--fe-font-primary);
  --dnd5e-font-roboto-slab: var(--fe-font-primary);
  --dnd5e-font-roboto-condensed: var(--fe-font-primary);
  --dnd5e-font-signika: var(--fe-font-primary);
  --dnd5e-font-modesto: var(--fe-font-primary);

  /* Chat font choice (default: CookieRun). Controlled via body class. */
  --fe-chat-font-family: var(--fe-font-primary);
}

body.fe-chat-font-cookie { --fe-chat-font-family: var(--fe-font-primary); }
body.fe-chat-font-cookie-all {
  --fe-font-geurimilgi: var(--fe-font-primary);
  --fe-font-secondary: var(--fe-font-primary);
  --fe-chat-font-family: var(--fe-font-primary);
}
body.fe-chat-font-geurimilgi {
  --fe-font-primary: var(--fe-font-geurimilgi);
  --fe-font-secondary: var(--fe-font-geurimilgi);
  --fe-chat-font-family: var(--fe-font-geurimilgi);
}
body.fe-ui-font-geurimilgi {
  --fe-ui-font-family: var(--fe-font-geurimilgi);
  --fe-dnd5e-label-font-family: var(--fe-font-geurimilgi);
}

/* Ensure the archive itself uses the embedded stack even when external CSS is partially blocked. */
html, body {
  font-family: var(--fe-ui-font-family, var(--fe-font-primary)) !important;
}

#fe-chat-export-container,


#fe-chat-export-container #fe-chat-export-sidebar,
#fe-chat-export-container #fe-chat-export-chat,
#fe-chat-export-container #fe-chat-export-log,
#fe-chat-export-container :is(#chat-log, #fe-chat-export-log) > li.chat-message {
  width: 100% !important;
  max-width: none !important;
  min-width: 0 !important;
}
#fe-chat-export-container .chat-message,
#fe-chat-export-container .chat-message * {
  font-family: var(--fe-chat-font-family) !important;
}
/* Inside cards and boxes - follows the toggle, exactly like the live ui-font.css. */
body.fe-fonts-enabled:not(.fe-chatcard-custom-font) #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat, .dx3rd-item-info),
body.fe-fonts-enabled:not(.fe-chatcard-custom-font) #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat, .dx3rd-item-info) * {
  font-family: var(--fe-chat-card-system-font-family) !important;
}
body.fe-fonts-enabled.fe-chatcard-custom-font #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat, .dx3rd-item-info),
body.fe-fonts-enabled.fe-chatcard-custom-font #fe-chat-export-container .chat-message :is(.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat, .dx3rd-item-info) * {
  font-family: var(--fe-font-secondary) !important;
}

/* Re-assert Font Awesome over the '.chat-message *' chat-font rule above.
 *
 * NEVER PUT A RAW BACKTICK IN THIS BLOCK, not even in prose. This whole CSS body is
 * one template literal, so a backtick ENDS it rather than quoting anything -- and the
 * result stays syntactically valid JS (member access + subtraction + multiplication),
 * so the syntax check passes and only a ReferenceError at call time reveals it. That
 * happened in 2.6.3 and, swallowed by this function's own catch, silently shipped two
 * versions of font-less exports. Use apostrophes; "npm run lint" is the guard.
 *
 * MUST stay a VERSION-AGNOSTIC STACK: v13 ships FA6, v14 ships FA7, and the families
 * are named per major version. This <style> is unlayered, so its !important outranks
 * FA's own "font-family: var(--_fa-family)" -- naming only one version's families
 * turns every icon into tofu on the other. Fallback is per-glyph, so one stack covers
 * solid/regular/brands/duotone.
 */
#fe-chat-export-container :is(.fa-solid, .fa-regular, .fa-light, .fa-thin, .fa-duotone, .fa-brands, [class^="fa-"], [class*=" fa-"]) {
  font-family:
    "Font Awesome 7 Pro", "Font Awesome 7 Free", "Font Awesome 7 Brands", "Font Awesome 7 Duotone",
    "Font Awesome 6 Pro", "Font Awesome 6 Free", "Font Awesome 6 Brands", "Font Awesome 6 Duotone",
    "Font Awesome 5 Pro", "Font Awesome 5 Free", "Font Awesome 5 Brands", "Font Awesome 5 Duotone",
    "FontAwesome" !important;
}
`;

    feEmbeddedFontCssValue = css;
    return css;
  } catch {
    // A transient timeout/network failure must not poison every later export in
    // this Foundry session. Successful CSS is cached; failures remain retryable.
    return "";
  }
  })();

  try {
    return await feEmbeddedFontCssPromise;
  } finally {
    feEmbeddedFontCssPromise = null;
  }
}
