// Network floor for the archive snapshot family.
//
// Sub-module of fe-chat-archive.js. Scope: ONE HTTP RESOURCE — fetch it with a
// timeout, decide its credentials mode, decide whether its origin is allowed, and
// turn it into a size-capped data: URL.
//
// It exists as its own module because BOTH `fe-archive-assets.js` and
// `fe-archive-fonts.js` need `feFetchWithTimeout` while `fe-archive-snapshot.js`
// imports both of them. Without this floor those imports would have to point back
// at the snapshot module and the family's import graph would stop being a DAG.
//
// Its ONLY family import is feBlobToDataURL (fe-archive-image.js), which imports
// nothing from here. Keep it that way: anything this module imports becomes a
// dependency of the entire snapshot family.

import { feBlobToDataURL } from "./fe-archive-image.js";

// Matches a browser's own per-host connection limit — more in-flight fetches would just
// queue in the network stack while holding decoded blobs alive in JS.
export const FE_EXPORT_EMBED_CONCURRENCY = 6;
export const FE_EXPORT_RESOURCE_FETCH_TIMEOUT = 12000;

export const FE_EXPORT_FONT_CDN_HOSTS = new Set(["cdn.jsdelivr.net"]);

export async function feFetchWithTimeout(url, options = {}, timeoutMs = FE_EXPORT_RESOURCE_FETCH_TIMEOUT, consume = null) {
  const controller = new AbortController();
  const upstream = options?.signal;
  const abortFromUpstream = () => controller.abort(upstream?.reason);
  if (upstream?.aborted) abortFromUpstream();
  else upstream?.addEventListener?.("abort", abortFromUpstream, { once: true });

  const timer = setTimeout(() => controller.abort(new DOMException("Export resource request timed out", "TimeoutError")), timeoutMs);
  try {
    const response = await fetch(url, { ...options, signal: controller.signal });
    return typeof consume === "function" ? await consume(response, controller) : response;
  } finally {
    clearTimeout(timer);
    upstream?.removeEventListener?.("abort", abortFromUpstream);
  }
}

/**
 * `credentials` for one asset/stylesheet fetch.
 *
 * MUST be "omit" cross-origin. A response carrying `Access-Control-Allow-Origin: *`
 * — which is what every CDN here sends — is REJECTED by the browser outright when
 * the request was made with credentials; the wildcard and credentialed mode are
 * mutually exclusive per the CORS spec. Sending "include" everywhere would make
 * every cross-origin font fail with a CORS error rather than embed.
 *
 * Same-origin keeps "include": Foundry gates its own routes on the session cookie.
 * The URL may still be relative here (feBuildEmbeddedCookieRunFontCSS passes
 * `/modules/…`), so resolve against the document before deciding — a bare
 * `new URL(url)` would throw on those and wrongly downgrade them to "omit".
 */
export function feSnapshotFetchCredentials(url) {
  try {
    return new URL(url, window.location.href).origin === window.location.origin ? "include" : "omit";
  } catch {
    return "include";
  }
}

/**
 * Replace same-origin `url()` references inside the already-inlined <style> blocks
 * with data: URLs, so the saved standalone HTML renders offline.
 *
 * WHY (the bug it fixes):
 * feInlineSnapshotStylesheets brings the CSS *text* into the file, but
 * feRewriteSnapshotCSSURLs only ABSOLUTIZES the `url()`s inside it — it never
 * embeds them. Opened as file://, every one of those absolute Foundry-origin URLs
 * 404s (and even with Foundry running, a file:// document's origin is "null", so
 * @font-face fetches are blocked by CORS). Measured consequences on a real export:
 *   - core fontawesome/webfonts/*.woff2  → every icon renders as tofu (□ / ✗)
 *   - core Signika, dnd5e modesto-condensed → text silently falls to a system face
 *   - dnd5e's 97 url() assets (icons/svg/d20-black.svg, ui/lozenge.svg,
 *     ui/notable-*-corner.svg, ui/texture-gray1.webp, the badge webps) → dice icons
 *     vanish and the decorated boxes around them lose their art
 * This pass closes that gap. Anything it cannot embed (cross-origin, over cap,
 * fetch failed, 404 — Foundry v14 references a fa-v4compatibility.woff2 that is
 * not shipped) is LEFT AS THE ABSOLUTE URL, i.e. exactly today's behaviour, so a
 * failure here can only ever be a no-op.
 *
 * Runs only for the HTML snapshot. The print/PDF popup is a live document with
 * network access and needs none of this.
 */
export function feSnapshotAssetIsSameOrigin(abs) {
  try {
    const u = new URL(abs);
    return u.origin === window.location.origin && (u.protocol === "http:" || u.protocol === "https:");
  } catch {
    return false;
  }
}

/** An https URL on the webfont host allowlist. See FE_EXPORT_FONT_CDN_HOSTS. */
export function feSnapshotIsAllowedFontCdn(abs) {
  try {
    const u = new URL(abs);
    return u.protocol === "https:" && FE_EXPORT_FONT_CDN_HOSTS.has(u.hostname);
  } catch {
    return false;
  }
}

export async function feFetchAsDataURLCapped(url, maxBytes) {
  // Stream the response and abort if it exceeds maxBytes.
  // This avoids OOM when servers omit Content-Length.
  const cap = Math.max(0, Number(maxBytes) || 0);
  if (!cap) return null;

  const controller = new AbortController();
  const timeoutTimer = setTimeout(() => controller.abort(), FE_EXPORT_RESOURCE_FETCH_TIMEOUT);
  try {
    const res = await fetch(url, { credentials: feSnapshotFetchCredentials(url), signal: controller.signal });
    if (!res.ok) return null;

    // Carry the response's own MIME into the Blob we assemble from the stream.
    // `new Blob(chunks)` with no type yields `data:application/octet-stream`, which a
    // font `src` survives (the `format()` hint drives the decode) but an IMAGE does
    // NOT — `background-image: url(data:application/octet-stream;…)` renders nothing.
    // The blob() fallback below already carries the type; this makes the streamed
    // path match it.
    const contentType = (() => {
      try {
        return String(res.headers.get("content-type") || "").split(";")[0].trim();
      } catch {
        return "";
      }
    })();

    // Respect content-length if present.
    try {
      const len = Number(res.headers.get("content-length") || 0);
      if (Number.isFinite(len) && len > 0 && len > cap) {
        try {
          controller.abort();
        } catch {}
        return null;
      }
    } catch {}

    // If streams aren't available, fall back to blob() (still capped).
    if (!res.body || typeof res.body.getReader !== "function") {
      const blob = await res.blob();
      if (blob.size > cap) return null;
      return { dataUrl: await feBlobToDataURL(blob), bytes: blob.size };
    }

    const reader = res.body.getReader();
    const chunks = [];
    let received = 0;

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength || value.length || 0;
      if (received > cap) {
        try {
          controller.abort();
        } catch {}
        return null;
      }
      chunks.push(value);
    }

    const blob = contentType ? new Blob(chunks, { type: contentType }) : new Blob(chunks);
    if (blob.size > cap) return null;
    return { dataUrl: await feBlobToDataURL(blob), bytes: blob.size };
  } catch {
    try {
      controller.abort();
    } catch {}
    return null;
  } finally {
    clearTimeout(timeoutTimer);
  }
}
