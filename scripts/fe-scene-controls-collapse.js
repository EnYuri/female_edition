import { feRegisterSetting } from "./fe-settings-data.js";
// female_edition: FVTT v13+ / v14
// Scene-controls "dropdown" collapse.
//
// The top-left scene controls are two vertical menus:
//   #scene-controls-layers  — the layer buttons (tokens, tiles, walls, …)
//   #scene-controls-tools   — the tools for the active layer
// Both are <menu class="flexcol"> columns of <li><button class="control …"></button></li>.
//
// With the setting enabled (body.fe-collapse-scene-controls), each menu is
// collapsed to a single cell showing only its currently-active button — a
// dropdown. Clicking that cell EXPANDS the menu (adds .fe-sc-open). While open
// the menu STAYS open: picking an item lets core handle the selection and the
// column remains expanded, so several tools can be used without re-opening it.
// Clicking the collapse cell (the currently-active button, i.e. the same cell
// that expanded it) is the ONLY thing that folds a menu back. Not an outside
// click, not Escape, and not opening the other menu — the two dropdowns are
// independent and can be open at once. Explicit user decision; do not re-add
// any of those auto-collapse paths.
//
// All visual collapsing lives in styles/fe-scene-controls-collapse.css; this
// script only drives the body class and the open/close state class.
//
// The active cell is chosen purely by CSS off aria-pressed, which Foundry's
// SceneControls#activate keeps in sync synchronously (see core
// applications/ui/scene-controls.mjs). So the visible cell always tracks the
// real selection regardless of when we add/remove .fe-sc-open.

import { MODULE_ID, S, FE_DEFAULTS, feSetting } from "./fe-chat-enhance.js";

const BODY_CLASS = "fe-collapse-scene-controls";
const OPEN_CLASS  = "fe-sc-open";
const MENU_SELECTOR = "#scene-controls-layers, #scene-controls-tools";

// --------------------------------
// Settings helpers
// --------------------------------

function safeGetSetting(key, fallback) {
  try { return feSetting(key) ?? fallback; }
  catch { return fallback; }
}

function isCollapseEnabled() {
  return document.body?.classList?.contains(BODY_CLASS);
}

// --------------------------------
// Open / close state
// --------------------------------

// Resolve the button a collapsed menu would display. MUST mirror the CSS in
// styles/fe-scene-controls-collapse.css — pressed button (for tools, the
// pressed NON-toggle tool), with the first cell as the nothing-pressed
// fallback. This is the button that both expands the menu and folds it back.
function collapsedCellButton(menu) {
  if (!menu) return null;
  const pressed = menu.id === "scene-controls-tools"
    ? menu.querySelector(':scope > li > button[aria-pressed="true"]:not(.toggle)')
    : menu.querySelector(':scope > li > button[aria-pressed="true"]');
  return pressed ?? menu.querySelector(":scope > li:first-child > button");
}

// Only used when the feature itself is switched off — no click path collapses
// a menu except its own collapse cell.
function closeAllMenus() {
  for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
    menu.classList.remove(OPEN_CLASS);
  }
}

function applyCollapseSetting(enabled) {
  try {
    document.body?.classList?.toggle(BODY_CLASS, !!enabled);
    if (!enabled) closeAllMenus();
  } catch { /* no-op */ }
}

// --------------------------------
// Click handling
// --------------------------------
// A single capture-phase listener on document survives the frequent
// re-renders of the SceneControls application. Capture at the document root
// runs before core's delegated [data-action] handler on #scene-controls, so a
// collapsed click can be intercepted (expand) instead of triggering selection.

function onDocumentClickCapture(event) {
  if (!isCollapseEnabled()) return;

  // Clicks outside the control menus are left alone — an open dropdown stays
  // open until its own collapse cell is clicked.
  const menu = event.target?.closest?.(MENU_SELECTOR);
  if (!menu) return;

  const button = event.target?.closest?.("button.control");
  if (!button) return;

  if (!menu.classList.contains(OPEN_CLASS)) {
    // Collapsed: the only visible button is the active one, so re-selecting it
    // is a core no-op. Intercept and expand this menu instead.
    event.preventDefault();
    event.stopImmediatePropagation();
    menu.classList.add(OPEN_CLASS);
    return;
  }

  // Open. Clicking the collapse cell — the very button the menu shows when
  // collapsed — is the explicit "fold it back" gesture. Re-selecting an
  // already-active control is a core no-op, so intercepting costs nothing.
  if (button === collapsedCellButton(menu)) {
    event.preventDefault();
    event.stopImmediatePropagation();
    menu.classList.remove(OPEN_CLASS);
    return;
  }

  // Any other button: let core process it and leave the menu open, so the user
  // can keep picking. Only the collapse cell above closes it. The visible cell
  // still follows aria-pressed once it does collapse.
}

// --------------------------------
// Foundry hooks
// --------------------------------

Hooks.once("init", () => {
  feRegisterSetting(S.SC_COLLAPSE_ENABLED, value => applyCollapseSetting(value));

  // Capture-phase listener is attached once and persists across re-renders.
  document.addEventListener("click", onDocumentClickCapture, true);
});

Hooks.once("ready", () => {
  applyCollapseSetting(safeGetSetting(S.SC_COLLAPSE_ENABLED, FE_DEFAULTS[S.SC_COLLAPSE_ENABLED]));

  // Re-assert after every GM priority sync (this key is GM-priority-excluded,
  // i.e. a personal preference, but a sync may re-run apply logic elsewhere).
  Hooks.on(`${MODULE_ID}.chatUiUpdated`, (payload) => {
    try {
      if (payload?.reason !== "gm-priority-overrides") return;
      applyCollapseSetting(safeGetSetting(S.SC_COLLAPSE_ENABLED, FE_DEFAULTS[S.SC_COLLAPSE_ENABLED]));
    } catch { /* no-op */ }
  });
});
