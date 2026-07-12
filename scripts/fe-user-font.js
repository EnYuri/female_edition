// female_edition — User font support
//
// Lets a user apply a font that is EITHER installed locally on their machine OR
// dropped into this module's `font/` folder, as an alternative to the built-in
// CookieRun/Geurimilgi stack. When active it remaps every font CSS variable
// (exactly like NeoDGM mode) — see `body.fe-fonts-enabled.fe-user-font-mode` in
// styles/ui-font.css and `feSetUserFontMode` in fe-style.js.
//
// Two font sources, both surfaced to the settings menu:
//   1. font/ folder fonts — scanned via FilePicker.browse only for users with
//      FILES_BROWSE permission, then registered as FontFace objects so their
//      family names become usable. Other users skip the protected directory
//      listing entirely (their local/system-font path remains available).
//   2. locally-installed system fonts — enumerated via the Local Font Access API
//      (window.queryLocalFonts), which needs a user gesture + a one-time permission
//      grant. Falls back to plain manual family-name entry when unavailable.
//
// Self-contained: imports only constants + the apply helper. Settings are
// registered in fe-chat-enhance.js alongside the other font settings.

import { MODULE_ID } from "./fe-constants.js";
import { feSetUserFontMode } from "./fe-style.js";

const FONT_DIR = `modules/${MODULE_ID}/font`;
// font/ files that back the module's own @font-face declarations — they are
// already available under their "FE *" family names, so we hide them from the
// user-font picker to avoid duplicate/confusing entries.
const FE_BUILTIN_FONT_FILES = new Set([
  "cookierun regular.otf", "cookierun regular.ttf",
  "cookierun bold.otf", "cookierun bold.ttf",
  "cookierun black.otf", "cookierun black.ttf",
  "hakgyoansimgeurimilgi-r.ttf",
  "neodunggeunmopro-regular.ttf", "neodgm.ttf",
]);
const FONT_EXT_RE = /\.(ttf|otf|woff2?|otc|ttc)$/i;

let _moduleFontsPromise = null; // cache: Promise<Array<{family,label}>>
let _moduleFontsRegistered = false;

function feResolveFilePicker() {
  return (
    foundry?.applications?.apps?.FilePicker?.implementation ||
    foundry?.applications?.apps?.FilePicker ||
    globalThis.FilePicker
  );
}

// FilePicker.browse is a server-side manageFiles socket request, not a passive
// static-file read. Calling it without this permission produces the server's
// "You do not have permission to browse the host file system" error. Check
// before sending anything so ordinary players neither see a warning nor spend
// a socket round-trip on a request that is guaranteed to fail.
function feCanBrowseModuleFonts() {
  try { return game.user?.can?.("FILES_BROWSE") === true; }
  catch { return false; }
}

// Derive a stable, human-readable family name from a font file name.
// "MyCoolFont-Regular.ttf" → "MyCoolFont Regular". Prefixed so it never collides
// with the built-in "FE *" families.
function feFamilyFromFile(fileName) {
  const base = fileName.replace(FONT_EXT_RE, "").replace(/[_-]+/g, " ").trim();
  return `FEU ${base}`;
}

// Scan font/ and register every non-builtin font as a FontFace. Idempotent +
// cached: the FontFace objects are added to document.fonts once.
async function feRegisterModuleFolderFonts() {
  if (_moduleFontsPromise) return _moduleFontsPromise;
  _moduleFontsPromise = (async () => {
    const out = [];
    try {
      const Picker = feResolveFilePicker();
      if (!Picker?.browse || !feCanBrowseModuleFonts()) return out;
      const res = await Picker.browse("data", FONT_DIR);
      const files = Array.isArray(res?.files) ? res.files : [];
      for (const path of files) {
        // FilePicker.browse returns ALREADY URL-encoded paths (spaces → %20,
        // Hangul → %xx). Decode for the family/label/builtin checks, and reuse
        // the encoded basename verbatim for the fetch URL — re-encoding it would
        // double-encode (%20 → %2520 → 404) and the builtin filter would miss
        // (it stores space-separated names, not %20).
        const rawName = String(path).split("/").pop() ?? "";
        const fileName = decodeURIComponent(rawName);
        if (!FONT_EXT_RE.test(fileName)) continue;
        if (FE_BUILTIN_FONT_FILES.has(fileName.toLowerCase())) continue;
        const family = feFamilyFromFile(fileName);
        const label = fileName.replace(FONT_EXT_RE, "");
        try {
          if (!_moduleFontsRegistered) {
            const url = `${FONT_DIR}/${rawName}`;
            const face = new FontFace(family, `url("${url}")`, { display: "swap" });
            await face.load();
            document.fonts.add(face);
          }
        } catch (e) {
          console.warn(`female_edition | failed to load user font: ${fileName}`, e);
          continue;
        }
        out.push({ family, label });
      }
      _moduleFontsRegistered = true;
    } catch (e) {
      console.warn("female_edition | font/ folder scan failed", e);
    }
    return out;
  })();
  return _moduleFontsPromise;
}

// Enumerate locally-installed fonts. Requires a user gesture (call it from a
// click handler) + a one-time permission grant. Returns [] when unsupported or
// denied. Deduped + sorted by family name.
async function feQueryLocalFonts() {
  try {
    if (typeof window.queryLocalFonts !== "function") return [];
    const fonts = await window.queryLocalFonts();
    const seen = new Set();
    const out = [];
    for (const f of fonts ?? []) {
      const family = f?.family;
      if (!family || seen.has(family)) continue;
      seen.add(family);
      out.push({ family, label: family });
    }
    out.sort((a, b) => a.family.localeCompare(b.family, "ko"));
    return out;
  } catch (e) {
    console.warn("female_edition | queryLocalFonts unavailable/denied", e);
    return [];
  }
}

// Whether the browser can enumerate installed fonts at all (drives the settings
// menu's "load system fonts" button vs. manual-entry-only hint).
function feLocalFontsSupported() {
  return typeof window.queryLocalFonts === "function";
}

Hooks.once("ready", async () => {
  // Register font/-folder fonts so a saved user-font family that points at one of
  // them resolves, then (re)apply in case the user font is already selected.
  try {
    await feRegisterModuleFolderFonts();
  } catch { /* no-op */ }
  try { feSetUserFontMode(document); } catch { /* no-op */ }
});

export {
  feRegisterModuleFolderFonts,
  feQueryLocalFonts,
  feLocalFontsSupported,
};
