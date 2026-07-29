// female_edition: Screen Panel — data model + shared constants.
//
// A "screen panel" is a module-defined Actor sub-type (female_edition.screenPanel)
// that represents a CoCoFolia-style screen panel: a multi-faced image/info panel
// that can be placed on the scene canvas as a Tile and flipped between faces.
//
// The Actor holds the SHARED definition (the list of faces + default size). The
// per-placement runtime state (which face is showing, whether it is disabled)
// lives on each Tile's flags — see FE_PANEL_TILE_FLAG — because the same panel
// actor may be placed multiple times on one scene.
//
// This file deliberately keeps its only import to fe-constants.js (the dependency
// root) so it sits at the bottom of the screen-panel dependency order:
//   data ← sheet / menu ← fe-screen-panel (entry)

import { MODULE_ID } from "./fe-constants.js";

// Sub-type id pieces. Module sub-types are namespaced as "<moduleId>.<subtype>".
const FE_PANEL_SUBTYPE = "screenPanel";
const FE_PANEL_TYPE = `${MODULE_ID}.${FE_PANEL_SUBTYPE}`;

// Tile flag: flags.female_edition.panel = { actorId, currentFace, disabled }
const FE_PANEL_TILE_FLAG = "panel";

// Socket discriminators (shared "module.female_edition" channel — every consumer
// ignores foreign `type` values, see fe-theatre.js / fe-typing-indicator.js).
const FE_PANEL_SOCKET = Object.freeze({
  PLACE: "panelPlace",
  REMOVE: "panelRemove",
  SHOW_HIDE: "panelShowHide",
  FLIP: "panelFlip",
  DISABLE: "panelDisable",
  MOVE: "panelMove",
  LOCK: "panelLock",
  SORT: "panelSort",
});

const FE_PANEL_DEFAULT_SIZE = 400;

// Display order for the "패널 어트리뷰트" tab (both the panel's own customAttributes
// and any reference actor's real attributes): these common names first, in this
// order, then everything else alphabetically. Purely a display concern — storage
// order is untouched.
const FE_PANEL_COMMON_ATTR_NAMES = [
  // dnd5e
  "hp", "ac", "str", "dex", "con", "int", "wis", "cha",
  // double-cross-3rd (침식률 + 능력치 body/sense/mind/social)
  "encroachment", "body", "sense", "mind", "social",
];

// A panel's own customAttributes are free-form slots, NOT system values, so their
// DEFAULT labels are deliberately meaningless: an "hp"/"ac"/"mp"/"lv" default (what
// this used to ship) collides with real system attribute names — it sorts to the
// front via FE_PANEL_COMMON_ATTR_NAMES, reads as if the panel tracked that stat, and
// invites a macro/module/user to address it by name when the only address that ever
// resolves is the positional path `system.customAttributes.<index>.value`.
// `jk<n>` collides with nothing and is obviously a placeholder to rename.
const FE_PANEL_ATTR_NAME_PREFIX = "jk";
const FE_PANEL_DEFAULT_ATTR_COUNT = 4;

/** Lowest-numbered `jk<n>` not already used by `items` — keeps added rows unique. */
function feNextCustomAttrName(items) {
  const used = new Set((items ?? []).map(a => String(a?.name ?? "")));
  let n = 1;
  while (used.has(`${FE_PANEL_ATTR_NAME_PREFIX}${n}`)) n++;
  return `${FE_PANEL_ATTR_NAME_PREFIX}${n}`;
}

class ScreenPanelSourcedItemsMap extends Map {
  get(key) {
    if (!key) return undefined;
    return super.get(key);
  }

  set(key, value) {
    if (!key) return this;
    if (!super.has(key)) super.set(key, new Set());
    super.get(key).add(value);
    return this;
  }

  _redirectKeys() {
    // dnd5e 5.3.3 calls this on every Actor during ready. Screen panels do not
    // participate in dnd5e sourced-item redirects, but the method must exist.
  }
}

function feEnsureScreenPanelDnd5eActorCompat(actor) {
  if (!actor || actor.type !== FE_PANEL_TYPE) return;
  if (actor.sourcedItems && typeof actor.sourcedItems._redirectKeys === "function") return;
  try {
    Object.defineProperty(actor, "sourcedItems", {
      value: new ScreenPanelSourcedItemsMap(),
      configurable: true,
      enumerable: false,
      writable: true,
    });
  } catch {
    actor.sourcedItems = new ScreenPanelSourcedItemsMap();
  }
}

/**
 * Sort `{name, ...}` items for display: FE_PANEL_COMMON_ATTR_NAMES (case-insensitive)
 * first in that fixed order, then the rest alphabetically. Does not mutate input.
 * @param {Array<{name: string}>} items
 * @returns {Array<{name: string}>}
 */
function feSortAttrItems(items) {
  const rank = new Map(FE_PANEL_COMMON_ATTR_NAMES.map((n, i) => [n, i]));
  return [...(items ?? [])].sort((a, b) => {
    const ra = rank.get((a.name ?? "").toLowerCase());
    const rb = rank.get((b.name ?? "").toLowerCase());
    if (ra !== undefined || rb !== undefined) return (ra ?? Infinity) - (rb ?? Infinity);
    return (a.name ?? "").localeCompare(b.name ?? "", "ko");
  });
}

/**
 * TypeDataModel for the screenPanel Actor sub-type.
 */
class ScreenPanelData extends foundry.abstract.TypeDataModel {
  static defineSchema() {
    const f = foundry.data.fields;
    return {
      faces: new f.ArrayField(
        new f.SchemaField({
          name: new f.StringField({ required: true, blank: true, initial: "" }),
          img: new f.FilePathField({ categories: ["IMAGE"], required: false, blank: true }),
          description: new f.HTMLField({ required: false, blank: true }),
          linkedActorUuid: new f.StringField({ required: false, blank: true, initial: "" }),
          linkMode: new f.StringField({ required: true, blank: false, initial: "copy", choices: ["copy", "linked"] }),
          // This face's own Token settings, as a PrototypeToken-shaped source object —
          // each face is effectively its own token, so a status board's "alert" face can
          // carry a different name/size/disposition/bars than its "calm" face. Edited with
          // CORE's own PrototypeTokenConfig (see FeFaceTokenConfig in the sheet) and applied
          // on placement and on every face flip, but ONLY when the panel is tokenized.
          //
          // An untyped ObjectField rather than a mirror of the token schema: core owns that
          // schema and it changes between versions — cleaning/validating happens for free
          // when the object is handed to `new PrototypeToken(data, {parent: actor})`.
          // Position keys (x/y/_id/actorId) are stripped before it is stored: those are
          // per-placement, not per-face.
          token: new f.ObjectField({ required: false, initial: () => ({}) }),
          // Per-face attributes copied from this face's linked actor, snapshot
          // on link (system-agnostic — see ScreenPanelSheet#extractCopiedAttributes).
          // Kept PER-FACE so different faces linking different actors retain
          // independent attribute sets (no cross-face dedup/overwrite). `attr`
          // records the source dot-path so an overlay can read the live value.
          attributes: new f.ArrayField(
            new f.SchemaField({
              name: new f.StringField({ required: true, blank: true, initial: "" }),
              value: new f.StringField({ required: false, blank: true, initial: "" }),
              max: new f.StringField({ required: false, blank: true, initial: "" }),
              attr: new f.StringField({ required: false, blank: true, initial: "" }),
            }),
            { required: true, initial: [] }
          ),
          overlays: new f.ArrayField(
            new f.SchemaField({
              x: new f.NumberField({ required: true, min: 0, max: 1, initial: 0.5, nullable: false }),
              y: new f.NumberField({ required: true, min: 0, max: 1, initial: 0.5, nullable: false }),
              // Optional Actor THIS overlay's `attr` resolves against. Per-overlay
              // (not per-face/per-panel) — different labels on the same face may
              // each read from a different actor (e.g. a party status board with
              // one HP number per party member, all on a single image).
              linkedActorUuid: new f.StringField({ required: false, blank: true, initial: "" }),
              // Live value source: a dot-path resolved against this overlay's own
              // linkedActorUuid (e.g. "system.attributes.hp.value"). Takes
              // priority over `text` when it resolves to a non-empty value.
              attr: new f.StringField({ required: false, blank: true, initial: "" }),
              // Static fallback text, shown when `attr` is blank or does not resolve.
              text: new f.StringField({ required: false, blank: true, initial: "" }),
              fontSize: new f.NumberField({ required: true, integer: true, min: 4, initial: 28, nullable: false }),
              color: new f.StringField({ required: true, blank: false, initial: "#ffffff" }),
              // Optional value bar (HP-bar style). Only meaningful when `attr`
              // resolves to a number against the linked actor.
              bar: new f.BooleanField({ initial: false }),
              barMin: new f.NumberField({ required: true, initial: 0, nullable: false }),
              barMax: new f.NumberField({ required: true, initial: 100, nullable: false }),
              // Where the bar sits relative to the text:
              //   "under"  — text on top, thin bar drawn just below it (the original look)
              //   "inside" — bar-first "boss HP" layout: the bar IS the element and the
              //              text is drawn centered inside it. The thickness then has a
              //              floor of the text's own rendered height, i.e. the FONT SIZE
              //              is what sets the bar's default thickness and `barHeight` can
              //              only push it thicker.
              barMode: new f.StringField({ required: true, blank: false, initial: "under", choices: ["under", "inside"] }),
              // Bar LENGTH in the face image's own pixels (scaled with the panel exactly
              // like `fontSize`). 0 = auto — the rendered text's own width, which is what
              // the original bar always did; back then padding the text with spaces was
              // the only way to widen it.
              barWidth: new f.NumberField({ required: true, integer: true, min: 0, initial: 0, nullable: false }),
              // Bar THICKNESS, same units. In "inside" mode it is a floor, not the value.
              barHeight: new f.NumberField({ required: true, integer: true, min: 1, initial: 6, nullable: false }),
              barColor: new f.StringField({ required: true, blank: false, initial: "#33cc33" }),
              // Outline drawn on the bar's own box. The track is black at 50% alpha, which
              // is INVISIBLE on dark face art (live-verified) — in "inside" mode that made
              // the bar read as a floating block of fill with the number beside it rather
              // than as a bar. A width rather than "just a colour" because `<input
              // type="color">` cannot express "off" and because a 1px outline authored in
              // image pixels vanishes once the panel is scaled down. 0 = no outline, which
              // is what every pre-existing overlay keeps.
              barBorderWidth: new f.NumberField({ required: true, integer: true, min: 0, initial: 0, nullable: false }),
              barBorderColor: new f.StringField({ required: true, blank: false, initial: "#000000" }),
            }),
            { required: true, initial: [] }
          ),
        }),
        { required: true, initial: [] }
      ),
      defaultFace: new f.NumberField({ required: true, integer: true, min: 0, initial: 0, nullable: false }),
      width: new f.NumberField({ required: true, integer: true, min: 1, initial: FE_PANEL_DEFAULT_SIZE, nullable: false }),
      height: new f.NumberField({ required: true, integer: true, min: 1, initial: FE_PANEL_DEFAULT_SIZE, nullable: false }),
      locked: new f.BooleanField({ initial: false }),
      // Whether double-clicking this panel on the canvas cycles to the next face.
      // Lives on the ACTOR (world data) rather than a client setting so a GM turning
      // it off applies to every user, not just themselves — and so each panel can
      // differ (a decorative board vs. an interactive one).
      dblclickCycle: new f.BooleanField({ initial: true }),
      customAttributes: new f.ArrayField(
        new f.SchemaField({
          name: new f.StringField({ required: true, blank: false, initial: FE_PANEL_ATTR_NAME_PREFIX }),
          value: new f.StringField({ required: false, blank: true, initial: "" }),
          max: new f.StringField({ required: false, blank: true, initial: "" }),
        }),
        {
          required: true,
          initial: () => Array.from(
            { length: FE_PANEL_DEFAULT_ATTR_COUNT },
            (_, i) => ({ name: `${FE_PANEL_ATTR_NAME_PREFIX}${i + 1}`, value: "" })
          ),
        }
      ),
      // How this panel is placed on a scene: as a TOKEN when true, as a TILE when
      // false — one placeable, never both. A tokenized panel participates in core
      // token mechanics (selectable, combat tracker, native drag/snap) and core owns
      // its interaction; female_edition only adds the right-click face menu, the
      // overlays and the sheet. Toggling this CONVERTS existing placements in place
      // (feSyncPanelTokenization), preserving position, size and per-placement flags.
      tokenize: new f.BooleanField({ initial: false }),
    };
  }

  /** Clamp defaultFace into the valid range whenever data is prepared. */
  prepareDerivedData() {
    feEnsureScreenPanelDnd5eActorCompat(this.parent);

    const n = this.faces?.length ?? 0;
    if (n === 0) this.defaultFace = 0;
    else if (this.defaultFace >= n) this.defaultFace = n - 1;
    else if (this.defaultFace < 0) this.defaultFace = 0;
  }
}

/**
 * Resolve a face object (with safe fallbacks) for a given index.
 * @param {Actor} actor
 * @param {number} index
 * @returns {{name:string,img:string,description:string,index:number,count:number}}
 */
function fePanelFace(actor, index) {
  const faces = actor?.system?.faces ?? [];
  const count = faces.length;
  let i = Number.isInteger(index) ? index : 0;
  if (count === 0) return { name: "", img: "", description: "", overlays: [], linkedActorUuid: "", linkMode: "copy", token: {}, index: 0, count: 0 };
  if (i < 0) i = 0;
  if (i >= count) i = count - 1;
  const face = faces[i] ?? {};
  return {
    name: face.name ?? "",
    img: face.img ?? "",
    description: face.description ?? "",
    overlays: face.overlays ?? [],
    linkedActorUuid: face.linkedActorUuid ?? "",
    linkMode: face.linkMode ?? "copy",
    token: face.token ?? {},
    index: i,
    count,
  };
}

/**
 * Keys that must never survive into a face's stored Token settings: they identify a
 * specific placement (or document), not the face's appearance.
 */
const FE_PANEL_FACE_TOKEN_STRIP = ["_id", "x", "y", "actorId", "tokenId", "delta", "elevation", "sort", "hidden"];

/** Strip per-placement keys from a PrototypeToken-shaped object before storing it on a face. */
function feCleanFaceTokenData(data) {
  const out = foundry.utils.deepClone(data ?? {});
  for (const k of FE_PANEL_FACE_TOKEN_STRIP) delete out[k];
  return out;
}

/** Whether a face's Token settings explicitly pin a size (→ the aspect auto-fit must stand down). */
function feFaceTokenPinsSize(face) {
  const t = face?.token;
  return Number.isFinite(t?.width) && Number.isFinite(t?.height);
}

export {
  FE_PANEL_SUBTYPE,
  FE_PANEL_TYPE,
  FE_PANEL_TILE_FLAG,
  FE_PANEL_SOCKET,
  FE_PANEL_DEFAULT_SIZE,
  FE_PANEL_COMMON_ATTR_NAMES,
  FE_PANEL_ATTR_NAME_PREFIX,
  feNextCustomAttrName,
  feSortAttrItems,
  feEnsureScreenPanelDnd5eActorCompat,
  feCleanFaceTokenData,
  feFaceTokenPinsSize,
  ScreenPanelData,
  fePanelFace,
};
