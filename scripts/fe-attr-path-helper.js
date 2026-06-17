// female_edition — Attribute Name Helper.
//
// Developer / GM inspection aid. Plain HOVER over any element that displays an
// actor/item attribute (a sheet field, a rendered value, a chat-card stat) shows
// the system attribute name (e.g. `system.attributes.init.value`) as a tooltip —
// no key needs to be held.
//
// It integrates with Foundry's native tooltip (`game.tooltip` / `#tooltip`):
//   • If the hovered element already shows a native tooltip, the attribute name
//     is appended as an extra bottom line of that tooltip.
//   • If it shows none, the attribute name is displayed on its own (reusing the
//     native tooltip element + positioning + 500ms long-hover delay).
//
// System-agnostic: the name is read from the element's own `name` / `data-*`
// attributes, which both dnd5e and double-cross-3rd author on their editable
// fields and many display elements. A few dnd5e semantic shortcuts
// (data-ability / data-skill / data-tool) are mapped to canonical names.
//
// Self-contained: two client settings (config:false; surfaced in the unified
// female_edition settings menu) + one keybinding, no cross-module imports beyond
// MODULE_ID / S / FE_DEFAULTS. The value is never shown — name only.
//
// Instant-show keybinding (default X, "ceAphInstantKey"): while hovering an
// element with a resolvable name, pressing it skips the long-hover wait and shows
// the tooltip immediately. Shares its default key with fe-image-hover.js's own
// art-preview keybinding (ihKeybind) ON PURPOSE — both firing together for a
// hovered token portrait is acceptable (this helper still yields image/portrait
// elements for its OWN name-tooltip purposes; it does not suppress image-hover).
//
// Coexistence with fe-image-hover.js (X-key art preview over portraits): this
// helper YIELDS image/portrait elements, so it never pops a name tooltip over
// artwork. Disjoint by target.

import { MODULE_ID, S, FE_DEFAULTS } from "./fe-constants.js";

// Attributes, in priority order, whose value is (or contains) a document data
// path. `name` is handled separately first (form controls + generic name attr).
const FE_APH_PATH_ATTRS = [
  "data-name",
  "data-property",
  "data-target",
  "data-edit",
  "data-field",
  "data-attr",
  "data-attribute",
  "data-roll-property",
  "data-key",
  "data-path",
];

// ------------------------------------------------------------------
// Settings
// ------------------------------------------------------------------

function feAphSettingBool(key) {
  try {
    return !!game.settings.get(MODULE_ID, key);
  } catch {
    return !!FE_DEFAULTS[key];
  }
}

function feAphEnabled() {
  return feAphSettingBool(S.ATTR_PATH_HELPER);
}

function feAphSourceEnabled() {
  return feAphSettingBool(S.ATTR_PATH_HELPER_SOURCE);
}

function feAphRegisterSetting() {
  game.settings.register(MODULE_ID, S.ATTR_PATH_HELPER, {
    name: "FEAPH.Settings.EnableName",
    hint: "FEAPH.Settings.EnableHint",
    scope: "client",
    config: false, // surfaced via the unified female_edition settings menu
    type: Boolean,
    default: FE_DEFAULTS[S.ATTR_PATH_HELPER],
  });
  game.settings.register(MODULE_ID, S.ATTR_PATH_HELPER_SOURCE, {
    name: "FEAPH.Settings.SourceName",
    hint: "FEAPH.Settings.SourceHint",
    scope: "client",
    config: false, // surfaced via the unified female_edition settings menu
    type: Boolean,
    default: FE_DEFAULTS[S.ATTR_PATH_HELPER_SOURCE],
  });

  game.keybindings.register(MODULE_ID, "ceAphInstantKey", {
    name: "FEAPH.Keybind.InstantName",
    hint: "FEAPH.Keybind.InstantHint",
    editable: [{ key: "KeyX" }],
    onDown: () => feAphInstantShow(),
  });
}

// ------------------------------------------------------------------
// Name resolution
// ------------------------------------------------------------------

// Read a name from a single element (no traversal). Returns { name, source } or null.
function feAphReadName(node) {
  if (!node || node.nodeType !== 1) return null;

  // Form controls carry the path on their `name` (the field Foundry submits).
  const tag = node.tagName;
  if ((tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") && node.name) {
    return { name: node.name, source: "name" };
  }

  const nameAttr = node.getAttribute?.("name");
  if (nameAttr) return { name: nameAttr, source: "name" };

  for (const attr of FE_APH_PATH_ATTRS) {
    const v = node.getAttribute?.(attr);
    if (v) return { name: v, source: attr };
  }

  // dnd5e semantic shortcuts → canonical paths.
  const ds = node.dataset || {};
  if (ds.ability) return { name: `system.abilities.${ds.ability}`, source: "data-ability" };
  if (ds.skill) return { name: `system.skills.${ds.skill}`, source: "data-skill" };
  if (ds.tool) return { name: `system.tools.${ds.tool}`, source: "data-tool" };

  return null;
}

// Walk the hovered element and a few ancestors to find the nearest name. Falls
// back to (a) the control a hovered <label> points at, and (b) the nearest
// form-group's named field — so hovering a label/cell next to a value still
// resolves the name both dnd5e and dx3rd author on the editable field.
function feAphResolveName(start) {
  let el = start;
  for (let i = 0; el && i < 8; i++, el = el.parentElement) {
    const r = feAphReadName(el);
    if (r) return r;
    // A <label> resolves to the control it labels (for="id" or a nested control).
    if (el.tagName === "LABEL") {
      const lf = el.getAttribute("for");
      const ctrl = lf
        ? el.ownerDocument?.getElementById(lf)
        : el.querySelector("input, select, textarea");
      const lr = ctrl && feAphReadName(ctrl);
      if (lr) return lr;
    }
  }

  // Container fallback: the nearest field group usually pairs a label with its
  // named field. Use the first path-bearing field inside it.
  const group = start?.closest?.(".form-group, .form-fields, .form-row, .form-grid");
  if (group) {
    const ctrl = group.querySelector?.(
      "[name], [data-property], [data-name], [data-target], input, select, textarea"
    );
    const gr = ctrl && feAphReadName(ctrl);
    if (gr) return gr;
  }

  return null;
}

// ------------------------------------------------------------------
// Skip rules
// ------------------------------------------------------------------

function feAphIsEditable(node) {
  if (!node || node.nodeType !== 1) return false;
  const tag = node.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (node.isContentEditable) return true;
  if (node.classList?.contains("ProseMirror")) return true;
  return false;
}

// Elements that the image-hover feature handles (token/sheet portraits and
// image-edit controls). Yield these so we never pop a name tooltip over art.
function feAphIsImageHoverTarget(node) {
  if (node?.tagName === "IMG" || node?.tagName === "VIDEO") return true;
  return !!node?.closest?.(
    "img, video, [data-edit='img'], [data-action='editImage'], "
    + ".profile-img, .simple-sheet-portrait, .portrait, .token-portrait"
  );
}

// Mirror core TooltipManager#onActivate: does this element trigger a NATIVE
// tooltip on hover? (If so, the activate() wrapper appends our line; otherwise we
// drive activation ourselves.)
function feAphHasNativeTrigger(node) {
  const d = node?.dataset;
  if (!d) return false;
  const t = d.tooltipHtml ?? d.tooltipText ?? d.tooltip;
  if (t === undefined) return false;
  if (d.tooltip === "" && !node.ariaLabel) return false;
  return true;
}

function feAphShouldSkip(node) {
  if (!node || node.nodeType !== 1) return true;
  if (node.closest?.(".editor-content.ProseMirror")) return true; // match core
  if (feAphIsImageHoverTarget(node)) return true;
  // Don't pop over the field you're actively editing.
  const active = document.activeElement;
  if (active && feAphIsEditable(active) && (active === node || active.contains?.(node))) return true;
  return false;
}

// ------------------------------------------------------------------
// Tooltip integration
// ------------------------------------------------------------------

// When true, the activate() wrapper does NOT append a name line — used while we
// drive activation ourselves with the name already supplied as the tooltip text.
let feAphSuppressAppend = false;

function feAphAppendLine(tip, cls, text) {
  if (!tip) return;
  const line = document.createElement("div");
  line.className = cls;
  line.textContent = text; // textContent → no HTML injection
  tip.appendChild(line);
}

// Append the attribute name (+ optional source) under whatever the native
// tooltip already shows. Re-runs cleanly: core resets #tooltip content on every
// activate(), so stale lines are wiped automatically.
function feAphAppendInfo(element) {
  const hit = feAphResolveName(element);
  if (!hit) return;
  const tip = game.tooltip?.tooltip;
  if (!tip) return;
  feAphAppendLine(tip, "fe-aph-name-line", hit.name);
  if (feAphSourceEnabled() && hit.source) {
    feAphAppendLine(tip, "fe-aph-source-line", `(${hit.source})`);
  }
}

// Drive a tooltip ourselves for an element that has no native tooltip: show the
// name as the tooltip text (reusing core positioning), then append the source.
function feAphActivateOwn(element, hit) {
  const tm = game.tooltip;
  if (!tm?.activate) return;
  feAphSuppressAppend = true;
  try {
    tm.activate(element, { text: hit.name });
  } finally {
    feAphSuppressAppend = false;
  }
  if (feAphSourceEnabled() && hit.source) {
    feAphAppendLine(tm.tooltip, "fe-aph-source-line", `(${hit.source})`);
  }
}

// ------------------------------------------------------------------
// Hover handling (for elements without a native tooltip)
// ------------------------------------------------------------------

const _fnPending = { el: null, timer: null };

// The element (+ resolved name) currently under the pointer, regardless of
// whether it has a native tooltip trigger. Tracked independently of _fnPending
// so the instant-show keybinding (X) can fire for EITHER kind of element.
const _fnHover = { el: null, hit: null };

function feAphClearPending() {
  if (_fnPending.timer) {
    clearTimeout(_fnPending.timer);
    _fnPending.timer = null;
  }
  _fnPending.el = null;
}

function feAphOnEnter(event) {
  feAphClearPending();
  _fnHover.el = null;
  _fnHover.hit = null;
  if (!feAphEnabled()) return;
  const el = event.target;
  if (feAphShouldSkip(el)) return;
  const hit = feAphResolveName(el);
  if (!hit) return;
  _fnHover.el = el;
  _fnHover.hit = hit;

  // Native-tooltip elements are handled by the activate() wrapper.
  if (feAphHasNativeTrigger(el)) return;

  // Mirror the native 500ms long-hover delay.
  _fnPending.el = el;
  _fnPending.timer = setTimeout(() => {
    _fnPending.timer = null;
    if (_fnPending.el === el && feAphEnabled()) feAphActivateOwn(el, hit);
  }, 500);
}

function feAphOnLeave(event) {
  if (_fnPending.el && event.target === _fnPending.el) feAphClearPending();
  if (_fnHover.el === event.target) {
    _fnHover.el = null;
    _fnHover.hit = null;
  }
}

// Instant-show keybinding (default X): skip the long-hover wait entirely and show
// the attribute name tooltip right away for whatever is currently hovered.
function feAphInstantShow() {
  if (!feAphEnabled() || !_fnHover.el) return;
  feAphClearPending();
  if (feAphHasNativeTrigger(_fnHover.el)) {
    // Forces core's own activation immediately; our wrapped activate() then
    // appends the name line same as a normal (delayed) hover would.
    game.tooltip?.activate?.(_fnHover.el);
  } else {
    feAphActivateOwn(_fnHover.el, _fnHover.hit);
  }
}

// ------------------------------------------------------------------
// Init
// ------------------------------------------------------------------

function feAphWrapTooltipActivate() {
  const tm = game.tooltip;
  if (!tm || tm._feAphWrapped || typeof tm.activate !== "function") return;
  const orig = tm.activate.bind(tm);
  tm.activate = function feAphActivateWrapped(element, options) {
    const ret = orig(element, options);
    try {
      if (feAphEnabled() && !feAphSuppressAppend && element) feAphAppendInfo(element);
    } catch { /* best-effort overlay */ }
    return ret;
  };
  tm._feAphWrapped = true;
}

function feAphInit() {
  feAphWrapTooltipActivate();
  // Passive + capture: observe hovers without interfering. pointerenter does not
  // bubble, so capture is required to see descendants. (Matches core's own
  // body-level capture listeners.)
  document.body.addEventListener("pointerenter", feAphOnEnter, { capture: true, passive: true });
  document.body.addEventListener("pointerleave", feAphOnLeave, { capture: true, passive: true });
}

Hooks.once("init", feAphRegisterSetting);
Hooks.once("ready", feAphInit);
