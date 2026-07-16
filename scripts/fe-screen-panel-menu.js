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
import { FE_PANEL_TILE_FLAG } from "./fe-screen-panel-data.js";

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

  // --- Face switcher (OBSERVER+) ---
  if (faces.length > 1) {
    const section = document.createElement("div");
    section.className = "fe-sp-menu-section";
    const label = document.createElement("div");
    label.className = "fe-sp-menu-label";
    label.textContent = game.i18n.localize("FESP.Menu.Faces");
    section.appendChild(label);
    faces.forEach((face, i) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "fe-sp-menu-item fe-sp-face-item";
      if (i === (flag.currentFace ?? 0)) item.classList.add("active");
      const name = face.name?.trim() || game.i18n.format("FESP.Sheet.FaceN", { n: i + 1 });
      item.innerHTML = `<i class="fa-solid fa-clone"></i><span>${foundry.utils.escapeHTML?.(name) ?? name}</span>`;
      item.disabled = !gmOnline && !game.user.isGM;
      item.addEventListener("click", async () => {
        closePanelMenu();
        await _actions.flip?.(tile, i);
      });
      section.appendChild(item);
    });
    el.appendChild(section);
  }

  // --- Owner controls ---
  if (isOwner) {
    const ownerSection = document.createElement("div");
    ownerSection.className = "fe-sp-menu-section";

    const add = (icon, key, handler, { danger = false } = {}) => {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "fe-sp-menu-item" + (danger ? " danger" : "");
      item.innerHTML = `<i class="fa-solid ${icon}"></i><span>${game.i18n.localize(key)}</span>`;
      item.disabled = !gmOnline && !game.user.isGM;
      item.addEventListener("click", async () => { closePanelMenu(); await handler(); });
      ownerSection.appendChild(item);
    };

    const hidden = !!tile.document.hidden;
    add(hidden ? "fa-eye" : "fa-eye-slash",
        hidden ? "FESP.Menu.Show" : "FESP.Menu.Hide",
        () => _actions.toggleShowHide?.(tile));

    const disabled = !!flag.disabled;
    add(disabled ? "fa-user-check" : "fa-user-slash",
        disabled ? "FESP.Menu.Enable" : "FESP.Menu.Disable",
        () => _actions.toggleDisable?.(tile));

    const locked = !!flag.locked;
    add(locked ? "fa-lock-open" : "fa-lock",
        locked ? "FESP.Menu.Unlock" : "FESP.Menu.Lock",
        () => _actions.toggleLock?.(tile));

    // Layer ordering — TOKENIZED panels only. A tile panel is reachable through core's own
    // Tiles-layer tools (which have send-to-back/front); a token has no such UI, and core's
    // Token HUD is vetoed for panels, so this menu is the only place to reorder one.
    if (tile.document?.documentName === "Token") {
      add("fa-arrow-up", "FESP.Menu.SortForward", () => _actions.sort?.(tile, 1));
      add("fa-arrow-down", "FESP.Menu.SortBackward", () => _actions.sort?.(tile, -1));
    }

    // Grid-snap is a LOCAL drag preference (client setting, no GM relay), so this
    // item stays enabled even when no GM is online. It toggles snapping for THIS
    // user's panel drags globally.
    const snapOn = !!_actions.gridSnapState?.();
    const snapItem = document.createElement("button");
    snapItem.type = "button";
    snapItem.className = "fe-sp-menu-item";
    snapItem.innerHTML = `<i class="fa-solid ${snapOn ? "fa-table-cells" : "fa-table-cells-large"}"></i>`
      + `<span>${game.i18n.localize(snapOn ? "FESP.Menu.SnapOff" : "FESP.Menu.SnapOn")}</span>`;
    snapItem.addEventListener("click", async () => { closePanelMenu(); await _actions.toggleGridSnap?.(); });
    ownerSection.appendChild(snapItem);

    // Per-panel (actor.system.dblclickCycle) → world data, so it applies to every
    // user, not just this client. Writing it needs OWNER on the actor, which this
    // whole section is already gated on.
    const dblOn = !!_actions.dblclickCycleState?.(actor);
    const dblItem = document.createElement("button");
    dblItem.type = "button";
    dblItem.className = "fe-sp-menu-item";
    dblItem.innerHTML = `<i class="fa-solid ${dblOn ? "fa-toggle-on" : "fa-toggle-off"}"></i>`
      + `<span>${game.i18n.localize(dblOn ? "FESP.Menu.DblclickOff" : "FESP.Menu.DblclickOn")}</span>`;
    dblItem.addEventListener("click", async () => { closePanelMenu(); await _actions.toggleDblclickCycle?.(actor); });
    ownerSection.appendChild(dblItem);

    add("fa-trash", "FESP.Menu.Remove", () => _actions.remove?.(tile), { danger: true });
    ownerSection.appendChild(document.createElement("hr"));

    // Sheet edit is a local action (no socket) — always enabled for owners.
    const sheetItem = document.createElement("button");
    sheetItem.type = "button";
    sheetItem.className = "fe-sp-menu-item";
    sheetItem.innerHTML = `<i class="fa-solid fa-pen-to-square"></i><span>${game.i18n.localize("FESP.Menu.Edit")}</span>`;
    sheetItem.addEventListener("click", () => { closePanelMenu(); _actions.openSheet?.(actor); });
    ownerSection.appendChild(sheetItem);

    el.appendChild(ownerSection);
  }

  // --- GM controls: delegate operate rights to specific players ---
  if (game.user.isGM) {
    const gmSection = document.createElement("div");
    gmSection.className = "fe-sp-menu-section";
    const grant = document.createElement("button");
    grant.type = "button";
    grant.className = "fe-sp-menu-item";
    grant.innerHTML = `<i class="fa-solid fa-user-shield"></i><span>${game.i18n.localize("FESP.Menu.GrantRights")}</span>`;
    grant.addEventListener("click", () => { closePanelMenu(); _actions.grantRights?.(actor); });
    gmSection.appendChild(grant);
    el.appendChild(gmSection);
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
