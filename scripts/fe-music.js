// female_edition: Music feature — entry point (in module.json).
//
// Ported from the standalone "emanim-music" module, then restructured:
//  - ONE shared Playlist (flag `sharedMusic`) created by the GM with
//    `ownership: { default: OWNER }` so every player can play/stop/add tracks
//    DIRECTLY (no socket round-trip for playback control).
//  - A unified upload folder (no per-user subdir).
//  - Original filenames preserved on disk; dedup by name+size reuses an existing
//    file (and just ensures a PlaylistSound) instead of writing a duplicate.
//  - HYBRID uploads: a player with FILES_UPLOAD writes directly (client side, see
//    fe-music-app.js); otherwise the active GM proxies the chunked upload handled here.
//  - Non-GM deletions of the shared playlist/tracks are blocked (delete guard) so
//    default:OWNER doesn't let players wipe the shared list.
//
// The client UI + upload state machine live in fe-music-app.js; pure helpers + the
// socket vocabulary live in fe-music-shared.js.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";
import {
  MUSIC_SOCKET, MUSIC_MSG, SHARED_FLAG,
  isAnyGMOnline, pickSharedPlaylist, sanitizeFileName, stripExt, normalizeDataDir, allowedAudio,
  resolveUploadTarget, ensureDirectory, ensureTrack, getFilePicker,
} from "./fe-music-shared.js";
import {
  FeMusicApp, resendMissingChunks, clearLocalUpload, markInitAck, markUploadAck, markUploadError,
  markEnsureDirAck,
} from "./fe-music-app.js";

const AUTO_INIT_KEY = "ceMusicAutoInitDone";

/**
 * Only one GM may perform authoritative music work. The check is evaluated for
 * every socket message so a backup GM handles new requests if the current
 * active GM disconnects.
 */
function isPrimaryActiveGm() {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  if (activeGM) return activeGM.id === game.user.id;

  // `activeGM` can be briefly unavailable while presence state is settling.
  // Pick the same deterministic fallback on every client rather than allowing
  // every connected GM to process the request.
  const activeGms = Array.from(game.users ?? [])
    .filter((user) => user?.active && user?.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return activeGms[0]?.id === game.user.id;
}

function musicSetting(key) {
  try { return game.settings.get(MODULE_ID, key); } catch { return FE_DEFAULTS[key]; }
}
function musicEnabled() {
  return !!musicSetting(S.MUSIC_ENABLED);
}
function musicUploadDir() {
  return normalizeDataDir(musicSetting(S.MUSIC_UPLOAD_ROOT)) || "assets/uploadedmusic";
}

/** GM이 실행: 단일 공용 플레이리스트 생성 / 권한(default:OWNER) 보정. 이름은 생성 시에만 사용. */
async function ensureSharedPlaylist({ notify = true } = {}) {
  if (!isPrimaryActiveGm()) return null;

  const OWNER = CONST.DOCUMENT_OWNERSHIP_LEVELS.OWNER;
  const name = musicSetting(S.MUSIC_PLAYLIST_NAME) || "player-uploads";

  let pl = pickSharedPlaylist();
  if (!pl) {
    pl = await Playlist.create({
      name,
      description: "플레이어 공용 업로드 음악",
      ownership: { default: OWNER },
      flags: { [MODULE_ID]: { [SHARED_FLAG]: true } },
    });
    if (notify) ui.notifications.info("Emanim Music: 공용 플레이리스트 생성 완료");
    return pl;
  }

  // 이름은 안 건드림. default:OWNER 권한만 보정.
  if ((pl.ownership?.default ?? 0) !== OWNER) {
    await pl.update({ ownership: { ...(pl.ownership ?? {}), default: OWNER } });
  }
  return pl;
}

async function ensureMusicUploadDirectory({ notify = false } = {}) {
  if (!isPrimaryActiveGm()) return false;
  const dir = musicUploadDir();
  try {
    await ensureDirectory("data", dir);
    return true;
  } catch (err) {
    console.warn("[female_edition] music upload directory init failed", err);
    if (notify) ui.notifications.warn(`음악 업로드 폴더를 만들 수 없습니다: ${dir}`);
    return false;
  }
}

/** 공용 음악 문서(플레이리스트 / 트랙) 여부 */
function isSharedPlaylist(pl) {
  return pl?.getFlag?.(MODULE_ID, SHARED_FLAG) === true;
}

/** ===== 업로드 수신 버퍼(GM, 프록시 폴백 전용) ===== */
const uploads = new Map();
const UPLOAD_TTL_MS = 10 * 60 * 1000;
const MAX_RETRY = 5;
const uploadsByUser = new Map(); // userId -> uploadId

const GM_CHUNK_SIZE_DEFAULT = 256 * 1024;
const MIN_CHUNK_SIZE = 32 * 1024;
const MAX_CHUNK_SIZE = 2 * 1024 * 1024;
const MAX_CONCURRENT_UPLOADS = 4;

function coerceChunkSize(v) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return GM_CHUNK_SIZE_DEFAULT;
  const i = Math.floor(n);
  if (i < MIN_CHUNK_SIZE) return MIN_CHUNK_SIZE;
  if (i > MAX_CHUNK_SIZE) return MAX_CHUNK_SIZE;
  return i;
}

function cleanupUpload(uploadId) {
  const rec = uploads.get(uploadId);
  if (!rec) return;
  try { clearTimeout(rec.timer); } catch (_) {}
  uploads.delete(uploadId);
  if (rec.fromUserId) uploadsByUser.delete(rec.fromUserId);
}

function toUint8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
  return null;
}

function listMissingIndices(rec) {
  const missing = [];
  for (let i = 0; i < rec.chunksTotal; i++) if (!rec.chunks[i]) missing.push(i);
  return missing;
}

async function gmHandleUploadFinish(rec) {
  const dir = musicUploadDir();
  const pl = pickSharedPlaylist();
  if (!pl) throw new Error("NO_PLAYLIST");

  const blob = new Blob(rec.chunks, { type: rec.type || "application/octet-stream" });
  const file = new File([blob], rec.targetName, { type: rec.type || "" });

  await ensureDirectory("data", dir);
  const FP = getFilePicker();
  const res = await FP.upload("data", dir, file, {}, { notify: false });
  const path = res?.path ?? `${dir}/${rec.targetName}`;

  const trackName = rec.displayName || stripExt(rec.targetName);
  await ensureTrack(pl, path, trackName);
  return { trackName, playlistId: pl.id, reused: false };
}

function findOpenApp() {
  return (
    foundry?.applications?.instances?.get?.("fe-music-app") ??
    Object.values(ui.windows ?? {}).find(w => w?.id === "fe-music-app") ??
    null
  );
}

function openApp() {
  const existing = findOpenApp();
  if (existing) {
    existing.render(true);
    existing.bringToFront?.();
    existing.bringToTop?.();
    return existing;
  }
  return new FeMusicApp().render(true);
}

function notifyClientRefresh() {
  const win = findOpenApp();
  if (win) win.render();
}

function registerSocket() {
  game.socket.on(MUSIC_SOCKET, async (msg, senderId) => {
    // Coexist with other female_edition socket listeners (screen-panel, token-glow,
    // typing-indicator): only handle the `music:`-namespaced types, bail on the rest.
    if (!msg?.type || !String(msg.type).startsWith("music:")) return;

    /** ===== 플레이어 수신 ===== */
    if (!game.user.isGM) {
      const authority = feResolveSocketSender(senderId, msg.authorityId, "music-response");
      if (!authority?.isGM) return;
      if (msg.type === MUSIC_MSG.ENSURE_DIR_ACK && msg.toUserId === game.user.id) {
        markEnsureDirAck(msg.reqId, !!msg.ok, msg.reason);
        return;
      }
      if (msg.type === MUSIC_MSG.UP_INIT_ACK && msg.toUserId === game.user.id) {
        markInitAck(msg.uploadId, { reused: !!msg.reused });
        if (msg.reused) {
          ui.notifications.info(`이미 동일한 파일이 있어 재사용했습니다: ${msg.trackName ?? ""}`);
          notifyClientRefresh();
        }
        return;
      }
      if (msg.type === MUSIC_MSG.UP_REQ_MISSING && msg.toUserId === game.user.id) {
        await resendMissingChunks({ uploadId: msg.uploadId, missing: msg.missing ?? [], attempt: msg.attempt ?? 1 });
        return;
      }
      if (msg.type === MUSIC_MSG.UP_ACK && msg.toUserId === game.user.id) {
        markUploadAck(msg.uploadId, { trackName: msg.trackName, playlistId: msg.playlistId, reused: !!msg.reused });
        ui.notifications.info(`업로드 완료: ${msg.trackName ?? ""}`);
        clearLocalUpload(msg.uploadId);
        notifyClientRefresh();
        return;
      }
      if (msg.type === MUSIC_MSG.UP_ERR && msg.toUserId === game.user.id) {
        markUploadError(msg.uploadId, msg.reason);
        ui.notifications.error(`업로드 실패: ${msg.reason ?? "unknown"}`);
        clearLocalUpload(msg.uploadId);
        return;
      }
      return;
    }

    // Every GM receives the module socket broadcast. Only the current active GM
    // may create folders, allocate upload sessions, or write the finished file.
    // This guard is dynamic, so authority transfers without re-registering the
    // listener when the active GM changes.
    if (!isPrimaryActiveGm()) return;

    const sender = feResolveSocketSender(senderId, msg.fromUserId, "music-request");
    if (!sender) return;

    /** ===== 대표 GM 처리 (프록시 업로드만) ===== */

    // 폴더 생성 요청: 플레이어가 브라우즈/생성 권한이 없어도 GM 권한으로 업로드 폴더 생성.
    // 클라이언트가 보낸 경로는 무시하고, GM 자신의 설정(musicUploadDir)만 사용 —
    // 임의 폴더 생성을 유도당하지 않기 위함.
    if (msg.type === MUSIC_MSG.ENSURE_DIR) {
      const { reqId } = msg;
      const fromUserId = sender.id;
      if (!reqId) return;
      let ok = false, reason = "";
      try {
        await ensureDirectory("data", musicUploadDir());
        ok = true;
      } catch (e) {
        reason = e?.message || "폴더 생성 실패";
      }
      game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.ENSURE_DIR_ACK, authorityId: game.user.id, toUserId: fromUserId, reqId, ok, reason });
      return;
    }

    // 업로드 INIT
    if (msg.type === MUSIC_MSG.UP_INIT) {
      const { uploadId, fileName, fileType, fileSize, chunkSize: chunkSizeRaw } = msg;
      const fromUserId = sender.id;
      if (!uploadId) return;

      const err = (reason) => game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_ERR, authorityId: game.user.id, toUserId: fromUserId, uploadId, reason });

      if (!allowedAudio(fileName)) return void err("지원하지 않는 오디오 확장자");

      const size = Number(fileSize);
      if (!Number.isFinite(size) || size <= 0) return void err("파일 크기 정보가 올바르지 않음");

      const maxMB = musicSetting(S.MUSIC_MAX_MB);
      if (size > maxMB * 1024 * 1024) return void err(`파일이 너무 큼 (최대 ${maxMB}MB)`);

      if (uploads.size >= MAX_CONCURRENT_UPLOADS) return void err("서버가 바쁨(동시 업로드 제한). 잠시 후 다시 시도");
      if (uploadsByUser.has(fromUserId)) return void err("이미 업로드가 진행 중입니다. 이전 업로드 완료 후 다시 시도");

      const pl = pickSharedPlaylist();
      if (!pl) return void err("공용 플레이리스트 없음(GM 자동 초기화 실패)");

      const dir = musicUploadDir();
      const cleanName = sanitizeFileName(fileName);
      const displayName = sanitizeFileName(msg.displayName ?? stripExt(fileName), { maxLen: 120 });

      // 이름+크기 중복 검사. 동일하면 청크 전송 없이 즉시 트랙만 보장.
      const target = await resolveUploadTarget(dir, cleanName, size);
      if (target.reused) {
        try { await ensureTrack(pl, target.path, displayName); } catch (_) {}
        game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_INIT_ACK, authorityId: game.user.id, toUserId: fromUserId, uploadId, reused: true, trackName: displayName });
        return;
      }

      cleanupUpload(uploadId);

      const chunkSize = coerceChunkSize(chunkSizeRaw);
      const chunksTotal = Math.ceil(size / chunkSize);
      const timer = setTimeout(() => cleanupUpload(uploadId), UPLOAD_TTL_MS);

      uploads.set(uploadId, {
        uploadId, fromUserId,
        targetName: target.name,   // dedup-resolved on-disk name (original or "base (n).ext")
        displayName,
        type: fileType,
        size, chunkSize, chunksTotal,
        chunks: new Array(chunksTotal),
        received: 0, retryCount: 0, timer,
      });
      uploadsByUser.set(fromUserId, uploadId);

      game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_INIT_ACK, authorityId: game.user.id, toUserId: fromUserId, uploadId, reused: false });
      return;
    }

    // 업로드 CHUNK
    if (msg.type === MUSIC_MSG.UP_CHUNK) {
      const { uploadId, index, data } = msg;
      const rec = uploads.get(uploadId);
      if (!rec) return;
      if (sender.id !== rec.fromUserId) return;

      const idx = Number(index);
      if (!Number.isInteger(idx) || idx < 0 || idx >= rec.chunksTotal) return;
      if (rec.chunks[idx]) return;

      const u8 = toUint8(data);
      if (!u8) return;

      const expected = idx === rec.chunksTotal - 1
        ? Math.max(0, rec.size - idx * rec.chunkSize)
        : rec.chunkSize;
      if (u8.byteLength > expected + 1024) return;

      rec.chunks[idx] = u8;
      rec.received++;
      return;
    }

    // 업로드 FINISH
    if (msg.type === MUSIC_MSG.UP_FINISH) {
      const { uploadId } = msg;
      const rec = uploads.get(uploadId);

      if (!rec) {
        game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_ERR, authorityId: game.user.id, toUserId: sender.id, uploadId, reason: "업로드 세션 없음(다시 업로드 시작)" });
        return;
      }
      if (sender.id !== rec.fromUserId) return;

      const missing = listMissingIndices(rec);
      if (missing.length > 0) {
        rec.retryCount++;
        if (rec.retryCount > MAX_RETRY) {
          cleanupUpload(uploadId);
          game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_ERR, authorityId: game.user.id, toUserId: rec.fromUserId, uploadId, reason: `전송 누락 반복(누락 ${missing.length}개). 파일 다시 선택` });
          return;
        }
        game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_REQ_MISSING, authorityId: game.user.id, toUserId: rec.fromUserId, uploadId, attempt: rec.retryCount, missing });
        return;
      }

      try {
        const { trackName, playlistId } = await gmHandleUploadFinish(rec);
        game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_ACK, authorityId: game.user.id, toUserId: rec.fromUserId, uploadId, trackName, playlistId, reused: false });
      } catch (e) {
        const reason = e?.message === "NO_PLAYLIST" ? "공용 플레이리스트 없음" : "서버 업로드 실패";
        game.socket.emit(MUSIC_SOCKET, { type: MUSIC_MSG.UP_ERR, authorityId: game.user.id, toUserId: rec.fromUserId, uploadId, reason });
      } finally {
        cleanupUpload(uploadId);
      }
    }
  });
}

/** 공용 플레이리스트가 바뀌면(추가/삭제/재생상태) 열려 있는 음악 창을 갱신.
 *  직접 업로드/재생은 소켓을 타지 않으므로, 문서 변경 훅으로 모든 클라이언트의
 *  창을 라이브 동기화한다. */
function registerLiveRefresh() {
  const onSound = (sound) => { if (isSharedPlaylist(sound?.parent)) notifyClientRefresh(); };
  Hooks.on("createPlaylistSound", onSound);
  Hooks.on("updatePlaylistSound", onSound);
  Hooks.on("deletePlaylistSound", onSound);
  Hooks.on("updatePlaylist", (pl) => { if (isSharedPlaylist(pl)) notifyClientRefresh(); });
}

/** 비-GM의 공용 플레이리스트/트랙 삭제 차단 (default:OWNER 부작용 가드) */
function registerDeleteGuards() {
  Hooks.on("preDeletePlaylist", (doc) => {
    if (!isSharedPlaylist(doc) || game.user.isGM) return;
    ui.notifications.warn("공용 음악 플레이리스트는 GM만 삭제할 수 있습니다.");
    return false;
  });
  Hooks.on("preDeletePlaylistSound", (doc) => {
    if (!isSharedPlaylist(doc?.parent) || game.user.isGM) return;
    ui.notifications.warn("공용 음악 트랙은 GM만 삭제할 수 있습니다.");
    return false;
  });
}

/** 사이드바(Playlists 탭) 버튼 자동 삽입 */
function registerSidebarButton() {
  function getPlaylistDirectoryClass() {
    return (
      globalThis.CONFIG?.ui?.playlists ??
      foundry?.applications?.sidebar?.tabs?.PlaylistDirectory ??
      foundry?.applications?.sidebar?.PlaylistDirectory ??
      globalThis?.PlaylistDirectory ??
      null
    );
  }

  // 1) 공식 Header Controls (ApplicationV2)
  Hooks.on("getHeaderControlsApplicationV2", (app, controls) => {
    const PD = getPlaylistDirectoryClass();
    if (typeof PD !== "function" || !(app instanceof PD)) return;
    if (controls?.some?.(c => c?.action === "fe-music-open")) return;
    controls.push({
      action: "fe-music-open",
      icon: "fa-solid fa-music",
      label: "Emanim Music",
      onClick: () => openApp(),
      visible: true
    });
  });

  // 2) DOM 주입 (fallback, 중복 방지)
  function injectIntoDirectoryHeader(root) {
    const el =
      root instanceof HTMLElement ? root :
      (root?.[0] instanceof HTMLElement ? root[0] :
      (root?.element instanceof HTMLElement ? root.element : null));
    if (!el) return;

    const header =
      el.querySelector(".directory-header") ??
      el.querySelector("header.directory-header") ??
      el.querySelector(".header") ??
      el.querySelector("header");
    if (!header) return;

    if (
      header.querySelector(".fe-music-open") ||
      header.querySelector('[data-action="fe-music-open"]') ||
      header.querySelector('[data-control="fe-music-open"]')
    ) return;

    const btn = document.createElement("a");
    btn.className = "header-control fe-music-open";
    btn.dataset.action = "fe-music-open";
    btn.setAttribute("title", "Emanim Music");
    btn.setAttribute("aria-label", "Emanim Music");
    btn.innerHTML = '<i class="fa-solid fa-music"></i>';

    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      openApp();
    });

    const target =
      header.querySelector(".header-actions") ??
      header.querySelector(".header-controls") ??
      header.querySelector(".action-buttons") ??
      header;

    target.appendChild(btn);
  }

  Hooks.on("renderPlaylistDirectory", (app, html) => injectIntoDirectoryHeader(html));

  // 모듈을 월드 실행 중에 켠 경우 대비
  Hooks.on("ready", () => {
    try { if (ui?.playlists?.element) injectIntoDirectoryHeader(ui.playlists.element); } catch (_) {}
  });
}

Hooks.once("init", () => {
  // World-scope GM config. config:false — surfaced via the unified settings menu
  // (음악 section), never the core Module Settings sheet, per project convention.
  game.settings.register(MODULE_ID, S.MUSIC_ENABLED, {
    scope: "world", config: false, type: Boolean,
    default: FE_DEFAULTS[S.MUSIC_ENABLED], requiresReload: true
  });
  game.settings.register(MODULE_ID, S.MUSIC_PLAYLIST_NAME, {
    scope: "world", config: false, type: String, default: FE_DEFAULTS[S.MUSIC_PLAYLIST_NAME]
  });
  game.settings.register(MODULE_ID, S.MUSIC_UPLOAD_ROOT, {
    scope: "world", config: false, type: String, default: FE_DEFAULTS[S.MUSIC_UPLOAD_ROOT],
    onChange: () => {
      if (!musicEnabled()) return;
      ensureMusicUploadDirectory({ notify: true });
    }
  });
  game.settings.register(MODULE_ID, S.MUSIC_MAX_MB, {
    scope: "world", config: false, type: Number, default: FE_DEFAULTS[S.MUSIC_MAX_MB]
  });
  // One-time auto-init flag (hidden).
  game.settings.register(MODULE_ID, AUTO_INIT_KEY, {
    scope: "world", config: false, type: Boolean, default: false
  });

  if (!musicEnabled()) return;

  const mod = game.modules.get(MODULE_ID);
  if (mod) {
    // Namespaced under the shared module api object — do not clobber other features.
    mod.api ??= {};
    mod.api.music = {
      open: () => openApp(),
      ensurePlaylist: () => ensureSharedPlaylist({ notify: true }),
      isAnyGMOnline
    };
  }

  registerSidebarButton();
});

Hooks.once("ready", async () => {
  if (!musicEnabled()) return;

  registerSocket();
  registerDeleteGuards();
  registerLiveRefresh();

  if (isPrimaryActiveGm()) {
    // 공용 플레이리스트 생성/권한 보정(이름은 생성 시에만). 첫 부트스트랩 1회 알림.
    const done = game.settings.get(MODULE_ID, AUTO_INIT_KEY);
    await ensureSharedPlaylist({ notify: false });
    await ensureMusicUploadDirectory({ notify: true });
    if (!done) await game.settings.set(MODULE_ID, AUTO_INIT_KEY, true);
  }
});
