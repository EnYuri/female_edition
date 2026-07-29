// female_edition: Screen Panel — Actor sheet (ApplicationV2 / Handlebars).
//
// Edits the shared panel definition: the ordered list of faces (name + image +
// hover description) plus the default placement size and default face. Per-
// placement state (current face / disabled) is NOT edited here — it lives on the
// Tile and is changed via the on-canvas dropdown menu (fe-screen-panel-menu.js).
//
// AppV2 so it is forward-clean for v14; it also runs on v13.

import { MODULE_ID } from "./fe-constants.js";
import { FE_PANEL_COMMON_ATTR_NAMES, feCleanFaceTokenData, feNextCustomAttrName, feSortAttrItems } from "./fe-screen-panel-data.js";

// Overlay-preview zoom limits, relative to the contain-fit that zoom 1 means. The ceiling
// is well above fe-token-preview's 4x because the fit itself can be tiny here — a 200x3000
// face opens at roughly 0.11, so 4x would still be a 21px-wide sliver to place markers on.
const FE_PREVIEW_ZOOM_MIN = 0.5;
const FE_PREVIEW_ZOOM_MAX = 20;

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
      feDuplicateFace: ScreenPanelSheet.#onDuplicateFace,
      feMoveFaceUp: ScreenPanelSheet.#onMoveFaceUp,
      feMoveFaceDown: ScreenPanelSheet.#onMoveFaceDown,
      fePlaceOnScene: ScreenPanelSheet.#onPlaceOnScene,
      feAddOverlay: ScreenPanelSheet.#onAddOverlay,
      feRemoveOverlay: ScreenPanelSheet.#onRemoveOverlay,
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
   * Core actor-sheet header actions that are meaningful on a DISPLAY BOARD.
   * Anything else that reaches this sheet's `⋮` menu arrived through a
   * third-party `getHeaderControls*` hook (core fires it AFTER
   * `_getHeaderControls`, so the filter above cannot see it) and was written for
   * a character-ish actor.
   *
   * Live example: Item Piles adds "Configure Item Pile" to EVERY actor sheet
   * unconditionally (`insertActorHeaderButtons`, no type check). Using it on a
   * panel makes `isValidItemPile(actor)` true — and Item Piles' own
   * PRE_RENDER_SHEET handler then CANCELS this sheet's render and shows its pile
   * interface instead, i.e. the panel sheet becomes unopenable. Dropping the
   * button is the cheap way to keep a display board a display board.
   */
  static FE_ALLOWED_HEADER_ACTIONS = Object.freeze([
    "configureSheet",
    "configureOwnership",
    "configurePrototypeToken",
    "copyUuid",
    "importDocument",
  ]);

  static #headerControlAllowed(control) {
    const action = control?.action;
    // Hook-injected entries commonly carry only `onClick`/`class` and no action.
    if (typeof action !== "string" || !action) return false;
    if (action.startsWith("fe")) return true; // our own actions
    return ScreenPanelSheet.FE_ALLOWED_HEADER_ACTIONS.includes(action);
  }

  /**
   * @override — the ONE funnel that sees header controls AFTER the
   * `getHeaderControls…` hook has run, on both the v14 lazy ContextMenu path
   * (`_headerControlContextEntries` → here, rebuilt on every open) and the v13
   * frame-time dropdown. Foreign entries are dropped here rather than by racing
   * other modules' hook registration order, which is not guaranteed.
   */
  _headerControlButtons() {
    const source = super._headerControlButtons?.();
    if (!source) return source;
    const keep = (control) => {
      if (ScreenPanelSheet.#headerControlAllowed(control)) return true;
      ScreenPanelSheet.#logDroppedHeaderControl(control);
      return false;
    };
    // Shape-preserving on purpose: v14 core consumes this as an iterator
    // (`Array.from(this._headerControlContextEntries())` on every menu open), but
    // returning a generator where a core build handed back an array would break
    // any `.length`/`.map` in the caller. Mirror whatever super returned.
    if (Array.isArray(source)) return source.filter(keep);
    return (function* filterHeaderControls() {
      for (const control of source) if (keep(control)) yield control;
    })();
  }

  // Dropped labels are logged once each per session — a silently vanishing
  // third-party button would otherwise be undebuggable.
  static #droppedHeaderControls = new Set();

  static #logDroppedHeaderControl(control) {
    const label = String(control?.label ?? control?.action ?? control?.class ?? "(unnamed)");
    if (ScreenPanelSheet.#droppedHeaderControls.has(label)) return;
    ScreenPanelSheet.#droppedHeaderControls.add(label);
    console.debug(
      `${MODULE_ID} | screen panel sheet: dropped a foreign header control 「${label}」 ` +
      `(a panel is a display board, not a character)`
    );
  }

  /**
   * @override — surface the prototype-token config as a button directly in the
   * window header rather than buried inside the `⋮` controls dropdown. The
   * `configurePrototypeToken` action is inherited from ActorSheetV2's actions
   * map, so the frame button's data-action dispatches to it automatically.
   *
   * It is only meaningful for a TOKENIZED panel (a tile panel has no token at
   * all), but frame buttons are built once with the window frame and are not
   * rebuilt by later renders — so it is always created and its visibility is
   * driven by the `fe-sp-tokenized` root class that `#syncTokenizeButton`
   * maintains on every render (`styles/fe-screen-panel.css`).
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
    const live = ScreenPanelSheet.#resolveAttrValue(linkedActor, ov.attr);
    if (live !== null) return live;
    return ov.text || "";
  }

  /**
   * One attribute dot-path resolved against an actor, or null when it does not
   * yield a displayable scalar. Objects are rejected on purpose: a path that stops
   * one segment short of its leaf (`system.customAttributes.0` instead of
   * `…0.value`) would otherwise stringify to "[object Object]" and render that on
   * the canvas. Mirrors feResolveOverlayText's guard in fe-screen-panel.js.
   * @returns {string|null}
   */
  static #resolveAttrValue(actor, attr) {
    if (!attr || !actor) return null;
    let v;
    try { v = foundry.utils.getProperty(actor, attr); } catch { return null; }
    if (v === undefined || v === null || v === "") return null;
    if (typeof v === "object") return null;
    return String(v);
  }

  /**
   * Fill fraction (0-1) the canvas would paint for this overlay's value bar, or
   * null when it would paint nothing. Mirrors feResolveOverlayNumericValue + the
   * pct clamp in fe-screen-panel.js (duplicated for the same no-circular-import
   * reason as #previewFor) so the preview marker cannot disagree with the canvas.
   */
  static #barPctFor(ov, linkedActor) {
    if (!ov?.bar) return null;
    if (!ov.attr || !linkedActor) return null;
    let n;
    try { n = Number(foundry.utils.getProperty(linkedActor, ov.attr)); } catch { return null; }
    if (!Number.isFinite(n)) return null;
    const span = (ov.barMax ?? 100) - (ov.barMin ?? 0);
    if (span === 0) return null;
    return Math.max(0, Math.min(1, (n - (ov.barMin ?? 0)) / span));
  }

  /**
   * Candidate `attr` dot-paths for an overlay's attribute picker, resolved against
   * the actor the overlay actually reads from at runtime (its OWN linkedActorUuid —
   * the face's link is not a fallback, see feResolveOverlayText).
   *
   * The panel actor itself is a legitimate link target (that is how the panel's own
   * `customAttributes` are surfaced on the canvas), but it carries no trackable
   * system attributes, so it gets its own branch.
   * @returns {Array<{path: string, label: string}>}
   */
  #attrSuggestions(actor) {
    if (!actor) return [];
    const out = [];
    const push = (path, label) => { if (path) out.push({ path, label }); };
    if (actor.id === this.document.id) {
      const suffix = (k) => game.i18n.localize(`FESP.Sheet.AttrSuggest${k}`);
      for (const [i, ca] of (actor.system?.customAttributes ?? []).entries()) {
        const name = ca?.name || String(i);
        push(`system.customAttributes.${i}.value`, `${name} ${suffix("Value")}`);
        if (ca?.max) push(`system.customAttributes.${i}.max`, `${name} ${suffix("Max")}`);
      }
      return out;
    }
    for (const a of this.#extractCopiedAttributes(actor)) {
      push(a.attr, a.max ? `${a.name} = ${a.value} / ${a.max}` : `${a.name} = ${a.value}`);
      // A bar attribute's `.value` path always has a sibling `.max` worth offering.
      if (a.max && a.attr.endsWith(".value")) {
        push(`${a.attr.slice(0, -".value".length)}.max`, `${a.name} ${game.i18n.localize("FESP.Sheet.AttrSuggestMax")}`);
      }
    }
    return out;
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
      // Only the ACTIVE face is visible; the rest are display:none but still carry
      // their hidden inputs (the faces-array auto-submit needs every field present).
      const active = index === this.#activeFaceIndex;
      return {
        index,
        num: index + 1,
        active,
        isDefault: index === (sys.defaultFace ?? 0),
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
          const barPct = ScreenPanelSheet.#barPctFor(ov, linkedActor);
          const barMode = ov.barMode === "inside" ? "inside" : "under";
          const barWidth = Math.max(0, ov.barWidth ?? 0);
          const barBorderWidth = Math.max(0, ov.barBorderWidth ?? 0);
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
            barMode,
            barWidth,
            barHeight: ov.barHeight ?? 6,
            barColor: ov.barColor ?? "#33cc33",
            barBorderWidth,
            barBorderColor: ov.barBorderColor ?? "#000000",
            // Marker-level mirror of the canvas bar. `showBar` is deliberately the
            // "would the canvas actually paint one" test, not just `ov.bar`, so the
            // preview never promises a bar a non-numeric attr can't produce.
            showBar: barPct !== null,
            barPct: barPct === null ? 0 : Math.round(barPct * 1000) / 10,
            barFixed: barPct !== null && barWidth > 0,
            barBordered: barPct !== null && barBorderWidth > 0,
            preview: this.#previewFor(ov, linkedActor),
            // A set `attr` that yields nothing is the panel's most common silent
            // misconfiguration (no linked actor, a typo'd path, or a path stopping
            // one segment short of its leaf). Say so in the row instead of leaving
            // the user to wonder why the canvas shows the fallback text.
            attrWarn: !!ov.attr && ScreenPanelSheet.#resolveAttrValue(linkedActor, ov.attr) === null,
            attrWarnReason: game.i18n.localize(
              linkedActorUuid ? "FESP.Sheet.OverlayAttrWarnPath" : "FESP.Sheet.OverlayAttrWarnNoActor"
            ),
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
   * for fields that have a named `<input>`/`<select>` in the DOM. Several face
   * and overlay fields are JS-driven rather than visibly editable; without the
   * hidden inputs in screen-panel-sheet.hbs they would be absent from the
   * submitted ArrayField elements. Merging such a partial object onto the
   * document is unsafe for two compounding reasons:
   *  1. `document.update()` itself does not merge partial ArrayField elements —
   *     untouched sibling fields reset to schema defaults (documented on
   *     `#updateOverlayPos` below).
   *  2. Worse: `DocumentSheetV2#_prepareSubmitData` calls
   *     `this.document.validate({changes, clean: {copy: false}})` BEFORE
   *     `_processSubmitData` ever runs. `copy:false` means that clean() pass
   *     mutates the partial `changes` object IN PLACE, filling in schema
   *     defaults for whatever fields are "missing" from each face/overlay — so
   *     by the time `_processSubmitData` sees the data,
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

  /**
   * Per-face pan/zoom of the overlay preview. Kept on the sheet **instance**, not on the
   * DOM: `submitOnChange` re-renders the whole part on every edit, so view state parked
   * on an element would be thrown away the moment the user typed in an overlay field —
   * zoom in, nudge a marker, and you would be back at 100% for the next one.
   * Deliberately not persisted past the sheet's lifetime; it is a camera, not a setting.
   * @type {Map<number, {pan: {x: number, y: number}, zoom: number}>}
   */
  #previewView = new Map();

  #previewViewFor(faceIndex) {
    let v = this.#previewView.get(faceIndex);
    if (!v) this.#previewView.set(faceIndex, (v = { pan: { x: 0, y: 0 }, zoom: 1 }));
    return v;
  }

  /**
   * Rebuild the camera map through an old-index → new-index mapping (`null` = that face is
   * gone). A face's identity IS its array index — the schema has no per-face id — so every
   * structural face operation has to carry the cameras along with it, exactly as it already
   * carries `#activeFaceIndex` and `defaultFace`. Four operations shift indices: remove,
   * duplicate (inserts at i+1), move up and move down. Without this, deleting face 2 hands
   * its camera to whichever face slides into slot 2, and you find yourself looking at an
   * unrelated image through someone else's zoom.
   *
   * Rebuilds into a new Map rather than mutating in place: a shift touches overlapping keys
   * (2→1 while 3→2), so an in-place pass would overwrite entries it had not read yet.
   */
  #remapPreviewView(mapIndex) {
    const next = new Map();
    for (const [index, view] of this.#previewView) {
      const to = mapIndex(index);
      if (to !== null) next.set(to, view);
    }
    this.#previewView = next;
  }

  /**
   * Set up each face's overlay preview viewport. Runs BEFORE `_onRender`'s `isEditable`
   * guard — an observer's preview should be as truthful and as navigable as an owner's,
   * it just cannot be dragged or placed.
   *
   * Publishing the image's natural size is the one thing CSS cannot do for itself, and
   * two separate things are derived from it:
   * - **font**: an overlay's `fontSize` is authored in the face image's own pixels, so
   *   the canvas paints it at `fontSize * renderedWidth / naturalWidth`
   *   (`feRebuildPanelOverlays`). Without this the marker was pinned at a hardcoded
   *   11px and changing the font size visibly did nothing.
   * - **shape**: the aspect ratio is what contain-fits the stage into the fixed viewport
   *   at zoom 1, so any panel proportion opens fully visible.
   *
   * The stylesheet carries stand-in values for both, so a slow or broken image never
   * leaves the marker without a size.
   */
  #setupOverlayPreviews() {
    this.#publishCanvasTextStyle();
    for (const preview of this.element?.querySelectorAll(".fe-sp-overlay-preview") ?? []) {
      const img = preview.querySelector("img");
      if (!img) continue;
      const faceIndex = Number(preview.dataset.faceIndex);
      const apply = () => {
        if (!(img.naturalWidth > 0) || !(img.naturalHeight > 0)) return;
        preview.style.setProperty("--fe-sp-ov-natw", String(img.naturalWidth));
        preview.style.setProperty("--fe-sp-ov-nath", String(img.naturalHeight));
      };
      // Decoded already (the usual case — the same face image is in cache across
      // re-renders), else wait. No `error` handler: a broken image simply keeps the
      // stylesheet's stand-in size.
      if (img.complete) apply();
      else img.addEventListener("load", apply, { once: true });

      this.#applyPreviewView(preview, faceIndex);
      this.#wirePreviewViewport(preview, faceIndex);
    }
  }

  /**
   * Mirror `CONFIG.canvasTextStyle` — the style overlay labels are actually painted
   * with (`feRebuildPanelOverlays` clones it and overrides only fontSize/fill) — onto
   * the sheet root as CSS variables, so the preview marker renders in the SAME
   * typeface with the SAME outline instead of the sheet's UI font.
   *
   * It has to come from JS: the family is a runtime stack (`fe-style.js` pushes the
   * module font into CONFIG at ready/canvasReady, so it is not knowable at author
   * time), and `strokeThickness` is **not** scaled by the overlay's font size on the
   * canvas — it is a constant in the panel image's own pixels, which is why it is
   * published raw and converted with the same cqw formula as everything else.
   */
  #publishCanvasTextStyle() {
    const root = this.element;
    if (!root) return;
    const s = globalThis.CONFIG?.canvasTextStyle;
    if (!s) return;
    const family = Array.isArray(s.fontFamily)
      ? s.fontFamily.map(f => (/[^\w-]/.test(f) ? `"${f}"` : f)).join(", ")
      : String(s.fontFamily ?? "");
    if (family) root.style.setProperty("--fe-sp-ov-family", family);
    root.style.setProperty("--fe-sp-ov-weight", String(s.fontWeight ?? "normal"));
    root.style.setProperty("--fe-sp-ov-stroke", String(s.stroke ?? "#111111"));
    root.style.setProperty("--fe-sp-ov-stroke-w", String(Number(s.strokeThickness) || 0));
    root.style.setProperty("--fe-sp-ov-shadow", String(s.dropShadow ? (Number(s.dropShadowBlur) || 0) : 0));
    root.style.setProperty("--fe-sp-ov-shadow-color", String(s.dropShadowColor ?? "#000000"));
  }

  /** Push the stored camera onto the CSS custom properties the stage transform reads. */
  #applyPreviewView(preview, faceIndex) {
    const { pan, zoom } = this.#previewViewFor(faceIndex);
    preview.style.setProperty("--fe-sp-ov-panx", `${Math.round(pan.x)}px`);
    preview.style.setProperty("--fe-sp-ov-pany", `${Math.round(pan.y)}px`);
    preview.style.setProperty("--fe-sp-ov-zoom", String(zoom));
    const moved = Math.abs(pan.x) > 0.5 || Math.abs(pan.y) > 0.5 || Math.abs(zoom - 1) > 0.001;
    preview.classList.toggle("fe-sp-view-moved", moved);
    const readout = preview.querySelector(".fe-sp-overlay-zoom");
    if (readout) readout.textContent = `${Math.round(zoom * 100)}%`;
  }

  /**
   * Drag-to-pan, wheel-to-zoom and the reset control on one preview viewport.
   *
   * Re-binds on every render, with no "already wired" flag, because core hands us a fresh
   * element each time: `HandlebarsApplicationMixin#_replaceHTML` either `replaceWith`s the
   * part or `replaceChildren`s it (`handlebars-application.mjs:213-214`), so the previous
   * preview — and every listener on it — is detached and collected. That is also why the
   * click-to-place and marker-drag loops in `_onRender` need no guard. An earlier flag here
   * looked like it prevented listener duplication; it never fired once.
   */
  #wirePreviewViewport(preview, faceIndex) {
    preview.querySelector(".fe-sp-overlay-view-reset")?.addEventListener("click", (event) => {
      // View state only — marker positions are document data and are deliberately left
      // alone, so this can never undo an edit.
      event.preventDefault();
      event.stopPropagation();
      this.#previewView.set(faceIndex, { pan: { x: 0, y: 0 }, zoom: 1 });
      this.#applyPreviewView(preview, faceIndex);
    });

    preview.addEventListener("pointerdown", (event) => {
      if (event.button !== 0 && event.button !== 2) return;
      // A marker is its own drag handle and stops propagation, so anything that reaches
      // here is empty space. The one exception is the reset button.
      if (event.target.closest?.(".fe-sp-overlay-view-reset")) return;
      event.preventDefault();

      const startX = event.clientX;
      const startY = event.clientY;
      const start = { ...this.#previewViewFor(faceIndex).pan };
      preview.classList.add("fe-sp-preview-panning");
      preview.setPointerCapture?.(event.pointerId);

      const onMove = (e) => {
        e.preventDefault();
        const view = this.#previewViewFor(faceIndex);
        view.pan = { x: start.x + (e.clientX - startX), y: start.y + (e.clientY - startY) };
        this.#applyPreviewView(preview, faceIndex);
      };
      const done = (e) => {
        preview.releasePointerCapture?.(e.pointerId);
        preview.classList.remove("fe-sp-preview-panning");
        preview.removeEventListener("pointermove", onMove);
        preview.removeEventListener("pointerup", done);
        preview.removeEventListener("pointercancel", done);
      };
      preview.addEventListener("pointermove", onMove);
      preview.addEventListener("pointerup", done);
      preview.addEventListener("pointercancel", done);
    });

    // Right-drag pans too, so suppress the menu that would otherwise land on release.
    preview.addEventListener("contextmenu", (event) => event.preventDefault());

    preview.addEventListener("wheel", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const view = this.#previewViewFor(faceIndex);
      const perLine = event.deltaMode === WheelEvent.DOM_DELTA_LINE ? 16
        : event.deltaMode === WheelEvent.DOM_DELTA_PAGE ? preview.clientHeight : 1;
      const delta = Math.min(100, Math.max(-100, event.deltaY * perLine));
      const zoom = Math.min(
        FE_PREVIEW_ZOOM_MAX,
        Math.max(FE_PREVIEW_ZOOM_MIN, view.zoom * Math.exp(-delta * 0.0015))
      );
      if (Math.abs(zoom - view.zoom) < 0.0001) return;

      // Keep the image point under the cursor stationary. The stage's anchor is the
      // viewport centre plus the current pan, and pan is applied before `scale()` in the
      // transform, so it lives in unscaled viewport pixels — the same convention (and
      // the same correction) as `_feTPWireZoom` in fe-token-preview.js.
      const rect = preview.getBoundingClientRect();
      const fromAnchorX = event.clientX - rect.left - rect.width / 2 - view.pan.x;
      const fromAnchorY = event.clientY - rect.top - rect.height / 2 - view.pan.y;
      const ratio = zoom / view.zoom;
      view.pan = {
        x: view.pan.x + fromAnchorX * (1 - ratio),
        y: view.pan.y + fromAnchorY * (1 - ratio),
      };
      view.zoom = zoom;
      this.#applyPreviewView(preview, faceIndex);
    }, { passive: false });
  }

  /** @override */
  _onRender(context, options) {
    super._onRender?.(context, options);
    this.#syncTokenizeButton();
    this.#pruneForeignHeaderControlDom();
    this.#setupOverlayPreviews();
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

  /**
   * Rebuild + persist the faces array (preserves all current input edits via re-render).
   * `extra` carries sibling keys that must land in the SAME update — notably
   * `system.defaultFace`, which is a positional index into this very array and would
   * otherwise silently point at a different face after an insert/remove/reorder.
   */
  async #updateFaces(faces, extra = {}) {
    return this.document.update({ "system.faces": faces, ...extra });
  }

  /** `{ "system.defaultFace": n }` when the pointer moved, else `{}` (no needless write). */
  #defaultFacePatch(next) {
    const current = this.document.system.defaultFace ?? 0;
    return next === current ? {} : { "system.defaultFace": Math.max(0, next) };
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
   *
   * The same one-shot frame also carries the prototype-token button, which is
   * token-only; the `fe-sp-tokenized` root class set here is what reveals it
   * (CSS, so both directions of the flip are covered without DOM surgery).
   */
  #syncTokenizeButton() {
    const on = !!this.document.system.tokenize;
    this.element?.classList.toggle("fe-sp-tokenized", on);
    const btn = this.element?.querySelector('[data-action="feToggleTokenize"]');
    if (!btn) return;
    btn.classList.toggle("fa-chess-pawn", on);
    btn.classList.toggle("fa-square", !on);
    btn.classList.toggle("fa-solid", on);
    btn.classList.toggle("fa-regular", !on);
    const label = game.i18n.localize(on ? "FESP.Sheet.TokenizeOn" : "FESP.Sheet.TokenizeOff");
    btn.setAttribute("aria-label", label);
    btn.dataset.tooltip = label;
  }

  /**
   * Belt-and-braces for the `_headerControlButtons` filter: v14 builds the `⋮`
   * menu lazily through that generator (so the filter is authoritative there),
   * but a build that instead renders the controls into a static frame-time
   * `<ul class="controls-dropdown">` would bypass it. Sweep the rendered DOM with
   * the same allowlist; a no-op wherever that element does not exist.
   */
  #pruneForeignHeaderControlDom() {
    const menu = this.element?.querySelector(".controls-dropdown");
    if (!menu) return;
    for (const li of menu.querySelectorAll("li.header-control")) {
      // `_renderHeaderControl` stringifies a missing action to "undefined".
      const action = li.dataset.action === "undefined" ? "" : (li.dataset.action ?? "");
      if (ScreenPanelSheet.#headerControlAllowed({ action })) continue;
      ScreenPanelSheet.#logDroppedHeaderControl({
        action,
        label: li.querySelector(".control-label")?.textContent?.trim(),
      });
      li.remove();
    }
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
    this.#remapPreviewView((idx) => (idx === i ? null : idx > i ? idx - 1 : idx));
    if (this.#activeFaceIndex >= faces.length) this.#activeFaceIndex = Math.max(0, faces.length - 1);
    else if (this.#activeFaceIndex > i) this.#activeFaceIndex--;
    const df = this.document.system.defaultFace ?? 0;
    await this.#updateFaces(faces, this.#defaultFacePatch(df > i ? df - 1 : Math.min(df, faces.length - 1)));
  }

  /**
   * Clone a face — image, description, link, per-face token settings, copied
   * attributes AND every overlay (position, styling, per-overlay actor link) — and
   * insert it directly after the original. A second face usually differs from the
   * first by one image or one overlay value, and rebuilding a dozen positioned
   * overlays by hand was the sheet's most tedious workflow.
   */
  static async #onDuplicateFace(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (!Number.isInteger(i) || i < 0 || i >= faces.length) return;
    const copy = foundry.utils.deepClone(faces[i]);
    copy.name = game.i18n.format("FESP.Sheet.DuplicateFaceName", {
      name: faces[i].name || game.i18n.format("FESP.Sheet.FaceN", { n: i + 1 }),
    });
    faces.splice(i + 1, 0, copy);
    const camera = this.#previewView.get(i);
    this.#remapPreviewView((idx) => (idx > i ? idx + 1 : idx));
    // The copy opens on the same view as its original: you duplicate a face to tweak one
    // overlay, and re-finding the spot you were zoomed into is the tedious part. Cloned,
    // never shared — a shared object would make panning the copy drag the original too.
    if (camera) this.#previewView.set(i + 1, { pan: { ...camera.pan }, zoom: camera.zoom });
    this.#activeFaceIndex = i + 1;
    const df = this.document.system.defaultFace ?? 0;
    await this.#updateFaces(faces, this.#defaultFacePatch(df > i ? df + 1 : df));
  }

  static async #onMoveFaceUp(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (i <= 0 || i >= faces.length) return;
    [faces[i - 1], faces[i]] = [faces[i], faces[i - 1]];
    this.#remapPreviewView((idx) => ScreenPanelSheet.#swapIndex(idx, i - 1, i));
    if (this.#activeFaceIndex === i) this.#activeFaceIndex = i - 1;
    else if (this.#activeFaceIndex === i - 1) this.#activeFaceIndex = i;
    await this.#updateFaces(faces, this.#defaultFacePatch(ScreenPanelSheet.#swapIndex(this.document.system.defaultFace ?? 0, i - 1, i)));
  }

  /** Follow a two-element swap: an index sitting on either side moves with its face. */
  static #swapIndex(index, a, b) {
    if (index === a) return b;
    if (index === b) return a;
    return index;
  }

  static async #onMoveFaceDown(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (i < 0 || i >= faces.length - 1) return;
    [faces[i + 1], faces[i]] = [faces[i], faces[i + 1]];
    this.#remapPreviewView((idx) => ScreenPanelSheet.#swapIndex(idx, i, i + 1));
    if (this.#activeFaceIndex === i) this.#activeFaceIndex = i + 1;
    else if (this.#activeFaceIndex === i + 1) this.#activeFaceIndex = i;
    await this.#updateFaces(faces, this.#defaultFacePatch(ScreenPanelSheet.#swapIndex(this.document.system.defaultFace ?? 0, i, i + 1)));
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
      x: 0.5, y: 0.5,
      // An overlay's `attr` resolves against its OWN linked actor and nothing else
      // (feResolveOverlayText) — the face's link is not a fallback. Seeding it from
      // the face is what the user almost always wants and removes the trap where a
      // pasted path silently resolves to nothing; the link is still clearable.
      linkedActorUuid: faces[fi].linkedActorUuid ?? "",
      attr: "", text: "", fontSize: 28, color: "#ffffff",
      bar: false, barMin: 0, barMax: 100,
      barMode: "under", barWidth: 0, barHeight: 6, barColor: "#33cc33",
      barBorderWidth: 0, barBorderColor: "#000000",
    });
    await this.#updateFaces(faces);
  }

  static async #onRemoveOverlay(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    const overlays = faces[fi]?.overlays;
    if (!overlays || oi < 0 || oi >= overlays.length) return;
    overlays.splice(oi, 1);
    await this.#updateFaces(faces);
  }

  static async #onClearOverlayLinkedActor(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    await this.#updateOverlayLinkedActor(fi, oi, "");
  }

  /**
   * Everything except the static text lives in this dialog: the attribute path plus
   * the styling fields (font size, color, value bar). The row keeps only what is read
   * at a glance — number, actor link, fallback text — because the bar's six fields
   * (min/max/mode/length/thickness/color) would have pushed it past usable.
   *
   * The attr picker is a `<datalist>` built HERE, per overlay, from that overlay's OWN
   * linked actor. It used to be one datalist per row on every render of the active face;
   * on demand for exactly one overlay is both cheaper and where the path is now edited.
   */
  static async #onEditOverlay(event, target) {
    const fi = Number(target.dataset.faceIndex);
    const oi = Number(target.dataset.overlayIndex);
    const ov = this.document.system.faces?.[fi]?.overlays?.[oi];
    if (!ov) return;
    const esc = foundry.utils.escapeHTML ?? ((s) => s);
    const L = (k) => game.i18n.localize(k);
    let linkedActor = null;
    if (ov.linkedActorUuid) { try { linkedActor = fromUuidSync(ov.linkedActorUuid); } catch { /* stale uuid */ } }
    const options = this.#attrSuggestions(linkedActor);
    const listId = `fe-sp-attrlist-${fi}-${oi}`;
    const content = `
      <div class="fe-sp-overlay-edit-form">
        <div class="fe-sp-field fe-sp-field-wide">
          <label>${L("FESP.Sheet.OverlayAttr")}</label>
          <input type="text" name="attr" value="${esc(ov.attr ?? "")}"
                 placeholder="${esc(L("FESP.Sheet.OverlayAttrPh"))}"
                 ${options.length ? `list="${listId}"` : ""}>
          ${options.length ? `<datalist id="${listId}">${
            options.map(o => `<option value="${esc(o.path)}">${esc(o.label)}</option>`).join("")
          }</datalist>` : ""}
        </div>
        <hr>
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
          <label>${L("FESP.Sheet.OverlayBarMode")}</label>
          <select name="barMode">
            <option value="under" ${ov.barMode === "inside" ? "" : "selected"}>${L("FESP.Sheet.OverlayBarModeUnder")}</option>
            <option value="inside" ${ov.barMode === "inside" ? "selected" : ""}>${L("FESP.Sheet.OverlayBarModeInside")}</option>
          </select>
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarWidth")}</label>
          <input type="number" name="barWidth" value="${ov.barWidth ?? 0}" min="0" step="1"
                 placeholder="${esc(L("FESP.Sheet.OverlayBarWidthPh"))}">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarHeight")}</label>
          <input type="number" name="barHeight" value="${ov.barHeight ?? 6}" min="1" step="1">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarColor")}</label>
          <input type="color" name="barColor" value="${esc(ov.barColor ?? "#33cc33")}">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarBorderWidth")}</label>
          <input type="number" name="barBorderWidth" value="${ov.barBorderWidth ?? 0}" min="0" step="1"
                 placeholder="${esc(L("FESP.Sheet.OverlayBarBorderWidthPh"))}">
        </div>
        <div class="fe-sp-field">
          <label>${L("FESP.Sheet.OverlayBarBorderColor")}</label>
          <input type="color" name="barBorderColor" value="${esc(ov.barBorderColor ?? "#000000")}">
        </div>
        <p class="notes fe-sp-overlay-bar-note">${L("FESP.Sheet.OverlayBarNote")}</p>
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
            attr: (form.elements.attr?.value ?? "").trim(),
            fontSize: Number(form.elements.fontSize?.value) || 28,
            color: form.elements.color?.value || "#ffffff",
            bar: !!form.elements.bar?.checked,
            barMin: Number(form.elements.barMin?.value) || 0,
            barMax: Number(form.elements.barMax?.value) || 100,
            barMode: form.elements.barMode?.value === "inside" ? "inside" : "under",
            // 0 is a MEANINGFUL value here (auto-width), so `|| 0` is the fallback
            // rather than a bug — an empty/NaN field means "auto", same as typing 0.
            barWidth: Math.max(0, Math.round(Number(form.elements.barWidth?.value) || 0)),
            barHeight: Math.max(1, Number(form.elements.barHeight?.value) || 6),
            // Like barWidth, 0 is meaningful (no outline) rather than missing.
            barBorderWidth: Math.max(0, Math.round(Number(form.elements.barBorderWidth?.value) || 0)),
            barBorderColor: form.elements.barBorderColor?.value || "#000000",
            barColor: form.elements.barColor?.value || "#33cc33",
          };
          await this.#updateOverlayFields(fi, oi, patch);
        },
      },
    });
  }

  static async #onAddCustomAttr() {
    const items = foundry.utils.deepClone(this.document.system.customAttributes ?? []);
    // A blank name would be cleaned back to the field's bare initial ("jk"), so every
    // added row would share one label. Number it against the rows already present.
    items.push({ name: feNextCustomAttrName(items), value: "" });
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
