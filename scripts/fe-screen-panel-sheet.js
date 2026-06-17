// female_edition: Screen Panel — Actor sheet (ApplicationV2 / Handlebars).
//
// Edits the shared panel definition: the ordered list of faces (name + image +
// hover description) plus the default placement size and default face. Per-
// placement state (current face / disabled) is NOT edited here — it lives on the
// Tile and is changed via the on-canvas dropdown menu (fe-screen-panel-menu.js).
//
// AppV2 so it is forward-clean for v14; it also runs on v13.

import { MODULE_ID } from "./fe-constants.js";
import { FE_PANEL_COMMON_ATTR_NAMES, feSortAttrItems } from "./fe-screen-panel-data.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

class ScreenPanelSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["female-edition", "fe-screen-panel-sheet"],
    position: { width: 600, height: "auto" },
    form: { submitOnChange: true, closeOnSubmit: false },
    actions: {
      feAddFace: ScreenPanelSheet.#onAddFace,
      feRemoveFace: ScreenPanelSheet.#onRemoveFace,
      feMoveFaceUp: ScreenPanelSheet.#onMoveFaceUp,
      feMoveFaceDown: ScreenPanelSheet.#onMoveFaceDown,
      fePlaceOnScene: ScreenPanelSheet.#onPlaceOnScene,
      feAddOverlay: ScreenPanelSheet.#onAddOverlay,
      feRemoveOverlay: ScreenPanelSheet.#onRemoveOverlay,
      fePickOverlayPos: ScreenPanelSheet.#onPickOverlayPos,
      feClearOverlayLinkedActor: ScreenPanelSheet.#onClearOverlayLinkedActor,
      feEditOverlay: ScreenPanelSheet.#onEditOverlay,
      feAddCustomAttr: ScreenPanelSheet.#onAddCustomAttr,
      feRemoveCustomAttr: ScreenPanelSheet.#onRemoveCustomAttr,
      feClearFaceLinkedActor: ScreenPanelSheet.#onClearFaceLinkedActor,
      feCopyAttrPath: ScreenPanelSheet.#onCopyAttrPath,
      feSwitchFace: ScreenPanelSheet.#onSwitchFace,
    },
  };

  static PARTS = {
    tabs: { template: "templates/generic/tab-navigation.hbs" },
    faces: { template: `modules/${MODULE_ID}/templates/screen-panel-sheet.hbs` },
    attributes: { template: `modules/${MODULE_ID}/templates/screen-panel-sheet-attributes.hbs` },
  };

  static TABS = {
    sheet: {
      tabs: [
        { id: "faces", icon: "fa-solid fa-images" },
        { id: "attributes", icon: "fa-solid fa-list" },
      ],
      initial: "faces",
      labelPrefix: "FESP.Tabs",
    },
  };

  /** @override — keep only prototype-token (when tokenize is on); drop portrait/token artwork */
  _getHeaderControls() {
    const controls = super._getHeaderControls();
    const drop = new Set(["configureToken", "showPortraitArtwork", "showTokenArtwork"]);
    if (!this.document.system?.tokenize) drop.add("configurePrototypeToken");
    return controls.filter(c => !drop.has(c.action));
  }

  // { faceIndex, overlayIndex } of the overlay awaiting a click-to-place on its
  // face's preview image, or null. Pure UI state — never persisted.
  #picking = null;

  // Which face tab is currently shown. Pure UI state — never persisted.
  #activeFaceIndex = 0;

  /**
   * Resolved display value for one overlay (mirrors feResolveOverlayText in
   * fe-screen-panel.js — kept duplicated rather than imported to avoid a
   * sheet→entry-module circular import; this file already has no canvas deps).
   * Live attribute value (if `attr` resolves against the linked actor) else the
   * static fallback text, else "" when neither is set/resolves.
   */
  #previewFor(ov, linkedActor) {
    if (ov.attr && linkedActor) {
      try {
        const v = foundry.utils.getProperty(linkedActor, ov.attr);
        if (v !== undefined && v !== null && v !== "") return String(v);
      } catch { /* fall through to static text */ }
    }
    return ov.text || "";
  }

  /**
   * A face-linked actor's real attributes, flattened for read-only display in
   * the face's attribute section — a convenience for copying an `attr` dot-path
   * into an overlay. dnd5e-only (guarded on CONFIG?.DND5E per project
   * convention) — other systems show an empty list for now.
   */
  #extractActorAttributes(actor) {
    if (!actor || !CONFIG?.DND5E) return [];
    const out = [];
    const hp = actor.system?.attributes?.hp;
    if (hp) out.push({ name: "hp", path: "system.attributes.hp.value", value: `${hp.value ?? ""}/${hp.max ?? ""}` });
    const ac = actor.system?.attributes?.ac;
    if (ac) out.push({ name: "ac", path: "system.attributes.ac.value", value: String(ac.value ?? "") });
    for (const key of FE_PANEL_COMMON_ATTR_NAMES.slice(2)) {
      const ability = actor.system?.abilities?.[key];
      if (ability) out.push({ name: key, path: `system.abilities.${key}.value`, value: String(ability.value ?? "") });
    }
    return feSortAttrItems(out);
  }

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sys = this.document.system;
    const faceCount = (sys.faces ?? []).length;
    if (this.#activeFaceIndex >= faceCount) this.#activeFaceIndex = Math.max(0, faceCount - 1);
    const faces = (sys.faces ?? []).map((face, index) => {
      const faceActorUuid = face.linkedActorUuid ?? "";
      let faceActor = null;
      if (faceActorUuid) { try { faceActor = fromUuidSync(faceActorUuid); } catch { /* stale uuid */ } }
      return {
        index,
        num: index + 1,
        active: index === this.#activeFaceIndex,
        name: face.name ?? "",
        img: face.img ?? "",
        description: face.description ?? "",
        linkedActorUuid: faceActorUuid,
        linkedActorName: faceActor?.name ?? "",
        linkedActorImg: faceActor?.img ?? "",
        linkMode: face.linkMode ?? "copy",
        attrs: this.#extractActorAttributes(faceActor),
        overlays: (face.overlays ?? []).map((ov, oi) => {
          const linkedActorUuid = ov.linkedActorUuid ?? "";
          let linkedActor = null;
          if (linkedActorUuid) { try { linkedActor = fromUuidSync(linkedActorUuid); } catch { /* stale uuid */ } }
          return {
            index: oi,
            num: oi + 1,
            faceIndex: index,
            x: ov.x ?? 0.5,
            y: ov.y ?? 0.5,
            xPct: Math.round((ov.x ?? 0.5) * 1000) / 10,
            yPct: Math.round((ov.y ?? 0.5) * 1000) / 10,
            linkedActorUuid,
            linkedActorName: linkedActor?.name ?? "",
            linkedActorImg: linkedActor?.img ?? "",
            attr: ov.attr ?? "",
            text: ov.text ?? "",
            fontSize: ov.fontSize ?? 28,
            color: ov.color ?? "#ffffff",
            bar: ov.bar ?? false,
            barMin: ov.barMin ?? 0,
            barMax: ov.barMax ?? 100,
            barHeight: ov.barHeight ?? 6,
            barColor: ov.barColor ?? "#33cc33",
            preview: this.#previewFor(ov, linkedActor),
            picking: this.#picking?.faceIndex === index && this.#picking?.overlayIndex === oi,
          };
        }),
      };
    });
    const customAttributes = feSortAttrItems(
      (sys.customAttributes ?? []).map((ca, i) => ({ index: i, name: ca.name ?? "", value: ca.value ?? "", max: ca.max ?? "" }))
    );
    context.fe = {
      faces,
      defaultFace: sys.defaultFace ?? 0,
      width: sys.width,
      height: sys.height,
      locked: sys.locked,
      editable: this.isEditable,
      faceCount: faces.length,
      customAttributes,
      tokenize: sys.tokenize ?? false,
    };
    return context;
  }

  /** @override */
  async _preparePartContext(partId, context, options) {
    const partContext = await super._preparePartContext(partId, context, options);
    const tab = partContext.tabs?.[partId];
    if (tab) partContext.tab = tab;
    return partContext;
  }

  /**
   * The default AppV2 auto-submit (`form.submitOnChange`) only carries values
   * for fields that have a named `<input>`/`<select>` in the DOM — face
   * name/img/description and overlay attr/text/fontSize/color. Overlay x/y and
   * linkedActorUuid have NO corresponding input (they are JS-driven via
   * click-to-place/drag/drop). Merging that partial object onto the document is
   * unsafe for two compounding reasons:
   *  1. `document.update()` itself does not merge partial ArrayField elements —
   *     untouched sibling fields reset to schema defaults (documented on
   *     `#updateOverlayPos` below).
   *  2. Worse: `DocumentSheetV2#_prepareSubmitData` calls
   *     `this.document.validate({changes, clean: {copy: false}})` BEFORE
   *     `_processSubmitData` ever runs. `copy:false` means that clean() pass
   *     mutates the partial `changes` object IN PLACE, filling in schema
   *     defaults for whatever fields are "missing" from each overlay (x, y,
   *     linkedActorUuid) — so by the time `_processSubmitData` sees the data,
   *     the defaults are already baked in as if they had been submitted.
   *     Overriding `_processSubmitData` alone (tried first; did not work) is
   *     too late to prevent this.
   * The fix: every array-element field that lacks a visible <input>/<select>
   * in the template carries a hidden input instead (see screen-panel-sheet.hbs),
   * so the auto-submitted form data is always COMPLETE — clean() finds nothing
   * "missing" to backfill. This is version-agnostic (no dependency on whether
   * _processFormData exists in the core framework — works on v13 and v14+).
   *
   * Direct programmatic updates (drag-to-place, actor drop, edit dialog) still
   * go through the full-array-clone pattern (#updateOverlayPos et al.) for the
   * same reason documented below — narrow dot-path updates into ArrayFields
   * wipe sibling fields.
   */

  /**
   * Persist one overlay's x/y. MUST go through a full faces-array clone+submit
   * (like #updateFaces) rather than a narrow dot-path update such as
   * `{"system.faces.0.overlays.0.x": ...}` — empirically, Foundry does NOT merge
   * that into the existing ArrayField element; it resets every sibling field on
   * that face (img, name, description) and every other field on that overlay
   * (attr, text, fontSize, color, and even the untouched y) to schema defaults.
   * Confirmed live: a single such dot-path update wiped a face's image.
   */
  async #updateOverlayPos(faceIndex, overlayIndex, x, y) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const ov = faces[faceIndex]?.overlays?.[overlayIndex];
    if (!ov) return;
    ov.x = x;
    ov.y = y;
    await this.#updateFaces(faces);
  }

  /** Persist one overlay's linkedActorUuid — same full-array-clone safety as #updateOverlayPos. */
  async #updateOverlayLinkedActor(faceIndex, overlayIndex, uuid) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const ov = faces[faceIndex]?.overlays?.[overlayIndex];
    if (!ov) return;
    ov.linkedActorUuid = uuid;
    await this.#updateFaces(faces);
  }

  /** Persist an arbitrary set of overlay fields (the edit dialog) — same full-array-clone safety. */
  async #updateOverlayFields(faceIndex, overlayIndex, patch) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const ov = faces[faceIndex]?.overlays?.[overlayIndex];
    if (!ov) return;
    Object.assign(ov, patch);
    await this.#updateFaces(faces);
  }

  /** Relative (0-1, clamped) position of a client point within a preview's rendered image box. */
  #relativePos(preview, clientX, clientY) {
    const img = preview.querySelector("img");
    const box = (img ?? preview).getBoundingClientRect();
    if (!box.width || !box.height) return null;
    return {
      x: Math.min(1, Math.max(0, (clientX - box.left) / box.width)),
      y: Math.min(1, Math.max(0, (clientY - box.top) / box.height)),
    };
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    if (!this.isEditable) return;
    const root = this.element;

    // Click-to-place: while an overlay is "armed" (picking), clicking its own
    // face's preview image commits the click position as that overlay's x/y.
    for (const preview of root.querySelectorAll(".fe-sp-overlay-preview")) {
      preview.addEventListener("click", (event) => {
        const faceIndex = Number(preview.dataset.faceIndex);
        if (!this.#picking || this.#picking.faceIndex !== faceIndex) return;
        const pos = this.#relativePos(preview, event.clientX, event.clientY);
        if (!pos) return;
        const { overlayIndex } = this.#picking;
        this.#picking = null;
        this.#updateOverlayPos(faceIndex, overlayIndex, pos.x, pos.y);
      });
    }

    // Drag-to-reposition: pressing a marker and dragging moves it live (visual
    // only, via inline left/top%), committing the final position on release.
    // Mirrors the canvas tile drag pattern in fe-screen-panel.js (window-level
    // capture listeners, threshold-free since the marker itself is the handle).
    for (const preview of root.querySelectorAll(".fe-sp-overlay-preview")) {
      const faceIndex = Number(preview.dataset.faceIndex);
      for (const marker of preview.querySelectorAll(".fe-sp-overlay-marker")) {
        marker.addEventListener("pointerdown", (event) => {
          if (event.button !== 0) return;
          event.preventDefault();
          event.stopPropagation(); // don't let this bubble into the click-to-place listener above
          const overlayIndex = Number(marker.dataset.overlayIndex);
          let moved = false;
          marker.classList.add("dragging");
          const onMove = (e) => {
            const pos = this.#relativePos(preview, e.clientX, e.clientY);
            if (!pos) return;
            moved = true;
            marker.style.left = `${pos.x * 100}%`;
            marker.style.top = `${pos.y * 100}%`;
          };
          const cleanup = () => {
            window.removeEventListener("pointermove", onMove, true);
            window.removeEventListener("pointerup", onUp, true);
            window.removeEventListener("pointercancel", onCancel, true);
            marker.classList.remove("dragging");
          };
          const onUp = (e) => {
            cleanup();
            if (!moved) return;
            const pos = this.#relativePos(preview, e.clientX, e.clientY);
            if (!pos) return;
            this.#updateOverlayPos(faceIndex, overlayIndex, pos.x, pos.y);
          };
          const onCancel = () => cleanup(); // re-render restores the marker to its persisted position
          window.addEventListener("pointermove", onMove, true);
          window.addEventListener("pointerup", onUp, true);
          window.addEventListener("pointercancel", onCancel, true);
        });
      }
    }

    // Per-overlay linked-actor drop zone: accepts a dragged Actor document.
    for (const dropZone of root.querySelectorAll(".fe-sp-overlay-link")) {
      const faceIndex = Number(dropZone.dataset.faceIndex);
      const overlayIndex = Number(dropZone.dataset.overlayIndex);
      dropZone.addEventListener("dragover", (event) => event.preventDefault());
      dropZone.addEventListener("drop", async (event) => {
        event.preventDefault();
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
        if (data?.type !== "Actor" || !data.uuid) return;
        await this.#updateOverlayLinkedActor(faceIndex, overlayIndex, data.uuid);
      });
    }

    // Per-face linked-actor drop zone: drag an Actor onto the face's actor
    // area to set that face's linkedActorUuid.
    for (const dropZone of root.querySelectorAll(".fe-sp-face-actor-drop")) {
      const faceIndex = Number(dropZone.dataset.faceIndex);
      dropZone.addEventListener("dragover", (event) => event.preventDefault());
      dropZone.addEventListener("drop", async (event) => {
        event.preventDefault();
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
        if (data?.type !== "Actor" || !data.uuid) return;
        await this.#updateFaceLinkedActor(faceIndex, data.uuid);
      });
    }

    // Per-face image drop zone: drag an Actor onto the face thumb to pick
    // portrait or token image via a quick dialog.
    for (const dropZone of root.querySelectorAll(".fe-sp-face-thumb")) {
      const faceIndex = Number(dropZone.dataset.faceIndex);
      if (!Number.isInteger(faceIndex)) continue;
      dropZone.addEventListener("dragover", (event) => event.preventDefault());
      dropZone.addEventListener("drop", async (event) => {
        event.preventDefault();
        let data;
        try { data = JSON.parse(event.dataTransfer.getData("text/plain")); } catch { return; }
        if (data?.type !== "Actor" || !data.uuid) return;
        let actor = null;
        try { actor = await fromUuid(data.uuid); } catch { return; }
        if (!actor) return;
        await this.#pickActorImageForFace(faceIndex, actor);
      });
    }
  }

  /** Rebuild + persist the faces array (preserves all current input edits via re-render). */
  async #updateFaces(faces) {
    return this.document.update({ "system.faces": faces });
  }

  async #updateCustomAttributes(items) {
    return this.document.update({ "system.customAttributes": items });
  }

  async #updateFaceLinkedActor(faceIndex, uuid) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const face = faces[faceIndex];
    if (!face) return;
    face.linkedActorUuid = uuid;
    if (face.linkMode === "linked" && uuid) {
      try {
        const linked = await fromUuid(uuid);
        const img = linked?.img || linked?.prototypeToken?.texture?.src || "";
        if (img) face.img = img;
      } catch { /* stale uuid */ }
    }
    await this.#updateFaces(faces);
  }

  async #pickActorImageForFace(faceIndex, actor) {
    const portrait = actor.img ?? "";
    const token = actor.prototypeToken?.texture?.src ?? "";
    if (!portrait && !token) return;
    if (portrait && !token) return this.#setFaceImage(faceIndex, portrait);
    if (!portrait && token) return this.#setFaceImage(faceIndex, token);
    const L = (k) => game.i18n.localize(k);
    const esc = foundry.utils.escapeHTML ?? ((s) => s);
    await foundry.applications.api.DialogV2.wait({
      window: { title: L("FESP.Sheet.ActorImagePickTitle") },
      content: `<div style="display:flex;gap:16px;justify-content:center;padding:12px;">
        <div style="text-align:center;">
          <img src="${esc(portrait)}" style="width:80px;height:80px;object-fit:contain;border-radius:6px;">
          <div style="font-size:12px;margin-top:4px;">${L("FESP.Sheet.ActorImagePortrait")}</div>
        </div>
        <div style="text-align:center;">
          <img src="${esc(token)}" style="width:80px;height:80px;object-fit:contain;border-radius:6px;">
          <div style="font-size:12px;margin-top:4px;">${L("FESP.Sheet.ActorImageToken")}</div>
        </div>
      </div>`,
      buttons: [
        { action: "portrait", icon: "fa-solid fa-user", label: L("FESP.Sheet.ActorImagePortrait"),
          callback: async () => this.#setFaceImage(faceIndex, portrait) },
        { action: "token", icon: "fa-solid fa-circle-user", label: L("FESP.Sheet.ActorImageToken"),
          callback: async () => this.#setFaceImage(faceIndex, token) },
      ],
    });
  }

  async #setFaceImage(faceIndex, src) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const face = faces[faceIndex];
    if (!face) return;
    face.img = src;
    await this.#updateFaces(faces);
  }

  static #onSwitchFace(event, target) {
    const i = Number(target.dataset.index);
    if (!Number.isInteger(i) || i < 0) return;
    this.#activeFaceIndex = i;
    this.render();
  }

  static async #onAddFace() {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    faces.push({ name: "", img: "", description: "" });
    this.#activeFaceIndex = faces.length - 1;
    await this.#updateFaces(faces);
  }

  static async #onRemoveFace(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (!Number.isInteger(i) || i < 0 || i >= faces.length) return;
    faces.splice(i, 1);
    if (this.#activeFaceIndex >= faces.length) this.#activeFaceIndex = Math.max(0, faces.length - 1);
    else if (this.#activeFaceIndex > i) this.#activeFaceIndex--;
    await this.#updateFaces(faces);
  }

  static async #onMoveFaceUp(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (i <= 0 || i >= faces.length) return;
    [faces[i - 1], faces[i]] = [faces[i], faces[i - 1]];
    if (this.#activeFaceIndex === i) this.#activeFaceIndex = i - 1;
    else if (this.#activeFaceIndex === i - 1) this.#activeFaceIndex = i;
    await this.#updateFaces(faces);
  }

  static async #onMoveFaceDown(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (i < 0 || i >= faces.length - 1) return;
    [faces[i + 1], faces[i]] = [faces[i], faces[i + 1]];
    if (this.#activeFaceIndex === i) this.#activeFaceIndex = i + 1;
    else if (this.#activeFaceIndex === i + 1) this.#activeFaceIndex = i;
    await this.#updateFaces(faces);
  }

  static async #onPlaceOnScene() {
    // Delegated to the entry module to avoid a circular import.
    const fn = globalThis.feScreenPanelPlaceOnScene;
    if (typeof fn === "function") await fn(this.document);
    else ui.notifications?.warn("Screen Panel: placement API not ready.");
  }

  static async #onAddOverlay(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (!Number.isInteger(fi) || fi < 0 || fi >= faces.length) return;
    faces[fi].overlays ??= [];
    faces[fi].overlays.push({
      x: 0.5, y: 0.5, linkedActorUuid: "", attr: "", text: "", fontSize: 28, color: "#ffffff",
      bar: false, barMin: 0, barMax: 100, barHeight: 6, barColor: "#33cc33",
    });
    this.#picking = { faceIndex: fi, overlayIndex: faces[fi].overlays.length - 1 };
    await this.#updateFaces(faces);
  }

  static async #onRemoveOverlay(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const overlays = faces[fi]?.overlays;
    if (!overlays || oi < 0 || oi >= overlays.length) return;
    overlays.splice(oi, 1);
    if (this.#picking?.faceIndex === fi && this.#picking?.overlayIndex === oi) this.#picking = null;
    await this.#updateFaces(faces);
  }

  /** Arm/disarm click-to-place for one overlay (see _onRender's preview click listener). */
  static async #onPickOverlayPos(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    const already = this.#picking?.faceIndex === fi && this.#picking?.overlayIndex === oi;
    this.#picking = already ? null : { faceIndex: fi, overlayIndex: oi };
    this.render();
  }

  static async #onClearOverlayLinkedActor(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    await this.#updateOverlayLinkedActor(fi, oi, "");
  }

  /**
   * Secondary fields (font size, color, value bar) live in a dialog rather than
   * the overlay row — attr/text are the two fields actually tweaked often, and
   * the row was already getting cramped before the bar fields (min/max/height/
   * color) would have pushed it past usable.
   */
  static async #onEditOverlay(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    const ov = this.document.system.faces?.[fi]?.overlays?.[oi];
    if (!ov) return;
    const esc = foundry.utils.escapeHTML ?? ((s) => s);
    const L = (k) => game.i18n.localize(k);
    const content = `
      <div class="fe-sp-overlay-edit-form">
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayFontSize")}</label>
          <input type="number" name="fontSize" value="${ov.fontSize ?? 28}" min="4" step="1">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayColor")}</label>
          <input type="color" name="color" value="${esc(ov.color ?? "#ffffff")}">
        </div>
        <hr>
        <label class="fe-sp-overlay-bar-toggle">
          <input type="checkbox" name="bar" ${ov.bar ? "checked" : ""}>
          ${L("FESP.Sheet.OverlayBarEnable")}
        </label>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarMin")}</label>
          <input type="number" name="barMin" value="${ov.barMin ?? 0}" step="any">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarMax")}</label>
          <input type="number" name="barMax" value="${ov.barMax ?? 100}" step="any">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarHeight")}</label>
          <input type="number" name="barHeight" value="${ov.barHeight ?? 6}" min="1" step="1">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarColor")}</label>
          <input type="color" name="barColor" value="${esc(ov.barColor ?? "#33cc33")}">
        </div>
      </div>`;
    await foundry.applications.api.DialogV2.prompt({
      window: { title: game.i18n.format("FESP.Sheet.OverlayEditTitle", { n: oi + 1 }) },
      content,
      ok: {
        icon: "fa-solid fa-check",
        label: L("FESP.Sheet.OverlayEditApply"),
        callback: async (_event, button) => {
          const form = button.form ?? button.closest?.("form");
          if (!form) return;
          const patch = {
            fontSize: Number(form.elements.fontSize?.value) || 28,
            color: form.elements.color?.value || "#ffffff",
            bar: !!form.elements.bar?.checked,
            barMin: Number(form.elements.barMin?.value) || 0,
            barMax: Number(form.elements.barMax?.value) || 100,
            barHeight: Math.max(1, Number(form.elements.barHeight?.value) || 6),
            barColor: form.elements.barColor?.value || "#33cc33",
          };
          await this.#updateOverlayFields(fi, oi, patch);
        },
      },
    });
  }

  static async #onAddCustomAttr() {
    const items = foundry.utils.deepClone(this.document.system.customAttributes ?? []);
    items.push({ name: "", value: "" });
    await this.#updateCustomAttributes(items);
  }

  static async #onRemoveCustomAttr(event, target) {
    const i = Number(target.dataset.index);
    const items = foundry.utils.deepClone(this.document.system.customAttributes ?? []);
    if (!Number.isInteger(i) || i < 0 || i >= items.length) return;
    items.splice(i, 1);
    await this.#updateCustomAttributes(items);
  }

  static async #onClearFaceLinkedActor(event, target) {
    const fi = Number(target.dataset.faceIndex);
    await this.#updateFaceLinkedActor(fi, "");
  }

  /** Copy an attribute's dot-path to the clipboard — convenience for filling an overlay's attr field. */
  static async #onCopyAttrPath(event, target) {
    const path = target.dataset.path;
    if (!path) return;
    try {
      await navigator.clipboard.writeText(path);
      ui.notifications?.info(game.i18n.localize("FESP.Sheet.AttrPathCopied"));
    } catch { /* clipboard unavailable — no-op */ }
  }
}

export { ScreenPanelSheet };
