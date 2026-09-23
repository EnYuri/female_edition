// Archive message sourcing for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Answers exactly one question: WHICH
// ChatMessages does this export contain, and where does each one's live DOM come
// from? That covers the range dialog, the size-derived render profile, the
// database sweep that finds messages the client never rendered, the visibility
// filter, the live-log element map, and the scroll-safe history harvest.
//
// It never renders, normalizes or styles anything — that is
// `fe-archive-message.js`'s job.


// ===========================================================================
// Range Selection Dialog
// ===========================================================================

// Asks the user which message index range to archive.
// Returns { mode: "all"|"range", from, to } or null if cancelled.
// from/to are 1-based indices (inclusive).
import { feLocalize, feFormat, feLocalizeHTML, feFormatHTML } from "./fe-i18n.js";
import {
  S,
  feSetting,
  feGetChatLogs,
  feGetMessageIdFromElement,
} from "./fe-chat-enhance.js";
import { feSnapshotAndRestoreStickyScroll } from "./fe-util.js";
import {
  feArchiveIsWhisperMessage,
  feCanUserSeeChatMessage,
  feIsElement,
} from "./fe-archive-output.js";
import { feMirrorLiveMessageStyles } from "./fe-archive-clone.js";
import {
  FE_ARCHIVE_HARVEST_TIMEOUT_DEFAULT,
  FE_ARCHIVE_HARVEST_TIMEOUT_HUGE,
  FE_ARCHIVE_HARVEST_TIMEOUT_LARGE,
  FE_ARCHIVE_HUGE_LOG_THRESHOLD,
  FE_ARCHIVE_LARGE_LOG_THRESHOLD,
  FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE,
  FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE,
  FE_EXPORT_RENDER_BATCH,
  FE_EXPORT_RENDER_BATCH_HUGE,
  FE_EXPORT_RENDER_BATCH_LARGE,
  FE_EXPORT_RENDER_CONCURRENCY,
  FE_EXPORT_RENDER_CONCURRENCY_HUGE,
  FE_EXPORT_RENDER_CONCURRENCY_LARGE,
  FE_EXPORT_WAIT_IMAGES_MAX,
  feMaybeYieldForUI,
} from "./fe-archive-runtime.js";

export async function feShowArchiveRangeDialog(totalCount = 0) {
  const readRange = (root) => {
    try {
      // DialogV2 hands us an HTMLElement (often the <form> itself, via `button.form`),
      // while v13's legacy Dialog callback hands us a jQuery collection.
      //
      // Unwrap ONLY jQuery. A bare `root?.[0] ?? root` looks like a harmless normalization
      // but silently breaks the DialogV2 path: HTMLFormElement exposes indexed access to
      // its own controls, so `form[0]` returns the FIRST RADIO INPUT rather than undefined.
      // Every querySelector on that input then returns null, `mode` fell back to its "all"
      // default, and the range dialog became a no-op that always exported everything.
      // jQuery objects are identified by their `.jquery` version string.
      const el = (root && typeof root.jquery === "string") ? root[0] : root;

      // `el` may be the dialog root or the <form>; the controls are inside either, so query
      // directly and do not try to re-resolve a <form> ancestor/descendant.
      const q = (sel) => el?.querySelector?.(sel) ?? null;

      const mode = q("input[name='fe-range-mode']:checked")?.value ?? "all";
      const from = Math.max(1, parseInt(q("#fe-range-from")?.value ?? "1", 10) || 1);
      const to = Math.max(from, parseInt(q("#fe-range-to")?.value ?? String(totalCount), 10) || totalCount);
      return { mode, from, to };
    } catch {
      return { mode: "all", from: 1, to: Math.max(1, totalCount) };
    }
  };

  try {
    const content = `
<div style="display:flex;flex-direction:column;gap:12px;padding:4px 0;">
  <p style="margin:0;font-size:0.95em;">
    ${feLocalizeHTML("FE.ChatArchive.content.Text1")} <strong>${feFormatHTML("FE.Common.Count", { count: totalCount.toLocaleString() })}</strong>
  </p>
  <div style="display:flex;flex-direction:column;gap:8px;">
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="radio" name="fe-range-mode" value="all" checked style="margin:0;">
      ${feLocalizeHTML("FE.ChatArchive.content.Text3")}
    </label>
    <label style="display:flex;align-items:center;gap:8px;cursor:pointer;">
      <input type="radio" name="fe-range-mode" value="range" style="margin:0;">
      ${feLocalizeHTML("FE.ChatArchive.content.Text4")}
      <input type="number" id="fe-range-from" value="1" min="1" max="${totalCount || 99999}"
        style="width:80px;margin:0 4px;text-align:right;"> ${feLocalizeHTML("FE.Common.OrdinalSuffix")}
      ~
      <input type="number" id="fe-range-to" value="${totalCount || 99999}" min="1" max="${totalCount || 99999}"
        style="width:80px;margin:0 4px;text-align:right;"> ${feLocalizeHTML("FE.Common.OrdinalSuffix")}
    </label>
  </div>
  <p style="margin:0;font-size:0.82em;color:var(--color-text-secondary,#888);">
    ${feLocalizeHTML("FE.ChatArchive.content.Text7")}
  </p>
</div>`;

    const DialogV2 = foundry?.applications?.api?.DialogV2;
    if (typeof DialogV2?.prompt === "function") {
      return await DialogV2.prompt({
        window: { title: feLocalize("FE.ChatArchive.window.title") },
        content,
        ok: {
          label: feLocalize("FE.ChatArchive.ok.label"),
          callback: (event, button, dialog) => readRange(button?.form ?? dialog?.element),
        },
        rejectClose: false,
        render: (event, dialog) => {
          try {
            const el = dialog.element;
            // Clicking either number input switches to range mode
            ["#fe-range-from", "#fe-range-to"].forEach((sel) => {
              const inp = el.querySelector(sel);
              if (inp) inp.addEventListener("focus", () => {
                const r = el.querySelector("input[value='range']");
                if (r) r.checked = true;
              });
            });
          } catch {
            /* no-op */
          }
        },
      });
    }

    // Keep a legacy Dialog fallback for installations where DialogV2 is not
    // exposed (including older v13-compatible environments). Do not treat
    // that API gap as a cancellation: the archive renderer itself can still
    // run perfectly well once a range has been chosen.
    const LegacyDialog = globalThis.Dialog;
    if (typeof LegacyDialog !== "function") return null;
    return await new Promise((resolve) => {
      let settled = false;
      const finish = (value) => {
        if (settled) return;
        settled = true;
        resolve(value);
      };
      const dialog = new LegacyDialog({
        title: feLocalize("FE.ChatArchive.window.title"),
        content,
        buttons: {
          save: {
            icon: '<i class="fas fa-save"></i>',
            label: feLocalize("FE.ChatArchive.ok.label"),
            callback: (html) => finish(readRange(html)),
          },
        },
        default: "save",
        close: () => finish(null),
      });
      dialog.render(true);
    });
  } catch {
    return null;
  }
}

// Apply a range spec returned by feShowArchiveRangeDialog to a sorted items array.
// items: array of { msg, id, liveEl, key } sorted oldest-first.
// from/to are 1-based inclusive indices.
export function feApplyMessageRange(items, rangeSpec) {
  try {
    if (!rangeSpec || rangeSpec.mode === "all" || !Array.isArray(items)) return items;

    if (rangeSpec.mode === "range") {
      const from = Math.max(1, Number(rangeSpec.from) || 1);
      const to = Math.min(items.length, Math.max(from, Number(rangeSpec.to) || items.length));
      return items.slice(from - 1, to); // convert to 0-based
    }
  } catch {
    /* no-op */
  }
  return items;
}

export function feGetArchiveRenderProfile(messageCount = 0) {
  const count = Math.max(0, Number(messageCount) || 0);
  const large = count >= FE_ARCHIVE_LARGE_LOG_THRESHOLD;
  const huge = count >= FE_ARCHIVE_HUGE_LOG_THRESHOLD;

  return {
    count,
    large,
    huge,
    lean: large,
    renderBatch: huge ? FE_EXPORT_RENDER_BATCH_HUGE : large ? FE_EXPORT_RENDER_BATCH_LARGE : FE_EXPORT_RENDER_BATCH,
    renderConcurrency: huge ? FE_EXPORT_RENDER_CONCURRENCY_HUGE : large ? FE_EXPORT_RENDER_CONCURRENCY_LARGE : FE_EXPORT_RENDER_CONCURRENCY,
    initialImageWaitMax: huge ? FE_EXPORT_INITIAL_IMAGE_WAIT_HUGE : large ? FE_EXPORT_INITIAL_IMAGE_WAIT_LARGE : FE_EXPORT_WAIT_IMAGES_MAX,
    mirrorTree: !large,
    mirrorCardTree: !large,
    normalizeImageLoading: large ? "lazy" : "eager",
    normalizeImageDecoding: large ? "async" : "sync",
    deferPortraits: true,
    restoreOriginalPortraitSources: true,
    collapseDuplicateImages: true,
    collapseDuplicateImagesAggressive: large,
    bodyClass: huge ? " fe-archive-huge fe-archive-lean" : large ? " fe-archive-lean" : "",
  };
}

// ===========================================================================
// Message Collection & Filtering
// ===========================================================================

export async function feFetchAllChatMessagesFromDatabase() {
  try {
    const docClass = game?.messages?.documentClass || CONFIG?.ChatMessage?.documentClass || foundry?.documents?.ChatMessage || globalThis.ChatMessage?.implementation || globalThis.ChatMessage;
    const backend = docClass?.database;
    if (!docClass || !backend?.get) return { rows: [], docClass: null };
    // The public v13 API defines the third argument as the requesting User
    // document. v14 continues to accept that argument (and its client get
    // path does not require a private context object). Passing `{userId}` here
    // can make v13 permission-aware retrieval fail or omit older messages.
    const rows = await backend.get(docClass, { query: {}, sort: { timestamp: 1 } }, game?.user);
    if (!Array.isArray(rows)) return { rows: [], docClass: null };
    return { rows: rows.filter(Boolean), docClass };
  } catch {
    return { rows: [], docClass: null };
  }
}

// Turn one DB row into a ChatMessage document. `backend.get` sometimes hands back real
// documents already (the check below), in which case this is a pass-through.
//
// This is deliberately NOT done eagerly for every row: a large world returns thousands of
// rows and the user is usually about to pick a range that discards almost all of them.
// feCollectVisibleChatMessages defers each call behind a lazy `msg` getter so only rows
// that survive feApplyMessageRange ever become documents.
export function feMaterializeChatMessage(row, docClass = null) {
  if (!row) return null;
  if (typeof row.getFlag === "function" || row.documentName === "ChatMessage") return row;
  const cls = docClass
    || game?.messages?.documentClass
    || CONFIG?.ChatMessage?.documentClass
    || globalThis.ChatMessage?.implementation
    || globalThis.ChatMessage;
  if (!cls) return null;
  try {
    return cls.fromSource ? cls.fromSource(row) : new cls(row, {});
  } catch {
    try { return new cls(row, {}); } catch { return null; }
  }
}

export async function feCollectVisibleChatMessages(user = game.user, { liveMessageMap = null, progress = null } = {}) {
  const liveMap = liveMessageMap instanceof Map ? liveMessageMap : feBuildLiveChatMessageElementMap();
  const report = (text) => {
    try {
      if (typeof progress === "function") progress(String(text ?? ""));
    } catch {
      /* no-op */
    }
  };

  report(feLocalize("FE.ChatArchive.feCollectVisibleChatMessages"));

  let all = Array.from(game.messages?.contents ?? []);
  // Set only when `all` holds raw DB rows; the lazy `msg` getter needs it to materialize.
  let rowDocClass = null;
  // Archive/export should prefer the fullest document source available.
  // Some worlds/clients may only have the most recent chat page hydrated in memory,
  // so always probe the backend and keep whichever source is longer.
  try {
    report(feLocalize("FE.ChatArchive.feCollectVisibleChatMessages2"));
    const { rows: dbAll, docClass } = await feFetchAllChatMessagesFromDatabase();
    if (dbAll.length > all.length) {
      all = dbAll;
      rowDocClass = docClass;
    } else if (dbAll.length === 0 && all.length > 0) {
      console.warn(feLocalize("FE.Diagnostics.ChatArchive.feCollectVisibleChatMessages"));
    }
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feCollectVisibleChatMessages2"), err);
  }

  const collectProfile = feGetArchiveRenderProfile(all.length);

  // As a final best-effort fallback, harvest any live DOM-only history that has been
  // paged in by ChatLog.renderBatch so the archive can still preserve older messages.
  // IMPORTANT: this is a fidelity enhancement only. Do not let it block the archive UI
  // forever; large worlds should prefer completion over perfect DOM clones.
  let harvested = null;
  const needsHarvest = all.length > liveMap.size && liveMap.size > 0 && !collectProfile.lean;
  if (needsHarvest) {
    try {
      const timeBudgetMs = collectProfile.huge
        ? FE_ARCHIVE_HARVEST_TIMEOUT_HUGE
        : collectProfile.large
          ? FE_ARCHIVE_HARVEST_TIMEOUT_LARGE
          : FE_ARCHIVE_HARVEST_TIMEOUT_DEFAULT;
      const maxIterations = collectProfile.huge ? 4 : collectProfile.large ? 6 : 10;
      report(feFormat("FE.ChatArchive.feCollectVisibleChatMessages3", { value1: Math.min(liveMap.size, all.length), length: all.length }));
      harvested = await feHarvestFullChatHistory({
        batchSize: collectProfile.large ? 80 : 100,
        maxIterations,
        timeBudgetMs,
        progress: ({ collected = 0, total = all.length, timedOut = false } = {}) => {
          const suffix = timedOut ? feLocalize("FE.ChatArchive.progress") : "";
          report(feFormat("FE.ChatArchive.progress2", { value1: Math.min(collected, total), total: total, suffix: suffix }));
        },
      });
      if (harvested?.cloneMap?.size) {
        for (const [id, el] of harvested.cloneMap.entries()) {
          if (!liveMap.has(id)) liveMap.set(id, el);
        }
        // Release the harvest-side references — the clones now live in liveMap only.
        // Without this, both maps pin the same nodes and they can't be GC'd as render
        // progressively drops them from liveMap.
        harvested.cloneMap.clear();
      }
    } catch {
      harvested = null;
    }
  }

  report(feLocalize("FE.ChatArchive.feCollectVisibleChatMessages4"));

  // Applied here — inside collection — rather than alongside feApplyMessageRange, so the
  // count handed to the range dialog is the already-filtered count. Filtering later would
  // make "1~100번째" (items 1–100) refer to a list the user never saw.
  const excludeWhispers = !!feSetting(S.EXPORT_EXCLUDE_WHISPERS);

  const visibleDocs = all
    .filter((m) => feCanUserSeeChatMessage(m, user))
    .filter((m) => !(excludeWhispers && feArchiveIsWhisperMessage(m)))
    .sort((a, b) => {
      const ao = Number(a?.sort ?? a?.timestamp ?? 0);
      const bo = Number(b?.sort ?? b?.timestamp ?? 0);
      if (ao !== bo) return ao - bo;
      return String(a?.id ?? a?._id ?? '').localeCompare(String(b?.id ?? b?._id ?? ''));
    });

  // `msg` is a lazy getter, not a value. Everything above this point (visibility, whisper
  // filter, sort) reads only plain fields that a raw DB row already carries, and every
  // caller applies feApplyMessageRange to this array before touching `.msg` — so exporting
  // the last 50 of a 5000-message world constructs 50 ChatMessage documents instead of
  // 5000. Items dropped by the range slice are never materialized at all.
  //
  // If you add a step between collection and feApplyMessageRange, keep it off `.msg`, or
  // this degrades back to eager materialization without any visible symptom.
  const items = visibleDocs.map((m) => {
    const id = String(m?.id ?? m?._id ?? '');
    const item = {
      key: id || `__msg__${Math.random()}`,
      id,
      liveEl: id ? (liveMap.get(id) || null) : null,
    };
    let cached;
    Object.defineProperty(item, "msg", {
      configurable: true,
      enumerable: true,
      get() {
        if (cached === undefined) cached = feMaterializeChatMessage(m, rowDocClass);
        return cached;
      },
      // Present so an assignment can't throw in this strict-mode module; nothing writes
      // `.msg` today, but a getter-only property would fail loudly if that ever changed.
      set(value) { cached = value; },
    });
    return item;
  });

  if (!items.length && harvested?.orderedIds?.length) {
    const out = harvested.orderedIds.map((id, idx) => ({
      key: id || `__harvest__${idx}`,
      id,
      msg: null,
      liveEl: id ? (liveMap.get(id) || null) : null,
    })).filter((it) => it.liveEl)
      .filter((it) => !(excludeWhispers && feArchiveIsWhisperMessage(null, it.liveEl)));
    report(feFormat("FE.ChatArchive.feCollectVisibleChatMessages5", { length: out.length }));
    return out;
  }

  report(feFormat("FE.ChatArchive.feCollectVisibleChatMessages5", { length: items.length }));
  return items;
}

export function feBuildLiveChatMessageElementMap() {
  const map = new Map();
  try {
    const logs = feGetChatLogs?.() ?? [];
    for (const log of logs) {
      if (!log?.querySelectorAll) continue;
      for (const el of log.querySelectorAll("li.chat-message")) {
        const id = feGetMessageIdFromElement?.(el);
        if (id) map.set(String(id), el);
      }
    }

    // When the user is not viewing the Chat tab in FVTT v13, recent lines can still exist
    // in the notifications tray. Use them as a fidelity backup, but only for ids not already
    // backed by a real chat-log entry.
    for (const el of Array.from(document.querySelectorAll?.("#chat-notifications > .message") ?? [])) {
      const id = feGetMessageIdFromElement?.(el);
      if (id && !map.has(String(id))) map.set(String(id), el);
    }
  } catch {
    /* no-op */
  }
  return map;
}

export function feCloneChatMessageElement(el) {
  try {
    if (!feIsElement(el)) return null;
    const clone = el.cloneNode(true);
    // Harvested nodes are detached immediately after this pass, so capture the
    // live sidebar's essential computed appearance now. Use the lean targeted
    // profile: it preserves the message shell, header/content, portraits,
    // cards, component sizes, custom variables, and live control state without
    // multiplying a full descendant-style tree across the entire history.
    feMirrorLiveMessageStyles(el, clone, {
      renderProfile: { lean: true, mirrorTree: false, mirrorCardTree: false },
    });
    return clone;
  } catch {
    return null;
  }
}

// ===========================================================================
// Chat History Harvesting  (scroll-safe DOM clone, full log rebuild)
// ===========================================================================

export async function feHarvestFullChatHistory({ batchSize = 100, maxIterations = 80, timeBudgetMs = 0, progress = null } = {}) {
  const cloneMap = new Map();
  let orderedIds = [];
  // renderBatch prepends messages and changes the real `.chat-scroll` height.
  // Reuse the ordinary live-chat sticky-scroll contract so bottom-follow stays
  // pinned while a reader browsing older history keeps their current viewport.
  const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
  try {
    const chat = game?.messages?.directory || ui?.chat;
    const logs = feGetChatLogs?.() ?? [];
    if (!chat?.renderBatch || !logs.length) return { cloneMap, orderedIds };

    const harvestOnce = () => {
      const visibleIds = [];
      for (const log of logs) {
        if (!log?.querySelectorAll) continue;
        for (const el of log.querySelectorAll('li.chat-message')) {
          const id = feGetMessageIdFromElement?.(el);
          if (!id) continue;
          const sid = String(id);
          visibleIds.push(sid);
          if (!cloneMap.has(sid)) {
            const clone = feCloneChatMessageElement(el);
            if (clone) cloneMap.set(sid, clone);
          }
        }
      }
      if (visibleIds.length) {
        const seen = new Set();
        const merged = [];
        for (const id of visibleIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(id);
        }
        for (const id of orderedIds) {
          if (seen.has(id)) continue;
          seen.add(id);
          merged.push(id);
        }
        orderedIds = merged;
      }
      return visibleIds;
    };

    let prevFirst = '';
    let prevCount = -1;
    let stablePasses = 0;
    const startedAt = Date.now();
    let timedOut = false;
    for (let i = 0; i < maxIterations; i += 1) {
      if (timeBudgetMs > 0 && (Date.now() - startedAt) >= timeBudgetMs) {
        timedOut = true;
        break;
      }

      const before = harvestOnce();
      const beforeFirst = before[0] || '';
      const beforeCount = before.length;

      try {
        if (typeof progress === "function") progress({ iteration: i + 1, maxIterations, collected: cloneMap.size, total: orderedIds.length || beforeCount, timedOut: false });
      } catch {
        /* no-op */
      }

      try {
        // A started renderBatch cannot be cancelled. Always let this one settle
        // before restoring sticky state; otherwise a timed-out batch can mutate
        // the log after the finally block and invalidate the restoration.
        await chat.renderBatch(batchSize);
      } catch {
        break;
      }
      if (timeBudgetMs > 0 && (Date.now() - startedAt) >= timeBudgetMs) {
        timedOut = true;
        break;
      }
      await feMaybeYieldForUI(window);
      await feMaybeYieldForUI(window);

      const after = harvestOnce();
      const afterFirst = after[0] || '';
      const afterCount = after.length;

      if (afterCount === beforeCount && afterFirst === beforeFirst) stablePasses += 1;
      else stablePasses = 0;

      if (afterCount === prevCount && afterFirst === prevFirst) stablePasses += 1;
      prevCount = afterCount;
      prevFirst = afterFirst;

      if (stablePasses >= 2) break;
    }

    harvestOnce();
    try {
      if (typeof progress === "function") progress({ collected: cloneMap.size, total: orderedIds.length || cloneMap.size, timedOut });
    } catch {
      /* no-op */
    }

  } catch {
    // swallow and return best-effort partial history
  } finally {
    // Always restore follow intent — even if an error interrupted the harvest loop.
    restoreStickyScroll();
  }
  return { cloneMap, orderedIds };
}
