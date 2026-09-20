// Archive DOCUMENT chrome for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Everything that makes the popup's brand-new
// Document resolve CSS the same way the live Foundry document does: mirroring
// the head stylesheets, the <html>/<body> theme classes and data-* attributes,
// the module's JS-applied style toggles, the merge body classes, and the
// embedded font faces. Plus the merge application that rides on those classes.
//
// Window/document scope only. Per-message work lives in `fe-archive-message.js`.

import { feLocalize } from "./fe-i18n.js";
import { FE_DEFAULTS } from "./fe-settings-data.js";
import { feRegisterTemplates, feRenderTemplate } from "./fe-template.js";
import {
  MODULE_ID,
  S,
  feSetting,
  feNormalizeChoice,
  feApplyRenderedStateToLog,
} from "./fe-chat-enhance.js";
import { feGetFoundryBaseHref } from "./fe-archive-output.js";
import { feBuildEmbeddedCookieRunFontCSS } from "./fe-archive-snapshot.js";
import { feRefreshPortraitsForLog } from "./fe-archive-message.js";

const [FE_ARCHIVE_SHELL_TEMPLATE] = feRegisterTemplates("fe-archive-shell.hbs");


// ===========================================================================
// Shell
// ===========================================================================

/**
 * Write the archive popup's entire document in one shot.
 *
 * Called before any message collection starts, so the popup is never left sitting
 * on a blank `about:blank` while we sweep the database for older history.
 *
 * The markup and its inline `<style>` live in `templates/fe-archive-shell.hbs` —
 * see that file's header for why the stylesheet must stay inline and UNLAYERED.
 *
 * @param {Window} win         The popup (or hidden iframe) to write into.
 * @param {object} [options]
 * @param {string} [options.titleText]  Already-built `Chat Log – <world>` string.
 * @param {boolean} [options.optimized] Adds `fe-export-optimized` to the body.
 */
export function feBuildArchiveDocument(win, { titleText = "", optimized = false } = {}) {
  // Print/PDF image handling (Chrome/Electron can freeze on image-heavy pages).
  const printImgMode = String(feSetting(S.EXPORT_PRINT_IMAGE_MODE) ?? FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]);
  const printImgClass =
    printImgMode === "hideAll"
      ? " fe-print-hide-all"
      : printImgMode === "downscale"
        ? " fe-print-downscale"
        : printImgMode === "downscaleLite"
          ? " fe-print-downscale-lite"
          : printImgMode === "hideAvatars"
            ? " fe-print-hide-avatars"
            : "";

  // Keep Foundry/system/theme classes for variable definitions, then force a printable layout.
  const bodyClass = `${document.body.className ?? ""} fe-print-chatlog fe-chat-archive fe-chat-archive-window${optimized ? " fe-export-optimized" : ""}${printImgClass}`;

  const pixelTheme = !!feSetting(S.UI_RETRO_THEME);

  // No external-browser control: Electron exports are saved as HTML by the entry
  // path instead, so the button would never have anything to do here. (This is
  // also why `EXPORT_DESKTOP_EXTERNAL_MODE` is registered but read by nobody.)
  const html = feRenderTemplate(FE_ARCHIVE_SHELL_TEMPLATE, {
    baseHref: feGetFoundryBaseHref(),
    titleText,
    headStyles: feCollectHeadStylesHTML(),
    bodyClass,
    pixelTheme,
    archiveBg: pixelTheme ? "#000000" : "#ffffff",
    labels: {
      collecting: feLocalize("FE.ChatArchive.feCollectVisibleChatMessages"),
      downloadTooltip: feLocalize("FE.ChatArchive.innerHTML.Text1"),
      printTooltip: feLocalize("FE.ChatArchive.innerHTML.Text2"),
      print: feLocalize("FE.Common.Print"),
      close: feLocalize("FE.Common.Close"),
    },
  });

  // feRenderTemplate degrades to "" when the path was never preloaded. Writing that
  // would leave the user staring at an empty popup with no error anywhere, so fail
  // loudly instead — the export entry point already reports a thrown error.
  if (!html) throw new Error("Archive shell template is not available.");

  win.document.open();
  win.document.write(html);
  win.document.close();
}


// ===========================================================================
// Head styles, chrome and body classes
// ===========================================================================

export function feCollectHeadStylesHTML() {
  try {
    const baseHref = feGetFoundryBaseHref();

    // Copy all stylesheet links and injected <style> tags.
    // This makes the archive render match the Foundry UI as closely as possible.
    const nodes = Array.from(document.head.querySelectorAll('link[rel="stylesheet"], style'));
    return nodes
      .map((n) => {
        // IMPORTANT:
        // Some settings (including this module's "enableFonts") toggle stylesheets by setting
        // HTMLLinkElement.disabled. That state is not reliably preserved by outerHTML.
        // Preserve it explicitly for the archive window.
        try {
          if (n?.tagName === "LINK") {
            const c = n.cloneNode(true);

            // Preserve disabled stylesheet state in a *serialized* form.
            // HTMLLinkElement.disabled is not reliably reflected by outerHTML, so use
            // media="not all" + a data marker that the archive window can later inspect.
            const disabled = !!n.disabled;
            if (disabled) {
              c.setAttribute("data-fe-disabled-link", "1");
              c.setAttribute("media", "not all");
            }

            // IMPORTANT: Archive windows use about:blank as their URL.
            // If we keep relative hrefs (e.g. modules/..), they can resolve incorrectly
            // when Foundry is hosted under a route prefix or when the game URL ends with /game/.
            // Rewrite hrefs to absolute URLs rooted at the Foundry route prefix.
            try {
              const href = c.getAttribute("href");
              if (href) c.setAttribute("href", new URL(href, baseHref).href);
            } catch {}

            return c.outerHTML;
          }
        } catch {
          /* fall through */
        }
        return n.outerHTML;
      })
      .join("\n");
  } catch (err) {
    // "" is indistinguishable from "the head had no stylesheets", and the caller
    // interpolates it straight into the popup's <head> — a throw here yields a
    // completely unstyled archive window. Keep returning "" (better than no archive
    // at all); only the silence is fixed.
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feCollectHeadStylesHTML"), err);
    return "";
  }
}

/**
 * Best-effort base href rooted at Foundry's route prefix.
 *
 * Why:
 * - The game client URL is commonly /<prefix>/game
 * - But static assets live under /<prefix>/modules, /<prefix>/systems, /<prefix>/icons, ...
 * - Using document.baseURI (often /<prefix>/game/) makes relative assets resolve to /game/modules/... (wrong)
 */

export function feSyncArchiveDocumentChrome(doc) {
  try {
    if (!doc?.documentElement) return;
    const srcHtml = document.documentElement;
    const dstHtml = doc.documentElement;

    if (srcHtml?.className != null) dstHtml.className = srcHtml.className;
    const htmlStyle = srcHtml?.getAttribute?.("style");
    if (htmlStyle) dstHtml.setAttribute("style", htmlStyle);
    else dstHtml.removeAttribute?.("style");

    for (const attr of Array.from(srcHtml?.attributes ?? [])) {
      const name = String(attr?.name ?? "");
      if (!name || name === "class" || name === "style") continue;
      if (name === "lang" || name === "dir" || name.startsWith("data-") || name.startsWith("aria-")) {
        dstHtml.setAttribute(name, String(attr?.value ?? ""));
      }
    }

    const srcBody = document.body;
    const dstBody = doc.body;
    if (srcBody && dstBody) {
      for (const attr of Array.from(srcBody.attributes ?? [])) {
        const name = String(attr?.name ?? "");
        if (!name || name === "class") continue;
        if (name === "style" || name.startsWith("data-") || name.startsWith("aria-")) {
          dstBody.setAttribute(name, String(attr?.value ?? ""));
        }
      }
    }
  } catch {
    /* no-op */
  }
}

/**
 * Apply module settings which toggle stylesheets via JS (e.g. enableFonts -> ui-font.css).
 * The archive window is a new Document, so we must re-apply these toggles explicitly.
 */
export function feApplyModuleStylesheetSettingsToDocument(doc) {
  try {
    if (!doc?.querySelectorAll) return;

    // chat-bg-stripper.js controls the ui-font.css <link> using HTMLLinkElement.disabled.
    let enableFonts = true;
    try {
      enableFonts = !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS);
    } catch {
      enableFonts = true;
    }

    const needleAbs = `/modules/${MODULE_ID}/styles/ui-font.css`;
    const needleRel = `modules/${MODULE_ID}/styles/ui-font.css`;

    const links = Array.from(doc.querySelectorAll('link[rel="stylesheet"]'));
    for (const l of links) {
      try {
        // Generic disabled-state replay for cloned head links.
        if (l.getAttribute?.("data-fe-disabled-link") === "1") {
          l.disabled = true;
          l.setAttribute("media", "not all");
        }

        const hrefAttr = l.getAttribute("href") || "";
        const hrefAbs = l.href || "";
        const match =
          hrefAttr.includes(needleAbs) ||
          hrefAbs.includes(needleAbs) ||
          hrefAttr.includes(needleRel) ||
          hrefAbs.includes(needleRel);
        if (!match) continue;

        if (enableFonts) {
          l.disabled = false;
          if (l.getAttribute("media") === "not all") l.removeAttribute("media");
          l.removeAttribute?.("data-fe-disabled-link");
        } else {
          l.disabled = true;
          l.setAttribute("media", "not all");
          l.setAttribute("data-fe-disabled-link", "1");
        }
      } catch {
        /* no-op */
      }
    }

    // Mirror body class toggles used by stylesheet-driven chat UI features.
    // fe-fonts-enabled gates all font rules in ui-font.css — must be synced here.
    doc.body?.classList?.toggle?.("fe-fonts-enabled", enableFonts);
    try {
      const hidePortraits = !!game.settings.get(MODULE_ID, S.UI_HIDE_PORTRAITS);
      doc.body?.classList?.toggle?.("fe-hide-portraits", hidePortraits);
    } catch {
      /* no-op */
    }
    try {
      const stripTextures = !!game.settings.get(MODULE_ID, S.UI_STRIP_TEXTURES);
      doc.body?.classList?.toggle?.("fe-strip-chat-textures", stripTextures);
    } catch {
      /* no-op */
    }
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feApplyModuleStylesheetSettingsToDocument"), err);
  }
}

export function feSyncArchiveMergeBodyClasses(doc) {
  try {
    const enabled = !!feSetting(S.MERGE_ENABLED);
    // Same normalization as feSetBodyMergeClasses — an unknown stored value must
    // still pick ONE mode, or the archive loses border fusion while keeping the
    // follow-header rules (see the comment on feNormalizeChoice in fe-style.js).
    const style = feNormalizeChoice(feSetting(S.MERGE_FOLLOW_HEADER_STYLE), ["hide", "name", "portrait"], "hide");
    const mode = feNormalizeChoice(feSetting(S.MERGE_MODE), ["standard", "simple"], "standard");
    doc?.body?.classList?.toggle?.("fe-chat-merge", enabled);
    doc?.body?.classList?.toggle?.("fe-merge-mode-standard", enabled && mode === "standard");
    doc?.body?.classList?.toggle?.("fe-merge-mode-simple", enabled && mode === "simple");
    doc?.body?.classList?.toggle?.("fe-merge-follow-hide", enabled && style === "hide");
    doc?.body?.classList?.toggle?.("fe-merge-follow-name", enabled && style === "name");
    doc?.body?.classList?.toggle?.("fe-merge-follow-portrait", enabled && style === "portrait");
  } catch {
    /* no-op */
  }
}

export function feArchiveMergeOptions() {
  return {
    // Archive/print does not rely on narrator headers, so allowing narrator-only groups to merge
    // keeps PDF/HTML closer to the live visual grouping while still avoiding cross-type merges.
    allowNarratorMerge: true,
  };
}

// ===========================================================================
// Archive Merge & Style Mirroring  (merge classes, computed style copy,
//                                   live-tree mirror, message style mirror)
// ===========================================================================

// `skipPortraits` is set by the archive render path, which runs the portrait
// sweep itself in yielding chunks right after this call. Left default (false)
// for every other caller so the old one-shot behaviour is unchanged.
export function feApplyChatMergeInWindow(win, renderProfile = null, { skipPortraits = false } = {}) {
  try {
    const logEl =
      win.document.getElementById("fe-chat-export-log") ||
      win.document.getElementById("chat-log") ||
      win.document.querySelector("ol.chat-log");
    if (!logEl) return;

    feSyncArchiveMergeBodyClasses(win.document);
    feApplyRenderedStateToLog(logEl, feArchiveMergeOptions());
    if (!skipPortraits) feRefreshPortraitsForLog(logEl, renderProfile);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feApplyChatMergeInWindow"), err);
  }
}

export async function feEnsureArchiveEmbeddedFonts(win) {
  try {
    if (!win || win.closed) return;
    const doc = win.document;
    if (!doc?.head) return;

    let enableFonts = true;
    try {
      enableFonts = !!game.settings.get(MODULE_ID, S.UI_ENABLE_FONTS);
    } catch {
      enableFonts = true;
    }
    if (!enableFonts) return;
    if (doc.getElementById("fe-export-embedded-fonts-live")) return;

    const fontCss = await feBuildEmbeddedCookieRunFontCSS();
    if (!fontCss) return;

    const styleEl = doc.createElement("style");
    styleEl.id = "fe-export-embedded-fonts-live";
    styleEl.textContent = fontCss;
    doc.head.appendChild(styleEl);
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feEnsureArchiveEmbeddedFonts"), err);
  }
}
