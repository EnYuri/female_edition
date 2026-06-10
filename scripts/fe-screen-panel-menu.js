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
  remove: null,         // (tile)
  openSheet: null,      // (actor)
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
