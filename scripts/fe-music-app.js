// female_edition: Music feature — client UI (ApplicationV2) + upload logic.
//
// ApplicationV2 (HandlebarsApplicationMixin) per the project convention. The window
// drives a SINGLE shared playlist (everyone is OWNER via default:OWNER), so play /
// stop / dj run directly against the playlist with NO socket round-trip. File writes
// use a HYBRID path: if the user has FILES_UPLOAD they upload directly (and add the
// PlaylistSound themselves, since they own the shared playlist); otherwise they fall
// back to the GM-proxied chunked socket protocol. Dedup-by-name+size and original
// filename preservation are handled by fe-music-shared.js helpers (used on whichever
// side performs the upload).
//
// Imports shared helpers + S/MODULE_ID only — no import of fe-music.js (the GM-side
// entry), so there is no circular dependency.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
import {
  MUSIC_SOCKET, MUSIC_MSG,
  isAnyGMOnline, pickSharedPlaylist, normalizeDataDir, sanitizeFileName, stripExt,
  baseNameOf, getAudioHelper, extOf, getFilePicker, resolveUploadTarget, ensureDirectory, ensureTrack,
} from "./fe-music-shared.js";

const { ApplicationV2, HandlebarsApplicationMixin } = foundry.applications.api;

const CHUNK_SIZE = 256 * 1024;
const LOCAL_MAX_RETRY = 5;
const INIT_ACK_TIMEOUT_MS = 15000;
const FINISH_ACK_TIMEOUT_MS = 11 * 60 * 1000;

const localUploads = new Map(); // uploadId -> rec

function readSetting(key) {
  try { return game.settings.get(MODULE_ID, key); } catch { return FE_DEFAULTS[key]; }
}

/**
 * Whether THIS client can write files directly (skips the GM proxy chunk relay).
 * Requires FILES_UPLOAD (to write the file at all). Folder creation is delegated:
 *  - a client WITH FILES_BROWSE creates/deduplicates the folder itself;
 *  - a client WITHOUT FILES_BROWSE lets an online GM create the folder over the
 *    socket (see ensureUploadDir / requestGmEnsureDir), so it must NOT try to
 *    browse/create locally (that throws "You do not have permission to browse the
 *    host file system!"). Hence direct upload also needs EITHER browse OR a GM
 *    online to make the folder on its behalf. Everyone else falls back to the
 *    full GM-proxied chunked upload.
 */
function canUploadDirect() {
  if (game.user?.can?.("FILES_UPLOAD") !== true) return false;
  return game.user?.can?.("FILES_BROWSE") === true || isAnyGMOnline();
}

/**
 * Ensure the upload directory exists, preferring GM authority when this client
 * cannot create folders itself. The reason it was failing before: a player tried
 * to create the `assets` folder and lacked FILES_BROWSE. Now a browse-less client
 * asks the online GM to create the folder (with the GM's own permissions), and
 * only self-creates when it actually has the rights.
 */
async function ensureUploadDir(dir) {
  const canSelf = !!game.user?.isGM || game.user?.can?.("FILES_BROWSE") === true;
  if (canSelf) { await ensureDirectory("data", dir); return; }
  if (isAnyGMOnline()) { await requestGmEnsureDir(); return; }
  // Last resort — will surface a clear permission error to the caller/user.
  await ensureDirectory("data", dir);
}

// ── GM-authoritative folder creation (browse-less client → GM makes the dir) ──

const ensureDirWaiters = new Map(); // reqId -> { resolve, reject, timer }
const ENSURE_DIR_TIMEOUT_MS = 15000;

/** Ask an online GM to create the configured upload folder; resolves when done. */
function requestGmEnsureDir() {
  const reqId = `${game.user.id}-dir-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ensureDirWaiters.delete(reqId);
      reject(new Error("ENSURE_DIR_TIMEOUT"));
    }, ENSURE_DIR_TIMEOUT_MS);
    ensureDirWaiters.set(reqId, { resolve, reject, timer });
    game.socket.emit(MUSIC_SOCKET, {
      type: MUSIC_MSG.ENSURE_DIR,
      reqId,
      fromUserId: game.user.id,
    });
  });
}

/** Driven by the GM's ENSURE_DIR_ACK in fe-music.js. */
export function markEnsureDirAck(reqId, ok, reason) {
  const w = ensureDirWaiters.get(reqId);
  if (!w) return;
  clearTimeout(w.timer);
  ensureDirWaiters.delete(reqId);
  if (ok) w.resolve(true);
  else w.reject(new Error(reason || "ENSURE_DIR_FAILED"));
}

function musicUploadDir() {
  return normalizeDataDir(readSetting(S.MUSIC_UPLOAD_ROOT)) || "assets/uploadedmusic";
}

// ── Upload acknowledgement plumbing (driven by the socket handler in fe-music.js) ──

export function clearLocalUpload(uploadId) {
  if (!uploadId) return;
  const rec = localUploads.get(uploadId);
  if (rec?.ackTimer) clearTimeout(rec.ackTimer);
  if (rec?.doneTimer) clearTimeout(rec.doneTimer);
  localUploads.delete(uploadId);
}

function waitForInitAck(uploadId) {
  const rec = localUploads.get(uploadId);
  if (!rec) return Promise.reject(new Error("NO_LOCAL_UPLOAD"));

  return new Promise((resolve, reject) => {
    rec.ackResolve = resolve;
    rec.ackReject = reject;
    rec.ackTimer = setTimeout(() => {
      try { rec.ackReject?.(new Error("INIT_ACK_TIMEOUT")); } catch (_) {}
    }, INIT_ACK_TIMEOUT_MS);
  });
}

export function markInitAck(uploadId, payload = {}) {
  const rec = localUploads.get(uploadId);
  if (!rec) return;
  if (rec.ackTimer) clearTimeout(rec.ackTimer);
  rec.ackResolve?.(payload);
  rec.ackResolve = null;
  rec.ackReject = null;
  rec.ackTimer = null;
}

function waitForFinishAck(uploadId) {
  const rec = localUploads.get(uploadId);
  if (!rec) return Promise.reject(new Error("NO_LOCAL_UPLOAD"));

  return new Promise((resolve, reject) => {
    rec.doneResolve = resolve;
    rec.doneReject = reject;
    rec.doneTimer = setTimeout(() => {
      try { rec.doneReject?.(new Error("FINISH_ACK_TIMEOUT")); } catch (_) {}
    }, FINISH_ACK_TIMEOUT_MS);
  });
}

export function markUploadAck(uploadId, payload = {}) {
  const rec = localUploads.get(uploadId);
  if (!rec) return;
  if (rec.doneTimer) clearTimeout(rec.doneTimer);
  rec.doneResolve?.(payload);
  rec.doneResolve = null;
  rec.doneReject = null;
  rec.doneTimer = null;
}

export function markUploadError(uploadId, reason) {
  const rec = localUploads.get(uploadId);
  if (!rec) return;

  // INIT_ACK 대기 중이면 종료
  if (rec.ackTimer) clearTimeout(rec.ackTimer);
  try { rec.ackReject?.(new Error(`UP_ERR:${reason ?? "unknown"}`)); } catch (_) {}
  rec.ackResolve = null;
  rec.ackReject = null;
  rec.ackTimer = null;

  // FINISH_ACK 대기 중이면 종료
  if (rec.doneTimer) clearTimeout(rec.doneTimer);
  try { rec.doneReject?.(new Error(`UP_ERR:${reason ?? "unknown"}`)); } catch (_) {}
  rec.doneResolve = null;
  rec.doneReject = null;
  rec.doneTimer = null;
}

/** GM 누락 청크 요청 → 자동 재전송 */
export async function resendMissingChunks({ uploadId, missing, attempt }) {
  const rec = localUploads.get(uploadId);
  if (!rec) return;

  if (rec.retries >= LOCAL_MAX_RETRY) {
    ui.notifications.error("재전송 한도 초과. 파일 다시 선택하세요.");
    clearLocalUpload(uploadId);
    return;
  }
  rec.retries++;

  const miss = Array.isArray(missing) ? missing : [];
  if (!miss.length) return;

  ui.notifications.info(`누락 청크 재전송 중... (${miss.length}개, 시도 ${attempt ?? rec.retries})`);

  for (const i of miss) {
    const idx = Number(i);
    if (!Number.isInteger(idx) || idx < 0 || idx >= rec.totalChunks) continue;

    const start = idx * rec.chunkSize;
    const end = Math.min(rec.file.size, start + rec.chunkSize);
    const buf = await rec.file.slice(start, end).arrayBuffer();

    game.socket.emit(MUSIC_SOCKET, {
      type: MUSIC_MSG.UP_CHUNK,
      uploadId,
      index: idx,
      data: buf
    });

    if ((idx + 1) % 8 === 0) await new Promise(r => setTimeout(r, 0));
  }

  game.socket.emit(MUSIC_SOCKET, {
    type: MUSIC_MSG.UP_FINISH,
    uploadId,
    fromUserId: game.user.id
  });
}

// ── Direct playback helpers (everyone is OWNER on the shared playlist) ──

async function stopSharedMusic(pl) {
  if (!pl) return;
  await pl.update({
    playing: false,
    sounds: pl.sounds.map(s => ({ _id: s.id, playing: false, pausedTime: null })),
  }, { diff: false, forceSync: true });
}

async function stopSharedSound(pl, sound) {
  if (!pl || !sound) return;
  await pl.update({
    playing: pl.sounds.some(s => (s.id !== sound.id) && s.playing),
    sounds: pl.sounds.map(s => ({
      _id: s.id,
      playing: s.id === sound.id ? false : s.playing,
      pausedTime: s.id === sound.id ? null : s.pausedTime,
    })),
  }, { diff: false, forceSync: true });
}

// ── The window ──

export class FeMusicApp extends HandlebarsApplicationMixin(ApplicationV2) {
  constructor(...args) {
    super(...args);
    this._uploading = false;
    this._uploadStatusText = null;
  }

  static DEFAULT_OPTIONS = {
    id: "fe-music-app",
    classes: ["female-edition", "fe-music-app"],
    tag: "div",
    window: { title: "음악 (Emanim Music)", icon: "fa-solid fa-music", resizable: true },
    position: { width: 560, height: "auto" },
    actions: {
      refresh:   FeMusicApp.#onRefresh,
      stopMusic: FeMusicApp.#onStopMusic,
      play:      FeMusicApp.#onPlay,
      stop:      FeMusicApp.#onStop,
      dj:        FeMusicApp.#onDjPlay,
      del:       FeMusicApp.#onDelete,
    },
  };

  static PARTS = {
    body: { template: `modules/${MODULE_ID}/templates/fe-music.hbs` },
  };

  get playlist() {
    return pickSharedPlaylist();
  }

  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const pl = this.playlist;
    const isGM = !!game.user.isGM;
    const sounds = pl
      ? pl.sounds.contents
          .slice()
          .sort((a, b) => (a.sort ?? 0) - (b.sort ?? 0))
          .map(s => ({ id: s.id, name: s.name, playing: !!s.playing, canDelete: isGM }))
      : [];

    const direct = canUploadDirect();
    const gmOnline = isAnyGMOnline();
    // Direct uploaders don't need the GM; proxy uploaders do.
    const canUploadNow = direct || gmOnline;

    return {
      ...context,
      hasPlaylist: !!pl,
      playlistName: pl?.name ?? "(아직 없음)",
      uploadDir: musicUploadDir(),
      direct,
      sounds,
      gmOnline,
      uploadStatusText: this._uploadStatusText ?? null,
      uploadDisabled: this._uploading || !canUploadNow,
    };
  }

  _onRender(context, options) {
    super._onRender?.(context, options);
    const root = this.element;

    // Upload <input type="file"> change + drag-and-drop are NOT click actions, so
    // they are wired here rather than via the DEFAULT_OPTIONS.actions map.
    const fileInput = root.querySelector('input[type="file"][data-fe-upload]');
    if (fileInput) fileInput.addEventListener("change", (ev) => this._onUploadChange(ev));

    const dropZone = root.querySelector("[data-drop-zone]");
    if (dropZone) {
      dropZone.addEventListener("dragover", (ev) => {
        if (this._uploading) return;
        ev.preventDefault();
        dropZone.classList.add("drag-over");
      });
      dropZone.addEventListener("dragleave", (ev) => {
        if (!dropZone.contains(ev.relatedTarget)) dropZone.classList.remove("drag-over");
      });
      dropZone.addEventListener("drop", (ev) => {
        ev.preventDefault();
        dropZone.classList.remove("drag-over");
        if (this._uploading) return;
        if (!canUploadDirect() && !isAnyGMOnline()) return;
        const files = Array.from(ev.dataTransfer?.files ?? []).filter(Boolean);
        if (files.length) this._processFiles(files);
      });
    }
  }

  // ── Action handlers (this = app instance; signature (event, target)) ──

  static #onRefresh() { this.render(); }

  static async #onStopMusic() {
    await stopSharedMusic(this.playlist);
    this.render();
  }

  static async #onPlay(_event, target) {
    const pl = this.playlist;
    const sound = pl?.sounds?.get(target.dataset.soundId);
    if (!pl || !sound) return;
    await pl.playSound(sound);
    this.render();
  }

  static async #onStop(_event, target) {
    const pl = this.playlist;
    const sound = pl?.sounds?.get(target.dataset.soundId);
    if (!pl || !sound) return;
    await stopSharedSound(pl, sound);
    this.render();
  }

  // DJ = stop everything currently playing on the shared playlist, then play mine.
  static async #onDjPlay(_event, target) {
    const pl = this.playlist;
    const sound = pl?.sounds?.get(target.dataset.soundId);
    if (!pl || !sound) return;
    await stopSharedMusic(pl);
    await pl.playSound(sound);
    this.render();
  }

  // Delete a track (GM only; non-GM deletes are blocked by the guard in fe-music.js).
  static async #onDelete(_event, target) {
    if (!game.user.isGM) return;
    const pl = this.playlist;
    const sound = pl?.sounds?.get(target.dataset.soundId);
    if (!pl || !sound) return;
    const ok = await foundry.applications.api.DialogV2.confirm({
      window: { title: "트랙 삭제" },
      content: `<p>"${sound.name}" 트랙을 플레이리스트에서 제거할까요?<br>(디스크의 파일은 지워지지 않습니다.)</p>`,
    }).catch(() => false);
    if (!ok) return;
    await sound.delete();
    this.render();
  }

  // ── Upload flow ──

  async _onUploadChange(ev) {
    const input = ev.currentTarget;
    const files = Array.from(input?.files ?? []);
    if (input) input.value = "";
    if (!files.length) return;
    await this._processFiles(files);
  }

  async _processFiles(files) {
    if (this._uploading) {
      ui.notifications.warn("이미 업로드가 진행 중입니다.");
      return;
    }
    if (!this.playlist) {
      ui.notifications.error("공용 플레이리스트가 아직 없습니다. (GM이 월드에 들어오면 자동 생성)");
      return;
    }

    this._uploading = true;
    const total = files.length;
    const maxMB = readSetting(S.MUSIC_MAX_MB);
    const direct = canUploadDirect();
    let success = 0;
    let reused = 0;
    let failed = 0;

    const setStatus = (text) => {
      this._uploadStatusText = text;
      this.render();
    };

    try {
      for (let fi = 0; fi < total; fi++) {
        const file = files[fi];
        if (!file) continue;

        setStatus(
          total > 1
            ? `업로드 중 (${fi + 1}/${total}): ${file.name}`
            : `업로드 중: ${file.name}`
        );

        if (file.size > maxMB * 1024 * 1024) {
          ui.notifications.error(`파일이 너무 큽니다. (최대 ${maxMB}MB): ${file.name}`);
          failed++;
          continue;
        }

        const _AH = getAudioHelper();
        const audioOk = _AH?.hasAudioExtension
          ? _AH.hasAudioExtension(file.name)
          : ["mp3", "ogg", "wav", "flac", "m4a", "webm"].includes(extOf(file.name));
        if (!audioOk) {
          ui.notifications.error(`지원하지 않는 오디오 확장자: ${file.name}`);
          failed++;
          continue;
        }

        try {
          const r = direct ? await this._directUpload(file) : await this._proxyUpload(file);
          if (r === "reused") reused++; else success++;
        } catch (e) {
          if (e?.message !== "HANDLED") {
            console.error("female_edition | music upload failed", e);
            ui.notifications.error(`업로드 실패: ${file.name}${e?.message ? ` (${e.message})` : ""}`);
          }
          failed++;
        }
      }
    } finally {
      this._uploading = false;
      this._uploadStatusText = null;
      this.render();
    }

    if (total > 1 || reused) {
      ui.notifications.info(`업로드 결과: 추가 ${success}개, 중복재사용 ${reused}개, 실패 ${failed}개`);
    }
  }

  // Direct path: write the file ourselves + add the PlaylistSound (we own the playlist).
  async _directUpload(file) {
    const FP = getFilePicker();
    const dir = musicUploadDir();
    await ensureUploadDir(dir);

    const fileName = sanitizeFileName(file.name);             // original name, ext kept
    const target = await resolveUploadTarget(dir, fileName, file.size);

    let path = target.path;
    if (!target.reused) {
      const toUpload = target.name === file.name
        ? file
        : new File([file], target.name, { type: file.type });
      const res = await FP.upload("data", dir, toUpload, {}, { notify: false });
      path = res?.path ?? target.path;
    }

    await ensureTrack(this.playlist, path, stripExt(baseNameOf(path)));
    return target.reused ? "reused" : "added";
  }

  // Proxy path: GM-relayed chunked upload (for clients without FILES_UPLOAD).
  async _proxyUpload(file) {
    if (!isAnyGMOnline()) {
      ui.notifications.error(`GM이 온라인이어야 업로드(프록시)가 됩니다: ${file.name}`);
      throw new Error("HANDLED");
    }

    const fileName = sanitizeFileName(file.name);             // original name, ext kept
    const displayName = sanitizeFileName(stripExt(file.name), { maxLen: 120 });
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    const uploadId = `${game.user.id}-${Date.now()}-${Math.random().toString(16).slice(2)}`;

    localUploads.set(uploadId, {
      file,
      chunkSize: CHUNK_SIZE,
      totalChunks,
      retries: 0,
      ackResolve: null, ackReject: null, ackTimer: null,
      doneResolve: null, doneReject: null, doneTimer: null,
    });

    const initPromise = waitForInitAck(uploadId);

    game.socket.emit(MUSIC_SOCKET, {
      type: MUSIC_MSG.UP_INIT,
      uploadId,
      fromUserId: game.user.id,
      fileName,
      displayName,
      fileType: file.type,
      fileSize: file.size,
      chunkSize: CHUNK_SIZE,
      chunksTotal: totalChunks,
    });

    let initInfo;
    try {
      initInfo = await initPromise;
    } catch (e) {
      if (e?.message === "INIT_ACK_TIMEOUT") {
        ui.notifications.error(`서버 응답 지연(UP_INIT_ACK): ${file.name}`);
      }
      clearLocalUpload(uploadId);
      throw new Error("HANDLED");
    }

    // GM detected an identical file (name+size) already present → no chunks needed.
    if (initInfo?.reused) {
      clearLocalUpload(uploadId);
      return "reused";
    }

    for (let i = 0; i < totalChunks; i++) {
      const start = i * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      const buf = await file.slice(start, end).arrayBuffer();

      game.socket.emit(MUSIC_SOCKET, {
        type: MUSIC_MSG.UP_CHUNK,
        uploadId,
        index: i,
        data: buf,
      });

      if ((i + 1) % 8 === 0) await new Promise(r => setTimeout(r, 0));
    }

    const donePromise = waitForFinishAck(uploadId);

    game.socket.emit(MUSIC_SOCKET, {
      type: MUSIC_MSG.UP_FINISH,
      uploadId,
      fromUserId: game.user.id,
    });

    try {
      const res = await donePromise;
      return res?.reused ? "reused" : "added";
    } catch (e) {
      if (e?.message === "FINISH_ACK_TIMEOUT") {
        ui.notifications.error(`서버 응답 지연(UP_ACK/UP_ERR): ${file.name}`);
        clearLocalUpload(uploadId);
      }
      throw new Error("HANDLED");
    }
  }
}
