/**
 * fe-combat-dock.js
 *
 * A lean, native combat tracker dock for female_edition — a top-of-screen strip
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
 * skips its own install entirely so there is never a double dock. The matching
 * informational entry lives in fe-conflict-guard.js (mode "yield").
 *
 * Self-contained except for constants. Own DOM (`#fe-combat-dock` on <body>) +
 * own CSS (styles/fe-combat-dock.css, unlayered — no system-layer conflict).
 */
import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

const CTD_ID = "combat-tracker-dock"; // original Carousel Combat Tracker — we yield to it
const DOCK_DOM_ID = "fe-combat-dock";

// ── settings access ─────────────────────────────────────────────────────────

function feCdSetting(key) {
  try { return game.settings.get(MODULE_ID, key); }
  catch { return FE_DEFAULTS[key]; }
}

function feCdEnabled() {
  return !!feCdSetting(S.COMBAT_DOCK_ENABLED);
}

// Yield: skip install when the original Carousel Combat Tracker is active.
function feCdOriginalActive() {
  return !!game.modules?.get?.(CTD_ID)?.active;
}

// ── data helpers ────────────────────────────────────────────────────────────

function feCdGetCombat() {
  return game.combat ?? game.combats?.active ?? null;
}

// Token disposition → frame color. Uses core's configured disposition colors when
// available (PIXI ints), falling back to fixed hex.
function feCdDispositionColor(combatant) {
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

// Resolve the portrait image per the COMBAT_DOCK_PORTRAIT_IMAGE setting.
function feCdPortraitImage(c) {
  const pref = feCdSetting(S.COMBAT_DOCK_PORTRAIT_IMAGE);
  const actorImg = c.actor?.img;
  const tokenImg = c.token?.texture?.src;
  const primary = pref === "token" ? tokenImg : actorImg;
  return primary || c.img || tokenImg || actorImg || "icons/svg/mystery-man.svg";
}

// Resolve an HP {value,max,pct,color} bar from an actor. Primary path is the
// dx3rd/dnd5e shared `system.attributes.hp`; falls back to `system.hp`.
function feCdResolveHp(actor) {
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

function feCdCombatHasActor(actor) {
  const combat = feCdGetCombat();
  if (!combat || !actor) return false;
  return combat.combatants?.some((c) => c.actor?.id === actor.id);
}

function feCdEsc(s) {
  const fn = foundry.utils?.escapeHTML;
  if (typeof fn === "function") return fn(String(s ?? ""));
  return String(s ?? "").replace(/[&<>"']/g, (ch) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch])
  );
}

function feCdL(key, fallback) {
  try {
    const v = game.i18n?.localize?.(key);
    return v && v !== key ? v : fallback;
  } catch { return fallback; }
}

// ── DOM build ───────────────────────────────────────────────────────────────

function feCdEnsureRoot() {
  let root = document.getElementById(DOCK_DOM_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = DOCK_DOM_ID;
    root.className = "fe-cd";
    document.body.appendChild(root);
    feCdBindRootEvents(root);
  }
  return root;
}

function feCdPortraitHTML(c, active) {
  const img = feCdPortraitImage(c);
  const name = feCdEsc(c.name);
  const init = c.initiative;
  const cls = ["fe-cd-portrait"];
  if (active) cls.push("is-active");
  if (c.isDefeated) cls.push("is-defeated");
  if (c.hidden) cls.push("is-hidden");

  // Disposition color tints the frame border — but the active highlight (accent)
  // must win, so only apply it to non-active portraits.
  let frameStyle = "";
  if (!active && feCdSetting(S.COMBAT_DOCK_SHOW_DISPOSITION)) {
    const dc = feCdDispositionColor(c);
    if (dc) frameStyle = ` style="border-color:${dc}"`;
  }

  const initBadge =
    feCdSetting(S.COMBAT_DOCK_SHOW_INITIATIVE) && init != null && init !== ""
      ? `<span class="fe-cd-init">${Math.round(Number(init))}</span>`
      : "";
  let hpBar = "";
  if (feCdSetting(S.COMBAT_DOCK_SHOW_HP)) {
    const hp = feCdResolveHp(c.actor);
    if (hp) {
      hpBar =
        `<div class="fe-cd-hp"><div class="fe-cd-hp-fill" ` +
        `style="width:${hp.pct}%;background:${hp.color}"></div></div>`;
    }
  }
  return (
    `<div class="${cls.join(" ")}" data-combatant-id="${c.id}" data-tooltip="${name}">` +
    `<div class="fe-cd-frame"${frameStyle}><img src="${feCdEsc(img)}" alt=""></div>` +
    `${initBadge}` +
    `<div class="fe-cd-name">${name}</div>` +
    `${hpBar}` +
    `</div>`
  );
}

function feCdControlsHTML(combat) {
  const round = combat.round ?? 0;
  const btn = (action, icon, label) =>
    `<button class="fe-cd-btn" data-cd-action="${action}" ` +
    `data-tooltip="${feCdEsc(label)}"><i class="fas ${icon}"></i></button>`;
  return (
    btn("prev-round", "fa-angles-left", feCdL("FECD.PrevRound", "이전 라운드")) +
    btn("prev-turn", "fa-angle-left", feCdL("FECD.PrevTurn", "이전 턴")) +
    `<span class="fe-cd-round">R${round}</span>` +
    btn("next-turn", "fa-angle-right", feCdL("FECD.NextTurn", "다음 턴")) +
    btn("next-round", "fa-angles-right", feCdL("FECD.NextRound", "다음 라운드"))
  );
}

// ── render ──────────────────────────────────────────────────────────────────

let _cdRaf = 0;
function feCdScheduleRender() {
  if (_cdRaf) return;
  _cdRaf = requestAnimationFrame(() => {
    _cdRaf = 0;
    feCdRender();
  });
}

function feCdRender() {
  if (!feCdEnabled() || feCdOriginalActive()) return;
  const root = document.getElementById(DOCK_DOM_ID);
  if (!root) return;

  const combat = feCdGetCombat();
  if (!combat || !combat.turns?.length) {
    root.classList.remove("fe-cd-active");
    root.innerHTML = "";
    return;
  }

  const isGM = !!game.user?.isGM;
  const size = Number(feCdSetting(S.COMBAT_DOCK_PORTRAIT_SIZE)) || 90;
  const aspect = Number(feCdSetting(S.COMBAT_DOCK_ASPECT)) || 1;
  const round = Number(feCdSetting(S.COMBAT_DOCK_ROUNDNESS)) || 0;
  root.style.setProperty("--fe-cd-size", `${size}px`);
  root.style.setProperty("--fe-cd-h", `${Math.round(size * aspect)}px`);
  root.style.setProperty("--fe-cd-round", `${round}px`);

  const align = String(feCdSetting(S.COMBAT_DOCK_ALIGNMENT) || "center");
  root.classList.remove("fe-cd-align-left", "fe-cd-align-center", "fe-cd-align-right");
  root.classList.add(`fe-cd-align-${["left", "center", "right"].includes(align) ? align : "center"}`);

  const hideDefeated = !!feCdSetting(S.COMBAT_DOCK_HIDE_DEFEATED);
  const combatants = combat.turns.filter(
    (c) => (isGM || !c.hidden) && !(hideDefeated && c.isDefeated)
  );
  const activeId = combat.combatant?.id;
  const portraits = combatants.map((c) => feCdPortraitHTML(c, c.id === activeId)).join("");

  const center = isGM
    ? `<div class="fe-cd-controlbar">${feCdControlsHTML(combat)}</div>`
    : `<div class="fe-cd-roundonly">R${combat.round ?? 0}</div>`;

  root.innerHTML =
    `<div class="fe-cd-inner">` +
    `<div class="fe-cd-combatants">${portraits}</div>` +
    `${center}` +
    `</div>`;
  root.classList.add("fe-cd-active");
}

// ── interaction ─────────────────────────────────────────────────────────────

function feCdBindRootEvents(root) {
  root.addEventListener("click", async (ev) => {
    const btn = ev.target.closest?.("[data-cd-action]");
    if (btn) {
      ev.preventDefault();
      await feCdHandleAction(btn.dataset.cdAction);
      return;
    }
    const port = ev.target.closest?.("[data-combatant-id]");
    if (port) feCdHandlePortraitClick(port.dataset.combatantId);
  });
  root.addEventListener("dblclick", (ev) => {
    const port = ev.target.closest?.("[data-combatant-id]");
    if (port) feCdHandlePortraitDblClick(port.dataset.combatantId);
  });
}

async function feCdHandleAction(action) {
  if (!game.user?.isGM) return;
  const combat = feCdGetCombat();
  if (!combat) return;
  try {
    switch (action) {
      case "prev-round": await combat.previousRound(); break;
      case "prev-turn":  await combat.previousTurn(); break;
      case "next-turn":  await combat.nextTurn(); break;
      case "next-round": await combat.nextRound(); break;
    }
  } catch (e) {
    console.error("[female_edition] combat-dock action failed", e);
  }
}

function feCdHandlePortraitClick(id) {
  const combat = feCdGetCombat();
  const c = combat?.combatants?.get(id);
  const token = c?.token?.object;
  if (!token) return;
  try {
    if (token.isOwner) token.control({ releaseOthers: true });
    canvas?.animatePan?.({ x: token.center.x, y: token.center.y, duration: 250 });
  } catch (e) {
    console.warn("[female_edition] combat-dock pan failed", e);
  }
}

function feCdHandlePortraitDblClick(id) {
  const combat = feCdGetCombat();
  const c = combat?.combatants?.get(id);
  try { c?.actor?.sheet?.render(true); } catch {}
}

// ── lifecycle ───────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_ENABLED, {
    name: "FECD.Settings.EnableName",
    hint: "FECD.Settings.EnableHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_DOCK_ENABLED],
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_PORTRAIT_SIZE, {
    name: "FECD.Settings.SizeName",
    hint: "FECD.Settings.SizeHint",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.COMBAT_DOCK_PORTRAIT_SIZE],
    range: { min: 48, max: 160, step: 4 },
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_ASPECT, {
    name: "FECD.Settings.AspectName",
    hint: "FECD.Settings.AspectHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      "1": "FECD.Settings.Aspect.Square",
      "1.5": "FECD.Settings.Aspect.Portrait",
      "2": "FECD.Settings.Aspect.Long",
    },
    default: FE_DEFAULTS[S.COMBAT_DOCK_ASPECT],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_ROUNDNESS, {
    name: "FECD.Settings.RoundnessName",
    hint: "FECD.Settings.RoundnessHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      "0": "FECD.Settings.Roundness.Sharp",
      "8": "FECD.Settings.Roundness.Soft",
      "16": "FECD.Settings.Roundness.Round",
    },
    default: FE_DEFAULTS[S.COMBAT_DOCK_ROUNDNESS],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_ALIGNMENT, {
    name: "FECD.Settings.AlignmentName",
    hint: "FECD.Settings.AlignmentHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      left: "FECD.Settings.Alignment.Left",
      center: "FECD.Settings.Alignment.Center",
      right: "FECD.Settings.Alignment.Right",
    },
    default: FE_DEFAULTS[S.COMBAT_DOCK_ALIGNMENT],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_PORTRAIT_IMAGE, {
    name: "FECD.Settings.ImageName",
    hint: "FECD.Settings.ImageHint",
    scope: "client",
    config: false,
    type: String,
    choices: {
      actor: "FECD.Settings.Image.Actor",
      token: "FECD.Settings.Image.Token",
    },
    default: FE_DEFAULTS[S.COMBAT_DOCK_PORTRAIT_IMAGE],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_SHOW_INITIATIVE, {
    name: "FECD.Settings.ShowInitName",
    hint: "FECD.Settings.ShowInitHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_DOCK_SHOW_INITIATIVE],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_SHOW_DISPOSITION, {
    name: "FECD.Settings.ShowDispName",
    hint: "FECD.Settings.ShowDispHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_DOCK_SHOW_DISPOSITION],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_HIDE_DEFEATED, {
    name: "FECD.Settings.HideDefeatedName",
    hint: "FECD.Settings.HideDefeatedHint",
    scope: "world",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_DOCK_HIDE_DEFEATED],
    onChange: () => feCdScheduleRender(),
  });
  game.settings.register(MODULE_ID, S.COMBAT_DOCK_SHOW_HP, {
    name: "FECD.Settings.ShowHpName",
    hint: "FECD.Settings.ShowHpHint",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.COMBAT_DOCK_SHOW_HP],
    onChange: () => feCdScheduleRender(),
  });
});

Hooks.once("ready", () => {
  if (!feCdEnabled()) return;
  if (feCdOriginalActive()) {
    console.warn(
      `[female_edition] combat-dock: 「Carousel Combat Tracker」(${CTD_ID}) 활성 — ` +
        `내장 전투 도크를 끄고 원본에 양보합니다.`
    );
    return;
  }
  feCdEnsureRoot();
  feCdRender();

  const rerender = () => feCdScheduleRender();
  Hooks.on("createCombat", rerender);
  Hooks.on("deleteCombat", rerender);
  Hooks.on("updateCombat", rerender); // turn / round changes
  Hooks.on("createCombatant", rerender);
  Hooks.on("deleteCombatant", rerender);
  Hooks.on("updateCombatant", rerender);
  Hooks.on("renderCombatTracker", rerender);
  Hooks.on("canvasReady", rerender);
  Hooks.on("updateActor", (actor) => { if (feCdCombatHasActor(actor)) feCdScheduleRender(); });
  Hooks.on("updateToken", () => feCdScheduleRender());
});

export { feCdResolveHp, feCdEnabled, feCdOriginalActive };
