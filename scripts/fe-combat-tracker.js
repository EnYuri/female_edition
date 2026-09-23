import { feLocalize, feFormat } from "./fe-i18n.js";
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
import { MODULE_ID, S, feIsDx3rdSystemId } from "./fe-constants.js";
import { feHpMasked, feToggleHpMask } from "./fe-hp-mask.js";
import { feResolveSocketSender } from "./fe-socket-auth.js";
// Tracker portraits shrink huge sources, which CSS image-rendering cannot do well (see
// fe-portrait-hq.js). They are display-only, non-editable images, so the safe src-swap HQ
// path applies.
import { feApplyHQPortrait } from "./fe-portrait-hq.js";
import { feRegisterTemplates, feRenderTemplate } from "./fe-template.js";
import {
  TRACKER_DOM_ID,
  feCtDbpEnabled,
  feCtDbpHpStyle,
  feCtEnabled,
  feCtGetCombat,
  feCtOriginalActive,
  feCtResolveHp,
  feCtCancelScheduledRender,
  feCtScheduleRender,
  feCtSetRenderer,
  feCtSetting,
  CTD_ID,
} from "./fe-combat-tracker-core.js";
import {
  feCtDbpInsertLayout,
  feDbpApplyBarRoll,
  feDbpApplyInkMetric,
  feDbpApplyOffsets,
  feDbpApplyShake,
  feDbpData,
  feDbpHasHpBaseline,
  feDbpHitDelay,
  feDbpObserveActorHp,
  feDbpPruneState,
  feDbpReset,
  feDbpSeedHpBaseline,
  feDbpStartTicker,
} from "./fe-combat-tracker-dbp.js";

// All markup lives in templates/; preloaded at `init` (fe-template.js).
const [CT_TPL_ROOT, CT_TPL_MENU, CT_TPL_DIALOG, CT_TPL_REMOVE] = feRegisterTemplates(
  "fe-combat-tracker.hbs",
  "fe-combat-tracker-menu.hbs",
  "fe-combat-tracker-dialog.hbs",
  "fe-combat-tracker-remove.hbs"
);

const SOCKET_CHANNEL = `module.${MODULE_ID}`;
const CT_SOCKET_END_TURN = "feCombatTrackerEndTurn";

// Collapsed (minimized) state — a client runtime flag, reset on reload.
let _ctCollapsed = false;

// Entrance animation ("위에서 부드럽게 내려와 정지" = slide down smoothly from the top and
// settle). Must be per-combatant and
// TIME-BASED, not a plain CSS class: feCtRender rebuilds the strip with innerHTML on
// every combat/actor/token hook, so a freshly-created node would replay (or, once the
// id is known, abruptly lose) its animation on any unrelated update mid-flight.
// _ctEnterStart remembers WHEN each combatant's animation began; a re-render hands the
// node a negative `animation-delay` so it resumes exactly where it was.
//
// Reverse the exit sequence: the bar fades in first, then portraits slide down
// left-to-right from behind the strip's upper edge. Keep scaleY(-1) in their
// transforms to undo the strip's scrollbar flip.
// Portrait travel durations must match the keyframes in styles/fe-combat-tracker.css.
// The stagger is the interval BETWEEN two neighbours; CT_*_STAGGER_TOTAL_MS caps how long
// the whole cascade may take, so a 20-combatant encounter still reads as sequential
// instead of taking a second and a half to finish arriving.
// All entrance/exit durations and stagger intervals run at approximately 0.66x.
const CT_ENTER_MS = 455;
const CT_ENTER_STAGGER_MS = 83;
const CT_ENTER_STAGGER_TOTAL_MS = 500;
const CT_BAR_ENTER_MS = 333;
const _ctEnterStart = new Map(); // combatantId -> performance.now() timestamp
let _ctInitialEnterUntil = 0;
let _ctInitialEnterOrder = "";
let _ctBarEnterStart = 0;        // 0 = tracker is not on screen; set when it appears

// Exit animation: portraits slide up right-to-left, then the bar fades out.
// Unlike the entrance this needs no per-combatant stamp map: the strip is not re-rendered
// while it is leaving (feCtBeginExit owns the DOM until its timer clears it).
const CT_EXIT_MS = 455;
const CT_EXIT_STAGGER_MS = 83;
const CT_EXIT_STAGGER_TOTAL_MS = 500;
const CT_BAR_EXIT_MS = 333;
let _ctExitTimer = 0;            // 0 = not leaving

// ── settings access ─────────────────────────────────────────────────────────

// DX3rd replaces Combat#nextTurn with its action-end/action-delay workflow.
// That workflow must start in the acting player's browser: it opens a local
// choice dialog, updates their owned Actor, then asks DX3rd's own GM socket
// handler to continue the initiative process. Running it through our GM proxy
// would put the choice dialog on the GM's screen instead.
function feCtUsesLocalPlayerTurnEndWorkflow() {
  return feIsDx3rdSystemId(game.system?.id);
}

// ── data helpers ────────────────────────────────────────────────────────────

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
// fields, and evaluates it directly. The 유리/불리 (advantage/disadvantage) prompt the user
// sees in the
// native encounter tab comes from the OTHER dnd5e entry point
// (`actor.rollInitiativeDialog()`, combat-tracker action "rollInitiative"), which
// we intentionally never call — rolling from this tracker must be one click.
// For the same reason no `{event}` is forwarded: dnd5e reads keyboard modifiers
// off it to flip advantage.

// In-flight guard. The rollable test reads the LIVE `initiative`, which is still null
// until the roll's update round-trips — so a double-click (or an impatient second click
// on 전체 굴림 = roll-all) would pass the guard twice and roll the same combatant twice
// before the
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

// One combatant's template context. Everything that used to be concatenated into an
// HTML string is now plain data; templates/fe-combat-tracker.hbs owns the markup.
function feCtPortraitData(c, active, canEndTurn, enterDelay = null, dbpOpts = null) {
  const img = feCtPortraitImage(c);
  const init = c.initiative;

  // Disposition color tints the frame border — but the active highlight (accent)
  // must win, so only apply it to non-active portraits. In the retro/pixel theme
  // the frame outline must follow the accent-tone (--fe-ac-*) override, so the
  // hard-coded disposition tint is suppressed there (CSS class wins).
  const retro = document.body.classList.contains("fe-retro-theme");
  const disposition =
    !active && !retro && feCtSetting(S.COMBAT_TRACKER_SHOW_DISPOSITION)
      ? feCtDispositionColor(c) || null
      : null;

  const showInit =
    feCtSetting(S.COMBAT_TRACKER_SHOW_INITIATIVE) && init != null && init !== "";

  const hitDelay = dbpOpts ? feDbpHitDelay(c.id, dbpOpts.now) : null;

  return {
    id: c.id,
    name: c.name,
    img,
    active,
    defeated: !!c.isDefeated,
    hidden: !!c.hidden,
    entering: enterDelay != null,
    delay: enterDelay != null ? Math.round(enterDelay) : 0,
    disposition,
    // A separate flag, not a truthiness test on the number: initiative 0 is legal
    // and must still show its badge.
    showInitiative: showInit,
    initiative: showInit ? Math.round(Number(init)) : null,
    hp: feCtShowHpBar(c.actor) ? feCtResolveHp(c.actor) || null : null,
    // ">>" end-turn and the roll-initiative d20 both sit dead-centre on the frame, so
    // only one of them is ever drawn (see docs/combat-tracker.md).
    canEndTurn,
    canRollInit: !canEndTurn && feCtCanRollInitiative(c),
    // Dynamic battle portrait. dbpOpts only arrives for the vertical aspects, and
    // when it does the name caption is hidden in CSS (.has-dbp .fe-ct-name).
    dbp: dbpOpts ? feDbpData(c, dbpOpts.size, dbpOpts.now, dbpOpts.insert) : null,
    // The hit shake uses the same stamp scheme as the entrance: the REMAINING time
    // goes out as a negative delay, so an innerHTML rebuild never rewinds a shake
    // that is already playing.
    hit: hitDelay != null,
    hitDelay: hitDelay != null ? Math.round(hitDelay) : 0,
  };
}

// The plain HP bar under the portrait. It drew the exact ratio for EVERY combatant,
// including one whose numbers are hidden — a bar is coarse, but it still answers
// "how close to dead" for an actor the GM marked secret, and the dial next to it was
// carefully saying nothing. So the bar now follows the same per-actor mask, and for a
// masked actor the partial-disclosure setting is what decides: the same value that lets
// the dial publish its digit count lets the bar publish its ratio, since both are
// approximations rather than the number.
function feCtShowHpBar(actor) {
  if (!feCtSetting(S.COMBAT_TRACKER_SHOW_HP)) return false;
  // Two bars for one pool. The dynamic battle portrait's bar style already draws the
  // ratio, with a caption, inside the panel — this one would sit right under it saying
  // the same thing less precisely, so the panel's own reading wins.
  if (feCtDbpEnabled() && feCtDbpHpStyle() === "bar") return false;
  if (!feHpMasked(actor)) return true;
  return feCtSetting(S.COMBAT_TRACKER_HIDDEN_PARTIAL) === true;
}

function feCtBtn(action, icon, label) {
  return { action, icon, label };
}

function feCtCollapseBtn() {
  // Collapse/minimize is a personal UI toggle, so it is offered to GMs and players alike.
  return feCtBtn(
    "toggle-collapse",
    _ctCollapsed ? "fa-window-maximize" : "fa-window-minimize",
    feLocalize(_ctCollapsed ? "FECT.Expand" : "FECT.Collapse")
  );
}

// The GM control bar, in render order. A `roundLabel` entry renders as the round
// counter instead of a button.
function feCtControlButtons(combat) {
  const round = combat.round ?? 0;
  const paused = combat.active === false;
  const started = Number(round) > 0;
  return [
    // Shown only while somebody still needs a roll — same self-explanatory pattern as
    // 전투 개시 (begin combat — which disappears once the encounter has started).
    feCtHasUnrolledCombatants(combat)
      ? feCtBtn("roll-all", "fa-dice-d20", feLocalize("FECT.RollAll"))
      : null,
    started ? null : feCtBtn("start-combat", "fa-circle-play", feLocalize("FECT.StartCombat")),
    feCtBtn("end-combat", "fa-flag-checkered", feLocalize("FECT.EndCombat")),
    feCtBtn(
      "toggle-active",
      paused ? "fa-play" : "fa-pause",
      feLocalize(paused ? "FECT.Resume" : "FECT.Deactivate")
    ),
    feCtBtn("prev-round", "fa-angles-left", feLocalize("FECT.PrevRound")),
    feCtBtn("prev-turn", "fa-angle-left", feLocalize("FECT.PrevTurn")),
    { roundLabel: `R${round}` },
    feCtBtn("next-turn", "fa-angle-right", feLocalize("FECT.NextTurn")),
    feCtBtn("next-round", "fa-angles-right", feLocalize("FECT.NextRound")),
    feCtCollapseBtn(),
  ].filter(Boolean);
}

// ── render ──────────────────────────────────────────────────────────────────

// The last markup handed to root.innerHTML. feCtRender compares against it and
// leaves the DOM alone when nothing changed — see there.
let _ctLastHtml = "";
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
  feCtCancelScheduledRender();
  feCtCancelExit();
  feCtCloseContextMenu();
  // Stop the dynamic battle portrait ticker too — left running after the DOM is
  // gone it would keep firing a pointless querySelector every frame.
  feDbpReset();
  document.getElementById(TRACKER_DOM_ID)?.remove();
  _ctLastHtml = ""; // the root is gone; the next render must rebuild from scratch
}

// Interval between two neighbours' animations, squeezed so `count` of them finish
// within `total`. Never stretched beyond `base` — a two-combatant encounter keeps the
// comfortable spacing rather than snapping to the cap.
function feCtStagger(count, base, total) {
  if (count <= 1) return 0;
  return Math.min(base, total / (count - 1));
}

function feCtPrefersReducedMotion() {
  try { return window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches === true; }
  catch { return false; }
}

function feCtClearTracker(root) {
  root.classList.remove("fe-ct-active");
  root.innerHTML = "";
  _ctLastHtml = ""; // the DOM no longer matches the cached markup
}

function feCtCancelExit() {
  if (!_ctExitTimer) return;
  clearTimeout(_ctExitTimer);
  _ctExitTimer = 0;
}

/**
 * Play the tracker off the screen, then clear it.
 *
 * Portraits leave right-to-left (the reverse of the entrance stagger); the bar's own
 * upward slide starts only after the last one has finished, so the two never overlap.
 * `forwards` fill keeps everything hidden between the animation ending and the timer
 * clearing the DOM.
 *
 * The entrance stamps are dropped HERE rather than when the DOM is finally cleared: an
 * encounter started mid-exit must animate in fresh, and it would otherwise inherit the
 * old bar timestamp and skip its entrance entirely.
 */
function feCtBeginExit(root) {
  if (_ctExitTimer) return; // already leaving

  _ctBarEnterStart = 0;
  _ctInitialEnterUntil = 0;
  _ctInitialEnterOrder = "";
  _ctEnterStart.clear();

  const inner = root.querySelector(".fe-ct-inner");
  // Nothing on screen, or the user asked for reduced motion — leave immediately.
  if (!inner || feCtPrefersReducedMotion()) {
    feCtClearTracker(root);
    return;
  }

  // While collapsed, `.fe-ct-combatants-wrap` is display:none — staggering portraits
  // nobody can see would only delay the bar's exit by the full stagger. Skip straight
  // to the slide-up.
  const portraits = root.classList.contains("fe-ct-collapsed")
    ? []
    : [...inner.querySelectorAll(".fe-ct-combatants > .fe-ct-portrait")];
  const last = portraits.length - 1;
  const stagger = feCtStagger(portraits.length, CT_EXIT_STAGGER_MS, CT_EXIT_STAGGER_TOTAL_MS);
  portraits.forEach((el, i) => {
    el.classList.remove("is-entering");
    // Reverse order: the rightmost portrait leaves first.
    el.style.setProperty("--fe-ct-exit-delay", `${Math.round((last - i) * stagger)}ms`);
    el.classList.add("is-leaving");
  });

  const portraitsDone = portraits.length ? Math.round(last * stagger) + CT_EXIT_MS : 0;
  inner.classList.remove("is-entering");
  inner.style.setProperty("--fe-ct-bar-exit-delay", `${portraitsDone}ms`);
  inner.classList.add("is-leaving");
  // The exit is applied to the DOM directly, so the DOM no longer matches the
  // cached markup. Without this, a new encounter starting during the exit could
  // render byte-identical HTML, be skipped as "nothing changed", and leave the
  // whole tracker wearing is-leaving — i.e. faded out forever.
  _ctLastHtml = "";

  _ctExitTimer = setTimeout(() => {
    _ctExitTimer = 0;
    // An encounter may have started while the tracker was leaving.
    if (feCtGetCombat()?.turns?.length) feCtRender();
    else feCtClearTracker(root);
  }, portraitsDone + CT_BAR_EXIT_MS);
}

function feCtRender() {
  if (!feCtEnabled() || feCtOriginalActive()) return;
  const root = document.getElementById(TRACKER_DOM_ID);
  if (!root) return;
  feCtCloseContextMenu(); // drop any open menu — its combatant may have changed

  const combat = feCtGetCombat();
  if (!combat || !combat.turns?.length) {
    feCtBeginExit(root);
    return;
  }
  // A new encounter started while the previous one was still animating out; the
  // innerHTML below replaces those nodes, so the pending clear must not fire.
  feCtCancelExit();

  const isGM = !!game.user?.isGM;
  const size = Number(feCtSetting(S.COMBAT_TRACKER_PORTRAIT_SIZE)) || 90;
  const aspect = Number(feCtSetting(S.COMBAT_TRACKER_ASPECT)) || 1;
  const round = Number(feCtSetting(S.COMBAT_TRACKER_ROUNDNESS)) || 0;
  root.style.setProperty("--fe-ct-size", `${size}px`);
  root.style.setProperty("--fe-ct-h", `${Math.round(size * aspect)}px`);
  root.style.setProperty("--fe-ct-round", `${round}px`);
  // The dynamic battle portrait is vertical-aspect only (feCtDbpEnabled).
  const dbpOn = feCtDbpEnabled();
  const dbpInsert = dbpOn && feCtDbpInsertLayout();
  root.classList.toggle("fe-ct-dbp", dbpOn);
  if (dbpOn) {
    root.style.setProperty("--fe-dbp-icon", `${Math.max(8, Math.round(size * 0.11))}px`);
  }

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
  if (!_ctBarEnterStart) {
    _ctBarEnterStart = nowMs;
    _ctInitialEnterUntil = nowMs + CT_BAR_ENTER_MS + CT_ENTER_STAGGER_TOTAL_MS + CT_ENTER_MS;
  }
  // Creating an encounter delivers multiple combatant hooks; initiative can also
  // reorder turns before the entrance finishes. Rebuild that cascade from the live
  // left-to-right order only when its membership/order changes. Ordinary renders
  // keep the timestamps, so animation progress survives actor/token updates.
  const enterOrder = JSON.stringify(combatants.map((c) => c.id));
  if (nowMs < _ctInitialEnterUntil && enterOrder !== _ctInitialEnterOrder) {
    _ctInitialEnterOrder = enterOrder;
    const cascadeStart = Math.max(nowMs, _ctBarEnterStart + CT_BAR_ENTER_MS);
    const stagger = feCtStagger(combatants.length, CT_ENTER_STAGGER_MS, CT_ENTER_STAGGER_TOTAL_MS);
    combatants.forEach((c, i) => _ctEnterStart.set(c.id, cascadeStart + i * stagger));
    _ctInitialEnterUntil = cascadeStart + Math.max(0, combatants.length - 1) * stagger + CT_ENTER_MS;
  }
  const barDelay = _ctBarEnterStart - nowMs;
  const barEntering = barDelay > -CT_BAR_ENTER_MS;
  // The stagger has to be known BEFORE the first stamp is handed out, so count the
  // newcomers up front rather than incrementing as we go — otherwise a whole encounter
  // arriving at once would size its interval from a count of 1.
  const enterStagger = feCtStagger(
    combatants.reduce((n, c) => n + (_ctEnterStart.has(c.id) ? 0 : 1), 0),
    CT_ENTER_STAGGER_MS,
    CT_ENTER_STAGGER_TOTAL_MS
  );
  let newcomers = 0;
  const portraits = combatants.map((c) => {
    const isActive = c.id === activeId;
    // ">>" only on the active combatant, and only for a user allowed to end that turn
    const canEndTurn = isActive && feCtCanEndTurnForCombatant(combat, c);
    let start = _ctEnterStart.get(c.id);
    if (start === undefined) {
      // The reverse of the exit's final bar fade comes before portrait travel.
      start = Math.max(nowMs, _ctBarEnterStart + CT_BAR_ENTER_MS) + newcomers * enterStagger;
      newcomers += 1;
      _ctEnterStart.set(c.id, start);
    }
    const delay = start - nowMs;
    // The window has to cover the stagger too: the LAST newcomer's delay is
    // (n-1)*stagger, and a re-render before it starts must still emit its class.
    // The baseline for HP-change detection has to be ours (updateActor fires after
    // the update). Seeding it here means a real hit always has a previous value.
    if (dbpOn && !feDbpHasHpBaseline(c.id)) {
      const seed = feCtResolveHp(c.actor);
      if (seed) feDbpSeedHpBaseline(c.id, seed.value);
    }
    return feCtPortraitData(
      c,
      isActive,
      canEndTurn,
      delay > -CT_ENTER_MS ? delay : null,
      dbpOn ? { size, now: nowMs, insert: dbpInsert } : null
    );
  });
  // Drop stamps for combatants that are gone, so a re-added one animates in again.
  const liveIds = new Set(combatants.map((c) => c.id));
  for (const id of [..._ctEnterStart.keys()]) if (!liveIds.has(id)) _ctEnterStart.delete(id);
  // Same reason for the dynamic portrait's state: a combatant that left must not
  // keep its old HP baseline, or rejoining would replay a phantom hit against it.
  feDbpPruneState(liveIds);

  const html = feRenderTemplate(CT_TPL_ROOT, {
    isGM,
    barEntering,
    barDelay: Math.round(barDelay),
    combatants: portraits,
    // The control panel is GM-only; the collapse button alone is also shown to players.
    buttons: isGM ? feCtControlButtons(combat) : [feCtCollapseBtn()],
    labels: {
      endTurn: feLocalize("FECT.Ctx.EndTurn"),
      rollInit: feLocalize("FECT.Ctx.RollInit"),
    },
  });

  /* Rebuild ONLY when the markup actually changed.
   *
   * feCtRender runs from every updateActor / updateToken / combat hook, and each
   * run used to throw the whole strip away and build it again: new <img> elements
   * (re-decoded, re-HQ-resampled), new text, new compositor layers. Mid-spin that
   * is a dropped frame, and it is what was left of the "dial stutters" report once
   * the spin itself had been made continuous — the harness never showed it because
   * nothing else was updating there.
   *
   * The comparison is only meaningful because the dial offsets are NOT in the
   * markup (feDbpApplyOffsets writes them below); everything else that changes per
   * frame — entrance delays, the hit delay, floating-number delays — is emitted
   * only while that animation is actually alive, so a steady tracker renders the
   * same string every time and the DOM is left completely untouched.
   */
  if (html !== _ctLastHtml) {
    _ctLastHtml = html;
    root.innerHTML = html;
    // HQ downscale to the display size (size x size*aspect). These are display-only
    // images, so the src swap is safe; a cache hit applies synchronously with no
    // flicker. Only the rebuild can introduce new <img> elements, so this belongs
    // inside the branch.
    const hpx = Math.round(size * aspect);
    root.querySelectorAll(".fe-ct-frame > img").forEach((im) => {
      const src = im.dataset.feSrc;
      if (src) feApplyHQPortrait(im, src, size, hpx);
    });
  }
  root.classList.add("fe-ct-active");
  root.classList.toggle("fe-ct-collapsed", _ctCollapsed);
  root.classList.toggle("fe-ct-paused", combat.active === false);

  // Every dial's position, written straight into the DOM — a dial this render just
  // built would otherwise paint one frame at offset 0. The bar style's caption is the
  // same contract with a different applier: the template emits only the RESTING
  // reading, so a bar rebuilt mid-animation has to be handed its momentary one here.
  feDbpApplyInkMetric(root);
  feDbpApplyOffsets(root, nowMs);
  feDbpApplyBarRoll(root, nowMs);
  feDbpApplyShake(root);
  // Re-attach any running spin to the dials this render just built; waiting for the
  // next frame would flash the template's value for one frame.
  feDbpStartTicker();
}

// core's scheduler is what the dbp module and every hook below go through; this
// is the one place that closes the loop back to the actual renderer.
feCtSetRenderer(feCtRender);

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
    feCtScheduleRender(); // re-sync the button icon/tooltip to the new state
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
      // and on dnd5e it routes through Combat#rollInitiative → no 유리/불리 (adv/disadv) dialog.
      case "roll-all": {
        if (_ctRollingAll) break;
        if (!feCtHasUnrolledCombatants(combat)) {
          ui.notifications?.info(feLocalize("FECT.NothingToRoll"));
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
    console.error(feLocalize("FE.Diagnostics.CombatTracker.feCtHandleAction"), e);
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
    console.warn(feLocalize("FE.Diagnostics.CombatTracker.feCtHandlePortraitClick"), e);
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
    console.error(feLocalize("FE.Diagnostics.CombatTracker.feCtHandleEndTurnClick"), e);
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
    console.error(feLocalize("FE.Diagnostics.CombatTracker.feCtRollInitiativeFor"), e);
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
      label: feLocalize("FECT.Ctx.EndTurn"),
      disabled: !feCtCanEndTurnForCombatant(combat, c),
    },
  ];

  if (isGM) items.push(
    {
      action: "open-sheet",
      icon: "fa-edit",
      label: feLocalize("FECT.Ctx.OpenSheet"),
    },
    {
      action: "toggle-hidden",
      icon: c.hidden ? "fa-eye" : "fa-eye-slash",
      label: c.hidden ? feLocalize("FECT.Ctx.Unhide") : feLocalize("FECT.Ctx.Hide"),
    },
    {
      action: "toggle-defeated",
      icon: "fa-skull",
      label: c.isDefeated ? feLocalize("FECT.Ctx.Revive") : feLocalize("FECT.Ctx.Defeat"),
    },
    { action: "adjust-hp", icon: "fa-heart", label: feLocalize("FECT.Ctx.AdjustHP") },
    { action: "set-initiative", icon: "fa-dice-d20", label: feLocalize("FECT.Ctx.SetInit") },
    { action: "reroll-initiative", icon: "fa-dice", label: feLocalize("FECT.Ctx.Reroll") },
    { action: "move-up", icon: "fa-arrow-up", label: feLocalize("FECT.Ctx.MoveUp") },
    { action: "move-down", icon: "fa-arrow-down", label: feLocalize("FECT.Ctx.MoveDown") },
  );

  // The per-actor "hide the numbers" flag (fe-hp-mask.js) — the same one the status
  // panel's sheet-header button writes, so this is a second door onto one switch. GM
  // only, because the whole point of the flag is that the table cannot see through it,
  // and only where there is an actor to carry it. Deliberately NOT gated on the
  // tracker's HP settings: the flag also governs the status panel, and a GM who hides
  // an enemy's numbers means it everywhere.
  if (isGM && c.actor) {
    const masked = feHpMasked(c.actor);
    items.push({
      action: "toggle-hp-mask",
      icon: masked ? "fa-hashtag" : "fa-question",
      label: masked ? feLocalize("FECT.Ctx.RevealHP") : feLocalize("FECT.Ctx.MaskHP"),
    });
  }

  // Mirrors core's `visible` conditions (combat-tracker.mjs#_getEntryContextOptions):
  // reset only when an initiative is actually set, movement history only when it exists.
  // `clearMovementHistory` is v14-only — v13 combatants have no movement history at all.
  if (isGM && Number.isFinite(c.initiative)) {
    items.push({
      action: "clear-initiative",
      icon: "fa-arrow-rotate-left",
      label: feLocalize("FECT.Ctx.ClearInit"),
    });
  }
  if (isGM && typeof c.clearMovementHistory === "function" && (c.token?.movementHistory?.length > 0)) {
    items.push({
      action: "clear-movement",
      icon: "fa-shoe-prints",
      label: feLocalize("FECT.Ctx.ClearMovement"),
    });
  }

  if (isGM) items.push({
    action: "remove-combatant",
    icon: "fa-trash",
    label: feLocalize("FECT.Ctx.Remove"),
    danger: true,
  });

  const menu = document.createElement("div");
  menu.id = CTX_MENU_ID;
  menu.className = "fe-ct-context-menu";
  if (document.body.classList.contains("fe-retro-theme")) menu.classList.add("fe-retro-theme");
  menu.innerHTML = feRenderTemplate(CT_TPL_MENU, { items });
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
          catch (e) { console.warn(feLocalize("FE.Diagnostics.CombatTracker.feCtHandleContextAction"), e); }
        }
        break;
      }
      case "open-sheet":      c.sheet?.render({ force: true }); break;
      case "adjust-hp":       await feCtOpenHpDialog(c); break;
      // The flag update fires updateActor, and that hook already reschedules a render
      // for any actor in the combat — nothing to do here but write it.
      case "toggle-hp-mask":  await feToggleHpMask(c.actor); break;
      case "set-initiative":  await feCtOpenInitiativeDialog(combat, c); break;
      case "reroll-initiative": await combat.rollInitiative([c.id]); break;
      case "clear-initiative":  await c.update({ initiative: null }); break;
      case "clear-movement": {
        if (typeof c.clearMovementHistory !== "function") break;
        await c.clearMovementHistory();
        ui.notifications?.info(feFormat("FE.CombatTracker.feCtHandleContextAction", { name: c.name }));
        break;
      }
      case "move-up":         await feCtMoveCombatant(combat, c, -1); break;
      case "move-down":       await feCtMoveCombatant(combat, c, +1); break;
      case "remove-combatant": await feCtRemoveCombatant(c); break;
    }
  } catch (e) {
    console.error(feLocalize("FE.Diagnostics.CombatTracker.feCtHandleContextAction2"), e);
  }
}

async function feCtRequestEndTurn(combat, c) {
  if (!feCtCanEndTurnForCombatant(combat, c)) {
    const msg = combat?.combatant?.id === c?.id
      ? feLocalize("FECT.Ctx.NoTurnPermission")
      : feLocalize("FECT.Ctx.NotCurrentTurn");
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
    ui.notifications?.warn(feLocalize("FECT.Ctx.NoGM"));
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
    console.error(feLocalize("FE.Diagnostics.CombatTracker.feCtOnSocket"), e);
  });
}

async function feCtOpenHpDialog(c) {
  const actor = c.actor;
  if (!actor) {
    ui.notifications?.warn(feLocalize("FECT.Ctx.NoActor"));
    return;
  }
  const sys = actor.system ?? {};
  const hasAttr = !!sys?.attributes?.hp;
  const hasFlat = !!sys?.hp;
  if (!hasAttr && !hasFlat) {
    ui.notifications?.warn(feLocalize("FECT.Ctx.NoHP"));
    return;
  }
  const path = hasAttr ? "system.attributes.hp.value" : "system.hp.value";
  const cur = Number(foundry.utils.getProperty(actor, path)) || 0;

  const DialogV2 = foundry.applications.api.DialogV2;
  const content = feRenderTemplate(CT_TPL_DIALOG, {
    label: "HP",
    field: "hp",
    value: cur,
    step: 1,
  });
  let result;
  try {
    result = await DialogV2.prompt({
      window: { title: `${feLocalize("FECT.Ctx.AdjustHP")} — ${c.name}` },
      content,
      ok: {
        label: feLocalize("FECT.Apply"),
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
  const content = feRenderTemplate(CT_TPL_DIALOG, {
    label: feLocalize("FECT.Ctx.Initiative"),
    field: "init",
    value: curStr,
    step: "any",
    placeholder: feLocalize("FECT.Ctx.InitEmpty"),
  });
  let result;
  try {
    result = await DialogV2.prompt({
      window: { title: `${feLocalize("FECT.Ctx.SetInit")} — ${c.name}` },
      content,
      ok: {
        label: feLocalize("FECT.Apply"),
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
    ui.notifications?.warn(feLocalize("FECT.Ctx.InitInvalid"));
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
    ui.notifications?.warn(feLocalize("FECT.Ctx.NeedInit"));
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
      window: { title: feLocalize("FECT.Ctx.Remove") },
      content: feRenderTemplate(CT_TPL_REMOVE, {
        message: feLocalize("FECT.Ctx.RemoveConfirm"),
        name: c.name ?? "",
      }),
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

// Rerender, and tell the status panel (fe-dx3rd-resource-ui.js) that the answer to
// "is the tracker showing HP?" may have changed — it stands down while we are
// (ceDx3rdRuiYieldToTracker, feCtDisplaysHp). A hook rather than an import: the two
// features are otherwise unrelated, and feRegisterSetting takes exactly one onChange
// per key, so the tracker cannot simply hand these keys over to the panel.
const FE_CT_HP_DISPLAY_HOOK = `${MODULE_ID}.combatTrackerHpDisplay`;

function feCtHpDisplayChanged() {
  feCtScheduleRender();
  Hooks.callAll(FE_CT_HP_DISPLAY_HOOK);
}

Hooks.once("init", () => {
  feRegisterSetting(S.COMBAT_TRACKER_ENABLED, (v) => {
    if (!v) feCtTeardown();
    Hooks.callAll(FE_CT_HP_DISPLAY_HOOK);
  });
  feRegisterSetting(S.COMBAT_TRACKER_PORTRAIT_SIZE, () => feCtScheduleRender());
  // The aspect is part of feCtDbpEnabled — a square portrait has no status panel,
  // so switching to one puts the tracker's HP readout away entirely.
  feRegisterSetting(S.COMBAT_TRACKER_ASPECT, feCtHpDisplayChanged);
  feRegisterSetting(S.COMBAT_TRACKER_ROUNDNESS, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_ALIGNMENT, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_PORTRAIT_IMAGE, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_SHOW_INITIATIVE, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_SHOW_DISPOSITION, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_HIDE_DEFEATED, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_SHOW_HP, feCtHpDisplayChanged);
  feRegisterSetting(S.COMBAT_TRACKER_DBP_HP_STYLE, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_DYNAMIC_PORTRAIT_LAYOUT, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_HIDDEN_PARTIAL, () => feCtScheduleRender());
  feRegisterSetting(S.COMBAT_TRACKER_DYNAMIC_PORTRAIT, () => {
    // HP changes that happened while the panel was off went unobserved, so the
    // baselines go with it.
    feDbpReset();
    feCtHpDisplayChanged();
  });
});

Hooks.once("ready", () => {
  if (!feCtEnabled()) return;
  if (feCtOriginalActive()) {
    console.warn(
      feFormat("FE.Diagnostics.CombatTracker.warn", { CTD_ID: CTD_ID }) +
        feLocalize("FE.Diagnostics.CombatTracker.warn2")
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
  Hooks.on("updateActor", (actor) => {
    feDbpObserveActorHp(actor);
    if (feCtCombatHasActor(actor)) feCtScheduleRender();
  });
  // Updating an unlinked token's actor updates its ActorDelta rather than the
  // synthetic Actor, so updateActor never fires for it — without this hook those
  // HP changes are missed entirely.
  Hooks.on("updateActorDelta", (delta) => {
    const actor = delta?.parent?.actor ?? delta?.syntheticActor ?? null;
    if (!actor) return;
    feDbpObserveActorHp(actor);
    if (feCtCombatHasActor(actor)) feCtScheduleRender();
  });
  Hooks.on("updateToken", () => feCtScheduleRender());
  // Old HP baselines mean nothing once the encounter is gone.
  Hooks.on("deleteCombat", () => feDbpReset());
});

export { feCtResolveHp, feCtEnabled, feCtOriginalActive };
