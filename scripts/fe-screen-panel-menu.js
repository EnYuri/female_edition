// female_edition: Screen Panel — on-canvas dropdown menu + hover tooltip.
//
// Pure UI. It does NOT import the entry module (fe-screen-panel.js imports THIS
// one). The privileged actions are injected at ready time via
// feSetPanelMenuActions(), mirroring the callback-injection pattern used by
// fe-merge.js / feSetMergeScheduleCallback.
//
// The menu/tooltip are plain absolutely-positioned HTML so we can anchor them at
// arbitrary screen coordinates (the canvas tile has no DOM element of its own).

import { MODULE_ID } from "./fe-constants.js";
import { FE_PANEL_TILE_FLAG, feEscapeHtml } from "./fe-screen-panel-data.js";

const MENU_ID = "fe-sp-menu";
const TOOLTIP_ID = "fe-sp-tooltip";

// Injected by the entry module. Each is async (op, ...) → Promise.
let _actions = {
  flip: null,        // (tile, faceIndex)
  toggleShowHide: null, // (tile)
  toggleDisable: null,  // (tile)
  toggleLock: null,     // (tile)
  sort: null,           // (tile, dir) — dir>0 forward, dir<0 backward (tokenized panels only)
  remove: null,         // (tile)
  openSheet: null,      // (actor)
  grantRights: null,    // (actor) — GM only
  gridSnapState: null,  // () => boolean — current local snap preference
  toggleGridSnap: null, // () => toggles the local snap preference
  dblclickCycleState: null, // (actor) => boolean — per-panel (actor.system.dblclickCycle)
  toggleDblclickCycle: null, // (actor) => toggles dblclick face cycling for THIS panel
};

function feSetPanelMenuActions(actions) {
  _actions = { ..._actions, ...actions };
}

// --------------------------------
// Element helpers
// --------------------------------

function ensureMenuEl() {
  let el = document.getElementById(MENU_ID);
  if (!el) {
    el = document.createElement("nav");
    el.id = MENU_ID;
    el.className = "fe-sp-menu";
    document.body.appendChild(el);
  }
  return el;
}

function closePanelMenu() {
  document.getElementById(MENU_ID)?.remove();
}

function isMenuOpen() {
  return !!document.getElementById(MENU_ID);
}

// --------------------------------
// Tooltip
// --------------------------------

/**
 * One dropdown row. Every entry in this menu is the same button — icon, label, a click
 * that closes the menu and then runs the action — so they are all built here rather than
 * hand-assembled per row.
 *
 * `disabled` is opt-in per row and NOT derived from "is a GM online": relayed ops need
 * one, but the local-only rows (grid snap, open sheet) work regardless and must stay
 * clickable. `onClick` is omitted for a pure informational row (the panel-level lock
 * note), which is then always disabled.
 */
function menuItem({ icon, label, danger = false, disabled = false, active = false, extraClass = "", onClick }) {
  const item = document.createElement("button");
  item.type = "button";
  item.className = ["fe-sp-menu-item", extraClass, danger ? "danger" : "", active ? "active" : ""]
    .filter(Boolean).join(" ");
  item.innerHTML = `<i class="${icon}"></i><span>${feEscapeHtml(label)}</span>`;
  item.disabled = disabled || !onClick;
  if (onClick) item.addEventListener("click", async () => { closePanelMenu(); await onClick(); });
  return item;
}

function ensureTooltipEl() {
  let el = document.getElementById(TOOLTIP_ID);
  if (!el) {
    el = document.createElement("div");
    el.id = TOOLTIP_ID;
    el.className = "fe-sp-tooltip";
    document.body.appendChild(el);
  }
  return el;
}

// The panel description is an HTMLField authored by the actor's OWNER, but the
// tooltip is shown to any OBSERVER. Rendering it raw would let a malicious owner
// run script in observers' browsers (e.g. <img onerror>). Strip the execution
// vectors (script/embed elements, on* handlers, javascript: URLs) while keeping
// legitimate rich-text formatting (bold, line breaks, images).
function _sanitizeTooltipHtml(html) {
  try {
    const doc = new DOMParser().parseFromString(String(html ?? ""), "text/html");
    for (const el of doc.querySelectorAll("script, style, iframe, object, embed, link, meta, base")) el.remove();
    for (const el of doc.body.querySelectorAll("*")) {
      for (const attr of [...el.attributes]) {
        const name = attr.name.toLowerCase();
        if (name.startsWith("on")) el.removeAttribute(attr.name);
        else if (/^(?:href|src|xlink:href|formaction|action)$/.test(name) && /^\s*javascript:/i.test(attr.value)) {
          el.removeAttribute(attr.name);
        }
      }
    }
    return doc.body.innerHTML;
  } catch {
    // On any parser failure, fall back to plain text (never raw HTML).
    const div = document.createElement("div");
    div.textContent = String(html ?? "");
    return div.innerHTML;
  }
}

function feShowPanelTooltip(text, clientX, clientY) {
  const trimmed = (text ?? "").toString().trim();
  if (!trimmed) { feHidePanelTooltip(); return; }
  const el = ensureTooltipEl();
  el.innerHTML = _sanitizeTooltipHtml(trimmed); // owner-authored HTML, sanitized (see above)
  el.style.left = `${clientX + 14}px`;
  el.style.top = `${clientY + 14}px`;
  el.classList.add("active");
}

function feHidePanelTooltip() {
  document.getElementById(TOOLTIP_ID)?.classList.remove("active");
}

// --------------------------------
// Menu construction
// --------------------------------

/**
 * Open the dropdown for a placed panel tile.
 * @param {object} ctx { tile (PlaceableObject), actor, clientX, clientY }
 */
function feOpenPanelMenu({ tile, actor, clientX, clientY }) {
  if (!tile || !actor) return;
  closePanelMenu();
  feHidePanelTooltip();

  const isOwner = actor.testUserPermission(game.user, "OWNER");
  const isObserver = actor.testUserPermission(game.user, "OBSERVER");
  if (!isObserver) return; // nothing this user may do

  const flag = tile.document.getFlag(MODULE_ID, FE_PANEL_TILE_FLAG) ?? {};
  const faces = actor.system.faces ?? [];
  const gmOnline = !!game.users.activeGM;

  const el = ensureMenuEl();
  el.innerHTML = "";

  // Every mutating row goes through the GM relay, so it is dead while no GM is online.
  const relayDown = !gmOnline && !game.user.isGM;
  const L = (key) => game.i18n.localize(key);
  const section = () => {
    const node = document.createElement("div");
    node.className = "fe-sp-menu-section";
    el.appendChild(node);
    return node;
  };

  // --- Face switcher (OBSERVER+) ---
  if (faces.length > 1) {
    const facesSection = section();
    const label = document.createElement("div");
    label.className = "fe-sp-menu-label";
    label.textContent = L("FESP.Menu.Faces");
    facesSection.appendChild(label);
    faces.forEach((face, i) => {
      facesSection.appendChild(menuItem({
        icon: "fa-solid fa-clone",
        label: face.name?.trim() || game.i18n.format("FESP.Sheet.FaceN", { n: i + 1 }),
        extraClass: "fe-sp-face-item",
        active: i === (flag.currentFace ?? 0),
        disabled: relayDown,
        onClick: () => _actions.flip?.(tile, i),
      }));
    });
  }

  // --- Owner controls ---
  if (isOwner) {
    const ownerSection = section();
    // `relay: true` = the op is applied by the GM, so the row follows relayDown.
    const add = (opts) => ownerSection.appendChild(menuItem({
      ...opts,
      disabled: opts.relay ? relayDown : false,
    }));

    const hidden = !!tile.document.hidden;
    add({
      relay: true,
      icon: hidden ? "fa-solid fa-eye" : "fa-solid fa-eye-slash",
      label: L(hidden ? "FESP.Menu.Show" : "FESP.Menu.Hide"),
      onClick: () => _actions.toggleShowHide?.(tile),
    });

    const disabled = !!flag.disabled;
    add({
      relay: true,
      icon: disabled ? "fa-solid fa-user-check" : "fa-solid fa-user-slash",
      label: L(disabled ? "FESP.Menu.Enable" : "FESP.Menu.Disable"),
      onClick: () => _actions.toggleDisable?.(tile),
    });

    // Position lock. The ENFORCED lock (feIsPanelPlacementLocked / fePanelLockSource in
    // the entry module) is `flag.locked` OR `actor.system.locked`, but this row can only
    // ever write the flag. While the panel-level lock is on, offering the flag toggle was
    // a row that lied twice over: it read "위치 고정" on a panel that was already locked,
    // and pressing it changed nothing anyone could see. Name the real source instead —
    // the owner releases it from the sheet's 위치 고정 checkbox. No `onClick`, so the row
    // renders permanently disabled.
    if (actor.system?.locked) {
      add({ icon: "fa-solid fa-lock", label: L("FESP.Menu.LockedByPanel") });
    } else {
      const locked = !!flag.locked;
      add({
        relay: true,
        icon: locked ? "fa-solid fa-lock-open" : "fa-solid fa-lock",
        label: L(locked ? "FESP.Menu.Unlock" : "FESP.Menu.Lock"),
        onClick: () => _actions.toggleLock?.(tile),
      });
    }

    // Layer ordering — TOKENIZED panels only. A tile panel is reachable through core's own
    // Tiles-layer tools (which have send-to-back/front); a token has no such UI, and core's
    // Token HUD is vetoed for panels, so this menu is the only place to reorder one.
    if (tile.document?.documentName === "Token") {
      add({ relay: true, icon: "fa-solid fa-arrow-up", label: L("FESP.Menu.SortForward"), onClick: () => _actions.sort?.(tile, 1) });
      add({ relay: true, icon: "fa-solid fa-arrow-down", label: L("FESP.Menu.SortBackward"), onClick: () => _actions.sort?.(tile, -1) });
    }

    // Grid-snap is a LOCAL drag preference (client setting, no GM relay), so this
    // item stays enabled even when no GM is online. It toggles snapping for THIS
    // user's panel drags globally.
    const snapOn = !!_actions.gridSnapState?.();
    add({
      icon: snapOn ? "fa-solid fa-table-cells" : "fa-solid fa-table-cells-large",
      label: L(snapOn ? "FESP.Menu.SnapOff" : "FESP.Menu.SnapOn"),
      onClick: () => _actions.toggleGridSnap?.(),
    });

    // Per-panel (actor.system.dblclickCycle) → world data, so it applies to every
    // user, not just this client. Writing it needs OWNER on the actor, which this
    // whole section is already gated on.
    const dblOn = !!_actions.dblclickCycleState?.(actor);
    add({
      icon: dblOn ? "fa-solid fa-toggle-on" : "fa-solid fa-toggle-off",
      label: L(dblOn ? "FESP.Menu.DblclickOff" : "FESP.Menu.DblclickOn"),
      onClick: () => _actions.toggleDblclickCycle?.(actor),
    });

    add({ relay: true, danger: true, icon: "fa-solid fa-trash", label: L("FESP.Menu.Remove"), onClick: () => _actions.remove?.(tile) });
    ownerSection.appendChild(document.createElement("hr"));

    // Sheet edit is a local action (no socket) — always enabled for owners.
    add({
      icon: "fa-solid fa-pen-to-square",
      label: L("FESP.Menu.Edit"),
      onClick: () => _actions.openSheet?.(actor),
    });
  }

  // --- GM controls: delegate operate rights to specific players ---
  if (game.user.isGM) {
    section().appendChild(menuItem({
      icon: "fa-solid fa-user-shield",
      label: L("FESP.Menu.GrantRights"),
      onClick: () => _actions.grantRights?.(actor),
    }));
  }

  if (!gmOnline && !game.user.isGM && isOwner) {
    const note = document.createElement("div");
    note.className = "fe-sp-menu-note";
    note.textContent = game.i18n.localize("FESP.Menu.NoGM");
    el.appendChild(note);
  }

  // Position: clamp into viewport after we know its size.
  el.style.visibility = "hidden";
  el.style.left = "0px";
  el.style.top = "0px";
  el.classList.add("active");
  const rect = el.getBoundingClientRect();
  const x = Math.min(clientX, window.innerWidth - rect.width - 8);
  const y = Math.min(clientY, window.innerHeight - rect.height - 8);
  el.style.left = `${Math.max(4, x)}px`;
  el.style.top = `${Math.max(4, y)}px`;
  el.style.visibility = "";
}

// --------------------------------
// Global dismissers (capture-phase, survive re-renders)
// --------------------------------

function onDocClickCapture(event) {
  if (!isMenuOpen()) return;
  if (event.target?.closest?.(`#${MENU_ID}`)) return; // click inside menu
  closePanelMenu();
}

function onDocKeydown(event) {
  if (event.key === "Escape") closePanelMenu();
}

function feInitPanelMenuDismissers() {
  document.addEventListener("pointerdown", onDocClickCapture, true);
  document.addEventListener("keydown", onDocKeydown, true);
}

export {
  feSetPanelMenuActions,
  feOpenPanelMenu,
  closePanelMenu,
  isMenuOpen as isPanelMenuOpen,
  feShowPanelTooltip,
  feHidePanelTooltip,
  feInitPanelMenuDismissers,
};
