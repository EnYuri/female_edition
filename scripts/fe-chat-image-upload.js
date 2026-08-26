// Chat-image file upload transport.
//
// FILES_UPLOAD controls direct FilePicker writes, not whether the module's chat
// image feature may be used. Clients without that core permission relay bounded
// binary chunks to the primary active GM. The GM authenticates the socket sender,
// validates the file, ignores client-supplied paths, sanitizes the supplied
// basename, and writes only to the module-configured chat-image directory.

import { MODULE_ID } from "./fe-constants.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";

export const CI_UPLOAD_SOCKET = `module.${MODULE_ID}`;
export const CI_UPLOAD_MSG = Object.freeze({
  INIT: "chat-image:upInit",
  INIT_ACK: "chat-image:upInitAck",
  CHUNK: "chat-image:upChunk",
  FINISH: "chat-image:upFinish",
  REQUEST_MISSING: "chat-image:upRequestMissing",
  ACK: "chat-image:upAck",
  ERROR: "chat-image:upError",
});

// Maximum accepted image size, in MB, as a world setting. Registered by
// fe-chat-images.js (which owns the whole `chatImages*` key family); the key and
// its bounds live HERE because this module is the lower layer — fe-chat-images.js
// imports it, so it cannot import back without a cycle.
//
// Both the sender-side check and the GM-authority check below read this. The
// authority read is the one that matters: the sender's check is a courtesy, and a
// crafted socket message can simply omit it. World scope means every client agrees
// on the number, and only the GM can move it.
export const CI_MAX_UPLOAD_MB_KEY = "chatImagesMaxUploadMB";
export const CI_DEFAULT_MAX_UPLOAD_MB = 12;
// Hard bounds on the setting itself. The ceiling is not arbitrary: the proxy path
// buffers the whole file in the GM's memory while reassembling chunks, and the
// data-URL fallback stores the image inside ChatMessage content that every client
// then downloads. 64 MB is already generous for both.
export const CI_MIN_MAX_UPLOAD_MB = 1;
export const CI_MAX_MAX_UPLOAD_MB = 64;

export function ciMaxUploadMB() {
  let raw;
  try { raw = game.settings.get(MODULE_ID, CI_MAX_UPLOAD_MB_KEY); }
  catch { return CI_DEFAULT_MAX_UPLOAD_MB; }
  // Blank/garbage must fall back to the DEFAULT, never to the clamp floor: a
  // bare `Number("")` is 0, which would clamp to 1 MB and silently reject almost
  // every image instead of behaving as if the setting had never been touched.
  const mb = typeof raw === "number" ? raw : Number(String(raw ?? "").trim() || NaN);
  if (!Number.isFinite(mb)) return CI_DEFAULT_MAX_UPLOAD_MB;
  return Math.min(CI_MAX_MAX_UPLOAD_MB, Math.max(CI_MIN_MAX_UPLOAD_MB, mb));
}

export function ciMaxUploadBytes() {
  return Math.round(ciMaxUploadMB() * 1024 * 1024);
}

const CI_CHUNK_SIZE = 256 * 1024;
const CI_MIN_CHUNK_SIZE = 32 * 1024;
const CI_MAX_CHUNK_SIZE = 512 * 1024;
const CI_INIT_TIMEOUT_MS = 15_000;
const CI_FINISH_TIMEOUT_MS = 3 * 60 * 1000;
const CI_UPLOAD_TTL_MS = 5 * 60 * 1000;
const CI_MAX_RETRY = 5;
const CI_MAX_CONCURRENT_UPLOADS = 4;

const CI_IMAGE_EXTENSIONS = new Set([
  "gif", "png", "jpg", "jpeg", "webp", "svg", "bmp", "tif", "tiff", "avif",
]);

const CI_MIME_EXTENSIONS = Object.freeze({
  "image/gif": "gif",
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "image/bmp": "bmp",
  "image/tiff": "tiff",
  "image/avif": "avif",
});

const localUploads = new Map();
const authorityUploads = new Map();
const authorityUploadByUser = new Map();
let socketRegistered = false;

export function ciNormalizeUploadDirectory(path) {
  const raw = String(path ?? "").replace(/\\/g, "/").trim();
  const rawParts = raw.split("/").map((part) => part.trim()).filter(Boolean);
  let dataRoot = -1;
  for (let i = 0; i < rawParts.length; i++) {
    const part = rawParts[i].toLowerCase();
    if (part === "data" || part === "~data") dataRoot = i;
  }
  const relative = dataRoot >= 0 ? rawParts.slice(dataRoot + 1) : rawParts;
  return relative
    .filter((part) => part !== "." && part !== "..")
    .map((part) => part.replace(/[:*?"<>|]/g, "_").replace(/\s+/g, "-").trim())
    .filter(Boolean)
    .join("/");
}

export function ciResolveImageExtension(fileName, fileType) {
  const type = String(fileType ?? "").trim().toLowerCase();
  const mimeExt = CI_MIME_EXTENSIONS[type] ?? "";
  const match = String(fileName ?? "").trim().toLowerCase().match(/\.([a-z0-9]+)$/);
  const nameExt = match?.[1] ?? "";

  if (mimeExt) {
    if (CI_IMAGE_EXTENSIONS.has(nameExt)) {
      if ((mimeExt === "jpg" && (nameExt === "jpg" || nameExt === "jpeg"))
        || (mimeExt === "tiff" && (nameExt === "tif" || nameExt === "tiff"))
        || nameExt === mimeExt) return `.${nameExt}`;
    }
    return `.${mimeExt}`;
  }

  // Some browsers provide an empty MIME type for otherwise valid local files.
  if (!type && CI_IMAGE_EXTENSIONS.has(nameExt)) return `.${nameExt}`;
  return "";
}

function ciGetFilePicker() {
  return (
    globalThis.CONFIG?.ux?.FilePicker
    ?? globalThis.foundry?.applications?.apps?.FilePicker?.implementation
    ?? globalThis.foundry?.applications?.apps?.FilePicker
    ?? globalThis.FilePicker
    ?? null
  );
}

function ciRandomId() {
  try {
    return globalThis.foundry?.utils?.randomID?.() || Math.random().toString(36).slice(2);
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

export function ciBuildUploadFileName(fileName, fileType, uniqueId = ciRandomId()) {
  const extension = ciResolveImageExtension(fileName, fileType);
  if (!extension) return "";

  const leaf = String(fileName || "image").replace(/\\/g, "/").split("/").pop() || "image";
  const printableStem = Array.from(leaf.replace(/\.[^.]*$/, "").normalize("NFKC"))
    .map(char => {
      const code = char.codePointAt(0);
      return code <= 31 || code === 127 ? "-" : char;
    })
    .join("");
  const stem = printableStem
    .replace(/[<>:"/\\|?*]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[.\-_]+|[.\-_]+$/g, "");
  const safeStem = Array.from(stem || "image").slice(0, 80).join("");
  const suffix = String(uniqueId || ciRandomId()).replace(/[^a-z0-9_-]/gi, "").slice(0, 12) || "upload";
  return `${safeStem}-${suffix}${extension}`;
}

export function ciCanUploadDirect() {
  try { return game.user?.can?.("FILES_UPLOAD") === true; } catch { return false; }
}

export function ciHasUploadAuthorityOnline() {
  try {
    const authority = game.users?.activeGM ?? Array.from(game.users ?? [])
      .filter((user) => user?.active && user?.isGM)
      .sort((a, b) => String(a.id).localeCompare(String(b.id)))[0];
    // A primary GM cannot proxy to itself. In practice a full GM can upload
    // directly; this distinction matters for a non-primary Assistant whose
    // FILES_UPLOAD permission was revoked.
    return !!authority && authority.id !== game.user?.id;
  } catch {
    return false;
  }
}

function ciIsPrimaryActiveGm() {
  if (!game.user?.isGM) return false;
  const activeGM = game.users?.activeGM;
  if (activeGM) return activeGM.id === game.user.id;

  const activeGms = Array.from(game.users ?? [])
    .filter((user) => user?.active && user?.isGM)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
  return activeGms[0]?.id === game.user.id;
}

export async function ciEnsureUploadDirectory(path) {
  const Picker = ciGetFilePicker();
  const target = ciNormalizeUploadDirectory(path) || "uploaded-chat-images";
  if (!Picker?.browse || !Picker?.createDirectory) throw new Error("FilePicker API unavailable");

  let current = "";
  for (const segment of target.split("/")) {
    current = current ? `${current}/${segment}` : segment;
    try {
      const listing = await Picker.browse("data", current);
      // Some Foundry/server combinations resolve a missing target to the data
      // root instead of rejecting the request. That is not proof the requested
      // directory exists; create it below.
      if (listing?.target !== ".") continue;
    } catch { /* create and verify below */ }

    try { await Picker.createDirectory("data", current, {}); } catch { /* verify below */ }
    const verified = await Picker.browse("data", current);
    if (verified?.target === ".") throw new Error(`업로드 폴더를 만들 수 없습니다: ${current}`);
  }
  return target;
}

export async function ciUploadImageDirect(file, uploadDirectory) {
  if (!ciResolveImageExtension(file?.name, file?.type)) throw new Error("지원하지 않는 이미지 형식입니다.");
  const Picker = ciGetFilePicker();
  if (!Picker) throw new Error("FilePicker API unavailable");

  const target = await ciEnsureUploadDirectory(uploadDirectory);
  const safeFile = new File([file], ciBuildUploadFileName(file.name, file.type), {
    type: file.type || "",
    lastModified: Number(file.lastModified) || Date.now(),
  });
  const upload = typeof Picker.upload === "function"
    ? Picker.upload.bind(Picker)
    : (typeof Picker.implementation?.upload === "function"
      ? Picker.implementation.upload.bind(Picker.implementation)
      : null);
  if (!upload) throw new Error("FilePicker upload API unavailable");
  const result = await upload("data", target, safeFile, {}, { notify: false });
  if (!result?.path) throw new Error("업로드 결과 경로가 없습니다.");
  return String(result.path);
}

function ciClearLocalUpload(uploadId) {
  const record = localUploads.get(uploadId);
  if (!record) return;
  if (record.initTimer) clearTimeout(record.initTimer);
  if (record.doneTimer) clearTimeout(record.doneTimer);
  localUploads.delete(uploadId);
}

function ciWaitForInit(uploadId) {
  const record = localUploads.get(uploadId);
  if (!record) return Promise.reject(new Error("NO_LOCAL_UPLOAD"));
  return new Promise((resolve, reject) => {
    record.initResolve = resolve;
    record.initReject = reject;
    record.initTimer = setTimeout(() => reject(new Error("INIT_TIMEOUT")), CI_INIT_TIMEOUT_MS);
  });
}

function ciWaitForFinish(uploadId) {
  const record = localUploads.get(uploadId);
  if (!record) return Promise.reject(new Error("NO_LOCAL_UPLOAD"));
  return new Promise((resolve, reject) => {
    record.doneResolve = resolve;
    record.doneReject = reject;
    record.doneTimer = setTimeout(() => reject(new Error("FINISH_TIMEOUT")), CI_FINISH_TIMEOUT_MS);
  });
}

function ciMarkInit(uploadId) {
  const record = localUploads.get(uploadId);
  if (!record) return;
  if (record.initTimer) clearTimeout(record.initTimer);
  record.initTimer = null;
  record.initResolve?.(true);
  record.initResolve = null;
  record.initReject = null;
}

function ciMarkDone(uploadId, path) {
  const record = localUploads.get(uploadId);
  if (!record) return;
  if (record.doneTimer) clearTimeout(record.doneTimer);
  record.doneTimer = null;
  record.doneResolve?.(String(path ?? ""));
  record.doneResolve = null;
  record.doneReject = null;
}

function ciMarkError(uploadId, reason) {
  const record = localUploads.get(uploadId);
  if (!record) return;
  const error = new Error(String(reason || "대리 업로드 실패"));
  if (record.initTimer) clearTimeout(record.initTimer);
  if (record.doneTimer) clearTimeout(record.doneTimer);
  record.initTimer = null;
  record.doneTimer = null;
  record.initReject?.(error);
  record.doneReject?.(error);
  record.initResolve = record.initReject = null;
  record.doneResolve = record.doneReject = null;
}

async function ciEmitChunks(record, indices = null) {
  const wanted = Array.isArray(indices)
    ? indices.map(Number).filter((i) => Number.isInteger(i) && i >= 0 && i < record.totalChunks)
    : Array.from({ length: record.totalChunks }, (_, i) => i);

  for (let n = 0; n < wanted.length; n++) {
    const index = wanted[n];
    const start = index * record.chunkSize;
    const end = Math.min(record.file.size, start + record.chunkSize);
    const data = await record.file.slice(start, end).arrayBuffer();
    game.socket.emit(CI_UPLOAD_SOCKET, {
      type: CI_UPLOAD_MSG.CHUNK,
      uploadId: record.uploadId,
      fromUserId: game.user.id,
      index,
      data,
    });
    if ((n + 1) % 8 === 0) await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

export async function ciUploadImageViaAuthority(file) {
  if (!ciHasUploadAuthorityOnline()) throw new Error("온라인 GM이 없습니다.");
  const size = Number(file?.size);
  if (!Number.isFinite(size) || size <= 0) throw new Error("파일 크기가 올바르지 않습니다.");
  if (size > ciMaxUploadBytes()) throw new Error(`대리 업로드는 최대 ${ciMaxUploadMB()} MB까지 가능합니다.`);
  const ext = ciResolveImageExtension(file?.name, file?.type);
  if (!ext) throw new Error("지원하지 않는 이미지 형식입니다.");

  const uploadId = `${game.user.id}-${Date.now()}-${ciRandomId()}`;
  const totalChunks = Math.ceil(size / CI_CHUNK_SIZE);
  const record = {
    uploadId,
    file,
    chunkSize: CI_CHUNK_SIZE,
    totalChunks,
    retries: 0,
    initResolve: null,
    initReject: null,
    initTimer: null,
    doneResolve: null,
    doneReject: null,
    doneTimer: null,
  };
  localUploads.set(uploadId, record);

  try {
    const init = ciWaitForInit(uploadId);
    game.socket.emit(CI_UPLOAD_SOCKET, {
      type: CI_UPLOAD_MSG.INIT,
      uploadId,
      fromUserId: game.user.id,
      fileName: String(file.name || `image${ext}`),
      fileType: String(file.type || ""),
      fileSize: size,
      chunkSize: CI_CHUNK_SIZE,
    });
    await init;
    await ciEmitChunks(record);

    const done = ciWaitForFinish(uploadId);
    game.socket.emit(CI_UPLOAD_SOCKET, {
      type: CI_UPLOAD_MSG.FINISH,
      uploadId,
      fromUserId: game.user.id,
    });
    const path = await done;
    if (!path) throw new Error("대리 업로드 결과 경로가 없습니다.");
    return path;
  } finally {
    ciClearLocalUpload(uploadId);
  }
}

function ciCoerceChunkSize(value) {
  const size = Math.floor(Number(value));
  if (!Number.isFinite(size)) return CI_CHUNK_SIZE;
  return Math.max(CI_MIN_CHUNK_SIZE, Math.min(CI_MAX_CHUNK_SIZE, size));
}

function ciToUint8(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  if (data && data.type === "Buffer" && Array.isArray(data.data)) return new Uint8Array(data.data);
  return null;
}

function ciClearAuthorityUpload(uploadId) {
  const record = authorityUploads.get(uploadId);
  if (!record) return;
  if (record.timer) clearTimeout(record.timer);
  authorityUploads.delete(uploadId);
  if (authorityUploadByUser.get(record.fromUserId) === uploadId) authorityUploadByUser.delete(record.fromUserId);
}

function ciRefreshAuthorityTtl(record) {
  if (record.timer) clearTimeout(record.timer);
  record.timer = setTimeout(() => ciClearAuthorityUpload(record.uploadId), CI_UPLOAD_TTL_MS);
}

function ciAuthorityError(toUserId, uploadId, reason) {
  game.socket.emit(CI_UPLOAD_SOCKET, {
    type: CI_UPLOAD_MSG.ERROR,
    authorityId: game.user.id,
    toUserId,
    uploadId,
    reason: String(reason || "대리 업로드 실패"),
  });
}

async function ciFinishAuthorityUpload(record, getUploadDirectory) {
  const blob = new Blob(record.chunks, { type: record.fileType || "application/octet-stream" });
  if (blob.size !== record.fileSize) throw new Error("수신한 이미지 크기가 원본과 일치하지 않습니다.");

  const file = new File([blob], ciBuildUploadFileName(record.fileName, record.fileType), {
    type: record.fileType || "",
  });
  const target = await ciEnsureUploadDirectory(getUploadDirectory());
  const Picker = ciGetFilePicker();
  const upload = typeof Picker?.upload === "function"
    ? Picker.upload.bind(Picker)
    : (typeof Picker?.implementation?.upload === "function"
      ? Picker.implementation.upload.bind(Picker.implementation)
      : null);
  if (!upload) throw new Error("FilePicker upload API unavailable");
  const result = await upload("data", target, file, {}, { notify: false });
  if (!result?.path) throw new Error("업로드 결과 경로가 없습니다.");
  return String(result.path);
}

export function ciRegisterImageUploadSocket({ getUploadDirectory, isFeatureEnabled }) {
  if (socketRegistered) return;
  socketRegistered = true;

  game.socket.on(CI_UPLOAD_SOCKET, async (message, senderId) => {
    if (!String(message?.type || "").startsWith("chat-image:")) return;

    if (!ciIsPrimaryActiveGm()) {
      const authority = feResolveSocketSender(senderId, message.authorityId, "chat-image-response");
      if (!authority?.isGM || message.toUserId !== game.user.id) return;
      if (message.type === CI_UPLOAD_MSG.INIT_ACK) ciMarkInit(message.uploadId);
      else if (message.type === CI_UPLOAD_MSG.ACK) ciMarkDone(message.uploadId, message.path);
      else if (message.type === CI_UPLOAD_MSG.ERROR) ciMarkError(message.uploadId, message.reason);
      else if (message.type === CI_UPLOAD_MSG.REQUEST_MISSING) {
        const record = localUploads.get(message.uploadId);
        if (!record) return;
        if (record.retries >= CI_MAX_RETRY) {
          ciMarkError(message.uploadId, "이미지 청크 재전송 한도를 초과했습니다.");
          return;
        }
        record.retries++;
        try {
          await ciEmitChunks(record, message.missing);
          game.socket.emit(CI_UPLOAD_SOCKET, {
            type: CI_UPLOAD_MSG.FINISH,
            uploadId: record.uploadId,
            fromUserId: game.user.id,
          });
        } catch (error) {
          ciMarkError(message.uploadId, error?.message || "이미지 청크 재전송에 실패했습니다.");
        }
      }
      return;
    }

    const sender = feResolveSocketSender(senderId, message.fromUserId, "chat-image-request");
    if (!sender?.active) return;

    if (message.type === CI_UPLOAD_MSG.INIT) {
      const uploadId = String(message.uploadId || "");
      const reject = (reason) => ciAuthorityError(sender.id, uploadId, reason);
      if (!uploadId) return;
      if (typeof isFeatureEnabled === "function" && !isFeatureEnabled()) return void reject("채팅 이미지 기능이 비활성화되어 있습니다.");

      const fileSize = Number(message.fileSize);
      if (!Number.isFinite(fileSize) || fileSize <= 0) return void reject("파일 크기가 올바르지 않습니다.");
      if (fileSize > ciMaxUploadBytes()) return void reject(`파일이 너무 큽니다. 최대 ${ciMaxUploadMB()} MB`);
      const extension = ciResolveImageExtension(message.fileName, message.fileType);
      if (!extension) return void reject("지원하지 않는 이미지 형식입니다.");

      const previous = authorityUploadByUser.get(sender.id);
      if (previous && previous !== uploadId) ciClearAuthorityUpload(previous);
      if (authorityUploads.size >= CI_MAX_CONCURRENT_UPLOADS) return void reject("서버가 다른 이미지 업로드를 처리 중입니다. 잠시 후 다시 시도하세요.");
      ciClearAuthorityUpload(uploadId);

      const chunkSize = ciCoerceChunkSize(message.chunkSize);
      const totalChunks = Math.ceil(fileSize / chunkSize);
      const record = {
        uploadId,
        fromUserId: sender.id,
        fileName: String(message.fileName || `image${extension}`).slice(0, 512),
        fileType: String(message.fileType || ""),
        fileSize,
        chunkSize,
        totalChunks,
        chunks: new Array(totalChunks),
        retryCount: 0,
        timer: null,
      };
      authorityUploads.set(uploadId, record);
      authorityUploadByUser.set(sender.id, uploadId);
      ciRefreshAuthorityTtl(record);
      game.socket.emit(CI_UPLOAD_SOCKET, {
        type: CI_UPLOAD_MSG.INIT_ACK,
        authorityId: game.user.id,
        toUserId: sender.id,
        uploadId,
      });
      return;
    }

    const uploadId = String(message.uploadId || "");
    const record = authorityUploads.get(uploadId);
    if (!record || record.fromUserId !== sender.id) return;

    if (message.type === CI_UPLOAD_MSG.CHUNK) {
      const index = Number(message.index);
      if (!Number.isInteger(index) || index < 0 || index >= record.totalChunks || record.chunks[index]) return;
      const bytes = ciToUint8(message.data);
      if (!bytes) return;
      const expected = index === record.totalChunks - 1
        ? record.fileSize - index * record.chunkSize
        : record.chunkSize;
      if (bytes.byteLength !== expected) return;
      record.chunks[index] = bytes;
      ciRefreshAuthorityTtl(record);
      return;
    }

    if (message.type !== CI_UPLOAD_MSG.FINISH) return;
    const missing = [];
    for (let i = 0; i < record.totalChunks; i++) if (!record.chunks[i]) missing.push(i);
    if (missing.length) {
      record.retryCount++;
      if (record.retryCount > CI_MAX_RETRY) {
        ciClearAuthorityUpload(uploadId);
        ciAuthorityError(sender.id, uploadId, "이미지 청크 재전송 한도를 초과했습니다.");
        return;
      }
      ciRefreshAuthorityTtl(record);
      game.socket.emit(CI_UPLOAD_SOCKET, {
        type: CI_UPLOAD_MSG.REQUEST_MISSING,
        authorityId: game.user.id,
        toUserId: sender.id,
        uploadId,
        missing,
      });
      return;
    }

    try {
      const path = await ciFinishAuthorityUpload(record, getUploadDirectory);
      game.socket.emit(CI_UPLOAD_SOCKET, {
        type: CI_UPLOAD_MSG.ACK,
        authorityId: game.user.id,
        toUserId: sender.id,
        uploadId,
        path,
      });
    } catch (error) {
      ciAuthorityError(sender.id, uploadId, error?.message || "서버 이미지 업로드에 실패했습니다.");
    } finally {
      ciClearAuthorityUpload(uploadId);
    }
  });
}
