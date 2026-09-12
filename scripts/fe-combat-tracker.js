import { feRegisterSetting } from "./fe-settings-data.js";
/**
 * fe-combat-tracker.js
 *
 * A lean, native combat tracker for female_edition — a top-of-screen strip
 * of combatant portraits (in turn order) with a centered GM control panel
 * (previous round / previous turn / pause / next turn / next round).
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
import { MODULE_ID, S, FE_DEFAULTS, feIsDx3rdSystemId } from "./fe-constants.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";
// Tracker portraits shrink huge sources, which CSS image-rendering cannot do well (see
// fe-portrait-hq.js). They are display-only, non-editable images, so the safe src-swap HQ
// path applies.
import { feApplyHQPortrait } from "./fe-portrait-hq.js";

const CTD_ID = "combat-tracker-dock"; // original Carousel Combat Tracker — we yield to it
const TRACKER_DOM_ID = "fe-combat-tracker";
const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const CT_SOCKET_END_TURN = "feCombatTrackerEndTurn";

// Collapsed (minimized) state — a client runtime flag, reset on reload.
let _ctCollapsed = false;

// Entrance animation ("위에서 부드럽게 내려와 정지"). Must be per-combatant and
// TIME-BASED, not a plain CSS class: feCtRender rebuilds the strip with innerHTML on
// every combat/actor/token hook, so a freshly-created node would replay (or, once the
// id is known, abruptly lose) its animation on any unrelated update mid-flight.
// _ctEnterStart remembers WHEN each combatant's animation began; a re-render hands the
// node a negative `animation-delay` so it resumes exactly where it was.
//
// It is deliberately split in two, because `.fe-ct-combatants` is `overflow-y: hidden`
// (it must be — the strip's scrollbar is flipped to the top): a portrait animated with a
// vertical travel INSIDE the strip would simply be clipped and never seen. So the
// "위에서 내려온다" travel is played by the whole bar (`.fe-ct-inner`, which nothing
// clips), while individual portraits fade/scale in place with a stagger.
const CT_ENTER_MS = 420;
const CT_ENTER_STAGGER_MS = 55;
const CT_BAR_ENTER_MS = 520;
const _ctEnterStart = new Map(); // combatantId -> performance.now() timestamp
let _ctBarEnterStart = 0;        // 0 = tracker is not on screen; set when it appears

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

// DX3rd replaces Combat#nextTurn with its action-end/action-delay workflow.
// That workflow must start in the acting player's browser: it opens a local
// choice dialog, updates their owned Actor, then asks DX3rd's own GM socket
// handler to continue the initiative process. Running it through our GM proxy
// would put the choice dialog on the GM's screen instead.
function feCtUsesLocalPlayerTurnEndWorkflow() {
  return feIsDx3rdSystemId(game.system?.id);
}

// ── data helpers ────────────────────────────────────────────────────────────

function feCtGetCombat() {
  // The `viewed` fallback keeps a deactivated encounter (active:false) on screen so it can
  // be resumed straight from the tracker instead of the tracker vanishing.
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

function feCtActiveGm() {
  return game.users?.activeGM ?? game.users?.find?.((u) => u.active && u.isGM) ?? null;
}

function feCtIsPrimaryGm() {
  const gm = feCtActiveGm();
  return !!game.user?.isGM && (!gm || gm.id === game.user.id);
}

function feCtUserOwnsCombatant(combatant, user = game.user) {
  if (!combatant || !user) return false;
  if (user.isGM) return true;
  try {
    if (typeof combatant.testUserPermission === "function") {
      return !!combatant.testUserPermission(user, "OWNER");
    }
  } catch { /* fall through */ }
  try { return !!combatant.actor?.testUserPermission?.(user, "OWNER"); }
  catch { return false; }
}

function feCtCanEndTurnForCombatant(combat, combatant, user = game.user) {
  if (!combat || !combatant) return false;
  if (!feCtUserOwnsCombatant(combatant, user)) return false;
  return combat.combatant?.id === combatant.id;
}

// ── initiative rolling ──────────────────────────────────────────────────────
//
// Rolling goes through `combat.rollInitiative([id])` — core's own path — for a
// deliberate reason: on dnd5e that method builds the roll from
// `Actor5e#getInitiativeRoll()`, i.e. the actor sheet's OWN advantage/disadvantage
// fields, and evaluates it directly. The 유리/불리 prompt the user sees in the
// native encounter tab comes from the OTHER dnd5e entry point
// (`actor.rollInitiativeDialog()`, combat-tracker action "rollInitiative"), which
// we intentionally never call — rolling from this tracker must be one click.
// For the same reason no `{event}` is forwarded: dnd5e reads keyboard modifiers
// off it to flip advantage.

// In-flight guard. The rollable test reads the LIVE `initiative`, which is still null
// until the roll's update round-trips — so a double-click (or an impatient second click
// on 전체 굴림) would pass the guard twice and roll the same combatant twice before the
// first call resolves. dblclick on the d20 is already ignored for opening the sheet, but
// a dblclick still delivers TWO click events, so this has to be handled here.
const _ctRollingIds = new Set();
let _ctRollingAll = false;

function feCtNeedsInitiative(c) {
  return !!c && (c.initiative === null || c.initiative === undefined);
}

// A combatant is rollable by this user when it has no initiative yet and the user
// owns it (GM owns everything). Core's rollInitiative skips non-owners anyway, so
// this only decides whether the affordance is drawn.
function feCtCanRollInitiative(c, user = game.user) {
  if (!feCtNeedsInitiative(c) || _ctRollingIds.has(c.id)) return false;
  return feCtUserOwnsCombatant(c, user);
}

// Does the current user have anything left to roll in this encounter?
function feCtHasUnrolledCombatants(combat) {
  return !!combat?.turns?.some((c) => feCtCanRollInitiative(c));
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
    // No base class: every rule in fe-combat-tracker.css is anchored on the id
    // (`#fe-combat-tracker…`). The state classes added later (fe-ct-active,
    // fe-ct-align-*, fe-ct-collapsed, fe-ct-paused) are set with classList, and
    // this assignment runs only on first creation, so it never clobbers them.
    root.id = TRACKER_DOM_ID;
    document.body.appendChild(root);
    feCtBindRootEvents(root);
  }
  return root;
}

function feCtPortraitHTML(c, active, canEndTurn, enterDelay = null) {
  const img = feCtPortraitImage(c);
  const name = feCtEsc(c.name);
  const init = c.initiative;
  const cls = ["fe-ct-portrait"];
  if (active) cls.push("is-active");
  if (enterDelay != null) cls.push("is-entering");
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
  // Hover ">>" end-turn marker. Rendered only for the active combatant, and only for a user
  // allowed to end that combatant's turn (GM: all, player: owned). It is a large glowing
  // glyph centred on the portrait with no background fill; the container is
  // pointer-events:none so selection/panning/double-click outside the glyph still work —
  // the glyph itself is the click target. Both an fa icon and a plain ">>" are emitted so
  // the retro theme can swap to the pixel font via CSS.
  const endTurnBtn = canEndTurn
    ? `<div class="fe-ct-endturn">` +
        `<i class="fas fa-angles-right fe-ct-endturn-icon" data-ct-endturn="1" ` +
          `data-tooltip="${feCtEsc(feCtL("FECT.Ctx.EndTurn", "턴 종료"))}"></i>` +
        `<span class="fe-ct-endturn-px" data-ct-endturn="1" ` +
          `data-tooltip="${feCtEsc(feCtL("FECT.Ctx.EndTurn", "턴 종료"))}">&gt;&gt;</span>` +
      `</div>`
    : "";

  // Roll-initiative affordance: a d20 centred on the portrait, drawn only when this
  // combatant has NO initiative yet and the viewer owns it. Suppressed while the
  // end-turn ">>" is showing so the two never overlap on one portrait.
  const rollInitBtn =
    !canEndTurn && feCtCanRollInitiative(c)
      ? `<div class="fe-ct-rollinit">` +
          // `far` (regular) = the outline d20 — the same icon Carousel Combat Tracker
          // uses (`scripts/systems.js` default `rollIcon: "far fa-dice-d20"`). Foundry
          // bundles Font Awesome PRO webfonts (fa-regular-400.woff2 is present), so the
          // regular weight really renders instead of falling back to solid.
          `<i class="far fa-dice-d20" data-ct-rollinit="1" ` +
            `data-tooltip="${feCtEsc(feCtL("FECT.Ctx.RollInit", "이니셔티브 굴리기"))}"></i>` +
        `</div>`
      : "";

  const enterStyle = enterDelay != null ? ` style="animation-delay:${Math.round(enterDelay)}ms"` : "";
  return (
    `<div class="${cls.join(" ")}" data-combatant-id="${c.id}" data-tooltip="${name}"${enterStyle}>` +
    `<div class="fe-ct-frame"${frameStyle}>` +
      `<img src="${feCtEsc(img)}" data-fe-src="${feCtEsc(img)}" alt="">` +
    `</div>` +
    // name caption straddles the frame's bottom outline (sibling of the frame so
    // the frame's overflow:hidden — which clips the image — doesn't clip it)
    `<div class="fe-ct-name">${name}</div>` +
    `${initBadge}` +
    `${hpBar}` +
    `${endTurnBtn}` +
    `${rollInitBtn}` +
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
  // Collapse/minimize is a personal UI toggle, so it is offered to GMs and players alike.
  const label = _ctCollapsed
    ? feCtL("FECT.Expand", "컴뱃 트래커 펼치기")
    : feCtL("FECT.Collapse", "컴뱃 트래커 최소화");
  return feCtBtnHTML("toggle-collapse", _ctCollapsed ? "fa-window-maximize" : "fa-window-minimize", label);
}

function feCtControlsHTML(combat) {
  const round = combat.round ?? 0;
  const paused = combat.active === false;
  const started = Number(round) > 0;
  const startButton = started
    ? ""
    : feCtBtnHTML("start-combat", "fa-circle-play", feCtL("FECT.StartCombat", "전투 개시"));
  // Shown only while somebody still needs a roll — same self-explanatory pattern as
  // 전투 개시 (which disappears once the encounter has started).
  const rollAllButton = feCtHasUnrolledCombatants(combat)
    ? feCtBtnHTML("roll-all", "fa-dice-d20", feCtL("FECT.RollAll", "이니셔티브 전체 굴림"))
    : "";
  return (
    rollAllButton +
    startButton +
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

/**
 * Remove every trace of the tracker from the screen.
 *
 * `feCtRender` bails on `!feCtEnabled()` BEFORE it touches the DOM, so turning the
 * feature off only stops repainting — whatever was last drawn stays on screen forever.
 * The root is appended to `document.body` (feCtEnsureRoot), i.e. it survives scene
 * changes and sidebar re-renders on its own; nothing else would ever collect it.
 *
 * Teardown is enough to make "off" complete WITHOUT a reload: the hooks registered at
 * `ready` all funnel into `feCtRender`, which stands down on its own gate, and
 * `feCtOnSocket` is likewise inert while disabled. Turning it back ON is the direction
 * that genuinely needs a reload (the `ready` block never ran), which is why
 * S.COMBAT_TRACKER_ENABLED is in the settings menu's FE_RELOAD_REQUIRED_KEYS.
 *
 * `feCtCloseContextMenu` is what drops the menu's document/window listeners, so it must
 * run here and not just `.remove()` the node.
 */
function feCtTeardown() {
  if (_ctRaf) { cancelAnimationFrame(_ctRaf); _ctRaf = 0; }
  feCtCloseContextMenu();
  document.getElementById(TRACKER_DOM_ID)?.remove();
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
    // Tracker left the screen — the next encounter drops in fresh.
    _ctBarEnterStart = 0;
    _ctEnterStart.clear();
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
  // Entrance animation timing. A combatant seen for the first time gets a start stamp
  // staggered behind the other newcomers in this same pass (so a whole encounter cascades
  // in), and every render passes the REMAINING delay: positive = not started yet,
  // negative = resume mid-flight, past the window = no class at all.
  const nowMs = performance.now();
  if (!_ctBarEnterStart) _ctBarEnterStart = nowMs;
  const barDelay = _ctBarEnterStart - nowMs;
  const barEntering = barDelay > -CT_BAR_ENTER_MS;
  let newcomers = 0;
  const portraits = combatants
    .map((c) => {
      const isActive = c.id === activeId;
      // ">>" only on the active combatant, and only for a user allowed to end that turn
      const canEndTurn = isActive && feCtCanEndTurnForCombatant(combat, c);
      let start = _ctEnterStart.get(c.id);
      if (start === undefined) {
        start = nowMs + newcomers * CT_ENTER_STAGGER_MS;
        newcomers += 1;
        _ctEnterStart.set(c.id, start);
      }
      const delay = start - nowMs;
      return feCtPortraitHTML(c, isActive, canEndTurn, delay > -CT_ENTER_MS ? delay : null);
    })
    .join("");
  // Drop stamps for combatants that are gone, so a re-added one animates in again.
  const liveIds = new Set(combatants.map((c) => c.id));
  for (const id of [..._ctEnterStart.keys()]) if (!liveIds.has(id)) _ctEnterStart.delete(id);

  // The control panel is GM-only; the collapse button alone is also shown to players.
  const center = isGM
    ? `<div class="fe-ct-controlbar">${feCtControlsHTML(combat)}</div>`
    : `<div class="fe-ct-controlbar fe-ct-controlbar-player">${feCtCollapseBtnHTML()}</div>`;

  // .fe-ct-combatants scrolls (overflow-x), so the retro pixel-border decoration
  // (an inset:-10px pseudo-element) would be clipped/scroll with it — wrap it in
  // a non-scrolling positioned wrapper that carries the border instead.
  const innerAttrs = barEntering
    ? ` class="fe-ct-inner is-entering" style="animation-delay:${Math.round(barDelay)}ms"`
    : ` class="fe-ct-inner"`;
  root.innerHTML =
    `<div${innerAttrs}>` +
    `<div class="fe-ct-combatants-wrap"><div class="fe-ct-combatants">${portraits}</div></div>` +
    `${center}` +
    `</div>`;
  root.classList.add("fe-ct-active");
  root.classList.toggle("fe-ct-collapsed", _ctCollapsed);
  root.classList.toggle("fe-ct-paused", combat.active === false);

  // HQ downscale to the display size (size x size*aspect). These are display-only images,
  // so the src swap is safe; a cache hit applies synchronously with no flicker.
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
    // The hover ">>" button ends the turn immediately, ahead of portrait select/pan.
    const endBtn = ev.target.closest?.("[data-ct-endturn]");
    if (endBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const port = endBtn.closest?.("[data-combatant-id]");
      if (port) await feCtHandleEndTurnClick(port.dataset.combatantId);
      return;
    }
    // The d20 overlay rolls initiative, ahead of portrait select/pan.
    const rollBtn = ev.target.closest?.("[data-ct-rollinit]");
    if (rollBtn) {
      ev.preventDefault();
      ev.stopPropagation();
      const p = rollBtn.closest?.("[data-combatant-id]");
      if (p) await feCtRollInitiativeFor(p.dataset.combatantId);
      return;
    }
    const port = ev.target.closest?.("[data-combatant-id]");
    if (port) feCtHandlePortraitClick(port.dataset.combatantId);
  });
  root.addEventListener("dblclick", (ev) => {
    // Double-clicking the ">>" / d20 button must not open the sheet — one click already acted.
    if (ev.target.closest?.("[data-ct-endturn]")) return;
    if (ev.target.closest?.("[data-ct-rollinit]")) return;
    const port = ev.target.closest?.("[data-combatant-id]");
    if (port) feCtHandlePortraitDblClick(port.dataset.combatantId);
  });
  // Right-click opens the combatant menu: full management for a GM, only "end turn" on an
  // owned combatant for a player.
  root.addEventListener("contextmenu", (ev) => {
    const port = ev.target.closest?.("[data-combatant-id]");
    if (!port) return;
    const combat = feCtGetCombat();
    const c = combat?.combatants?.get(port.dataset.combatantId);
    if (!c || (!game.user?.isGM && !feCtUserOwnsCombatant(c))) return;
    ev.preventDefault();
    feCtOpenContextMenu(port.dataset.combatantId, ev.clientX, ev.clientY);
  });
  // Wheel scrolls the portrait strip horizontally (vertical wheel → horizontal move).
  root.addEventListener("wheel", (ev) => {
    const strip = ev.target.closest?.(".fe-ct-combatants");
    if (!strip || strip.scrollWidth <= strip.clientWidth) return;
    strip.scrollLeft += ev.deltaY || ev.deltaX;
    ev.preventDefault();
  }, { passive: false });
}

async function feCtHandleAction(action) {
  // The collapse toggle is personal UI, so handle it before the GM gate.
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
      case "start-combat": {
        if (combat.round > 0) {
          if (combat.active === false) await (combat.activate?.() ?? combat.update({ active: true }));
          break;
        }
        if (combat.active === false) await (combat.activate?.() ?? combat.update({ active: true }));
        if (typeof combat.startCombat === "function") await combat.startCombat();
        else await combat.update({ round: 1, turn: 0 });
        break;
      }
      case "end-combat": await combat.endCombat(); break;
      // Core's rollAll() already filters to owned combatants whose initiative is null,
      // and on dnd5e it routes through Combat#rollInitiative → no 유리/불리 dialog.
      case "roll-all": {
        if (_ctRollingAll) break;
        if (!feCtHasUnrolledCombatants(combat)) {
          ui.notifications?.info(feCtL("FECT.NothingToRoll", "이니셔티브를 굴릴 전투원이 없습니다."));
          break;
        }
        _ctRollingAll = true;
        try { await combat.rollAll(); }
        finally { _ctRollingAll = false; feCtScheduleRender(); }
        break;
      }
      // Pause/resume the encounter without deleting it (same state the native tracker uses)
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

// Hover ">>" click → end turn, through exactly the same path as the context-menu entry:
// permission check, then GM handles it directly while a player proxies over the socket.
async function feCtHandleEndTurnClick(id) {
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  if (!combat || !c) return;
  try {
    await feCtRequestEndTurn(combat, c);
  } catch (e) {
    console.error("[female_edition] combat-tracker end-turn (>>) failed", e);
  }
}

// Portrait d20 click → roll this one combatant's initiative. Players roll their own:
// core's Combat#rollInitiative writes through updateEmbeddedDocuments, which a combatant
// OWNER is allowed to do, so no GM socket proxy is needed (unlike ending a turn, which
// mutates the Combat document itself).
async function feCtRollInitiativeFor(id) {
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  if (!combat || !c) return;
  if (!feCtCanRollInitiative(c)) return;
  _ctRollingIds.add(c.id);
  try {
    await combat.rollInitiative([c.id]);
  } catch (e) {
    console.error("[female_edition] combat-tracker roll initiative failed", e);
  } finally {
    _ctRollingIds.delete(c.id);
    // The updateCombatant hook normally repaints, but a failed/no-op roll fires nothing —
    // repaint anyway so the d20 comes back instead of staying silently hidden.
    feCtScheduleRender();
  }
}

// ── per-combatant context menu ───────────────────────────────────────────────

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
  feCtCloseContextMenu();
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  if (!c) return;
  const isGM = !!game.user?.isGM;
  const isOwner = feCtUserOwnsCombatant(c);
  if (!isGM && !isOwner) return;

  const items = [
    {
      action: "end-turn",
      icon: "fa-hourglass-end",
      label: feCtL("FECT.Ctx.EndTurn", "턴 종료"),
      disabled: !feCtCanEndTurnForCombatant(combat, c),
    },
  ];

  if (isGM) items.push(
    {
      action: "open-sheet",
      icon: "fa-edit",
      label: feCtL("FECT.Ctx.OpenSheet", "전투원 설정"),
    },
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
    { action: "reroll-initiative", icon: "fa-dice", label: feCtL("FECT.Ctx.Reroll", "이니셔티브 재굴림") },
    { action: "move-up", icon: "fa-arrow-up", label: feCtL("FECT.Ctx.MoveUp", "순서 위로") },
    { action: "move-down", icon: "fa-arrow-down", label: feCtL("FECT.Ctx.MoveDown", "순서 아래로") },
  );

  // Mirrors core's `visible` conditions (combat-tracker.mjs#_getEntryContextOptions):
  // reset only when an initiative is actually set, movement history only when it exists.
  // `clearMovementHistory` is v14-only — v13 combatants have no movement history at all.
  if (isGM && Number.isFinite(c.initiative)) {
    items.push({
      action: "clear-initiative",
      icon: "fa-arrow-rotate-left",
      label: feCtL("FECT.Ctx.ClearInit", "이니셔티브 초기화"),
    });
  }
  if (isGM && typeof c.clearMovementHistory === "function" && (c.token?.movementHistory?.length > 0)) {
    items.push({
      action: "clear-movement",
      icon: "fa-shoe-prints",
      label: feCtL("FECT.Ctx.ClearMovement", "이동 기록 초기화"),
    });
  }

  if (isGM) items.push({
    action: "remove-combatant",
    icon: "fa-trash",
    label: feCtL("FECT.Ctx.Remove", "전투원 제거"),
    danger: true,
  });

  const menu = document.createElement("div");
  menu.id = CTX_MENU_ID;
  menu.className = "fe-ct-context-menu";
  if (document.body.classList.contains("fe-retro-theme")) menu.classList.add("fe-retro-theme");
  menu.innerHTML = items
    .map(
      (it) =>
        `<button type="button" class="fe-ct-ctx-item${it.disabled ? " is-disabled" : ""}` +
        `${it.danger ? " is-danger" : ""}" ` +
        `data-ct-ctx="${it.action}" ${it.disabled ? "disabled" : ""}>` +
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
  const combat = feCtGetCombat();
  const c = combat?.combatants?.get(id);
  if (!c) return;
  try {
    if (action === "end-turn") {
      await feCtRequestEndTurn(combat, c);
      return;
    }
    if (!game.user?.isGM) return;
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
      case "open-sheet":      c.sheet?.render({ force: true }); break;
      case "adjust-hp":       await feCtOpenHpDialog(c); break;
      case "set-initiative":  await feCtOpenInitiativeDialog(combat, c); break;
      case "reroll-initiative": await combat.rollInitiative([c.id]); break;
      case "clear-initiative":  await c.update({ initiative: null }); break;
      case "clear-movement": {
        if (typeof c.clearMovementHistory !== "function") break;
        await c.clearMovementHistory();
        ui.notifications?.info(`${c.name}의 이동 기록을 초기화했습니다.`);
        break;
      }
      case "move-up":         await feCtMoveCombatant(combat, c, -1); break;
      case "move-down":       await feCtMoveCombatant(combat, c, +1); break;
      case "remove-combatant": await feCtRemoveCombatant(c); break;
    }
  } catch (e) {
    console.error("[female_edition] combat-tracker context action failed", e);
  }
}

async function feCtRequestEndTurn(combat, c) {
  if (!feCtCanEndTurnForCombatant(combat, c)) {
    const msg = combat?.combatant?.id === c?.id
      ? feCtL("FECT.Ctx.NoTurnPermission", "이 전투원의 턴을 종료할 권한이 없습니다.")
      : feCtL("FECT.Ctx.NotCurrentTurn", "현재 턴인 전투원만 턴을 종료할 수 있습니다.");
    ui.notifications?.warn(msg);
    return;
  }

  const payload = {
    type: CT_SOCKET_END_TURN,
    combatId: combat.id,
    combatantId: c.id,
    requesterId: game.user.id,
  };

  if (game.user?.isGM) {
    await feCtApplyEndTurn(payload, game.user);
    return;
  }

  // DX3rd's nextTurn is deliberately a player-facing action-end workflow, not
  // a direct Combat update. Let the owning player invoke it locally so its
  // dialog and follow-up system socket run on the intended client.
  if (feCtUsesLocalPlayerTurnEndWorkflow()) {
    await combat.nextTurn();
    return;
  }

  if (!feCtActiveGm()) {
    ui.notifications?.warn(feCtL("FECT.Ctx.NoGM", "GM이 접속해 있지 않아 턴을 종료할 수 없습니다."));
    return;
  }
  game.socket.emit(SOCKET_CHANNEL, payload);
}

async function feCtApplyEndTurn(data, requester) {
  if (!requester) return;
  const combat = game.combats?.get?.(data.combatId) ?? null;
  const c = combat?.combatants?.get?.(data.combatantId) ?? null;
  if (!feCtCanEndTurnForCombatant(combat, c, requester)) return;
  await combat.nextTurn();
}

function feCtOnSocket(data, senderId) {
  if (data?.type !== CT_SOCKET_END_TURN) return;
  // The setting is world-scope, so a request arriving while it is off means a client
  // that has not reloaded yet. The GM is the one who advances the turn, so this is
  // where it has to stop (same shape as onPanelSocket in fe-screen-panel.js).
  if (!feCtEnabled()) return;
  if (!feCtIsPrimaryGm()) return;
  const requester = feResolveSocketSender(senderId, data.requesterId, "combat-tracker");
  if (!requester) return;
  feCtApplyEndTurn(data, requester).catch((e) => {
    console.error("[female_edition] combat-tracker end-turn request failed", e);
  });
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

// Remove a combatant from the encounter (the native tracker's own entry). Deleting the
// Combatant is all that is needed — core's Combat#_onDeleteDescendantDocuments re-runs
// setupTurns() and fixes up `turn` when the removed one was the current/earlier turn.
// Confirmed first because it is destructive and the tracker has no undo.
async function feCtRemoveCombatant(c) {
  const DialogV2 = foundry.applications.api.DialogV2;
  let ok = false;
  try {
    ok = await DialogV2.confirm({
      window: { title: feCtL("FECT.Ctx.Remove", "전투원 제거") },
      content: `<p>${feCtEsc(
        feCtL("FECT.Ctx.RemoveConfirm", "이 전투원을 전투에서 제거합니다.")
      )}</p><p><strong>${feCtEsc(c.name ?? "")}</strong></p>`,
      rejectClose: false,
      modal: true,
    });
  } catch {
    return; // dialog cancelled
  }
  if (!ok) return;
  await c.delete();
}

// ── lifecycle ───────────────────────────────────────────────────────────────

Hooks.once("init", () => {
  feRegisterSetting(S.COMBAT_TRACKER_ENABLED, (v) => { if (!v) feCtTeardown(); });
  feRegisterSetting(S.COMBAT_TRACKER_PORTRAIT_SIZE, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_ASPECT, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_ROUNDNESS, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_ALIGNMENT, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_PORTRAIT_IMAGE, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_SHOW_INITIATIVE, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_SHOW_DISPOSITION, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_HIDE_DEFEATED, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_SHOW_HP, () => feCtScheduleRender());
});

Hooks.once("ready", () => {
  if (!feCtEnabled()) return;
  if (feCtOriginalActive()) {
    console.warn(
      `[female_edition] combat-tracker: 「Carousel Combat Tracker」(${CTD_ID}) 활성 — ` +
        `내장 컴뱃 트래커를 끄고 원본에 양보합니다.`
    );
    return;
  }
  feCtEnsureRoot();
  feCtRender();
  game.socket.on(SOCKET_CHANNEL, feCtOnSocket);

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
