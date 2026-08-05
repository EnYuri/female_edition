/**
 * fe-conflict-guard.js
 *
 * female_edition reimplements several standalone modules internally (narrator,
 * theatre/stage chat, token image-hover, chat-log pruning, cinematic chat).
 * When the ORIGINAL standalone module is also active, behaviour overlaps.
 *
 * Resolution strategy (decided with the module author):
 *
 *   - Has a `neutralize` spec → it is a module the author has confirmed is
 *     ABANDONED (no longer updated for the current Foundry generation) AND that
 *     female_edition fully replaces. On detection we attempt a best-effort LIVE
 *     NEUTRALIZE: strip its hooks + remove its overlay DOM so female_edition's
 *     port wins without a reload. The chief fragility of runtime neutralization
 *     — breaking when the target updates — does not apply to an abandoned
 *     module. SAFETY GATE: if the module's manifest declares FORWARD
 *     compatibility (`compatibility.maximum` generation > current core), it is
 *     evidently being maintained, so a full replacement yields female_edition's
 *     corresponding feature instead of killing the original. (Curation can't be
 *     inferred from the manifest alone:
 *     narrator-tools/image-hover declare no maximum yet stopped at v13, while
 *     theatre caps at 13 — so the abandoned set is an explicit list here, not a
 *     version formula. The forward-compat gate only protects against a future
 *     revival.)
 *
 *   - mode "warn" (no spec) → a partial/soft duplicate; the GM is warned only
 *     when both modules' conflicting feature toggles are actually enabled.
 *
 *   - mode "yield" → when the original's matching feature setting is enabled,
 *     female_edition turns only its OWN corresponding feature off for this
 *     launch. Saved preferences are not overwritten. The GM is still informed.
 *
 * SAFETY: neutralization NEVER removes a handler whose source/name contains a
 * female_edition self-marker (`female_edition`, `_FET_`, `FemaleEdition`) — so
 * our own ports are protected even when they share vocabulary with the target.
 * Everything removed is logged for audit. Live neutralization is best-effort:
 * hooks + overlay DOM are removed, but non-hook surface (jQuery/DOM listeners,
 * globals, libWrapper patches) may linger inert — verified harmless for the
 * curated targets.
 *
 * Warns the GM at `ready`. Neutralization runs on every client (per-client
 * runtime fix). No settings or CSS of its own.
 */

import {
  FE_CONFLICT_FEATURE,
  feSuppressConflictFeature,
  feIsConflictFeatureSuppressed,
  feClearConflictFeatureSuppressions,
  feReadRegisteredModuleSetting,
} from "./fe-conflict-state.js";

// Self-markers that must NEVER be stripped (protects female_edition's own code).
const FE_CG_SELF_GUARD = ["female_edition", "_FET_", "FemaleEdition"];

const FE_CG_CONFLICTS = [
  {
    id: "narrator-tools",
    feature: "내레이터 채팅",
    detail: "내레이션 오버레이와 슬래시 명령이 이중으로 실행됩니다.",
    own: { features: [FE_CONFLICT_FEATURE.NARRATOR], settings: ["narratorEnabled"] },
    yieldWhenMaintained: true,
    yieldDetail: "유지보수 중인 원본의 내레이터 기능이 활성화되어 female_edition 내레이터를 런타임에서 껐습니다.",
    // Verified live: arrow handlers carry "NarratorTools" in source; the three
    // chat hooks are `Method.bind(NarratorTools)` → identified by fn.name
    // ("bound _chatMessage" …). Overlay is `<div id="narrator">` + a
    // `#narratorWebFont` <style>.
    neutralize: {
      // Spec written/verified against this target version. A newer installed
      // version → markers/DOM may not match → skip neutralize, warn instead.
      verifiedVersion: "1.0.1",
      markers: [
        "NarratorTools",
        "bound _chatMessage",
        "bound _renderChatMessage",
        "bound _createSceneryButton",
      ],
      dom: ["#narrator", "#narratorWebFont"],
      minimumHooks: 1,
    },
  },
  {
    id: "theatre",
    feature: "무대(극장) 채팅",
    detail: "채팅 스피커 라우팅이 정면 충돌합니다.",
    own: { features: [FE_CONFLICT_FEATURE.STAGE], settings: ["stageEnabled"] },
    yieldWhenMaintained: true,
    yieldDetail: "유지보수 중인 원본의 무대 기능이 활성화되어 female_edition 무대를 런타임에서 껐습니다.",
    // Markers are tokens unique to the ORIGINAL theatre (fe-theatre never uses
    // these and is additionally protected by the self-guard).
    neutralize: {
      verifiedVersion: "3.3.0",
      markers: [
        "Theatre.instance",
        "theatreId",
        "theatre-bar",
        "theatreDock",
        "theatre-control",
        "TheatreSettings",
        "theatre-emote",
      ],
      dom: [
        "#theatre-bar",
        "#theatreDock",
        "#theatre-control",
        "#theatre-narrator-toolbar",
        "#theatre-emote-menu",
        "#theatre-tooltip",
      ],
      minimumHooks: 1,
    },
  },
  {
    id: "vino",
    feature: "시네마틱 채팅(vino)",
    detail: "오버레이/플래그 처리가 충돌하며, v9 API라 현재 코어에서 깨집니다.",
    own: { features: [FE_CONFLICT_FEATURE.STAGE], settings: ["stageEnabled"] },
    externalCheck: "vinoActors",
    yieldWhenMaintained: true,
    yieldDetail: "유지보수 중인 원본의 시네마틱 채팅이 활성화되어 female_edition 무대를 런타임에서 껐습니다.",
    neutralize: {
      verifiedVersion: "1.0.0",
      markers: ["VNOverlay", "_getMood", "vino-overlay", "flags.vino"],
      dom: ["#vino-overlay"],
      minimumHooks: 1,
    },
  },
  {
    id: "image-hover",
    feature: "토큰 이미지 호버",
    detail: "토큰 호버 HUD가 두 개 표시됩니다.",
    own: { features: [FE_CONFLICT_FEATURE.IMAGE_HOVER], settings: ["ihEnabled"] },
    externalSetting: "userEnableModule",
    yieldWhenMaintained: true,
    yieldDetail: "유지보수 중인 원본의 이미지 호버가 이 클라이언트에서 활성화되어 female_edition 이미지 호버를 런타임에서 껐습니다.",
    // fe-image-hover is a direct port and shares the `canvas.hud.imageHover`
    // slot + much vocabulary, so markers must be tokens UNIQUE to the original:
    // its keybind id "image-hover.userKeybindButton", the globals showSpecificArt
    // / imageHoverDelay, and the cache helpers. Verified live: these catch the
    // original's hoverToken + renderHeadsUpDisplayContainer + createToken with
    // ZERO false positives on fe-image-hover (which uses _ih*/female_edition).
    // DOM id is "#image-hover-hud" exactly — does NOT match our
    // "#fe-image-hover-hud".
    neutralize: {
      verifiedVersion: "3.1",
      markers: [
        "image-hover.userKeybindButton",
        "showSpecificArt",
        "imageHoverDelay",
        "cacheAvailableToken",
        "cacheImageNames",
      ],
      dom: ["#image-hover-hud"],
      minimumHooks: 1,
    },
  },
  {
    // Novel-game-style bottom message window (portrait + typewriter text).
    // Functionally a SUBSET of fe-theatre (무대): both turn chat messages into a
    // VN-style portrait+message overlay. Actively maintained (v13, recent) → warn,
    // never neutralize. Soft conflict (only bites when BOTH features are on): a
    // staged-actor line double-shows (stage bubble + SMW window), and SMW does not
    // recognise female_edition's `flags.female_edition.isNarrator`, so /narrate
    // also double-shows. No hooks to strip / no DOM clash (#smw-* ≠ #fe-*).
    id: "simple-message-window",
    feature: "무대(노벨게임풍 메시지 창)",
    mode: "warn",
    own: {
      features: [FE_CONFLICT_FEATURE.STAGE, FE_CONFLICT_FEATURE.NARRATOR],
      settings: ["stageEnabled", "narratorEnabled"],
      match: "any",
    },
    externalSetting: "smwEnable",
    detail: "채팅을 입그림+메시지 창으로 표시하는 기능이 female_edition 무대(fe-theatre)와 겹칩니다. 둘 다 켜면 무대 발화가 이중 표시되고, /narrate 내레이션도 두 곳에 표시됩니다. 한쪽만 사용하세요.",
  },
  {
    id: "chatlog-prune",
    feature: "채팅 자동 정리",
    mode: "yield",
    own: { features: [FE_CONFLICT_FEATURE.CHAT_PRUNE], settings: ["cePruneEnabled"] },
    externalSetting: "enabled",
    detail: "female_edition 내장 채팅 정리 기능을 끄고 이 모듈에 양보했습니다.",
  },
  {
    // fe-typing-indicator ALREADY fully yields to CGMP's typing notifier:
    // feTypingFeatureEnabled() returns false when CGMP is active (no injection,
    // socket display, or listeners), so there is no double indicator. This entry
    // is purely informational — same yield pattern as chatlog-prune.
    id: "CautiousGamemastersPack",
    feature: "타이핑 알림",
    mode: "yield",
    own: { features: [FE_CONFLICT_FEATURE.TYPING], settings: ["ceTypingEnabled"] },
    externalSetting: "notifyTyping",
    detail: "female_edition이 타이핑 인디케이터를 끄고 이 모듈의 타이핑 알림에 양보했습니다.",
  },
  {
    // fe-combat-tracker.js ALREADY fully yields: feCtOriginalActive() returns true
    // when this module is active, so the internal combat tracker skips its own
    // install (no double tracker). This entry is purely informational — same yield
    // pattern as chatlog-prune. Carousel is actively maintained, so we never
    // neutralize it.
    id: "combat-tracker-dock",
    feature: "컴뱃 트래커",
    mode: "yield",
    own: { features: [FE_CONFLICT_FEATURE.COMBAT_TRACKER], settings: ["ceCombatTrackerEnabled"] },
    detail: "female_edition이 내장 컴뱃 트래커를 끄고 이 모듈(Carousel Combat Tracker)에 양보했습니다.",
  },
  {
    id: "chat-portrait",
    feature: "채팅 포트레이트",
    mode: "yield",
    own: { features: [FE_CONFLICT_FEATURE.CHAT_PORTRAIT], settings: ["chatPortraitEnabled"] },
    detail: "female_edition이 내장 채팅 포트레이트를 런타임에서 끄고 원본 모듈에 양보했습니다.",
  },
  {
    id: "chat-images",
    feature: "채팅 이미지 업로드/임베드",
    mode: "yield",
    own: { features: [FE_CONFLICT_FEATURE.CHAT_IMAGES], settings: ["chatImagesEnabled"] },
    detail: "female_edition이 내장 채팅 이미지 기능을 런타임에서 끄고 원본 모듈에 양보했습니다.",
  },
  {
    id: "emanim-music",
    feature: "공용 음악 업로드/재생",
    mode: "yield",
    own: { features: [FE_CONFLICT_FEATURE.MUSIC], settings: ["ceMusicEnabled"] },
    detail: "female_edition이 내장 음악 기능을 런타임에서 끄고 원본 모듈에 양보했습니다.",
  },
];

const FE_CG_RUNTIME_ACTIONS = new Map();
const FE_CG_FCS_ID = "force-client-settings";
const FE_CG_OWN_SETTING_PREFIX = "female_edition.";
let FE_CG_FCS_RESULT = null;

// ── helpers ─────────────────────────────────────────────────────────────────

/**
 * Force Client Settings is a classic script, so its top-level class is a
 * global lexical binding rather than a globalThis property. ES modules can
 * still resolve that binding through the global environment; retain the
 * property fallback for forks which explicitly export it.
 */
function feCgGetForceClientSettingsRuntime() {
  try {
    if (typeof ForceClientSettings !== "undefined") return ForceClientSettings;
  // NOTE: this comment must not begin with the word "global" — ESLint reads such a
  // block comment as a global-declaration directive and then reports each following
  // word as an unused variable.
  } catch { /* ForceClientSettings lexical binding unavailable */ }
  try { return globalThis.ForceClientSettings ?? null; }
  catch { return null; }
}

function feCgIsOwnSettingKey(key) {
  return String(key ?? "").startsWith(FE_CG_OWN_SETTING_PREFIX);
}

/**
 * Neutralize the abandoned Force Client Settings module ONLY for this module.
 *
 * Its get/set/register wrappers all consult the mutable static `forced` Map at
 * call time. Removing our namespace from that Map therefore makes the existing
 * wrappers transparently pass female_edition reads/writes through while every
 * other module remains governed by FCS. We also clear its per-client unlock and
 * restriction maps for our keys, then guard the two mutators so the setting UI
 * cannot re-apply an FE lock later in the same launch.
 *
 * This is runtime-only by design. We do not rewrite another module's persisted
 * world settings; the same scoped neutralization is re-applied on every load.
 */
function feCgNeutralizeForceClientSettings(runtime = feCgGetForceClientSettingsRuntime()) {
  const mod = game.modules?.get?.(FE_CG_FCS_ID);
  if (!mod?.active) return { active: false, success: true, removed: [] };
  if (!runtime || !(runtime.forced instanceof Map)) {
    return {
      active: true,
      success: false,
      removed: [],
      reason: "ForceClientSettings 런타임 맵에 접근할 수 없음",
    };
  }

  const removed = [];
  for (const [name, map] of [
    ["forced", runtime.forced],
    ["unlocked", runtime.unlocked],
    ["restricted", runtime.restricted],
  ]) {
    if (!(map instanceof Map)) continue;
    for (const key of [...map.keys()]) {
      if (!feCgIsOwnSettingKey(key)) continue;
      map.delete(key);
      removed.push({ map: name, key: String(key) });
    }
  }

  let guarded = false;
  try {
    if (!runtime._feOwnNamespaceGuardInstalled) {
      if (typeof runtime.forceSetting !== "function" || typeof runtime.restrictSetting !== "function") {
        throw new Error("예상한 forceSetting/restrictSetting 메서드가 없음");
      }
      const wrapMutator = (methodName) => {
        const original = runtime[methodName];
        runtime[methodName] = function feCgFcsOwnNamespaceGuard(key, ...args) {
          if (feCgIsOwnSettingKey(key)) {
            console.warn(
              `[female_edition] Force Client Settings의 ${key} ${methodName} 요청을 차단했습니다.`
            );
            return Promise.resolve(false);
          }
          return original.call(this, key, ...args);
        };
      };
      wrapMutator("forceSetting");
      wrapMutator("restrictSetting");
      Object.defineProperty(runtime, "_feOwnNamespaceGuardInstalled", {
        value: true,
        configurable: true,
      });
    }
    guarded = !!runtime._feOwnNamespaceGuardInstalled;
  } catch (err) {
    return {
      active: true,
      success: false,
      removed,
      reason: `재강제 차단 설치 실패: ${err?.message ?? err}`,
    };
  }

  return { active: true, success: guarded, guarded, removed };
}

function feCgIsMldMidiTargetPositionError(app, err) {
  const mld = game.modules?.get?.("monks-little-details");
  if (!mld?.active) return false;
  const midi = game.modules?.get?.("midi-qol");
  if (!midi?.active) return false;

  const isMidiTargetDialog = app?.id === "midi-qol-targetConfirmation"
    || app?.constructor?.name === "TargetConfirmationDialog"
    || app?.element?.classList?.contains?.("midi-targeting")
    || app?.options?.classes?.includes?.("midi-targeting");
  if (!isMidiTargetDialog) return false;

  const stack = String(err?.stack ?? "");
  const message = String(err?.message ?? err ?? "");
  const hay = `${message}\n${stack}`;
  return hay.includes("monks-little-details")
    && (hay.includes("_updatePosition") || hay.includes("setPosition") || hay.includes("setWidth"));
}

function feCgPositionFallback(app, position) {
  const current = app?.position;
  if (current && typeof current === "object") return current;
  return position && typeof position === "object" ? position : {};
}

function feCgInstallMldTargetConfirmationGuard() {
  try {
    const mld = game.modules?.get?.("monks-little-details");
    if (!mld?.active) return false;
    const midi = game.modules?.get?.("midi-qol");
    if (!midi?.active) return false;
    const proto = foundry.applications?.api?.ApplicationV2?.prototype;
    if (!proto?.setPosition || proto.setPosition._feCgMldGuard) return false;

    const guard = function feCgMldSetPositionGuard(wrapped, ...args) {
      try {
        return wrapped(...args);
      } catch (err) {
        if (!feCgIsMldMidiTargetPositionError(this, err)) throw err;
        if (!this._feCgMldPositionWarned) {
          this._feCgMldPositionWarned = true;
          console.warn(
            "[female_edition] monks-little-details/midi-qol TargetConfirmation setPosition 오류를 우회했습니다.",
            err
          );
        }
        return feCgPositionFallback(this, args[0]);
      }
    };

    if (game.modules?.get?.("lib-wrapper")?.active && globalThis.libWrapper?.register) {
      try {
        libWrapper.register("female_edition", "foundry.applications.api.ApplicationV2.prototype.setPosition", guard, "WRAPPER");
        proto.setPosition._feCgMldGuard = true;
        return true;
      } catch (err) {
        console.warn("[female_edition] libWrapper guard registration failed; falling back to manual wrapper", err);
      }
    }

    const original = proto.setPosition;
    const wrapped = function feCgMldSetPositionGuardManual(...args) {
      try {
        return original.apply(this, args);
      } catch (err) {
        if (!feCgIsMldMidiTargetPositionError(this, err)) throw err;
        if (!this._feCgMldPositionWarned) {
          this._feCgMldPositionWarned = true;
          console.warn(
            "[female_edition] monks-little-details/midi-qol TargetConfirmation setPosition 오류를 우회했습니다.",
            err
          );
        }
        return feCgPositionFallback(this, args[0]);
      }
    };
    wrapped._feCgMldGuard = true;
    proto.setPosition = wrapped;
    return true;
  } catch (err) {
    console.warn("[female_edition] monks-little-details TargetConfirmation guard install failed", err);
    return false;
  }
}

function feCgGenOf(v) {
  if (v == null) return null;
  const n = Number(String(v).split(".")[0]);
  return Number.isFinite(n) ? n : null;
}

function feCgCoreGen() {
  return (
    Number(game.release?.generation) ||
    feCgGenOf(game.version) ||
    feCgGenOf(game.data?.version) ||
    0
  );
}

// Safety gate: true when the module declares compatibility with a Foundry
// generation NEWER than the running core — evidence it is actively maintained,
// so a full-replacement target should yield our feature instead of being stripped.
function feCgDeclaresForwardCompat(mod) {
  const max = mod?.compatibility?.maximum ?? mod?.compatibleCoreVersion;
  const maxGen = feCgGenOf(max);
  return maxGen != null && maxGen > feCgCoreGen();
}

// Safety gate: true when the installed module is NEWER than the version this
// spec was written/verified against. The markers/DOM selectors are version-
// specific, so a newer target may have changed internals → skip neutralize and
// yield our corresponding feature instead of risking a wrong/partial strip.
function feCgIsNewerThanVerified(mod, verifiedVersion) {
  if (!verifiedVersion) return false;
  const cur = String(mod?.version ?? "").replace(/^v/i, "");
  const ver = String(verifiedVersion).replace(/^v/i, "");
  try { return foundry.utils.isNewerVersion(cur, ver); } catch { return false; }
}

function feCgOwnFeatureState(hit) {
  const own = hit?.own;
  if (!own?.settings?.length) return { known: true, enabled: true };

  const values = own.settings.map((key, index) => {
    const setting = feReadRegisteredModuleSetting("female_edition", key);
    if (!setting.known) return { known: false, enabled: false };
    const feature = own.features?.[index];
    const suppressed = feature ? feIsConflictFeatureSuppressed(feature) : false;
    return { known: true, enabled: !!setting.value && !suppressed };
  });
  if (values.some((v) => !v.known)) return { known: false, enabled: false };
  const enabled = own.match === "all"
    ? values.every((v) => v.enabled)
    : values.some((v) => v.enabled);
  return { known: true, enabled };
}

function feCgExternalFeatureState(hit) {
  if (!hit?.mod?.active) return { known: true, enabled: false };
  if (hit.externalCheck === "vinoActors") {
    try {
      const actors = Array.from(game.actors?.contents ?? game.actors ?? []);
      const enabled = actors.some((actor) => {
        const flag = actor?.flags?.vino?.enabled ?? actor?.data?.flags?.vino?.enabled;
        return flag !== false;
      });
      return { known: true, enabled };
    } catch {
      return { known: false, enabled: false };
    }
  }
  if (!hit.externalSetting) return { known: true, enabled: true };
  const setting = feReadRegisteredModuleSetting(hit.id, hit.externalSetting);
  return setting.known
    ? { known: true, enabled: !!setting.value }
    : { known: false, enabled: false };
}

function feCgAssessConflict(hit) {
  const own = feCgOwnFeatureState(hit);
  const external = feCgExternalFeatureState(hit);
  if (own.known && !own.enabled) return { action: "none", own, external };
  if (external.known && !external.enabled) return { action: "none", own, external };
  if (!own.known || !external.known) {
    return { action: "unknown", own, external, reason: "기능 활성 설정을 확인할 수 없음" };
  }
  if (hit.mode === "yield") return { action: "yield", own, external };
  if (!hit.neutralize) return { action: "warn", own, external };

  const fwd = feCgDeclaresForwardCompat(hit.mod);
  const newer = feCgIsNewerThanVerified(hit.mod, hit.neutralize.verifiedVersion);
  if (!fwd && !newer) return { action: "neutralize", own, external };

  const reason = fwd
    ? "상위 코어 호환 선언 — 유지보수 중으로 판단"
    : `검증 버전(${hit.neutralize.verifiedVersion})보다 높음(현재 ${hit.mod.version})`;
  return {
    action: hit.yieldWhenMaintained ? "yield" : "warn",
    own,
    external,
    reason,
    maintained: true,
  };
}

function feCgPrepareRuntimePolicy() {
  FE_CG_RUNTIME_ACTIONS.clear();
  feClearConflictFeatureSuppressions();
  for (const conflict of FE_CG_CONFLICTS) {
    const mod = game.modules?.get?.(conflict.id);
    if (!mod?.active) continue;
    const hit = { ...conflict, mod, title: mod.title || conflict.id };
    const assessment = feCgAssessConflict(hit);
    FE_CG_RUNTIME_ACTIONS.set(hit.id, { hit, assessment });
    if (assessment.action !== "yield") continue;
    for (const feature of hit.own?.features ?? []) {
      feSuppressConflictFeature(feature, `${hit.id}: ${assessment.reason ?? hit.detail ?? "yield"}`);
    }
  }
  return FE_CG_RUNTIME_ACTIONS;
}

// Resolve the hook-registry object across Foundry versions. v11+ exposes it via
// `Hooks.events` (getter → private #events). Falls back to the pre-v11 `_hooks`
// store if a build differs. Returns null if neither is usable.
function feCgHookEvents() {
  try { if (Hooks?.events && typeof Hooks.events === "object") return Hooks.events; } catch { /* getter threw */ }
  try { if (Hooks?._hooks && typeof Hooks._hooks === "object") return Hooks._hooks; } catch { /* no-op */ }
  return null;
}

// Strip every hook handler matching a marker (source OR fn.name), skipping any
// handler protected by the self-guard. Returns a {hookName: count} summary.
// Hardened for v13/older builds: tolerates a missing/renamed registry, both
// enumerable and non-enumerable hook keys, entry shapes ({hook,id,fn} or a bare
// function), and `Hooks.off` accepting an id OR a function. Any single bad entry
// is skipped without aborting the sweep.
function feCgStripHooks(markers, selfGuard = FE_CG_SELF_GUARD) {
  const removed = {};
  const events = feCgHookEvents();
  if (!events) return removed;

  // getOwnPropertyNames catches BOTH enumerable (older) and non-enumerable (v14,
  // defined writable:false) keys; Object.keys is a last-ditch fallback.
  let names;
  try { names = Object.getOwnPropertyNames(events); }
  catch { try { names = Object.keys(events); } catch { return removed; } }

  for (const name of names) {
    let arr;
    try { arr = events[name]; } catch { continue; }
    if (!Array.isArray(arr)) continue;
    for (const entry of [...arr]) {
      try {
        const fn = entry?.fn ?? (typeof entry === "function" ? entry : null);
        if (typeof fn !== "function") continue;
        let src = "";
        try { src = Function.prototype.toString.call(fn); } catch { /* native/bound */ }
        const hay = src + " " + (fn.name || "");
        if (selfGuard.some((g) => hay.includes(g))) continue; // never our own
        if (!markers.some((m) => hay.includes(m))) continue;
        // Prefer off-by-id; fall back to off-by-function for older builds.
        let ok = false;
        const id = entry?.id;
        if (id != null) {
          try {
            Hooks.off(name, id);
            ok = !arr.includes(entry);
          } catch { /* try fn */ }
        }
        if (!ok) {
          try {
            Hooks.off(name, fn);
            ok = !arr.includes(entry);
          } catch { /* no-op */ }
        }
        if (ok) removed[name] = (removed[name] || 0) + 1;
      } catch { /* skip this entry, keep sweeping */ }
    }
  }
  return removed;
}

function feCgRemoveDom(selectors) {
  let n = 0;
  for (const sel of selectors) {
    try {
      document.querySelectorAll(sel).forEach((el) => { el.remove(); n++; });
    } catch {}
  }
  return n;
}

function feCgNeutralize(hit) {
  const spec = hit.neutralize;
  const hooks = feCgStripHooks(spec.markers);
  const dom = feCgRemoveDom(spec.dom);
  const hookCount = Object.values(hooks).reduce((a, b) => a + b, 0);

  return { hookCount, hooks, dom };
}

function feCgScheduleNeutralizeSecondPass(hit) {
  const spec = hit.neutralize;
  // A target may rebuild hooks/DOM in its own ready/canvasReady after our pass.
  setTimeout(() => {
    try {
      const moreHooks = feCgStripHooks(spec.markers);
      const moreDom = feCgRemoveDom(spec.dom);
      const moreHookCount = Object.values(moreHooks).reduce((a, b) => a + b, 0);
      if (moreHookCount || moreDom) {
        console.warn(
          `[female_edition] conflict-guard 2차 strip 「${hit.id}」 — 훅 +${moreHookCount}, DOM +${moreDom}`,
          moreHooks
        );
      }
    } catch { /* no-op */ }
  }, 1000);
}

// ── main ──────────────────────────────────────────────────────────────────

// All module settings have been registered by setup, while feature ready hooks
// have not run yet. Establish runtime yields here so our own ready handlers see
// the suppression before they inject UI or listeners.
Hooks.once("setup", () => {
  try {
    FE_CG_FCS_RESULT = feCgNeutralizeForceClientSettings();
    feCgPrepareRuntimePolicy();
  }
  catch (err) { console.error("[female_edition] conflict policy setup failed", err); }
});

Hooks.once("ready", () => {
  try {
    feCgInstallMldTargetConfirmationGuard();
    if (!FE_CG_FCS_RESULT?.success) {
      FE_CG_FCS_RESULT = feCgNeutralizeForceClientSettings();
    }

    if (!FE_CG_RUNTIME_ACTIONS.size) feCgPrepareRuntimePolicy();
    const active = [...FE_CG_RUNTIME_ACTIONS.values()];
    const fcsAffected = FE_CG_FCS_RESULT?.active
      && (FE_CG_FCS_RESULT.removed?.length || !FE_CG_FCS_RESULT.success);
    if (!active.length && !fcsAffected) return;

    const neutralized = []; // { hit, result }
    const warnConflicts = [];
    const yields = [];

    for (const { hit, assessment } of active) {
      if (assessment.action === "none") continue;
      if (assessment.action === "yield") {
        if (assessment.maintained && hit.yieldDetail) hit.detail = hit.yieldDetail;
        yields.push(hit);
        continue;
      }
      if (assessment.action === "unknown") {
        hit._skipReason = assessment.reason;
        warnConflicts.push(hit);
        continue;
      }
      if (assessment.action === "warn") {
        hit._skipReason = assessment.reason;
        warnConflicts.push(hit);
        continue;
      }

      try {
        const result = feCgNeutralize(hit);
        const minimumHooks = Math.max(1, Number(hit.neutralize?.minimumHooks) || 1);
        if (result.hookCount < minimumHooks) {
          hit._skipReason = `무력화 검증 실패(제거 훅 ${result.hookCount}/${minimumHooks})`;
          warnConflicts.push(hit);
          continue;
        }
        neutralized.push({ hit, result });
        feCgScheduleNeutralizeSecondPass(hit);
      } catch (e) {
        console.error(`[female_edition] neutralize failed for ${hit.id}`, e);
        hit._skipReason = "무력화 실패(예외)";
        warnConflicts.push(hit);
      }
    }

    // ── console audit ──
    console.warn(
      "%c[female_edition] 충돌/중복 모듈 감지",
      "color:#e67e22;font-weight:bold;font-size:1.1em"
    );
    for (const { hit, result } of neutralized) {
      console.warn(
        ` 🔧 「${hit.title}」(${hit.id}) — 버려진 중복 모듈 → 무력화: ` +
          `훅 ${result.hookCount}개 제거, DOM ${result.dom}개 제거`,
        result.hooks
      );
    }
    for (const hit of warnConflicts) {
      const why = hit._skipReason ? ` [무력화 보류: ${hit._skipReason}]` : "";
      console.warn(
        ` ⚠ 「${hit.title}」(${hit.id}) — female_edition "${hit.feature}"와 중복: ${hit.detail}${why} → 원본 모듈을 비활성화하세요.`
      );
    }
    for (const hit of yields) {
      console.warn(` ↪ 「${hit.title}」(${hit.id}) — ${hit.detail}`);
    }
    if (FE_CG_FCS_RESULT?.active) {
      if (FE_CG_FCS_RESULT.success) {
        const keys = [...new Set(FE_CG_FCS_RESULT.removed.map((entry) => entry.key))];
        if (keys.length) {
          console.warn(
            ` 🔧 「Force Client Settings」 — female_edition 범위만 런타임 무력화: ${keys.length}개 설정`,
            keys
          );
        }
      } else {
        console.error(
          ` ⚠ 「Force Client Settings」 — female_edition 범위 무력화 실패: ${FE_CG_FCS_RESULT.reason}`
        );
      }
    }

    // ── notifications (GM only — module management is GM-only) ──
    if (!game.user?.isGM) return;

    if (warnConflicts.length) {
      const list = warnConflicts.map((h) => `「${h.title}」`).join(", ");
      ui.notifications?.warn(
        `female_edition: 중복 충돌 모듈 ${warnConflicts.length}개 감지 — ${list}. ` +
          `female_edition이 동일 기능을 내장하므로 해당 원본 모듈을 비활성화하세요. (콘솔 F12 확인)`,
        { permanent: true }
      );
    }
    for (const { hit, result } of neutralized) {
      ui.notifications?.warn(
        `female_edition: 버려진 중복 모듈 「${hit.title}」 감지 — 라이브 무력화함` +
          `(훅 ${result.hookCount}개 제거). female_edition 내장 기능이 대체합니다.`
      );
    }
    for (const hit of yields) {
      ui.notifications?.warn(`female_edition: 「${hit.title}」 감지 — ${hit.detail}`);
    }
    if (FE_CG_FCS_RESULT?.active && FE_CG_FCS_RESULT.removed?.length) {
      const count = new Set(FE_CG_FCS_RESULT.removed.map((entry) => entry.key)).size;
      ui.notifications?.warn(
        `female_edition: 유지보수가 중단된 「Force Client Settings」의 ` +
          `female_edition 설정 강제 ${count}개를 이 세션에서 무력화했습니다.`
      );
    } else if (FE_CG_FCS_RESULT?.active && !FE_CG_FCS_RESULT.success) {
      ui.notifications?.error(
        `female_edition: Force Client Settings의 자체 설정 강제를 무력화하지 못했습니다. ` +
          `해당 모듈에서 female_edition 설정 잠금을 해제하세요. (콘솔 F12 확인)`,
        { permanent: true }
      );
    }
  } catch (err) {
    console.error("[female_edition] conflict-guard failed", err);
  }
});

// Pure/testable helpers exported for the Node unit tests under `ci/`. Foundry
// loads this file for its side effects only and ignores these named exports.
export {
  FE_CG_CONFLICTS,
  FE_CG_SELF_GUARD,
  feCgGenOf,
  feCgDeclaresForwardCompat,
  feCgIsNewerThanVerified,
  feCgOwnFeatureState,
  feCgExternalFeatureState,
  feCgAssessConflict,
  feCgPrepareRuntimePolicy,
  feCgStripHooks,
  feCgIsOwnSettingKey,
  feCgNeutralizeForceClientSettings,
};
