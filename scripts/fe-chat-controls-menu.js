// fe-chat-controls-menu.js
// Collapses #message-modes, .control-buttons, .fe-export-pdf, #ci-upload-image
// into a hamburger toggle dropdown inside #chat-controls to save horizontal space.

const FE_CTRL_WRAPPER_ID = "fe-ctrl-menu-wrapper";
const FE_CTRL_TOGGLE_ID  = "fe-ctrl-menu-toggle";
const FE_CTRL_PANEL_ID   = "fe-ctrl-menu-panel";
const FE_CTRL_ACTIVE_CLS = "fe-ctrl-menu-active";

// Selectors of elements to collect into the panel (in order).
// #ci-upload-image is listed explicitly in case it ends up as a direct child of
// #chat-controls rather than inside .control-buttons (v14 layout variation).
// .fe-export-pdf is a fallback: fe-chat-archive.js injects it directly into the
// panel when the panel already exists; the selector here catches the first-load
// case where the panel is built after the button was injected into #chat-controls.
// #fe-stage-nav is intentionally excluded — it stays visible outside the panel.
const FE_CTRL_TARGETS = [
  "#message-modes",
  ".control-buttons",
  "#ci-upload-image",
  ".fe-export-pdf",
  "#fe-dx3rd-rui-toggle-btn",
  // #fe-dx3rd-accent-btn is intentionally excluded — it stays permanently visible
  // outside the panel, directly in #chat-controls.
];

let _docListenerAdded = false;

function feCtrlAddDocListener() {
  if (_docListenerAdded) return;
  _docListenerAdded = true;

  // Close on outside click
  document.addEventListener("click", (ev) => {
    const panel = document.getElementById(FE_CTRL_PANEL_ID);
    if (!panel || panel.hidden) return;
    const wrapper = document.getElementById(FE_CTRL_WRAPPER_ID);
    if (wrapper?.contains(ev.target)) return;
    panel.hidden = true;
  });

  // Close on Escape — capture phase so we intercept before Foundry's KeyboardManager.
  // stopPropagation prevents Foundry from also blurring the active element and corrupting
  // keyboard state. Focus is explicitly returned to the chat input afterward.
  document.addEventListener("keydown", (ev) => {
    if (ev.key !== "Escape") return;
    const panel = document.getElementById(FE_CTRL_PANEL_ID);
    if (!panel || panel.hidden) return;
    ev.stopPropagation();
    panel.hidden = true;
    const chatInput =
      document.querySelector("#chat-message") ||
      document.querySelector("#chat-form textarea[name='message']") ||
      document.querySelector("textarea[name='message']");
    chatInput?.focus?.();
  }, { capture: true });
}

// True when #chat-controls is currently relocated into the popped-out quick-reply
// dock (#chat-notifications), shown when the sidebar is on a non-chat tab. In that
// state we keep everything native and hide our injected widgets via CSS.
function feControlsInNotifications(controls) {
  return !!controls?.closest?.("#chat-notifications");
}

// Synchronously reconcile #chat-controls collapse state with its current location:
//   sidebar      → collapse (hide raw controls; our hamburger menu shows)
//   popped dock  → native (un-collapse; our widgets hidden by CSS)
// Called from the render hooks so the state is correct immediately, before the
// debounced rebuild runs (prevents a flash of the wrong layout).
function feMarkActiveIfSidebar() {
  const controls = document.querySelector("#chat-controls");
  if (!controls) return;
  if (feControlsInNotifications(controls)) feUncollapseCtrlMenu(controls);
  else controls.classList.add(FE_CTRL_ACTIVE_CLS);
}

// Restore #chat-controls to its native (un-collapsed) state: drop the active class
// and move the NATIVE controls (message-modes / control-buttons) collected into our
// panel back into #chat-controls so the native quick-reply bar works. Our own widgets
// (export, image upload, RUI toggle) stay in the hidden panel so the popped-out dock
// isn't cluttered. Used when the block is relocated into the notification dock.
function feUncollapseCtrlMenu(controls) {
  controls.classList.remove(FE_CTRL_ACTIVE_CLS);
  const panel = document.getElementById(FE_CTRL_PANEL_ID);
  if (!panel) return;
  const wrapper = document.getElementById(FE_CTRL_WRAPPER_ID);
  const ref = (wrapper && wrapper.parentElement === controls) ? wrapper : null;
  for (const el of Array.from(panel.children)) {
    if (el.matches?.("#message-modes, .control-buttons")) {
      try { controls.insertBefore(el, ref); } catch { /* no-op */ }
    }
  }
}

function feRebuildCtrlMenu() {
  const controls = document.querySelector("#chat-controls");
  if (!controls) return;

  // Popped-out quick-reply dock (#chat-notifications): keep it fully native and let
  // CSS hide our injected widgets. Our menu/panels operate only in the sidebar tab.
  if (feControlsInNotifications(controls)) {
    feUncollapseCtrlMenu(controls);
    return;
  }

  // Mark immediately so CSS hides the raw controls (prevents flash).
  controls.classList.add(FE_CTRL_ACTIVE_CLS);

  let wrapper = document.getElementById(FE_CTRL_WRAPPER_ID);
  let toggle  = document.getElementById(FE_CTRL_TOGGLE_ID);
  let panel   = document.getElementById(FE_CTRL_PANEL_ID);

  if (!wrapper) {
    wrapper = document.createElement("div");
    wrapper.id = FE_CTRL_WRAPPER_ID;

    toggle = document.createElement("button");
    toggle.type = "button";
    toggle.id   = FE_CTRL_TOGGLE_ID;
    toggle.className = "ui-control icon fa-solid fa-bars";
    toggle.dataset.tooltip = "채팅 메뉴";
    toggle.ariaLabel = "채팅 메뉴";
    toggle.addEventListener("click", () => {
      const p = document.getElementById(FE_CTRL_PANEL_ID);
      if (!p) return;
      if (p.hidden) {
        // Anchor the panel just above the toggle button using fixed coords so the
        // panel position is independent of how tall the wrapper or #chat-controls is.
        const rect = toggle.getBoundingClientRect();
        p.style.bottom = (window.innerHeight - rect.top + 6) + "px";
        p.style.right  = (window.innerWidth  - rect.right)  + "px";
        p.style.left   = "auto";
        p.hidden = false;
      } else {
        p.hidden = true;
      }
    });

    panel = document.createElement("div");
    panel.id = FE_CTRL_PANEL_ID;
    panel.hidden = true;

    wrapper.append(toggle, panel);
    feCtrlAddDocListener();
  }

  // Re-parent wrapper into the current controls node if needed.
  if (wrapper.parentElement !== controls) controls.prepend(wrapper);

  // Collect target elements into the panel.
  // searchRoot fallback is intentionally restricted to .fe-export-pdf, which
  // fe-chat-archive.js may inject into the parent form as a last resort.
  // All other selectors must exist inside #chat-controls to be collected;
  // a broad fallback would accidentally grab sidebar navigation buttons
  // that share class names like .control-buttons in Foundry v14.
  const searchRoot = controls.closest("form") ?? controls.parentElement ?? controls;
  for (const sel of FE_CTRL_TARGETS) {
    const el = controls.querySelector(sel) ??
      (sel === ".fe-export-pdf" ? searchRoot.querySelector(sel) : null);
    if (el && !panel.contains(el)) panel.appendChild(el);
  }
}

let _rebuildTimer = null;
function feScheduleCtrlMenuRebuild(delay = 80) {
  if (_rebuildTimer) clearTimeout(_rebuildTimer);
  _rebuildTimer = setTimeout(() => {
    _rebuildTimer = null;
    try { feRebuildCtrlMenu(); } catch (err) {
      console.warn("[female_edition] fe-chat-controls-menu: rebuild failed", err);
    }
  }, delay);
}

// v14: fires whenever the shared chat input/controls block is moved.
Hooks.on("renderChatInput", () => {
  // Add class synchronously to suppress the native controls via CSS immediately,
  // then rebuild after archive/images scripts have had time to inject their buttons.
  feMarkActiveIfSidebar();
  feScheduleCtrlMenuRebuild(200);
});

// v13 / fallback: rebuild when chat log renders or sidebar activates.
// Also suppress raw controls immediately (like renderChatInput does) to prevent PDF-button flash.
Hooks.on("renderChatLog", () => {
  feMarkActiveIfSidebar();
  feScheduleCtrlMenuRebuild(200);
});
Hooks.on("activateChatLog", () => {
  feMarkActiveIfSidebar();
  feScheduleCtrlMenuRebuild(200);
});

// Re-collect buttons after any chatUiUpdated (dx3rd/archive inject on various reasons).
// Apply the active class synchronously so CSS hides raw controls before inject timers fire.
const _FE_CTRL_MENU_MODULE_ID = "female_edition";
Hooks.on(`${_FE_CTRL_MENU_MODULE_ID}.chatUiUpdated`, () => {
  feMarkActiveIfSidebar();
  feScheduleCtrlMenuRebuild(200);
});

Hooks.once("ready", () => {
  feMarkActiveIfSidebar();
  feScheduleCtrlMenuRebuild(600);
});
