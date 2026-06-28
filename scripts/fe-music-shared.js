// female_edition: Music feature — shared constants + pure helpers.
//
// Ported from the standalone "emanim-music" module (nayuri), then restructured:
// instead of one personal Playlist per player, there is ONE shared Playlist
// (flag `sharedMusic`) that the GM creates with `ownership: { default: OWNER }`
// so every player can play/stop/add tracks directly — no socket round-trip for
// playback control. File writes use a HYBRID path: a player with FILES_UPLOAD
// uploads directly; otherwise the active GM proxies the upload over the socket.
// This file holds the socket vocabulary + the small pure helpers shared by the
// GM-side handler (fe-music.js) and the client App (fe-music-app.js). Only
// imports fe-constants.js.

import { MODULE_ID } from "./fe-constants.js";

// All music traffic rides the shared `module.female_edition` socket alongside
// screen-panel / token-glow / typing-indicator. Every music message type is
// namespaced with the `music:` prefix and the handler bails on anything else, so
// the listeners coexist without collision. Playback control (play/stop/dj) is now
// done directly against the shared OWNER playlist, so ONLY the upload-proxy
// fallback vocabulary remains.
export const MUSIC_SOCKET = `module.${MODULE_ID}`;

export const MUSIC_MSG = Object.freeze({
  UP_INIT:        "music:upInit",
  UP_INIT_ACK:    "music:upInitAck",
  UP_CHUNK:       "music:upChunk",
  UP_FINISH:      "music:upFinish",

  UP_REQ_MISSING: "music:upReqMissing",
  UP_ACK:         "music:upAck",
  UP_ERR:         "music:upErr",
});

/** Flag marking the single shared music playlist. */
export const SHARED_FLAG = "sharedMusic";

/** @returns {boolean} */
export function isAnyGMOnline() {
  return game.users.some(u => u.active && u.isGM);
}

/** The single shared music playlist (flagged on creation), or null. */
export function pickSharedPlaylist() {
  return game.playlists.find(p => p.getFlag(MODULE_ID, SHARED_FLAG) === true) ?? null;
}

/** Lowercased file extension without the dot, or "". */
export function extOf(name) {
  const m = String(name).toLowerCase().match(/\.([a-z0-9]+)$/);
  return m ? m[1] : "";
}

/** Filename without its extension. */
export function stripExt(name) {
  return String(name ?? "").replace(/\.[^/.]+$/, "");
}

export function getAudioHelper() {
  return globalThis.AudioHelper ?? globalThis.foundry?.audio?.AudioHelper ?? null;
}

export function allowedAudio(name) {
  const AH = getAudioHelper();
  if (AH?.hasAudioExtension) return AH.hasAudioExtension(name);
  return ["mp3", "ogg", "wav", "flac", "m4a", "webm"].includes(extOf(name));
}

/** Cross-version FilePicker implementation resolver. */
export function getFilePicker() {
  return (
    foundry?.applications?.apps?.FilePicker?.implementation ??
    foundry?.applications?.apps?.FilePicker ??
    globalThis.FilePicker ??
    null
  );
}

/**
 * Sanitize a filename component, PRESERVING the original (incl. non-ASCII) name.
 * Only path separators / reserved chars are replaced; Unicode is kept intact so
 * foreign-language track names survive on disk and in the playlist.
 */
export function sanitizeFileName(name, { maxLen = 120 } = {}) {
  const cleaned = String(name ?? "track")
    .replace(/[/\\?%*:|"<>]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, ""); // no leading dots
  const safe = cleaned.slice(0, maxLen).trim();
  return safe || "track";
}

/**
 * Normalize a data directory path to a safe, relative form.
 * - Converts backslashes to slashes.
 * - Removes leading/trailing slashes and '.'/'..' segments.
 * - Replaces Windows-reserved chars.
 */
export function normalizeDataDir(p) {
  const raw = String(p ?? "").replace(/\\/g, "/").trim();
  const parts = raw
    .split("/")
    .map(s => s.trim())
    .filter(Boolean)
    .filter(s => s !== "." && s !== "..")
    .map(s => s.replace(/[:*?"<>|]/g, "_"));
  return parts.join("/");
}

/** The basename (last path segment), URL-decoded. */
export function baseNameOf(p) {
  const raw = String(p ?? "");
  const seg = raw.split("/").pop() ?? raw;
  try { return decodeURIComponent(seg); } catch { return seg; }
}

/**
 * HEAD a server file and return its byte size, or null if unknown.
 * Used to compare an existing file's size for dedup.
 */
export async function remoteFileSize(path) {
  try {
    let route = foundry?.utils?.getRoute ? foundry.utils.getRoute(path) : `/${path}`;
    // Encode spaces / non-ASCII (Korean) only when not already percent-encoded,
    // otherwise the HEAD silently 404s and dedup falsely treats the file as new.
    if (!/%[0-9A-Fa-f]{2}/.test(route)) route = encodeURI(route);
    const res = await fetch(route, { method: "HEAD" });
    if (!res.ok) return null;
    const len = res.headers.get("content-length");
    return len == null ? null : Number(len);
  } catch {
    return null;
  }
}

/**
 * Resolve where a file should land in `dir`, deduplicating by name+size.
 * Browses the folder once, then:
 *  - identical name AND identical size already present → { path, reused:true } (skip upload)
 *  - name free → { name, reused:false } (upload under the ORIGINAL name)
 *  - name taken by a DIFFERENT-size file → { name: "base (n).ext", reused:false }
 *
 * Requires FILES_BROWSE; on any browse failure falls back to the plain original
 * name (no dedup) so the caller can still upload.
 *
 * @param {string} dir        normalized target dir (e.g. "assets/uploadedmusic")
 * @param {string} fileName   sanitized original filename incl. extension
 * @param {number} size       byte size of the candidate file
 */
export async function resolveUploadTarget(dir, fileName, size) {
  const FP = getFilePicker();
  let files = [];
  try {
    const listing = await FP.browse("data", dir);
    files = Array.isArray(listing?.files) ? listing.files : [];
  } catch {
    return { name: fileName, path: `${dir}/${fileName}`, reused: false };
  }

  const byBase = new Map();
  for (const f of files) byBase.set(baseNameOf(f), f);

  const existing = byBase.get(fileName);
  if (existing) {
    const exSize = await remoteFileSize(existing);
    if (exSize != null && Number(exSize) === Number(size)) {
      return { name: fileName, path: existing, reused: true };
    }
    // Same name, different (or unknown) size → pick a free "base (n).ext".
    const ext = extOf(fileName);
    const base = stripExt(fileName);
    for (let n = 2; n < 1000; n++) {
      const cand = ext ? `${base} (${n}).${ext}` : `${base} (${n})`;
      if (!byBase.has(cand)) {
        return { name: cand, path: `${dir}/${cand}`, reused: false };
      }
    }
  }

  return { name: fileName, path: `${dir}/${fileName}`, reused: false };
}

/** Create each segment of `dir` under `source` (idempotent). */
export async function ensureDirectory(source, dir) {
  const FP = getFilePicker();
  const norm = normalizeDataDir(dir);
  if (!norm) return;
  const parts = norm.split("/").filter(Boolean);
  let cur = "";
  for (const part of parts) {
    cur = cur ? `${cur}/${part}` : part;
    try { await FP.createDirectory(source, cur); } catch (_) {}
  }
}

/**
 * Ensure a PlaylistSound pointing at `path` exists in `pl` (dedup by path).
 * Returns the existing or newly-created sound. Requires OWNER on `pl`.
 */
export async function ensureTrack(pl, path, name) {
  if (!pl) return null;
  const existing = pl.sounds.find(s => s.path === path);
  if (existing) return existing;
  const created = await pl.createEmbeddedDocuments("PlaylistSound", [{
    name: name || stripExt(baseNameOf(path)),
    path,
    channel: "music",
    volume: 0.5,
    repeat: true,
  }]);
  return created?.[0] ?? null;
}
