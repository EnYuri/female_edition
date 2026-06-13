
// Chat Images integration (ported from chat-images, adapted for female_edition)
// Features:
//  - Upload button + preview tray in chat form
//  - Paste / drag&drop images into chat
//  - Convert !ci|...! shortcode into image embeds
//  - Click to open image popout

import { MODULE_ID, feCaptureMessageRenderFlagsOnPreCreate } from "./fe-chat-enhance.js";

const CI = Object.freeze({
  ENABLED: "chatImagesEnabled",
  SHOW_BUTTON: "chatImagesShowButton",
  UPLOAD_LOCATION: "chatImagesUploadLocation",
});

const CI_STATE = {
  pending: [],
  busy: false,
};

const CI_SHORTCODE_RE = /!\s*ci\s*\|\s*(.+?)\s*!/gi;
const CI_IMAGE_FILE_RE = /\.(gif|png|jpe?g|webp|svg|bmp|tif|tiff|avif)(\?.*)?$/i;
const CI_HTML_IGNORES = ["static.wikia"];

function ciGet(key) {
  return game.settings.get(MODULE_ID, key);
}

function ciEnabled() {
  try {
    return !!ciGet(CI.ENABLED);
  } catch {
    return false;
  }
}

function ciShowButton() {
  try {
    return !!ciGet(CI.SHOW_BUTTON);
  } catch {
    return false;
  }
}

function ciUploadLocation() {
  try {
    return String(ciGet(CI.UPLOAD_LOCATION) || "uploaded-chat-images").trim() || "uploaded-chat-images";
  } catch {
    return "uploaded-chat-images";
  }
}

function ciRandomId() {
  try {
    return foundry?.utils?.randomID?.() || Math.random().toString(36).slice(2);
  } catch {
    return Math.random().toString(36).slice(2);
  }
}

function ciEscapeHtml(str) {
  return String(str ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function ciGetFilePickerClass() {
  return foundry?.applications?.apps?.FilePicker?.implementation || globalThis.FilePicker;
}

function ciGetImagePopoutClass() {
  return foundry?.applications?.apps?.ImagePopout || globalThis.ImagePopout;
}

function ciCanUpload(silent = false) {
  try {
    if (typeof game?.user?.can === "function") {
      const ok = !!game.user.can("FILES_UPLOAD");
      if (!ok && !silent) ui?.notifications?.warn?.("이미지 업로드 권한이 없습니다.");
      return ok;
    }
  } catch {}

  try {
    const role = game?.user?.role;
    const perms = game?.permissions?.FILES_UPLOAD;
    const ok = !!role && Array.isArray(perms) && perms.includes(role);
    if (!ok && !silent) ui?.notifications?.warn?.("이미지 업로드 권한이 없습니다.");
    return ok;
  } catch {}

  if (!silent) ui?.notifications?.warn?.("이미지 업로드 권한을 확인할 수 없습니다.");
  return false;
}

async function ciEnsureUploadDirectory(path) {
  const Picker = ciGetFilePickerClass();
  if (!Picker) return;
  const target = String(path || "uploaded-chat-images").trim() || "uploaded-chat-images";
  try {
    const browse = await Picker.browse("data", target);
    if (browse?.target === ".") await Picker.createDirectory("data", target, {});
    return;
  } catch {}
  try {
    await Picker.createDirectory("data", target, {});
  } catch {}
}

function ciFileExt(file) {
  const name = String(file?.name || "");
  const m = name.match(/\.[^.]+$/);
  if (m) return m[0];
  const type = String(file?.type || "");
  if (type.startsWith("image/")) {
    const sub = type.slice(6).replace(/[^a-z0-9]+/gi, "").toLowerCase();
    if (sub) return `.${sub === "jpeg" ? "jpg" : sub}`;
  }
  return ".png";
}

function ciRevokeObjectUrl(src) {
  try {
    if (typeof src === "string" && src.startsWith("blob:")) URL.revokeObjectURL(src);
  } catch {}
}

function ciGetPendingArea(root = document) {
  return root.querySelector?.("#ci-chat-upload-area") || null;
}

function ciGetPendingStrip(root = document) {
  return ciGetPendingArea(root)?.querySelector?.(".ci-upload-area-images") || null;
}

function ciFind(root = document, selector) {
  try {
    return root?.querySelector?.(selector) || null;
  } catch {
    return null;
  }
}

function ciGetTextarea(root = document) {
  const sel = "#chat-message, textarea#chat-message, .chat-message-input, .chat-form textarea";
  let all;
  try { all = Array.from(root?.querySelectorAll?.(sel) ?? []); } catch { all = []; }
  if (!all.length) return null;
  // v14 renders a chat input BOTH in the open sidebar (chat tab) and in the
  // #chat-notifications column (collapsed / notification view). The notifications
  // input precedes the sidebar one in DOM order, so a naive first-match anchors
  // the preview tray to the LEFT of the open sidebar. Prefer a VISIBLE input
  // docked in #sidebar; fall back to any visible input, then the first.
  const visible = all.filter((el) => { try { return el.getClientRects().length > 0; } catch { return false; } });
  const pool = visible.length ? visible : all;
  return pool.find((el) => el.closest?.("#sidebar")) || pool[0] || null;
}

function ciGetChatForm(root = document) {
  return ciFind(root, ".chat-form, #chat-form, form.chat-form") || null;
}

function ciGetChatControls(root = document) {
  return ciFind(root, ".chat-controls, #chat-controls") || null;
}

function ciGetPendingItems() {
  return CI_STATE.pending;
}

function ciSetAreaVisibility(root = document) {
  const area = ciGetPendingArea(root);
  if (!area) return;
  area.classList.toggle("hidden", ciGetPendingItems().length === 0);
}

function ciRemovePendingById(id, root = document) {
  const idx = CI_STATE.pending.findIndex((p) => p.id === id);
  if (idx >= 0) {
    const [item] = CI_STATE.pending.splice(idx, 1);
    ciRevokeObjectUrl(item?.previewUrl);
  }
  const tile = root.querySelector?.(`#ci-chat-upload-area [data-ci-pending-id="${CSS.escape(String(id))}"]`);
  tile?.remove?.();
  ciSetAreaVisibility(root);
}

function ciClearPending(root = document) {
  while (CI_STATE.pending.length) {
    const item = CI_STATE.pending.pop();
    ciRevokeObjectUrl(item?.previewUrl);
  }
  const strip = ciGetPendingStrip(root);
  if (strip) strip.textContent = "";
  ciSetAreaVisibility(root);
}

function ciAddPendingTile(item, root = document) {
  const strip = ciGetPendingStrip(root);
  if (!strip) return;
  const doc = strip.ownerDocument || document;
  const tile = doc.createElement("div");
  tile.className = "ci-upload-area-image";
  tile.dataset.ciPendingId = String(item.id);

  const remove = doc.createElement("i");
  remove.className = "ci-remove-image-icon fa-regular fa-circle-xmark";
  remove.title = "제거";
  remove.addEventListener("click", () => ciRemovePendingById(item.id, root));

  const img = doc.createElement("img");
  img.className = "ci-image-preview";
  img.src = item.previewUrl || item.src || item.imageSrc || "";
  img.alt = item.name || "image";
  img.addEventListener("click", (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ciOpenImagePopout(img.currentSrc || img.src);
  });

  tile.append(remove, img);
  strip.appendChild(tile);
}

function ciNormalizePendingItem(raw) {
  const id = raw?.id || ciRandomId();
  const file = raw?.file || null;
  const src = String(raw?.src || raw?.imageSrc || "").trim();
  if (!file && !src) return null;
  const previewUrl = file ? (raw.previewUrl || URL.createObjectURL(file)) : src;
  return {
    id,
    file,
    src,
    previewUrl,
    name: String(raw?.name || file?.name || "image"),
    type: String(raw?.type || file?.type || "image/*"),
  };
}

function ciPushPending(raw, root = document) {
  const item = ciNormalizePendingItem(raw);
  if (!item) return;
  CI_STATE.pending.push(item);
  ciAddPendingTile(item, root);
  ciSetAreaVisibility(root);
}

function ciExtractClipboardHtmlImages(dataTransfer) {
  try {
    const html = dataTransfer?.getData?.("text/html");
    if (!html) return [];
    const doc = new DOMParser().parseFromString(html, "text/html");
    const imgs = Array.from(doc.querySelectorAll("img[src]"));
    return imgs
      .map((img) => String(img.getAttribute("src") || "").trim())
      .filter((src) => src && !CI_HTML_IGNORES.some((frag) => src.includes(frag)));
  } catch {
    return [];
  }
}

function ciExtractFiles(dataTransfer) {
  const files = [];
  try {
    const items = Array.from(dataTransfer?.items || []);
    for (const item of items) {
      if (item?.kind !== "file") continue;
      const file = item.getAsFile?.();
      if (file?.type?.startsWith?.("image/")) files.push(file);
    }
    if (files.length) return files;
  } catch {}

  try {
    const list = Array.from(dataTransfer?.files || []);
    return list.filter((file) => file?.type?.startsWith?.("image/"));
  } catch {
    return [];
  }
}

function ciOpenImagePopout(src) {
  try {
    const Popout = ciGetImagePopoutClass();
    if (!Popout) return;
    // v13 ApplicationV2 ImagePopout takes an options object as its first argument.
    // Legacy (v11/v12) ImagePopout takes (src, options).
    // ciGetImagePopoutClass() returns the v13 class when available, so we can
    // distinguish by checking whether the class lives in the new apps namespace.
    const isAppV2 = !!foundry?.applications?.apps?.ImagePopout;
    if (isAppV2) {
      new Popout({ src, editable: false, shareable: true }).render(true);
    } else {
      new Popout(src, { editable: false, shareable: true }).render(true);
    }
  } catch {}
}

function ciBindRenderedImages(root) {
  if (!root?.querySelectorAll) return;
  for (const img of root.querySelectorAll(".ci-message-image img")) {
    if (img.dataset.feCiBound === "1") continue;
    img.dataset.feCiBound = "1";
    img.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const src = img.currentSrc || img.getAttribute("src") || img.src;
      if (src) ciOpenImagePopout(src);
    });
  }
}

function ciShortcodeToHtml(text) {
  return String(text ?? "").replace(CI_SHORTCODE_RE, (_m, raw) => {
    const src = String(raw || "").trim();
    if (!src || !CI_IMAGE_FILE_RE.test(src)) return _m;
    const safeSrc = ciEscapeHtml(src);
    return `<div class="ci-message"><div class="ci-message-image"><img src="${safeSrc}" alt="image"></div></div>`;
  });
}

function ciGetMessageStyleOOC() {
  const styles = CONST?.CHAT_MESSAGE_STYLES;
  return styles?.OOC ?? 1;
}

// Maximum file size allowed for data URL embedding (fallback when upload is unavailable).
// Large data URLs bloat ChatMessage content stored in DB and sent to all clients.
// Users with files exceeding this limit should use the archive downscale feature instead.
const CI_MAX_DATAURL_BYTES = 17 * 1024 * 1024; // 17 MB

async function ciFileToDataUrl(file) {
  return await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(reader.error || new Error("File read failed"));
    reader.onload = () => resolve(String(reader.result || ""));
    reader.readAsDataURL(file);
  });
}

async function ciResolvePendingSource(item) {
  if (!item?.file) return item?.src || item?.previewUrl || "";

  const uploadAllowed = ciCanUpload(true);
  if (uploadAllowed) {
    try {
      const Picker = ciGetFilePickerClass();
      if (Picker) {
        const target = ciUploadLocation();
        await ciEnsureUploadDirectory(target);
        const ext = ciFileExt(item.file);
        const safeFile = new File([item.file], `${item.id}${ext}`, { type: item.file.type || "image/png" });
        const uploadFn =
          (typeof Picker.upload === "function" && Picker.upload.bind(Picker)) ||
          (typeof Picker.implementation?.upload === "function" && Picker.implementation.upload.bind(Picker.implementation));
        let uploaded = null;
        if (uploadFn) uploaded = await uploadFn("data", target, safeFile, {}, { notify: false });
        else {
          const picker = new Picker();
          if (typeof picker.upload === "function") uploaded = await picker.upload("data", target, safeFile, {}, { notify: false });
        }
        if (uploaded?.path) return String(uploaded.path);
      }
    } catch {}
  }

  // Fallback: embed as data URL so players without upload permission can still send images.
  // Guard against excessively large files — they bloat the DB and every client's network traffic.
  if ((item.file.size ?? 0) > CI_MAX_DATAURL_BYTES) {
    const mb = (item.file.size / 1024 / 1024).toFixed(1);
    ui?.notifications?.error?.(
      `이미지 "${item.name || "image"}" (${mb} MB)가 너무 큽니다. 최대 ${CI_MAX_DATAURL_BYTES / 1024 / 1024} MB까지 허용됩니다.`,
      { permanent: false }
    );
    return "";
  }

  try {
    return await ciFileToDataUrl(item.file);
  } catch {
    return item.previewUrl || "";
  }
}

function ciBuildMessageHtml(items, note) {
  const images = items
    .map((item) => {
      const src = ciEscapeHtml(item.src || "");
      const alt = ciEscapeHtml(item.name || "image");
      return `<div class="ci-message-image"><img src="${src}" alt="${alt}"></div>`;
    })
    .join("");

  const notes = String(note || "").trim();
  const noteHtml = notes
    ? `<div class="ci-notes">${ciEscapeHtml(notes).replace(/\n/g, "<br>")}</div>`
    : "";
  return `<div class="ci-message">${images}</div>${noteHtml}`;
}

async function ciHandleSubmit(ev, root = document) {
  if (!ciEnabled()) return;
  if (!ciGetPendingItems().length) return;
  ev?.preventDefault?.();
  ev?.stopPropagation?.();
  try { ev?.stopImmediatePropagation?.(); } catch {}
  await ciSendPending(root);
}

function ciEnsureUploadArea(root = document) {
  const textarea = ciGetTextarea(root);
  const chatForm = ciGetChatForm(root);
  const controls = ciGetChatControls(root);
  if (!textarea && !chatForm && !controls) return null;

  // Find the existing tray ANYWHERE (it may have been left in a different chat
  // container after the input reparented), not just under `root`.
  let area = ciGetPendingArea(root) || ciGetPendingArea(document);
  if (!area) {
    const anchor = textarea || chatForm || controls;
    const doc = anchor?.ownerDocument || document;
    area = doc.createElement("div");
    area.id = "ci-chat-upload-area";
    area.className = "hidden";

    const strip = doc.createElement("div");
    strip.className = "ci-upload-area-images";
    const actions = doc.createElement("div");
    actions.className = "ci-upload-area-actions";

    const send = doc.createElement("a");
    send.className = "ci-send-all";
    send.title = "이미지 전송";
    send.innerHTML = '<i class="fa-solid fa-paper-plane"></i>';
    send.addEventListener("click", async (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation?.(); } catch {}
      await ciSendPending(root);
    });

    const clear = doc.createElement("a");
    clear.className = "ci-clear-all";
    clear.title = "모두 제거";
    clear.innerHTML = '<i class="fa-solid fa-trash"></i>';
    clear.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation?.(); } catch {}
      ciClearPending(root);
    });

    actions.append(send, clear);
    area.append(strip, actions);
  }

  // Dock the tray immediately before the CURRENT chat input every refresh,
  // relocating it if the input reparented (v14 moves the input between the open
  // sidebar and the #chat-notifications column). Without this the tray gets
  // stranded left of the open sidebar where the notification input lives.
  const ref = textarea || controls || chatForm;
  if (ref?.parentNode && area.nextElementSibling !== ref) {
    ref.parentNode.insertBefore(area, ref);
  }

  const strip = ciGetPendingStrip(root);
  if (strip) {
    // Only rebuild if the strip's tiles don't match the current pending list.
    // ciRefreshUi is called on every renderChatLog (= every new message), so rebuilding
    // unconditionally would destroy and recreate all tiles for every chat message received.
    const pendingIds = ciGetPendingItems().map((p) => String(p.id));
    const domIds = Array.from(strip.querySelectorAll("[data-ci-pending-id]"))
      .map((el) => String(el.dataset.ciPendingId ?? ""));
    const alreadyInSync = pendingIds.length === domIds.length
      && pendingIds.every((id, i) => id === domIds[i]);
    if (!alreadyInSync) {
      strip.textContent = "";
      for (const item of ciGetPendingItems()) ciAddPendingTile(item, root);
    }
  }
  ciSetAreaVisibility(root);
  return area;
}

function ciEnsureUploadButton(root = document) {
  const controls = ciGetChatControls(root);
  if (!controls) return;

  const existingBtn = root.querySelector?.("#ci-upload-image");
  const existingInput = root.querySelector?.("#ci-upload-image-hidden-input");

  if (!ciEnabled() || !ciShowButton()) {
    existingBtn?.remove?.();
    existingInput?.remove?.();
    return;
  }

  let btn = existingBtn;
  let input = existingInput;
  const doc = controls.ownerDocument || document;

  if (!btn) {
    btn = doc.createElement("a");
    btn.id = "ci-upload-image";
    btn.title = "이미지 업로드";
    btn.setAttribute("role", "button");
    btn.innerHTML = '<i class="fas fa-images"></i>';
    const target = controls.querySelector?.(".control-buttons") || controls;
    target.appendChild(btn);
  }

  if (!input) {
    input = doc.createElement("input");
    input.id = "ci-upload-image-hidden-input";
    input.type = "file";
    input.accept = "image/*";
    input.multiple = true;
    controls.appendChild(input);
  }

  if (btn.dataset.feCiBound !== "1") {
    btn.dataset.feCiBound = "1";
    btn.addEventListener("click", (ev) => {
      ev.preventDefault();
      input?.click?.();
    });
  }

  if (input.dataset.feCiBound !== "1") {
    input.dataset.feCiBound = "1";
    input.addEventListener("change", () => {
      const files = Array.from(input.files || []).filter((file) => file?.type?.startsWith?.("image/"));
      for (const file of files) ciPushPending({ file, name: file.name, type: file.type }, root);
      input.value = "";
    });
  }
}

function ciHandleTransfer(event, root = document) {
  if (!ciEnabled()) return false;
  const data = event?.clipboardData || event?.dataTransfer;
  if (!data) return false;

  const stop = () => {
    event?.preventDefault?.();
    event?.stopPropagation?.();
    try { event?.stopImmediatePropagation?.(); } catch {}
  };

  const files = ciExtractFiles(data);
  if (files.length) {
    stop();
    for (const file of files) ciPushPending({ file, name: file.name, type: file.type }, root);
    try { ciGetTextarea(root)?.focus?.(); } catch {}
    return true;
  }

  const urls = ciExtractClipboardHtmlImages(data);
  if (urls.length) {
    stop();
    for (const src of urls) ciPushPending({ src, name: src.split("/").pop() || "image" }, root);
    try { ciGetTextarea(root)?.focus?.(); } catch {}
    return true;
  }
  return false;
}

async function ciSendPending(root = document) {
  if (!ciEnabled()) return false;
  if (CI_STATE.busy) return false;
  const pending = ciGetPendingItems();
  if (!pending.length) return false;

  CI_STATE.busy = true;
  const textarea = ciGetTextarea(root);
  const note = textarea?.value ? String(textarea.value) : "";

  try {
    const resolved = [];
    for (const item of [...pending]) {
      const src = await ciResolvePendingSource(item);
      if (!src) continue;
      resolved.push({ ...item, src });
    }
    if (!resolved.length) {
      ui?.notifications?.warn?.("전송할 수 있는 이미지가 없습니다. 업로드에 실패했거나 파일이 너무 클 수 있습니다.");
      return false;
    }

    await ChatMessage.create({
      content: ciBuildMessageHtml(resolved, note),
      // v14 uses `style`, v13 uses `type` (same OOC value). Set the right field.
      ...(CONST?.CHAT_MESSAGE_STYLES ? { style: ciGetMessageStyleOOC() } : { type: ciGetMessageStyleOOC() }),
      // v13+: author replaces the deprecated user field. Keep user as fallback for v12.
      author: game.user?.id,
    });

    if (textarea) textarea.value = "";
    ciClearPending(root);
    return true;
  } catch (err) {
    console.error("female_edition | chat-images send failed", err);
    ui?.notifications?.error?.("채팅 이미지 전송에 실패했습니다.");
    return false;
  } finally {
    CI_STATE.busy = false;
  }
}

function ciBindChatForm(root = document) {
  const chatForm = ciGetChatForm(root);
  const textarea = ciGetTextarea(root);
  const controls = ciGetChatControls(root);
  if (!chatForm && !textarea && !controls) return;

  const bindTransfer = (el) => {
    if (!el || el.dataset?.feCiTransferBound === "1") return;
    el.dataset.feCiTransferBound = "1";
    el.addEventListener("paste", (ev) => { ciHandleTransfer(ev, root); }, true);
    el.addEventListener("drop", (ev) => { ciHandleTransfer(ev, root); }, true);
    el.addEventListener("dragover", (ev) => {
      if (!ciEnabled()) return;
      if ((ev.dataTransfer?.types || []).length) {
        ev.preventDefault();
        ev.stopPropagation();
        try { ev.stopImmediatePropagation?.(); } catch {}
      }
    }, true);
  };

  const bindSubmitKey = (el) => {
    if (!el || el.dataset?.feCiKeyBound === "1") return;
    el.dataset.feCiKeyBound = "1";
    el.addEventListener("keydown", async (ev) => {
      if (!ciEnabled() || !ciGetPendingItems().length) return;
      if (ev.key !== "Enter") return;
      if (ev.shiftKey || ev.ctrlKey || ev.altKey || ev.metaKey || ev.isComposing) return;
      ev.preventDefault();
      ev.stopPropagation();
      try { ev.stopImmediatePropagation?.(); } catch {}
      await ciSendPending(root);
    }, true);
  };

  if (chatForm && chatForm.dataset.feCiBound !== "1") {
    chatForm.dataset.feCiBound = "1";
    chatForm.addEventListener("submit", (ev) => ciHandleSubmit(ev, root), true);
  }

  bindTransfer(chatForm);
  bindTransfer(textarea);
  bindTransfer(controls);
  bindSubmitKey(textarea);
}

const _ciRefreshTimers = new WeakMap();

function ciScheduleRefreshUi(rootLike = document, delay = 0) {
  try {
    const root = rootLike?.[0] ?? rootLike ?? document;
    if (!root) return;
    const existing = _ciRefreshTimers.get(root);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      try { ciRefreshUi(root); } catch {}
      finally {
        const cur = _ciRefreshTimers.get(root);
        if (cur === t) _ciRefreshTimers.delete(root);
      }
    }, Math.max(0, Number(delay) || 0));
    _ciRefreshTimers.set(root, t);
  } catch {}
}

function ciRefreshUi(root = document) {
  ciEnsureUploadArea(root);
  ciEnsureUploadButton(root);
  ciBindChatForm(root);
  ciBindRenderedImages(root);
  if (!ciEnabled()) ciClearPending(root);
}

function ciRegisterSettings() {
  game.settings.register(MODULE_ID, CI.ENABLED, {
    name: "채팅 이미지 업로드/임베드 활성화",
    hint: "chat-images 모듈 기능(업로드 버튼, 붙여넣기/드래그 앤 드롭, !ci|경로! 임베드)을 사용합니다.",
    scope: "client",
    config: false, // managed in the unified settings menu (fe-settings-menu)
    type: Boolean,
    default: true,
    onChange: () => ciScheduleRefreshUi(document, 0),
  });

  game.settings.register(MODULE_ID, CI.SHOW_BUTTON, {
    name: "채팅 이미지 업로드 버튼 표시",
    hint: "채팅 입력창 오른쪽 컨트롤에 이미지 업로드 버튼을 표시합니다. 꺼도 붙여넣기/드래그 앤 드롭은 사용할 수 있습니다.",
    scope: "client",
    config: false, // managed in the unified settings menu (fe-settings-menu)
    type: Boolean,
    default: true,
    onChange: () => ciScheduleRefreshUi(document, 0),
  });

  game.settings.register(MODULE_ID, CI.UPLOAD_LOCATION, {
    name: "채팅 이미지 업로드 경로",
    hint: "업로드 가능한 경우 이미지를 저장할 data 폴더 경로입니다.",
    scope: "world",
    config: false, // managed in the unified settings menu (fe-settings-menu)
    restricted: true,
    type: String,
    default: "uploaded-chat-images",
    onChange: async (value) => {
      const cleaned = String(value || "uploaded-chat-images").trim().replace(/\s+/g, "-") || "uploaded-chat-images";
      if (cleaned !== value) await game.settings.set(MODULE_ID, CI.UPLOAD_LOCATION, cleaned);
      await ciEnsureUploadDirectory(cleaned);
    },
  });
}

Hooks.once("init", () => {
  ciRegisterSettings();
});

Hooks.once("ready", async () => {
  try {
    await ciEnsureUploadDirectory(ciUploadLocation());
  } catch {}
  ciScheduleRefreshUi(document, 0);
});

Hooks.on("renderChatLog", (app, html) => {
  // The input form UI does not need a whole-document refresh every time the log renders.
  // Keep this root-scoped so new/popped-out chat apps get their controls bound without
  // re-scanning the entire document on every log update.
  ciScheduleRefreshUi(app?.element || html || document, 0);
});

// v14: fires when the shared chat-input/controls block is created or reparented.
Hooks.on("renderChatInput", () => {
  ciScheduleRefreshUi(document, 0);
});

Hooks.on("activateChatLog", (app) => {
  ciScheduleRefreshUi(app?.element || document, 0);
});

Hooks.on("collapseSidebar", (_app, collapsed) => {
  if (collapsed) return;
  ciScheduleRefreshUi(document, 0);
});


Hooks.on("renderChatMessageHTML", (_message, html) => {
  if (!ciEnabled()) return;
  const root = html?.ownerDocument ? (html.closest?.("li.chat-message") || html) : document;
  ciBindRenderedImages(root);
});

Hooks.on("preCreateChatMessage", (message, data, _options, userId) => {
  if (!ciEnabled()) return;
  try {
    // Prefer message.content over data.content: feApplyMarkdownOnPreCreate (which runs
    // in an earlier preCreateChatMessage hook in fe-chat-enhance.js) writes its result
    // via message.updateSource(), which updates message.content but NOT data.content.
    // Reading data.content would discard markdown formatting entirely.
    const current = String(message?.content ?? data?.content ?? "");
    const next = ciShortcodeToHtml(current);
    if (next !== current) {
      if (typeof message?.updateSource === "function") message.updateSource({ content: next });
      else if (data) data.content = next;
      try {
        const pending = message?.toObject?.() ?? { ...data, content: next };
        feCaptureMessageRenderFlagsOnPreCreate(message, pending, userId ?? game?.user?.id ?? null);
      } catch {
        /* no-op */
      }
    }
  } catch {}
});
