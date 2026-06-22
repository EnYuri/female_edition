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
 *     evidently being maintained, so we downgrade to a warning instead of
 *     killing it. (Curation can't be inferred from the manifest alone:
 *     narrator-tools/image-hover declare no maximum yet stopped at v13, while
 *     theatre caps at 13 — so the abandoned set is an explicit list here, not a
 *     version formula. The forward-compat gate only protects against a future
 *     revival.)
 *
 *   - mode "warn" (no spec) → a still-maintained duplicate; the GM is warned to
 *     disable the original (female_edition can't safely kill a live module).
 *
 *   - mode "yield" → female_edition turns its OWN feature off and lets the
 *     original run (chatlog-prune — other modules may depend on it; see
 *     fe-chat-prune.js). The GM is still informed.
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
 * runtime fix). Self-contained — no imports, no settings, no CSS.
 */

// Self-markers that must NEVER be stripped (protects female_edition's own code).
const FE_CG_SELF_GUARD = ["female_edition", "_FET_", "FemaleEdition"];

const FE_CG_CONFLICTS = [
  {
    id: "narrator-tools",
    feature: "내레이터 채널",
    detail: "내레이션 오버레이와 슬래시 명령이 이중으로 실행됩니다.",
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
    },
  },
  {
    id: "theatre",
    feature: "무대(극장) 채팅",
    detail: "채팅 스피커 라우팅이 정면 충돌합니다.",
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
    },
  },
  {
    id: "vino",
    feature: "시네마틱 채팅(vino)",
    detail: "오버레이/플래그 처리가 충돌하며, v9 API라 현재 코어에서 깨집니다.",
    neutralize: {
      verifiedVersion: "1.0.0",
      markers: ["VNOverlay", "_getMood", "vino-overlay", "flags.vino"],
      dom: ["#vino-overlay"],
    },
  },
  {
    id: "image-hover",
    feature: "토큰 이미지 호버",
    detail: "토큰 호버 HUD가 두 개 표시됩니다.",
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
    detail: "채팅을 입그림+메시지 창으로 표시하는 기능이 female_edition 무대(fe-theatre)와 겹칩니다. 둘 다 켜면 무대 발화가 이중 표시되고, /narrate 내레이션도 두 곳에 표시됩니다. 한쪽만 사용하세요.",
  },
  {
    id: "chatlog-prune",
    feature: "채팅 자동 정리",
    mode: "yield",
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
    detail: "female_edition이 타이핑 인디케이터를 끄고 이 모듈의 타이핑 알림에 양보했습니다.",
  },
  {
    // fe-combat-tracker.js ALREADY fully yields: feCtOriginalActive() returns true
    // when this module is active, so the internal combat tracker skips its own
    // install (no double tracker). This entry is purely informational — same yield
    // pattern as chatlog-prune. Carousel is actively maintained, so we never
    // neutralize it.
    id: "combat-tracker-dock",
    feature: "배틀 트래커",
    mode: "yield",
    detail: "female_edition이 내장 배틀 트래커를 끄고 이 모듈(Carousel Combat Tracker)에 양보했습니다.",
  },
];

// ── helpers ─────────────────────────────────────────────────────────────────

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
// so an abandoned-target neutralize should be downgraded to a warning.
function feCgDeclaresForwardCompat(mod) {
  const max = mod?.compatibility?.maximum ?? mod?.compatibleCoreVersion;
  const maxGen = feCgGenOf(max);
  return maxGen != null && maxGen > feCgCoreGen();
}

// Safety gate: true when the installed module is NEWER than the version this
// spec was written/verified against. The markers/DOM selectors are version-
// specific, so a newer target may have changed internals → skip neutralize and
// warn instead of risking a wrong/partial strip.
function feCgIsNewerThanVerified(mod, verifiedVersion) {
  if (!verifiedVersion) return false;
  const cur = String(mod?.version ?? "").replace(/^v/i, "");
  const ver = String(verifiedVersion).replace(/^v/i, "");
  try { return foundry.utils.isNewerVersion(cur, ver); } catch { return false; }
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
        if (id != null) { try { Hooks.off(name, id); ok = true; } catch { /* try fn */ } }
        if (!ok) { try { Hooks.off(name, fn); ok = true; } catch { /* no-op */ } }
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

  // Second pass: a target that (re)registers hooks or builds its overlay DOM in
  // its OWN ready/canvasReady — which may run AFTER our ready — would otherwise
  // slip past the immediate strip. Re-run once after the dust settles; report
  // only what the second pass actually caught (the synchronous console log below
  // already covered the first pass).
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

  return { hookCount, hooks, dom };
}

// ── main ──────────────────────────────────────────────────────────────────

Hooks.once("ready", () => {
  try {
    const active = FE_CG_CONFLICTS
      .map((c) => ({ ...c, mod: game.modules?.get?.(c.id) }))
      .filter((c) => c.mod?.active)
      .map((c) => ({ ...c, title: c.mod.title || c.id }));
    if (!active.length) return;

    const neutralized = []; // { hit, result }
    const warnConflicts = [];
    const yields = [];

    for (const hit of active) {
      if (hit.mode === "yield") { yields.push(hit); continue; }
      if (hit.neutralize) {
        // Abandoned target → neutralize, UNLESS a safety gate says it may be
        // maintained / changed: forward core-compat, or installed newer than
        // the version this spec was verified against. Then fall back to a warn.
        const fwd = feCgDeclaresForwardCompat(hit.mod);
        const newer = feCgIsNewerThanVerified(hit.mod, hit.neutralize.verifiedVersion);
        if (!fwd && !newer) {
          try {
            neutralized.push({ hit, result: feCgNeutralize(hit) });
          } catch (e) {
            console.error(`[female_edition] neutralize failed for ${hit.id}`, e);
            hit._skipReason = "무력화 실패(예외)";
            warnConflicts.push(hit);
          }
        } else {
          hit._skipReason = fwd
            ? "상위 코어 호환 선언 — 유지보수 중으로 판단"
            : `검증 버전(${hit.neutralize.verifiedVersion})보다 높음(현재 ${hit.mod.version}) — 마커 불일치 가능`;
          warnConflicts.push(hit);
        }
      } else {
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
  } catch (err) {
    console.error("[female_edition] conflict-guard failed", err);
  }
});

// Pure/testable helpers exported for the Node unit tests under `test/`. Foundry
// loads this file for its side effects only and ignores these named exports.
export {
  FE_CG_CONFLICTS,
  FE_CG_SELF_GUARD,
  feCgGenOf,
  feCgDeclaresForwardCompat,
  feCgIsNewerThanVerified,
  feCgStripHooks,
};
