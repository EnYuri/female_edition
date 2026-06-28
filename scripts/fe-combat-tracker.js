/**
 * fe-combat-tracker.js
 *
 * A lean, native combat tracker for female_edition — a top-of-screen strip
 * of combatant portraits (in turn order) with a centered GM control panel
 * (이전 라운드 / 이전 턴 / 일시정지 / 다음 턴 / 다음 라운드).
 *
 * Scope is deliberately a FOCUSED subset of theripper93's "Carousel Combat
 * Tracker" (`combat-tracker-dock`), NOT a clone: portrait strip + center GM
 * controls + per-combatant initiative/HP, themed natively (pixel/retro), Korean,
 * v13+v14, reading dx3rd/dnd5e HP at `system.attributes.hp`.
 *
 * CONFLICT HANDLING (per fe-conflict-guard.js philosophy): the original Carousel
 * Combat Tracker is an actively-MAINTAINED module, so female_edition does NOT
 * neutralize it — it YIELDS. When `combat-tracker-dock` is active, this feature
 * skips its own install entirely so there is never a double tracker. The matching
 * informational entry lives in fe-conflict-guard.js (mode "yield").
 *
 * Self-contained except for constants. Own DOM (`#fe-combat-tracker` on <body>) +
 * own CSS (styles/fe-combat-tracker.css, unlayered — no system-layer conflict).
 */
import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";
// 포트레이트는 거대한 원본을 작게 표시 → CSS image-rendering 으로는 고품질 축소가
// 불가능하다(fe-portrait-hq.js 주석 참고). 트래커 포트레이트(편집 불가 표시용 img)는
// 안전한 src 스왑 HQ 경로를 그대로 쓸 수 있어 안티에일리어싱이 살아난다.
import { feApplyHQPortrait } from "./fe-portrait-hq.js";

const CTD_ID = "combat-tracker-dock"; // original Carousel Combat Tracker — we yield to it
const TRACKER_DOM_ID = "fe-combat-tracker";

// 트래커 접힘(최소화) 상태 — 클라이언트 런타임 플래그(새로고침 시 초기화).
let _ctCollapsed = false;

// ── settings access ─────────────────────────────────────────────────────────

function feCtSetting(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch { return FE_DEFAULTS[key]; }
}

function feCtEnabled() {
  return !!feCtSetting(S.COMBAT_TRACKER_ENABLED);
}

// Yield: skip install when the original Carousel Combat Tracker is active.
function feCtOriginalActive() {
  return !!game.modules?.get?.(CTD_ID)?.active;
}

// ── data helpers ────────────────────────────────────────────────────────────

function feCtGetCombat() {
  // viewed 폴백: "전투 일시종료"(active:false)로 비활성화돼도 추적기에서 보이는 전투를
  // 계속 표시 → 트래커에서 바로 "재개"할 수 있다(비활성화 후 트래커가 사라지지 않도록).
  return game.combat ?? game.combats?.active ?? game.combats?.viewed ?? null;
}

// Token disposition → frame color. Uses core's configured disposition colors when
// available (PIXI ints), falling back to fixed hex.
function feCtDispositionColor(combatant) {
  const D = CONST?.TOKEN_DISPOSITIONS ?? {};
  const disp = combatant?.token?.disposition;
  if (disp == null) return null;
  const fallback = {
    [D.SECRET ?? -2]: "#9b59b6",
    [D.HOSTILE ?? -1]: "#e74c3c",
    [D.NEUTRAL ?? 0]: "#f1c40f",
    [D.FRIENDLY ?? 1]: "#2ecc71",
  };
  try {
    const dc = CONFIG?.Canvas?.dispositionColors;
    const map = {
      [D.SECRET ?? -2]: dc?.SECRET,
      [D.HOSTILE ?? -1]: dc?.HOSTILE,
      [D.NEUTRAL ?? 0]: dc?.NEUTRAL,
      [D.FRIENDLY ?? 1]: dc?.FRIENDLY,
    };
    const c = map[disp];
    if (c != null) {
      const hex = typeof c === "number" ? `#${c.toString(16).padStart(6, "0")}` : String(c);
      return hex;
    }
  } catch { /* fall through */ }
  return fallback[disp] ?? null;
}

// Resolve the portrait image per the COMBAT_TRACKER_PORTRAIT_IMAGE setting.
function feCtPortraitImage(c) {
  const pref = feCtSetting(S.COMBAT_TRACKER_PORTRAIT_IMAGE);
  const actorImg = c.actor?.img;
  const tokenImg = c.token?.texture?.src;
  const primary = pref === "token" ? tokenImg : actorImg;
  return primary || c.img || tokenImg || actorImg || "icons/svg/mystery-man.svg";
}

// Resolve an HP {value,max,pct,color} bar from an actor. Primary path is the
// dx3rd/dnd5e shared `system.attributes.hp`; falls back to `system.hp`.
function feCtResolveHp(actor) {
  if (!actor) return null;
  const sys = actor.system ?? {};
  const cand = sys?.attributes?.hp ?? sys?.hp ?? null;
  if (!cand) return null;
  const value = Number(cand.value);
  const max = Number(cand.max ?? cand.maxHP ?? 0);
  if (!Number.isFinite(value) || !Number.isFinite(max) || max <= 0) return null;
  const pct = Math.max(0, Math.min(100, (value / max) * 100));
  const color = pct > 50 ? "#2ecc71" : pct > 25 ? "#e67e22" : "#e74c3c";
  return { value, max, pct, color };
}

function feCtCombatHasActor(actor) {
  const combat = feCtGetCombat();
  if (!combat || !actor) return false;
  return combat.combatants?.some((c) => c.actor?.id === actor.id);
}

function feCtEsc(s) {
  const fn = foundry.utils?.escapeHTML;
  if (typeof fn === "function") return fn(String(s ?? ""));
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function feCtL(key, fallback) {
  try {
    const v = game.i18n?.localize?.(key);
    return v && v !== key ? v : fallback;
  } catch { return fallback; }
}

// ── DOM build ───────────────────────────────────────────────────────────────

function feCtEnsureRoot() {
  let root = document.getElementById(TRACKER_DOM_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = TRACKER_DOM_ID;
    root.className = "fe-ct";
    document.body.appendChild(root);
    feCtBindRootEvents(root);
  }
  return root;
}

function feCtPortraitHTML(c, active) {
  const img = feCtPortraitImage(c);
  const name = feCtEsc(c.name);
  const init = c.initiative;
  const cls = ["fe-ct-portrait"];
  if (active) cls.push("is-active");
  if (c.isDefeated) cls.push("is-defeated");
  if (c.hidden) cls.push("is-hidden");

  // Disposition color tints the frame border — but the active highlight (accent)
  // must win, so only apply it to non-active portraits. In the retro/pixel theme
  // the frame outline must follow the accent-tone (--fe-ac-*) override, so the
  // hard-coded disposition tint is suppressed there (CSS class wins).
  let frameStyle = "";
  const retro = document.body.classList.contains("fe-retro-theme");
  if (!active && !retro && feCtSetting(S.COMBAT_TRACKER_SHOW_DISPOSITION)) {
    const dc = feCtDispositionColor(c);
    if (dc) frameStyle = ` style="border-color:${dc}"`;
  }

  const initBadge =
    feCtSetting(S.COMBAT_TRACKER_SHOW_INITIATIVE) && init != null && init !== ""
      ? `<span class="fe-ct-init">${Math.round(Number(init))}</span>`
      : "";
  let hpBar = "";
  if (feCtSetting(S.COMBAT_TRACKER_SHOW_HP)) {
    const hp = feCtResolveHp(c.actor);
    if (hp) {
      hpBar =
        `<div class="fe-ct-hp"><div class="fe-ct-hp-fill" ` +
        `style="width:${hp.pct}%;background:${hp.color}"></div></div>`;
    }
  }
  return (
    `<div class="${cls.join(" ")}" data-combatant-id="${c.id}" data-tooltip="${name}">` +
    `<div class="fe-ct-frame"${frameStyle}>` +
      `<img src="${feCtEsc(img)}" data-fe-src="${feCtEsc(img)}" alt="">` +
    `</div>` +
    // name caption straddles the frame's bottom outline (sibling of the frame so
    // the frame's overflow:hidden — which clips the image — doesn't clip it)
    `<div class="fe-ct-name">${name}</div>` +
    `${initBadge}` +
    `${hpBar}` +
    `</div>`
  );
}

function feCtBtnHTML(action, icon, label) {
  return (
    `<button class="fe-ct-btn" data-ct-action="${action}" ` +
    `data-tooltip="${feCtEsc(label)}"><i class="fas ${icon}"></i></button>`
  );
}

function feCtCollapseBtnHTML() {
  // 트래커 UI 끄기/최소화 — GM·플레이어 공통(개인 UI 토글이므로 권한 무관).
  const label = _ctCollapsed
    ? feCtL("FECT.Expand", "배틀 트래커 펼치기")
    : feCtL("FECT.Collapse", "배틀 트래커 최소화");
  return feCtBtnHTML("toggle-collapse", _ctCollapsed ? "fa-window-maximize" : "fa-window-minimize", label);
}

function feCtControlsHTML(combat) {
  const round = combat.round ?? 0;
  const paused = combat.active === false;
  return (
    feCtBtnHTML("end-combat", "fa-flag-checkered", feCtL("FECT.EndCombat", "전투 종료")) +
    feCtBtnHTML(
      "toggle-active",
      paused ? "fa-play" : "fa-pause",
      paused
        ? feCtL("FECT.Resume", "전투 재개")
        : feCtL("FECT.Deactivate", "전투 일시종료 (인카운터 비활성화)")
    ) +
    feCtBtnHTML("prev-round", "fa-angles-left", feCtL("FECT.PrevRound", "이전 라운드")) +
    feCtBtnHTML("prev-turn", "fa-angle-left", feCtL("FECT.PrevTurn", "이전 턴")) +
    `<span class="fe-ct-round">R${round}</span>` +
    feCtBtnHTML("next-turn", "fa-angle-right", feCtL("FECT.NextTurn", "다음 턴")) +
    feCtBtnHTML("next-round", "fa-angles-right", feCtL("FECT.NextRound", "다음 라운드")) +
    feCtCollapseBtnHTML()
  );
}

// ── render ──────────────────────────────────────────────────────────────────

let _ctRaf = 0;
function feCtScheduleRender() {
  if (_ctRaf) return;
  _ctRaf = requestAnimationFrame(() => {
    _ctRaf = 0;
    feCtRender();
  });
}

function feCtRender() {
  if (!feCtEnabled() || feCtOriginalActive()) return;
  const root = document.getElementById(TRACKER_DOM_ID);
  if (!root) return;
  feCtCloseContextMenu(); // drop any open menu — its combatant may have changed

  const combat = feCtGetCombat();
  if (!combat || !combat.turns?.length) {
    root.classList.remove("fe-ct-active");
    root.innerHTML = "";
    return;
  }

  const isGM = !!game.user?.isGM;
  const size = Number(feCtSetting(S.COMBAT_TRACKER_PORTRAIT_SIZE)) || 90;
  const aspect = Number(feCtSetting(S.COMBAT_TRACKER_ASPECT)) || 1;
  const round = Number(feCtSetting(S.COMBAT_TRACKER_ROUNDNESS)) || 0;
  root.style.setProperty("--fe-ct-size", `${size}px`);
  root.style.setProperty("--fe-ct-h", `${Math.round(size * aspect)}px`);
  root.style.setProperty("--fe-ct-round", `${round}px`);

  const align = String(feCtSetting(S.COMBAT_TRACKER_ALIGNMENT) || "center");
  root.classList.remove("fe-ct-align-left", "fe-ct-align-center", "fe-ct-align-right");
  root.classList.add(`fe-ct-align-${["left", "center", "right"].includes(align) ? align : "center"}`);

  const hideDefeated = !!feCtSetting(S.COMBAT_TRACKER_HIDE_DEFEATED);
  const combatants = combat.turns.filter(
    (c) => (isGM || !c.hidden) && !(hideDefeated && c.isDefeated)
  );
  const activeId = combat.combatant?.id;
  const portraits = combatants.map((c) => feCtPortraitHTML(c, c.id === activeId)).join("");

  // 컨트롤 패널은 GM 전용. 단, 최소화 버튼만은 플레이어에게도 노출(개인 UI 토글).
  const center = isGM
    ? `<div class="fe-ct-controlbar">${feCtControlsHTML(combat)}</div>`
    : `<div class="fe-ct-controlbar fe-ct-controlbar-player">${feCtCollapseBtnHTML()}</div>`;

  // .fe-ct-combatants scrolls (overflow-x), so the retro pixel-border decoration
  // (an inset:-10px pseudo-element) would be clipped/scroll with it — wrap it in
  // a non-scrolling positioned wrapper that carries the border instead.
  root.innerHTML =
    `<div class="fe-ct-inner">` +
    `<div class="fe-ct-combatants-wrap"><div class="fe-ct-combatants">${portraits}</div></div>` +
    `${center}` +
    `</div>`;
  root.classList.add("fe-ct-active");
  root.classList.toggle("fe-ct-collapsed", _ctCollapsed);
  root.classList.toggle("fe-ct-paused", combat.active === false);

  // 포트레이트 고품질 다운스케일 — 표시 크기로 (size × size*aspect). 표시 전용 img라
  // src 스왑이 안전(편집 불가). 캐시 히트면 즉시 교체되어 깜박임 없음.
  const hpx = Math.round(size * aspect);
  root.querySelectorAll(".fe-ct-frame img").forEach((im) => {
    const src = im.dataset.feSrc;
    if (src) feApplyHQPortrait(im, src, size, hpx);
  });
}

// ── interaction ─────────────────────────────────────────────────────────────

function feCtBindRootEvents(root) {
  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-ct-action]");
    if (btn) {
      ev.preventDefault();
      await feCtHandleAction(btn.dataset.ctAction);
      return;
    }
    const port = ev.target.closest?.("[data-combatant-id]");
    if (port) feCtHandlePortraitClick(port.dataset.combatantId);
  });
  root.addEventListener("dblclick", (ev) => {
    const port = ev.target.closest?.("[data-combatant-id]");
    if (port) feCtHandlePortraitDblClick(port.dataset.combatantId);
  });
  // 우클릭 → 전투원 드롭다운 메뉴(GM 전용): 숨김/사망 토글, HP 조절, 순서 바꾸기.
  root.addEventListener("contextmenu", (ev) => {
    const port = ev.target.closest?.("[data-combatant-id]");
    if (!port) return;
    if (!game.user?.isGM) return; // players: leave the native right-click menu alone
    ev.preventDefault();
    feCtOpenContextMenu(port.dataset.combatantId, ev.clientX, ev.clientY);
  });
  // 마우스 휠로 포트레이트 스트립을 좌우 스크롤(세로 휠 → 가로 이동).
  root.addEventListener("wheel", (ev) => {
    const strip = ev.target.closest?.(".fe-ct-combatants");
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += ev.deltaY || ev.deltaX;
    ev.preventDefault();
  }, { passive: false });
}

async function feCtHandleAction(action) {
  // 최소화 토글은 권한 무관(개인 UI). GM 게이트보다 먼저 처리.
  if (action === "toggle-collapse") {
    _ctCollapsed = !_ctCollapsed;
    feCtScheduleRender(); // 버튼 아이콘/툴팁도 상태에 맞게 갱신
    return;
  }
  if (!game.user?.isGM) return;
  const combat = feCtGetCombat();
  if (!combat) return;
  try {
    switch (action) {
      case "prev-round": await combat.previousRound(); break;
      case "prev-turn":  await combat.previousTurn(); break;
      case "next-turn":  await combat.nextTurn(); break;
      case "next-round": await combat.nextRound(); break;
      case "end-combat": await combat.endCombat(); break;
      // 인카운터 활성/비활성 토글: 전투를 삭제하지 않고 일시정지/재개(네이티브 트래커와 동일 상태)
      case "toggle-active": await combat.update({ active: !combat.active }); break;
    }
  } catch (e) {
    console.error("[female_edition] combat-tracker action failed", e);
  }
}

function feCtHandlePortraitClick(id) {
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  const token = c?.token?.object;
  if (!token) return;
  try {
    if (token.isOwner) token.control({ releaseOthers: true });
    canvas?.animatePan?.({ x: token.center.x, y: token.center.y, duration: 250 });
  } catch (e) {
    console.warn("[female_edition] combat-tracker pan failed", e);
  }
}

function feCtHandlePortraitDblClick(id) {
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  try { c?.actor?.sheet?.render(true); } catch {}
}

// ── per-combatant context menu (GM only) ─────────────────────────────────────

const CTX_MENU_ID = "fe-ct-context-menu";

function feCtCtxOutside(ev) {
  if (!ev.target.closest?.(`#${CTX_MENU_ID}`)) feCtCloseContextMenu();
}

function feCtCloseContextMenu() {
  document.getElementById(CTX_MENU_ID)?.remove();
  document.removeEventListener("pointerdown", feCtCtxOutside, true);
  document.removeEventListener("contextmenu", feCtCtxOutside, true);
  window.removeEventListener("blur", feCtCloseContextMenu);
}

function feCtOpenContextMenu(id, x, y) {
  if (!game.user?.isGM) return;
  feCtCloseContextMenu();
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  if (!c) return;

  const items = [
    {
      action: "toggle-hidden",
      icon: c.hidden ? "fa-eye" : "fa-eye-slash",
      label: c.hidden ? feCtL("FECT.Ctx.Unhide", "숨김 해제") : feCtL("FECT.Ctx.Hide", "숨기기"),
    },
    {
      action: "toggle-defeated",
      icon: "fa-skull",
      label: c.isDefeated ? feCtL("FECT.Ctx.Revive", "사망 해제") : feCtL("FECT.Ctx.Defeat", "사망 표시"),
    },
    { action: "adjust-hp", icon: "fa-heart", label: feCtL("FECT.Ctx.AdjustHP", "HP 조절") },
    { action: "set-initiative", icon: "fa-dice-d20", label: feCtL("FECT.Ctx.SetInit", "이니셔티브 수정") },
    { action: "move-up", icon: "fa-arrow-up", label: feCtL("FECT.Ctx.MoveUp", "순서 위로") },
    { action: "move-down", icon: "fa-arrow-down", label: feCtL("FECT.Ctx.MoveDown", "순서 아래로") },
  ];

  const menu = document.createElement("div");
  menu.id = CTX_MENU_ID;
  menu.className = "fe-ct-context-menu";
  if (document.body.classList.contains("fe-retro-theme")) menu.classList.add("fe-retro-theme");
  menu.innerHTML = items
    .map(
      (it) =>
        `<button type="button" class="fe-ct-ctx-item" data-ct-ctx="${it.action}">` +
        `<i class="fas ${it.icon}"></i><span>${feCtEsc(it.label)}</span></button>`
    )
    .join("");
  document.body.appendChild(menu);

  // clamp to viewport
  const rect = menu.getBoundingClientRect();
  const px = Math.max(4, Math.min(x, window.innerWidth - rect.width - 4));
  const py = Math.max(4, Math.min(y, window.innerHeight - rect.height - 4));
  menu.style.left = `${px}px`;
  menu.style.top = `${py}px`;

  menu.addEventListener("click", async (ev) => {
    const b = ev.target.closest?.("[data-ct-ctx]");
    if (!b) return;
    ev.preventDefault();
    const act = b.dataset.ctCtx;
    feCtCloseContextMenu();
    await feCtHandleContextAction(act, id);
  });

  // defer outside-click binding so this very contextmenu event doesn't close it
  setTimeout(() => {
    document.addEventListener("pointerdown", feCtCtxOutside, true);
    document.addEventListener("contextmenu", feCtCtxOutside, true);
    window.addEventListener("blur", feCtCloseContextMenu);
  }, 0);
}

async function feCtHandleContextAction(action, id) {
  if (!game.user?.isGM) return;
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  if (!c) return;
  try {
    switch (action) {
      case "toggle-hidden":   await c.update({ hidden: !c.hidden }); break;
      case "toggle-defeated": {
        // mirror the native tracker: flip BOTH the combatant field and the
        // actor's DEFEATED status overlay, so isDefeated (field || status) is
        // consistent and the grayscale tracks correctly.
        const next = !c.isDefeated;
        await c.update({ defeated: next });
        const eff = CONFIG?.specialStatusEffects?.DEFEATED;
        if (eff && typeof c.actor?.toggleStatusEffect === "function") {
          try { await c.actor.toggleStatusEffect(eff, { active: next, overlay: true }); }
          catch (e) { console.warn("[female_edition] combat-tracker defeated status toggle failed", e); }
        }
        break;
      }
      case "adjust-hp":       await feCtOpenHpDialog(c); break;
      case "set-initiative":  await feCtOpenInitiativeDialog(combat, c); break;
      case "move-up":         await feCtMoveCombatant(combat, c, -1); break;
      case "move-down":       await feCtMoveCombatant(combat, c, +1); break;
    }
  } catch (e) {
    console.error("[female_edition] combat-tracker context action failed", e);
  }
}

async function feCtOpenHpDialog(c) {
  const actor = c.actor;
  if (!actor) {
    ui.notifications?.warn(feCtL("FECT.Ctx.NoActor", "연결된 액터가 없어 HP를 조절할 수 없습니다."));
    return;
  }
  const sys = actor.system ?? {};
  const hasAttr = !!sys?.attributes?.hp;
  const hasFlat = !!sys?.hp;
  if (!hasAttr && !hasFlat) {
    ui.notifications?.warn(feCtL("FECT.Ctx.NoHP", "이 액터에서 HP 경로를 찾을 수 없습니다."));
    return;
  }
  const path = hasAttr ? "system.attributes.hp.value" : "system.hp.value";
  const cur = Number(foundry.utils.getProperty(actor, path)) || 0;

  const DialogV2 = foundry.applications.api.DialogV2;
  const content =
    `<div class="fe-ct-hp-dialog" style="padding:6px 2px;display:flex;align-items:center;gap:8px;">` +
    `<label style="font-weight:bold;">HP</label>` +
    `<input type="number" name="hp" value="${cur}" step="1" autofocus ` +
    `style="flex:1;min-width:90px;"></div>`;
  let result;
  try {
    result = await DialogV2.prompt({
      window: { title: `${feCtL("FECT.Ctx.AdjustHP", "HP 조절")} — ${c.name}` },
      content,
      ok: {
        label: feCtL("FECT.Apply", "적용"),
        callback: (ev, btn) => btn.form.elements.hp.value,
      },
    });
  } catch {
    return; // dialog cancelled
  }
  if (result == null) return;
  const val = Number(result);
  if (!Number.isFinite(val)) return;
  await actor.update({ [path]: val });
}

// Edit a combatant's initiative value for the current encounter. We only write
// the one combatant's own `initiative` and let Foundry core re-sort — Combat#update
// calls `setupTurns()` which sorts `turns` by initiative DESC (core's own ordering).
// This is the safe approach: we never reorder/renumber other combatants ourselves.
async function feCtOpenInitiativeDialog(combat, c) {
  const cur = Number(c.initiative);
  const curStr = Number.isFinite(cur) ? String(cur) : "";

  const DialogV2 = foundry.applications.api.DialogV2;
  const content =
    `<div class="fe-ct-init-dialog" style="padding:6px 2px;display:flex;align-items:center;gap:8px;">` +
    `<label style="font-weight:bold;">${feCtEsc(feCtL("FECT.Ctx.Initiative", "이니셔티브"))}</label>` +
    `<input type="number" name="init" value="${feCtEsc(curStr)}" step="any" autofocus ` +
    `placeholder="${feCtEsc(feCtL("FECT.Ctx.InitEmpty", "비움 = 미설정"))}" ` +
    `style="flex:1;min-width:90px;"></div>`;
  let result;
  try {
    result = await DialogV2.prompt({
      window: { title: `${feCtL("FECT.Ctx.SetInit", "이니셔티브 수정")} — ${c.name}` },
      content,
      ok: {
        label: feCtL("FECT.Apply", "적용"),
        callback: (ev, btn) => btn.form.elements.init.value,
      },
    });
  } catch {
    return; // dialog cancelled
  }
  if (result == null) return;
  const raw = String(result).trim();
  // empty input → clear initiative (back to "unset"); core re-sorts unset to the bottom
  if (raw === "") {
    await c.update({ initiative: null });
    return;
  }
  const val = Number(raw);
  if (!Number.isFinite(val)) {
    ui.notifications?.warn(feCtL("FECT.Ctx.InitInvalid", "유효한 이니셔티브 값이 아닙니다."));
    return;
  }
  // write only this combatant's initiative — core's setupTurns() does the re-sort
  await c.update({ initiative: val });
}

// Reorder by ACTUALLY changing the moved combatant's own initiative (not a swap —
// a swap keeps the same numbers in the same slots, which reads as "position only").
// turns is sorted by initiative DESC, so dir<0 = move up = higher initiative.
async function feCtMoveCombatant(combat, c, dir) {
  const turns = combat.turns ?? [];
  const idx = turns.findIndex((t) => t.id === c.id);
  if (idx < 0) return;
  const j = idx + dir;
  if (j < 0 || j >= turns.length) return; // already at the edge

  const neighbor = turns[j];          // the combatant we're crossing
  const beyond = turns[j + dir];      // the one just past it (for a midpoint), may be undefined
  const nInit = Number(neighbor.initiative);
  if (!Number.isFinite(nInit)) {
    ui.notifications?.warn(feCtL("FECT.Ctx.NeedInit", "이니셔티브가 없는 전투원은 순서를 바꿀 수 없습니다."));
    return;
  }

  let newInit;
  const bInit = beyond != null ? Number(beyond.initiative) : NaN;
  if (Number.isFinite(bInit)) {
    // land strictly between the neighbor and the one beyond it
    newInit = (nInit + bInit) / 2;
  } else {
    // neighbor sits at the list edge → step past it (dir<0 = up = +1 higher)
    newInit = dir < 0 ? nInit + 1 : nInit - 1;
  }
  await c.update({ initiative: newInit });
}

// ── lifecycle ───────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_ENABLED, {
    name: "FECT.Settings.EnableName",
    hint: "FECT.Settings.EnableHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_TRACKER_ENABLED],
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_PORTRAIT_SIZE, {
    name: "FECT.Settings.SizeName",
    hint: "FECT.Settings.SizeHint",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.COMBAT_TRACKER_PORTRAIT_SIZE],
    range: { min: 48, max: 160, step: 4 },
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_ASPECT, {
    name: "FECT.Settings.AspectName",
    hint: "FECT.Settings.AspectHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      "1": "FECT.Settings.Aspect.Square",
      "1.5": "FECT.Settings.Aspect.Portrait",
      "2": "FECT.Settings.Aspect.Long",
    },
    default: FE_DEFAULTS[S.COMBAT_TRACKER_ASPECT],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_ROUNDNESS, {
    name: "FECT.Settings.RoundnessName",
    hint: "FECT.Settings.RoundnessHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      "0": "FECT.Settings.Roundness.Sharp",
      "8": "FECT.Settings.Roundness.Soft",
      "16": "FECT.Settings.Roundness.Round",
    },
    default: FE_DEFAULTS[S.COMBAT_TRACKER_ROUNDNESS],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_ALIGNMENT, {
    name: "FECT.Settings.AlignmentName",
    hint: "FECT.Settings.AlignmentHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      left: "FECT.Settings.Alignment.Left",
      center: "FECT.Settings.Alignment.Center",
      right: "FECT.Settings.Alignment.Right",
    },
    default: FE_DEFAULTS[S.COMBAT_TRACKER_ALIGNMENT],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_PORTRAIT_IMAGE, {
    name: "FECT.Settings.ImageName",
    hint: "FECT.Settings.ImageHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      actor: "FECT.Settings.Image.Actor",
      token: "FECT.Settings.Image.Token",
    },
    default: FE_DEFAULTS[S.COMBAT_TRACKER_PORTRAIT_IMAGE],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_SHOW_INITIATIVE, {
    name: "FECT.Settings.ShowInitName",
    hint: "FECT.Settings.ShowInitHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_TRACKER_SHOW_INITIATIVE],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_SHOW_DISPOSITION, {
    name: "FECT.Settings.ShowDispName",
    hint: "FECT.Settings.ShowDispHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_TRACKER_SHOW_DISPOSITION],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_HIDE_DEFEATED, {
    name: "FECT.Settings.HideDefeatedName",
    hint: "FECT.Settings.HideDefeatedHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_TRACKER_HIDE_DEFEATED],
    onChange: () => feCtScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_TRACKER_SHOW_HP, {
    name: "FECT.Settings.ShowHpName",
    hint: "FECT.Settings.ShowHpHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_TRACKER_SHOW_HP],
    onChange: () => feCtScheduleRender(),
  });
});

Hooks.once("ready", () => {
  if (!feCtEnabled()) return;
  if (feCtOriginalActive()) {
    console.warn(
      `[female_edition] combat-tracker: 「Carousel Combat Tracker」(${CTD_ID}) 활성 — ` +
        `내장 배틀 트래커를 끄고 원본에 양보합니다.`
    );
    return;
  }
  feCtEnsureRoot();
  feCtRender();

  const rerender = () => feCtScheduleRender();
  Hooks.on("createCombat", rerender);
  Hooks.on("deleteCombat", rerender);
  Hooks.on("updateCombat", rerender); // turn / round changes
  Hooks.on("createCombatant", rerender);
  Hooks.on("deleteCombatant", rerender);
  Hooks.on("updateCombatant", rerender);
  Hooks.on("renderCombatTracker", rerender);
  Hooks.on("canvasReady", rerender);
  Hooks.on("updateActor", (actor) => { if (feCtCombatHasActor(actor)) feCtScheduleRender(); });
  Hooks.on("updateToken", () => feCtScheduleRender());
});

export { feCtResolveHp, feCtEnabled, feCtOriginalActive };
