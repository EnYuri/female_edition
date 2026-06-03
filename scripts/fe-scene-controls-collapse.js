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
// dropdown. Clicking that cell EXPANDS the menu (adds .fe-sc-open); picking an
// item lets core handle the selection and then re-collapses. Clicking outside,
// or Escape, collapses everything.
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

function closeAllMenus(except = null) {
  for (const menu of document.querySelectorAll(MENU_SELECTOR)) {
    if (menu !== except) menu.classList.remove(OPEN_CLASS);
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

  const menu = event.target?.closest?.(MENU_SELECTOR);
  if (!menu) {
    // Click anywhere outside the control menus → collapse all open dropdowns.
    closeAllMenus();
    return;
  }

  const button = event.target?.closest?.("button.control");
  if (!button) return;

  if (!menu.classList.contains(OPEN_CLASS)) {
    // Collapsed: the only visible button is the active one, so re-selecting it
    // is a core no-op. Intercept and expand this menu instead.
    event.preventDefault();
    event.stopImmediatePropagation();
    closeAllMenus(menu);
    menu.classList.add(OPEN_CLASS);
  } else {
    // Open: let core process the selection, then collapse on the next tick.
    // The visible cell follows aria-pressed, so it auto-updates to the new pick.
    setTimeout(() => menu.classList.remove(OPEN_CLASS), 0);
  }
}

function onDocumentKeydown(event) {
  if (event.key === "Escape" && isCollapseEnabled()) closeAllMenus();
}

// --------------------------------
// Foundry hooks
// --------------------------------

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.SC_COLLAPSE_ENABLED, {
    name: "화면 좌상단 컨트롤 접기(드롭다운)",
    hint: "토큰/타일 등 레이어 줄과 도구 줄을 평소엔 현재 선택된 1칸만 보이도록 접습니다. 칸을 클릭하면 펼쳐지고, 항목을 고르면 다시 접힙니다. 바깥을 클릭하거나 Esc로도 접힙니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.SC_COLLAPSE_ENABLED],
    onChange: value => applyCollapseSetting(value),
  });

  // Capture-phase listeners are attached once and persist across re-renders.
  document.addEventListener("click", onDocumentClickCapture, true);
  document.addEventListener("keydown", onDocumentKeydown, true);
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
