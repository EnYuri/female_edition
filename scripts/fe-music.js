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
  FE_CONFLICT_FEATURE,
  feIsConflictFeatureSuppressed,
  feIsActiveModuleFeatureEnabled,
} from "./fe-conflict-state.js";
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
  return !!musicSetting(S.MUSIC_ENABLED)
    && !feIsConflictFeatureSuppressed(FE_CONFLICT_FEATURE.MUSIC)
    && !feIsActiveModuleFeatureEnabled("emanim-music");
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

    /** ===== 요청자 수신(업로드 응답) ===== */
    // Gated on "is NOT the authority", not on "is not a GM". `User#isGM` is
    // ASSISTANT-or-higher (common/documents/user.mjs:124), while FILES_UPLOAD is
    // revocable from ASSISTANT — its `requiredRoles` is [GAMEMASTER] alone
    // (common/constants.mjs:1312), unlike FILES_BROWSE which ASSISTANT can never
    // lose. So a world whose GM revokes assistant upload rights puts that assistant
    // on the PROXY path, and an `isGM` gate here made them emit UP_INIT and then
    // ignore their own UP_INIT_ACK — every upload died at INIT_ACK_TIMEOUT while
    // isPrimaryActiveGm() (highest role wins, via getDesignatedUser) also kept them
    // out of the handler below. Letting non-authority GMs run this branch is safe:
    // every handler in it already requires `msg.toUserId === game.user.id`, and the
    // authority never proxy-uploads to itself.
    if (!isPrimaryActiveGm()) {
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

    // Past this point the client IS the current active GM — the only one that may
    // create folders, allocate upload sessions, or write the finished file. The
    // branch above is the dynamic guard, so authority transfers without
    // re-registering the listener when the active GM changes.
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

      // A client has no way to cancel a GM-side session: closing the window or
      // reloading mid-transfer just abandons it, and it then survives for the full
      // UPLOAD_TTL_MS. Rejecting the retry left that user locked out for up to ten
      // minutes ("이미 업로드가 진행 중입니다") with nothing they could do about it,
      // and the dead session still counted against MAX_CONCURRENT_UPLOADS for
      // everyone else. Supersede instead of reject — the one-session-per-user cap is
      // unchanged (the old record is dropped before the new one is created), it is
      // just no longer the *first* session that wins.
      const prevUploadId = uploadsByUser.get(fromUserId);
      if (prevUploadId && prevUploadId !== uploadId) cleanupUpload(prevUploadId);

      if (uploads.size >= MAX_CONCURRENT_UPLOADS) return void err("서버가 바쁨(동시 업로드 제한). 잠시 후 다시 시도");

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

      // TTL is an ABANDONMENT timeout, not a transfer deadline. It was armed once
      // at UP_INIT, so a large file on a slow link could have its session collected
      // out from under it mid-transfer and fail at UP_FINISH with "업로드 세션 없음".
      // Re-arm on progress: an actually-abandoned session still expires
      // UPLOAD_TTL_MS after its LAST chunk, and the client's own
      // FINISH_ACK_TIMEOUT_MS is only awaited after the final chunk is sent, so it
      // still outlives the GM record it is waiting on.
      try { clearTimeout(rec.timer); } catch (_) {}
      rec.timer = setTimeout(() => cleanupUpload(uploadId), UPLOAD_TTL_MS);
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

/**
 * Replace Foundry's always-visible per-sound volume slider with a playback seek
 * slider. The original volume control is preserved inside a button-triggered
 * popover, so core's own volume handler continues to own volume changes.
 */
function registerPlaylistSeekControls() {
  const SEEK_SELECTOR = ".fe-music-seek";
  // uuid → generation of the newest local seek-sync run for that sound. Entries are
  // dropped once their run settles (see the `finally` in the updatePlaylistSound
  // hook), so the map only ever holds in-flight seeks. `seekSeq` is monotonic and
  // never reused, which is what makes that deletion safe: were the generation
  // re-derived from the map it could restart at 1 and a slow superseded run could
  // mistake itself for the current one.
  const seekGenerations = new Map();
  let seekSeq = 0;

  const extractElement = (html) => {
    const el = html?.nodeType ? html : html?.[0];
    return el?.querySelectorAll ? el : null;
  };

  const formatTimestamp = (seconds) => {
    if (!Number.isFinite(seconds)) return "∞";
    const value = Math.max(0, seconds ?? 0);
    const minutes = Math.floor(value / 60);
    const remainder = Math.round(value % 60);
    return `${minutes}:${String(remainder).padStart(2, "0")}`;
  };

  const soundForElement = (el) => {
    const row = el?.closest?.(".sound[data-playlist-id][data-sound-id]");
    const playlist = row ? game.playlists?.get(row.dataset.playlistId) : null;
    return { row, playlist, sound: playlist?.sounds?.get(row.dataset.soundId) ?? null };
  };

  const closeVolumePopovers = (except = null) => {
    for (const popover of document.querySelectorAll(".fe-music-volume-popover:not([hidden])")) {
      if (popover === except) continue;
      popover.hidden = true;
      popover.closest(".fe-music-volume-control")
        ?.querySelector(".fe-music-volume-toggle")
        ?.setAttribute("aria-expanded", "false");
    }
  };

  // `knownSound` skips the row→playlist→sound lookup for callers that already hold
  // the document (the per-second tick walks sounds, not sliders).
  const updateSeekSlider = (slider, knownSound = null) => {
    if (!slider || slider.dataset.seeking === "true") return;
    if (slider.dataset.dragging === "true") {
      const current = slider.closest(".sound")?.querySelector(".sound-timer .current");
      if (current) current.textContent = formatTimestamp(Number(slider.value));
      return;
    }
    const sound = knownSound ?? soundForElement(slider).sound;
    if (!sound) return;

    const duration = Number(sound.sound?.duration);
    if (!Number.isFinite(duration) || duration <= 0) {
      slider.disabled = true;
      slider.max = "1";
      slider.value = "0";
      slider.setAttribute("aria-valuetext", "재생 시간 불러오는 중");
      return;
    }

    const current = Number(sound.playing ? sound.sound?.currentTime : sound.pausedTime) || 0;
    slider.disabled = !sound.isOwner;
    slider.max = String(duration);
    slider.value = String(Math.clamp(current, 0, duration));
    slider.setAttribute("aria-valuetext", `${formatTimestamp(current)} / ${formatTimestamp(duration)}`);
  };

  // --- Seek-slider refresh (MUST keep: no timer of our own) ---------------------
  //
  // The playhead only advances while a sound is actually playing, and there is
  // already a timer on the page running exactly that cadence: core's
  // PlaylistDirectory arms `setInterval(this.updateTimestamps.bind(this), 1000)` in
  // `_onFirstRender` (playlist-directory.mjs:315) and never clears it, to keep the
  // `.current`/`.duration` text sitting right next to our slider live. So we ride
  // core's tick and own no timer at all.
  //
  // What this replaced: a bare `setInterval(…, 500)` armed at `ready` with no
  // `clearInterval` — a `querySelectorAll` plus a per-slider `game.playlists.get`/
  // `sounds.get`, twice a second, for the whole session, in every client, whether
  // or not the Playlists tab was ever opened and whether or not anything was
  // playing. Per-tick work is now proportional to the sounds that are actually
  // playing (usually one), and 1s lands the slider on the same frame as the
  // timestamp beside it instead of drifting against it at 500ms.
  //
  // Dropping to core's cadence loses nothing, because everything a NON-playing
  // slider needs is event-driven: a play/pause/stop/seek writes `playing` or
  // `pausedTime` → `updatePlaylistSound`; a row rebuild → `renderPlaylistDirectory`.
  // A paused playhead does not move on its own.

  // A playing sound is rendered TWICE — once in the directory tree, once in the
  // "currently playing" panel — from the same `sound-partial.hbs`, so this is
  // querySelectorAll, not querySelector. Matched on playlist-id + sound-id rather
  // than the row's `data-sound-uuid`: those are the two attributes `soundForElement`
  // has always relied on, i.e. the pair proven present on every supported core
  // version, and the ids are plain alphanumeric so they need no selector escaping.
  const seekSlidersForSound = (sound) => document.querySelectorAll(
    `.playlists-sidebar .sound[data-playlist-id="${sound.parent?.id}"][data-sound-id="${sound.id}"] ${SEEK_SELECTOR}`
  );

  /**
   * Per-tick path: walk the playing sounds, not the sliders.
   * `Playlist#playing` is derived in `prepareDerivedData` (client/documents/playlist.mjs:82 —
   * `this.sounds.some(s => s.playing)`), so `game.playlists.playing` cannot go stale.
   */
  const refreshPlayingSeekSliders = () => {
    for (const playlist of game.playlists?.playing ?? []) {
      for (const sound of playlist.sounds) {
        if (!sound.playing) continue;
        for (const slider of seekSlidersForSound(sound)) updateSeekSlider(slider, sound);
      }
    }
  };

  /** Event path: rare enough that sweeping every slider is the simpler correct thing. */
  const refreshAllSeekSliders = () => {
    for (const slider of document.querySelectorAll(`.playlists-sidebar ${SEEK_SELECTOR}`)) {
      updateSeekSlider(slider);
    }
  };

  // Must be `setup`, NOT `ready`: core binds the interval callback as
  // `this.updateTimestamps.bind(this)`, and `.bind` resolves the method off the
  // prototype AT BIND TIME. The sidebar first renders inside `initializeUI`, and
  // game.mjs runs setup (:740) → initializeUI (:764) → ready (:779) — so a patch
  // installed at `ready` would be captured by nobody and silently never run.
  Hooks.once("setup", () => {
    const PD = CONFIG?.ui?.playlists;
    const original = PD?.prototype?.updateTimestamps;
    if (typeof original !== "function") {
      // Degrade, don't break: sliders still seek and still refresh on every hook
      // below — they just stop advancing on their own.
      console.warn("female_edition | PlaylistDirectory#updateTimestamps is missing — playlist seek sliders will not auto-advance");
      return;
    }
    if (original.feSeekPatched) return;
    const patched = function (...args) {
      const result = original.apply(this, args);
      // Core scopes its own work to the `.currently-playing` panel; ours is
      // document-wide, so the docked instance's tick also covers the directory-tree
      // copy of the same row. Popout coverage is whatever `.playlists-sidebar`
      // resolves to — unchanged from the interval this replaced, which used the
      // same prefix; core arms no timer on a popout (`!this.isPopout`), so a popout
      // has never had a tick of its own.
      try { refreshPlayingSeekSliders(); }
      catch (error) { console.error("female_edition | playlist seek slider refresh failed", error); }
      return result;
    };
    patched.feSeekPatched = true;
    PD.prototype.updateTimestamps = patched;
  });

  const enhancePlayback = (playback) => {
    if (playback.querySelector(SEEK_SELECTOR)) return;
    const row = playback.closest(".sound[data-playlist-id][data-sound-id]");
    const playlist = row ? game.playlists?.get(row.dataset.playlistId) : null;
    const sound = playlist?.sounds?.get(row?.dataset.soundId);
    if (!sound) return;

    const volumeSlider = playback.querySelector(".sound-volume");
    const volumeControl = volumeSlider?.parentElement?.tagName?.toLowerCase() === "range-picker"
      ? volumeSlider.parentElement
      : volumeSlider;
    const oldVolumeIcon = playback.querySelector(":scope > .volume-icon");
    if (!volumeControl || !oldVolumeIcon) return;

    const seek = document.createElement("input");
    seek.type = "range";
    seek.className = "fe-music-seek";
    seek.min = "0";
    seek.max = "1";
    seek.step = "0.1";
    seek.setAttribute("aria-label", `${sound.name} 재생 위치`);

    const volume = document.createElement("div");
    volume.className = "fe-music-volume-control";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "inline-control sound-control icon fe-music-volume-toggle";
    toggle.setAttribute("aria-label", `${sound.name} 볼륨 조절`);
    toggle.setAttribute("aria-expanded", "false");
    toggle.innerHTML = '<i class="fa-solid fa-volume-low" inert></i>';
    const popover = document.createElement("div");
    popover.className = "fe-music-volume-popover";
    popover.hidden = true;
    popover.setAttribute("role", "group");
    popover.setAttribute("aria-label", `${sound.name} 볼륨`);
    const maxVolumeIcon = document.createElement("i");
    maxVolumeIcon.className = "fa-solid fa-volume-high fe-music-volume-max";
    maxVolumeIcon.setAttribute("aria-hidden", "true");

    oldVolumeIcon.remove();
    popover.append(volumeControl, maxVolumeIcon);
    volume.append(toggle, popover);
    playback.querySelector(".sound-timer")?.after(seek);
    const pause = playback.querySelector("button.pause");
    if (pause) pause.before(volume);
    else playback.append(volume);
    updateSeekSlider(seek);
  };

  const enhanceDirectory = (html) => {
    const root = extractElement(html);
    if (!root) return;
    for (const playback of root.querySelectorAll(".playlists-sidebar .sound-playback, .sound-playback")) {
      enhancePlayback(playback);
    }
    // A re-render replaces the sliders with fresh (0-valued) ones, so they need a
    // pass even when enhancePlayback short-circuited on an already-enhanced row.
    refreshAllSeekSliders();
  };

  Hooks.on("renderPlaylistDirectory", (_app, html) => enhanceDirectory(html));
  // Core writes `playing`/`pausedTime` on the sound and `playing` on the playlist;
  // either is a moment a slider's value changes without the playhead advancing.
  Hooks.on("updatePlaylist", () => refreshAllSeekSliders());
  Hooks.on("updatePlaylistSound", async (sound, changed) => {
    refreshAllSeekSliders();
    if (!("pausedTime" in changed) || !sound.playing || !sound.sound?.playing) return;
    const target = Number(changed.pausedTime);
    const duration = Number(sound.sound.duration);
    if (!Number.isFinite(target) || !Number.isFinite(duration) || duration <= 0) return;

    // Core only reads PlaylistSound.pausedTime when starting a stopped Sound.
    // Restart the already-playing local Sound on every client that receives the
    // document update, keeping the seek synchronized without two server trips.
    const generation = ++seekSeq;
    seekGenerations.set(sound.uuid, generation);
    const audio = sound.sound;
    try {
      await audio.stop({ fade: 0, volume: 0 });
      if (seekGenerations.get(sound.uuid) !== generation || !sound.playing) return;
      await audio.play({
        loop: sound.repeat,
        volume: sound.volume,
        fade: 0,
        offset: Math.clamp(target, 0, Math.max(0, duration - 0.05))
      });
    } catch (error) {
      console.error("female_edition | local playlist seek sync failed", error);
      sound.sync?.();
    } finally {
      // Keep the map to in-flight seeks only; without this it kept one entry per
      // seeked sound for the rest of the session. Only the run that still owns the
      // slot clears it — a superseded run must leave its successor's generation
      // alone.
      if (seekGenerations.get(sound.uuid) === generation) seekGenerations.delete(sound.uuid);
    }
  });

  document.addEventListener("click", (event) => {
    const toggle = event.target?.closest?.(".fe-music-volume-toggle");
    if (toggle) {
      event.preventDefault();
      event.stopPropagation();
      const popover = toggle.parentElement?.querySelector(".fe-music-volume-popover");
      if (!popover) return;
      const opening = popover.hidden;
      closeVolumePopovers(opening ? popover : null);
      popover.hidden = !opening;
      toggle.setAttribute("aria-expanded", String(opening));
      return;
    }
    if (!event.target?.closest?.(".fe-music-volume-popover")) closeVolumePopovers();
  }, true);

  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeVolumePopovers();
  }, true);

  document.addEventListener("pointerdown", (event) => {
    const slider = event.target?.closest?.(SEEK_SELECTOR);
    if (slider) slider.dataset.dragging = "true";
  }, true);

  const finishPointerDrag = (event) => {
    const slider = event.target?.closest?.(SEEK_SELECTOR);
    if (slider) slider.dataset.dragging = "false";
  };
  document.addEventListener("pointerup", finishPointerDrag, true);
  document.addEventListener("pointercancel", finishPointerDrag, true);

  document.addEventListener("input", (event) => {
    const slider = event.target?.closest?.(SEEK_SELECTOR);
    if (!slider) return;
    slider.dataset.dragging = "true";
    const row = slider.closest(".sound");
    const current = row?.querySelector(".sound-timer .current");
    if (current) current.textContent = formatTimestamp(Number(slider.value));
    slider.setAttribute(
      "aria-valuetext",
      `${formatTimestamp(Number(slider.value))} / ${formatTimestamp(Number(slider.max))}`
    );
  }, true);

  document.addEventListener("change", async (event) => {
    const slider = event.target?.closest?.(SEEK_SELECTOR);
    if (!slider) return;
    event.stopPropagation();
    slider.dataset.dragging = "false";
    slider.dataset.seeking = "true";

    const { playlist, sound } = soundForElement(slider);
    const duration = Number(sound?.sound?.duration);
    if (!playlist || !sound?.isOwner || !Number.isFinite(duration) || duration <= 0) {
      slider.dataset.seeking = "false";
      updateSeekSlider(slider);
      return;
    }

    const target = Math.clamp(Number(slider.value) || 0, 0, Math.max(0, duration - 0.05));
    try {
      // The update hook above restarts an already-playing local Sound at this
      // offset on every client. A paused Sound keeps the new resume position.
      await sound.update({ pausedTime: sound.playing ? target : Math.max(0.01, target) });
    } catch (error) {
      console.error("female_edition | playlist seek failed", error);
      ui.notifications?.error?.("재생 위치를 변경하지 못했습니다.");
    } finally {
      slider.dataset.seeking = "false";
      updateSeekSlider(slider);
    }
  }, true);

  Hooks.once("ready", () => {
    // Catch-up pass for a world that loaded with the sidebar already rendered;
    // from here on the sliders live off core's tick plus the hooks above.
    enhanceDirectory(ui?.playlists?.element ?? document);
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
  registerPlaylistSeekControls();
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
