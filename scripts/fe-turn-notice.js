/**
 * fe-turn-notice.js — turn notice (턴 알림)
 *
 * A port of the "Your Turn!" module (`your-turn`) for worlds that run female_edition
 * without it: on every turn change a banner sweeps across the screen with the
 * current combatant's portrait, "<name>의 턴!" (or "당신의 턴!" for the owning
 * player), the round/turn count and who is next.
 *
 * Relationship with the original, both directions:
 *   - your-turn is actively maintained, so fe-conflict-guard.js YIELDS to it
 *     (FE_CONFLICT_FEATURE.TURN_NOTICE) — with the original active this file shows
 *     nothing and the original keeps the job.
 *   - While the original is the one showing, it must still paint over our battle
 *     tracker. It renders inside core's #ui-middle, a stacking context at
 *     --z-index-app (30) that no z-index inside it can escape, while the tracker
 *     sits on <body> at 70. So #ui-middle is lifted for as long as a your-turn
 *     banner is visibly on screen (body.fe-yourturn-up, see feTnWatchYourTurn).
 *     That has to be timed from JS: your-turn never removes a finished banner —
 *     it fades it to opacity 0 and leaves the node until the next turn replaces
 *     it — so a pure `:has(.yourTurnBanner)` rule would keep #ui-middle over the
 *     tracker forever after the first notice.
 *
 * Our own banner lives on <body> above the tracker (z-index in fe-turn-notice.css),
 * so it needs none of that.
 *
 * Hooks are installed unconditionally and gated at event time, so the enable key
 * needs no reload; switching it off tears the DOM down in its onChange.
 */
import { feLocalize, feFormat } from "./fe-i18n.js";
import { feApplyHQPortrait } from "./fe-portrait-hq.js";
import { feRegisterSetting } from "./fe-settings-data.js";
import { S } from "./fe-constants.js";
import { feSetting } from "./fe-gm-priority.js";
import { FE_CONFLICT_FEATURE, feIsConflictFeatureSuppressed } from "./fe-conflict-state.js";
import { feRegisterTemplates, feRenderTemplateFragment } from "./fe-template.js";

const TN_ROOT_ID = "fe-turn-notice";
const YOUR_TURN_ID = "your-turn";
const [TN_TPL] = feRegisterTemplates("fe-turn-notice.hbs");

// Timing is owned HERE and published to CSS as custom properties, so the removal
// timers below and the keyframes can never drift apart.
const TN_IN_MS = 1200;   // band sweep / portrait pop
const TN_HOLD_MS = 4000; // on screen before leaving (your-turn's unload timer)
const TN_OUT_MS = 900;   // leave animation, then the node is removed

const TN_FALLBACK_IMG = "icons/svg/mystery-man.svg";
const TN_FALLBACK_COLOR = "#5f9ea0"; // your-turn's own default band colour

// your-turn: banner fade 3s after `.removing`, portrait fade 1.5s delay + 3s.
const YT_LEAVE_MS = 4600;
const YT_UP_CLASS = "fe-yourturn-up";

let _tnLastKey = null;
let _tnCombatId = null;
let _tnHiddenRound = null;
let _tnHoldTimer = null;
let _tnOutTimer = null;

function feTnEnabled() {
  if (!feSetting(S.TURN_NOTICE_ENABLED)) return false;
  return !feIsConflictFeatureSuppressed(FE_CONFLICT_FEATURE.TURN_NOTICE);
}

function feTnClearTimers() {
  clearTimeout(_tnHoldTimer);
  clearTimeout(_tnOutTimer);
  _tnHoldTimer = _tnOutTimer = null;
}

function feTnApplyVars(root) {
  const size = Number(feSetting(S.TURN_NOTICE_SIZE)) || 340;
  root.style.setProperty("--fe-tn-size", `${size}px`);
  root.style.setProperty("--fe-tn-in", `${TN_IN_MS}ms`);
  root.style.setProperty("--fe-tn-out", `${TN_OUT_MS}ms`);
}

function feTnRoot() {
  let root = document.getElementById(TN_ROOT_ID);
  if (!root) {
    root = document.createElement("div");
    root.id = TN_ROOT_ID;
    root.setAttribute("aria-live", "polite");
    document.body.appendChild(root);
  }
  feTnApplyVars(root);
  return root;
}

function feTnTeardown() {
  feTnClearTimers();
  document.getElementById(TN_ROOT_ID)?.remove();
  _tnLastKey = _tnCombatId = _tnHiddenRound = null;
}

function feTnLeave() {
  clearTimeout(_tnHoldTimer);
  _tnHoldTimer = null;
  const banner = document.querySelector(`#${TN_ROOT_ID} .fe-tn-banner`);
  if (!banner || banner.classList.contains("is-out")) return;
  banner.classList.add("is-out");
  clearTimeout(_tnOutTimer);
  _tnOutTimer = setTimeout(() => banner.remove(), TN_OUT_MS);
}

function feTnShow(data) {
  const root = feTnRoot();
  feTnClearTimers();
  root.replaceChildren(feRenderTemplateFragment(TN_TPL, data));
  // HQ-downscale the portraits (same path as the battle tracker): a
  // full-resolution image shrunk to banner size in one GPU-composited step
  // sparkles. Display-only imgs, so the src swap is safe; the original path
  // rides in data-fe-src.
  const size = Number(feSetting(S.TURN_NOTICE_SIZE)) || 340;
  const portrait = root.querySelector(".fe-tn-portrait");
  if (portrait?.dataset.feSrc) feApplyHQPortrait(portrait, portrait.dataset.feSrc, size, size);
  const next = root.querySelector(".fe-tn-next-img");
  if (next?.dataset.feSrc) feApplyHQPortrait(next, next.dataset.feSrc, 48, 48);
  _tnHoldTimer = setTimeout(feTnLeave, TN_HOLD_MS);
}

function feTnImage(c) {
  const actorImg = c.actor?.img;
  const tokenImg = c.token?.texture?.src;
  const primary = feSetting(S.TURN_NOTICE_IMAGE) === "token" ? tokenImg : actorImg;
  return primary || c.img || tokenImg || actorImg || TN_FALLBACK_IMG;
}

// PF2e's token name privacy, as your-turn honours it. The property exists only
// where a system defines it, so everywhere else this is just the name.
function feTnName(c) {
  if (game.user.isGM || (c.token?.playersCanSeeName ?? true)) return c.name;
  return feLocalize("FE.TurnNotice.Unknown");
}

function feTnUserColor(user) {
  const color = user?.color;
  if (!color) return TN_FALLBACK_COLOR;
  return color.css ?? String(color);
}

// The owning player's colour while that player is online, otherwise the GM's.
// A combatant shown through the hidden hint never reveals its owner's colour.
function feTnColor(c, anonymous) {
  const player = anonymous ? null : c.players?.find((p) => p.active) ?? null;
  if (c.hasPlayerOwner && player) return feTnUserColor(player);
  const gm = game.users?.activeGM ?? game.users?.find?.((u) => u.isGM) ?? null;
  return feTnUserColor(gm);
}

// Turn number counting only the combatants still standing, from 1.
function feTnTurnNumber(combat) {
  if (!combat?.turns || combat.turn == null) return 0;
  let count = 0;
  for (let i = 0; i <= combat.turn; i++) if (!combat.turns[i]?.defeated) count++;
  return count;
}

function feTnNextCombatant(combat) {
  const turns = combat?.turns ?? [];
  for (let j = 1; j < turns.length; j++) {
    const c = turns[(combat.turn + j) % turns.length];
    if (c && !c.hidden && !c.defeated) return c;
  }
  return null;
}

function feTnPresent(combat) {
  const c = combat.combatant;
  if (!c || c.defeated) return feTnLeave();

  let img = feTnImage(c);
  let title;
  let anonymous = false;
  const mine = !game.user.isGM && c.isOwner
    && !!c.players?.some((p) => p.id === game.user.id && p.active);

  if (mine) {
    title = feFormat("FE.TurnNotice.Yours", { name: feTnName(c) });
  } else if (c.hidden) {
    // Hidden combatants show nothing, or — when the GM allows the hint — one
    // anonymous "something is happening" per round, never to the GM.
    if (game.user.isGM || !feSetting(S.TURN_NOTICE_HIDDEN_HINT) || _tnHiddenRound === combat.round) {
      return feTnLeave();
    }
    _tnHiddenRound = combat.round;
    title = feLocalize("FE.TurnNotice.Something");
    img = TN_FALLBACK_IMG;
    anonymous = true;
  } else {
    title = feFormat("FE.TurnNotice.Turn", { name: feTnName(c) });
  }

  const nextCombatant = feSetting(S.TURN_NOTICE_SHOW_NEXT) ? feTnNextCombatant(combat) : null;
  feTnShow({
    mine,
    title,
    img,
    color: feTnColor(c, anonymous),
    count: feFormat("FE.TurnNotice.Count", { round: combat.round, turn: feTnTurnNumber(combat) }),
    nextLabel: feLocalize("FE.TurnNotice.NextUp"),
    next: nextCombatant ? { img: feTnImage(nextCombatant), name: feTnName(nextCombatant) } : null,
  });
}

function feTnOnUpdateCombat(combat, changes) {
  if (!feTnEnabled()) return;
  if (!combat?.started || !combat.active) return feTnLeave();
  if (!changes || (!("turn" in changes) && !("round" in changes))) return;

  if (_tnCombatId !== combat.id) {
    _tnCombatId = combat.id;
    _tnHiddenRound = null;
  }
  // updateCombat can fire more than once for one turn (a round change carries
  // `turn` too); the same turn must not replay the entrance.
  const key = `${combat.id}:${combat.round}:${combat.turn}`;
  if (key === _tnLastKey) return;
  _tnLastKey = key;
  feTnPresent(combat);
}

/* ── your-turn compat: keep its banner above the battle tracker ─────────── */

let _ytLeaveTimer = null;

function feTnSyncYourTurn(container) {
  const banner = container.querySelector(".yourTurnBanner");
  const body = document.body;
  if (banner && !banner.classList.contains("removing")) {
    clearTimeout(_ytLeaveTimer);
    _ytLeaveTimer = null;
    body.classList.add(YT_UP_CLASS);
    return;
  }
  // Fading out (or already gone): hold the lift until the portrait's fade ends.
  if (!body.classList.contains(YT_UP_CLASS) || _ytLeaveTimer) return;
  _ytLeaveTimer = setTimeout(() => {
    _ytLeaveTimer = null;
    const fresh = container.querySelector(".yourTurnBanner:not(.removing)");
    if (!fresh) body.classList.remove(YT_UP_CLASS);
  }, YT_LEAVE_MS);
}

function feTnWatchYourTurn() {
  if (!game.modules?.get?.(YOUR_TURN_ID)?.active) return;
  const top = document.getElementById("ui-top");
  if (!top) return;

  const watchContainer = (container) => {
    const obs = new MutationObserver(() => feTnSyncYourTurn(container));
    obs.observe(container, { subtree: true, childList: true, attributes: true, attributeFilter: ["class"] });
    feTnSyncYourTurn(container);
  };

  // your-turn builds its container only after an active GM is found, which can
  // be well after ready — wait for it rather than assume it exists.
  const existing = document.getElementById("yourTurnContainer");
  if (existing) return watchContainer(existing);
  const wait = new MutationObserver(() => {
    const container = document.getElementById("yourTurnContainer");
    if (!container) return;
    wait.disconnect();
    watchContainer(container);
  });
  wait.observe(top, { childList: true });
}

Hooks.once("init", () => {
  feRegisterSetting(S.TURN_NOTICE_ENABLED, (v) => { if (!v) feTnTeardown(); });
  feRegisterSetting(S.TURN_NOTICE_IMAGE);
  feRegisterSetting(S.TURN_NOTICE_SHOW_NEXT);
  feRegisterSetting(S.TURN_NOTICE_HIDDEN_HINT);
  feRegisterSetting(S.TURN_NOTICE_SIZE, () => {
    const root = document.getElementById(TN_ROOT_ID);
    if (root) feTnApplyVars(root);
  });

  Hooks.on("updateCombat", feTnOnUpdateCombat);
  // Only the encounter the notice belongs to — deleting some other, idle
  // encounter must not cut a live banner short.
  Hooks.on("deleteCombat", (combat) => {
    if (!_tnCombatId || combat?.id === _tnCombatId) feTnTeardown();
  });
});

Hooks.once("ready", feTnWatchYourTurn);
