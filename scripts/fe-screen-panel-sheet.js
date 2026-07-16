// female_edition: Screen Panel — Actor sheet (ApplicationV2 / Handlebars).
//
// Edits the shared panel definition: the ordered list of faces (name + image +
// hover description) plus the default placement size and default face. Per-
// placement state (current face / disabled) is NOT edited here — it lives on the
// Tile and is changed via the on-canvas dropdown menu (fe-screen-panel-menu.js).
//
// AppV2 so it is forward-clean for v14; it also runs on v13.

import { MODULE_ID } from "./fe-constants.js";
import { FE_PANEL_COMMON_ATTR_NAMES, feCleanFaceTokenData, feSortAttrItems } from "./fe-screen-panel-data.js";

/**
 * Core's own PrototypeTokenConfig, retargeted at ONE FACE's token settings instead of the
 * actor's prototype token.
 *
 * Why subclass rather than rebuild: a face is effectively its own token, and the user asked
 * for the real thing — every core tab/field, kept correct across versions for free.
 *
 * Two overrides are all it takes:
 * - `form.handler` — core's own submit does `this.actor.update({prototypeToken: submitData})`
 *   (`sheets/token/prototype-config.mjs`), which would write the ACTOR's prototype token. Ours
 *   hands the submit data to the caller's `feCommit` instead, so it lands on the face.
 * - `_initializeApplicationOptions` — core derives the window id from the parent actor's uuid
 *   alone, so two faces of the same panel would collide on one window. Append the face index.
 *
 * The `prototype` option is a detached `PrototypeToken` built from the face's stored object with
 * the panel actor as parent (core requires an identifiable parent, and reads `actor` off it for
 * the title/permission checks). Nothing writes through it — we never call its `update`.
 */
function feFaceTokenConfigClass() {
  const Base = foundry.applications.sheets?.PrototypeTokenConfig;
  if (!Base) return null;
  return class FeFaceTokenConfig extends Base {
    static DEFAULT_OPTIONS = {
      form: { handler: FeFaceTokenConfig._feOnSubmit },
    };

    static async _feOnSubmit(event, form, formData) {
      const submitData = this._processFormData(event, form, formData);
      await this.options.feCommit?.(submitData);
    }

    _initializeApplicationOptions(options) {
      const initialized = super._initializeApplicationOptions(options);
      initialized.id = `${initialized.id}-face-${options.feFaceIndex ?? 0}`;
      return initialized;
    }

    get title() {
      return `${game.i18n.localize("FESP.Sheet.FaceTokenTitle")}: ${this.options.feFaceLabel ?? ""}`;
    }
  };
}

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
      feAddFaceAttr: ScreenPanelSheet.#onAddFaceAttr,
      feRemoveFaceAttr: ScreenPanelSheet.#onRemoveFaceAttr,
      feRecopyFaceAttrs: ScreenPanelSheet.#onRecopyFaceAttrs,
      feClearFaceLinkedActor: ScreenPanelSheet.#onClearFaceLinkedActor,
      feCopyAttrPath: ScreenPanelSheet.#onCopyAttrPath,
      feSwitchFace: ScreenPanelSheet.#onSwitchFace,
      feToggleTokenize: ScreenPanelSheet.#onToggleTokenize,
      feEditFaceToken: ScreenPanelSheet.#onEditFaceToken,
      feClearFaceToken: ScreenPanelSheet.#onClearFaceToken,
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

  /**
   * @override — drop portrait/token artwork AND the prototype-token entry from
   * the controls dropdown. Prototype token is instead surfaced as an always-
   * visible frame header button (see _getFrameButtons) so it is never buried.
   */
  _getHeaderControls() {
    const controls = super._getHeaderControls();
    const drop = new Set(["configureToken", "showPortraitArtwork", "showTokenArtwork", "configurePrototypeToken"]);
    return controls.filter(c => !drop.has(c.action));
  }

  /**
   * @override — surface the prototype-token config as an ALWAYS-VISIBLE button
   * directly in the window header (not inside the `⋮` controls dropdown, and
   * regardless of the `tokenize` setting). The `configurePrototypeToken` action
   * is inherited from ActorSheetV2's actions map, so the frame button's
   * data-action dispatches to it automatically.
   */
  _getFrameButtons(options) {
    const buttons = super._getFrameButtons?.(options) ?? [];
    if (this.isEditable && !this.document.isToken) {
      // Tokenize is the panel's most consequential switch (it decides whether the panel
      // is placed as a Token or a Tile, and converts existing placements), so it lives
      // in the header rather than buried in a tab. Reflects state via its own icon.
      const on = !!this.document.system.tokenize;
      buttons.unshift({
        action: "feToggleTokenize",
        icon: on ? "fa-solid fa-chess-pawn" : "fa-regular fa-square",
        label: on ? "FESP.Sheet.TokenizeOn" : "FESP.Sheet.TokenizeOff",
      });
      buttons.unshift({
        action: "configurePrototypeToken",
        icon: "fa-solid fa-circle-user",
        label: "TOKEN.TitlePrototype",
      });
    }
    return buttons;
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

  /**
   * System-agnostic snapshot of a linked actor's trackable attributes, for the
   * per-face copied-attribute store. Uses core's `TokenDocument.getTrackedAttributes`
   * (the same inference the combat-tracker bar dropdown uses) so it works on
   * dnd5e (schema-based), double-cross-3rd (object-based), and any other system.
   * Returns `[{name, value, max, attr}]`; `attr` is the live source dot-path.
   */
  #extractCopiedAttributes(actor) {
    if (!actor?.system) return [];
    const TokenDoc = foundry.documents?.TokenDocument ?? CONFIG?.Token?.documentClass;
    let tracked;
    try { tracked = TokenDoc.getTrackedAttributes(actor.system); } catch { return []; }
    if (!tracked) return [];
    // path segments whose own name is uninformative — fold into the parent key.
    const GENERIC = new Set(["value", "max", "min", "total", "point", "bonus", "extra", "dice", "add", "mod", "base"]);
    const nameFor = (pathArr, isBar) => {
      const last = pathArr[pathArr.length - 1];
      if (isBar) return last;                                  // bar path points at the {value,max} object
      if ((last === "value" || last === "total") && pathArr.length >= 2) return pathArr[pathArr.length - 2];
      if (GENERIC.has(last) && pathArr.length >= 2) return `${pathArr[pathArr.length - 2]}.${last}`;
      return last;
    };
    const out = [];
    const seen = new Set();
    const push = (pathArr, isBar) => {
      const path = pathArr.join(".");
      if (seen.has(path)) return;
      let value = "", max = "";
      try {
        const v = foundry.utils.getProperty(actor.system, path);
        if (isBar) {
          if (!v || typeof v !== "object") return;
          if (v.value === undefined || v.value === null) return;
          value = v.value; max = v.max ?? "";
        } else {
          if (v === undefined || v === null || typeof v === "object") return;
          value = v;
        }
      } catch { return; }
      seen.add(path);
      out.push({
        name: nameFor(pathArr, isBar),
        value: String(value),
        max: max === "" ? "" : String(max),
        attr: isBar ? `system.${path}.value` : `system.${path}`,
      });
    };
    for (const p of tracked.bar ?? []) push(p, true);
    for (const p of tracked.value ?? []) push(p, false);
    return out;
  }

  /** Split copied face attributes into common (surfaced) vs other (collapsed), preserving real index. */
  #splitFaceAttrs(attributes) {
    const common = new Set(FE_PANEL_COMMON_ATTR_NAMES.map(n => n.toLowerCase()));
    const rows = (attributes ?? []).map((a, index) => ({
      index, name: a.name ?? "", value: a.value ?? "", max: a.max ?? "", attr: a.attr ?? "",
    }));
    return {
      common: feSortAttrItems(rows.filter(r => common.has((r.name ?? "").toLowerCase().split(".")[0]))),
      other: rows.filter(r => !common.has((r.name ?? "").toLowerCase().split(".")[0])),
    };
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
        // This face's own Token settings. `tokenJson` feeds a hidden `data-dtype="JSON"`
        // input so the object survives the faces-array auto-submit intact (FormDataExtended
        // JSON.parses it back) — see the ArrayField rule; without it every unrelated edit
        // would reset the face's token settings to {}.
        tokenJson: JSON.stringify(face.token ?? {}),
        tokenConfigured: Object.keys(face.token ?? {}).length > 0,
        attrs: this.#extractActorAttributes(faceActor),
        // Copied per-face attributes — rendered as hidden inputs in the faces
        // template so the faces-array auto-submit stays COMPLETE (otherwise the
        // attributes sub-array resets to [] on any face edit; see ArrayField rule).
        attributes: (face.attributes ?? []).map((a, ai) => ({
          index: ai, name: a.name ?? "", value: a.value ?? "", max: a.max ?? "", attr: a.attr ?? "",
        })),
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
    const activeRaw = (sys.faces ?? [])[this.#activeFaceIndex];
    const activeSplit = this.#splitFaceAttrs(activeRaw?.attributes);
    const activeFace = {
      index: this.#activeFaceIndex,
      name: activeRaw?.name ?? "",
      num: this.#activeFaceIndex + 1,
      hasFace: !!activeRaw,
      linkedActorName: faces[this.#activeFaceIndex]?.linkedActorName ?? "",
      commonAttrs: activeSplit.common,
      otherAttrs: activeSplit.other,
      attrCount: (activeRaw?.attributes ?? []).length,
    };
    context.fe = {
      faces,
      defaultFace: sys.defaultFace ?? 0,
      width: sys.width,
      height: sys.height,
      locked: sys.locked,
      dblclickCycle: sys.dblclickCycle !== false,
      editable: this.isEditable,
      faceCount: faces.length,
      customAttributes,
      activeFace,
      // Drives the per-face Token settings row: those settings only ever apply to a
      // tokenized panel, so showing the button on a tile panel would be a lie.
      tokenize: !!sys.tokenize,
      actorName: this.document.name ?? "",
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
    this.#syncTokenizeButton();
    if (!this.isEditable) return;
    const root = this.element;

    // Panel name = the Actor's own `name`. Deliberately NOT a `name="name"` form
    // field: an <input> named "name" shadows HTMLFormElement.prototype.name, and
    // the value did not persist reliably through the multi-part submitOnChange
    // pipeline. Commit it explicitly (capture + stopPropagation so it doesn't
    // also race the form auto-submit), mirroring the face-attr inputs below.
    const nameInput = root.querySelector(".fe-sp-name-input");
    if (nameInput) {
      nameInput.addEventListener("change", (event) => {
        event.stopPropagation();
        const value = nameInput.value.trim();
        if (value && value !== this.document.name) this.document.update({ name: value });
      }, { capture: true });
    }

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
        this.#activeFaceIndex = faceIndex; // so the Attributes tab reflects the just-linked face
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

    // Per-face attribute inline edits. These inputs carry NO `name` (so they
    // are invisible to the auto-submit FormDataExtended pass) — each commits via
    // the full-array-clone #updateFaceAttr on change, per the ArrayField rule.
    for (const input of root.querySelectorAll(".fe-sp-face-attr-input")) {
      // Capture + stopPropagation so this edit is committed ONLY by #updateFaceAttr
      // (full-array-clone) and does NOT also trigger the form's submitOnChange,
      // which would race against it using the faces tab's stale hidden inputs.
      input.addEventListener("change", (event) => {
        event.stopPropagation();
        const fi = Number(input.dataset.faceIndex);
        const ai = Number(input.dataset.attrIndex);
        const field = input.dataset.field;
        if (!Number.isInteger(fi) || !Number.isInteger(ai) || !field) return;
        this.#updateFaceAttr(fi, ai, { [field]: input.value });
      }, { capture: true });
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
    if (uuid) {
      let linked = null;
      try { linked = await fromUuid(uuid); } catch { /* stale uuid */ }
      if (linked) {
        if (face.linkMode === "linked") {
          const img = linked.img || linked.prototypeToken?.texture?.src || "";
          if (img) face.img = img;
        }
        // Auto-copy the linked actor's trackable attributes onto THIS face.
        face.attributes = this.#extractCopiedAttributes(linked);
      }
    } else {
      // Unlinking clears the face's copied attributes (avoid stale values).
      face.attributes = [];
    }
    await this.#updateFaces(faces);
  }

  /** Re-snapshot the active face's copied attributes from its current linked actor. */
  async #recopyFaceAttrs(faceIndex) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const face = faces[faceIndex];
    if (!face?.linkedActorUuid) return;
    let linked = null;
    try { linked = await fromUuid(face.linkedActorUuid); } catch { /* stale uuid */ }
    if (!linked) return;
    face.attributes = this.#extractCopiedAttributes(linked);
    await this.#updateFaces(faces);
  }

  /** Persist one face-attribute field edit (full-array-clone — never a narrow dot-path). */
  async #updateFaceAttr(faceIndex, attrIndex, patch) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const attr = faces[faceIndex]?.attributes?.[attrIndex];
    if (!attr) return;
    Object.assign(attr, patch);
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

  /**
   * Header toggle for `system.tokenize`. Deliberately immediate — no confirmation:
   * the updateActor hook converts every placed instance between a Token and a Tile
   * (feSyncPanelTokenization) preserving position, size and current face, and clicking
   * again converts straight back, so there is nothing to lose and nothing to confirm.
   */
  static async #onToggleTokenize() {
    if (!this.isEditable) return;
    await this.document.update({ "system.tokenize": !this.document.system.tokenize });
  }

  /**
   * Frame buttons are built once when the window frame is created and are NOT rebuilt by
   * subsequent renders, so the tokenize button would keep the icon and tooltip it was
   * born with even after the state flips. Re-sync it on every render instead.
   */
  #syncTokenizeButton() {
    const btn = this.element?.querySelector('[data-action="feToggleTokenize"]');
    if (!btn) return;
    const on = !!this.document.system.tokenize;
    btn.classList.toggle("fa-chess-pawn", on);
    btn.classList.toggle("fa-square", !on);
    btn.classList.toggle("fa-solid", on);
    btn.classList.toggle("fa-regular", !on);
    const label = game.i18n.localize(on ? "FESP.Sheet.TokenizeOn" : "FESP.Sheet.TokenizeOff");
    btn.setAttribute("aria-label", label);
    btn.dataset.tooltip = label;
  }

  /** Open core's TokenConfig for ONE face's token settings. */
  static async #onEditFaceToken(event, target) {
    if (!this.isEditable) return;
    const i = Number(target.dataset.index);
    const face = this.document.system.faces?.[i];
    if (!face) return;
    const Cls = feFaceTokenConfigClass();
    if (!Cls) { ui.notifications?.warn(game.i18n.localize("FESP.Sheet.FaceTokenUnavailable")); return; }

    // A detached PrototypeToken seeded with this face's stored settings — the face's own
    // image is the default so the config previews what the face actually shows.
    const seed = foundry.utils.mergeObject(
      { name: this.document.name, texture: { src: face.img || "" } },
      feCleanFaceTokenData(face.token),
      { inplace: false }
    );
    const prototype = new foundry.data.PrototypeToken(seed, { parent: this.document });
    new Cls({
      prototype,
      feFaceIndex: i,
      feFaceLabel: face.name || game.i18n.format("FESP.Sheet.FaceN", { n: i + 1 }),
      feCommit: (submitData) => this.#updateFaceToken(i, submitData),
    }).render(true);
  }

  /** Reset one face's token settings back to "inherit the panel's defaults". */
  static async #onClearFaceToken(event, target) {
    if (!this.isEditable) return;
    const i = Number(target.dataset.index);
    if (!Number.isInteger(i)) return;
    await this.#updateFaceToken(i, {});
  }

  /** Full-array-clone write, per the AppV2 Auto-Submit vs ArrayField rule. */
  async #updateFaceToken(index, submitData) {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (!faces[index]) return;
    faces[index].token = feCleanFaceTokenData(submitData);
    await this.document.update({ "system.faces": faces });
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

  static async #onAddFaceAttr() {
    const fi = this.#activeFaceIndex;
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (!faces[fi]) return;
    faces[fi].attributes ??= [];
    faces[fi].attributes.push({ name: "", value: "", max: "", attr: "" });
    await this.#updateFaces(faces);
  }

  static async #onRemoveFaceAttr(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const attrs = faces[fi]?.attributes;
    if (!attrs || i < 0 || i >= attrs.length) return;
    attrs.splice(i, 1);
    await this.#updateFaces(faces);
  }

  static async #onRecopyFaceAttrs() {
    await this.#recopyFaceAttrs(this.#activeFaceIndex);
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
