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
              // Optional value bar (HP-bar style) rendered just below the text.
              // Only meaningful when `attr` resolves to a number against the
              // linked actor. Width always matches the rendered text's width
              // (no separate field) — height is the only bar dimension exposed.
              bar: new f.BooleanField({ initial: false }),
              barMin: new f.NumberField({ required: true, initial: 0, nullable: false }),
              barMax: new f.NumberField({ required: true, initial: 100, nullable: false }),
              barHeight: new f.NumberField({ required: true, integer: true, min: 1, initial: 6, nullable: false }),
              barColor: new f.StringField({ required: true, blank: false, initial: "#33cc33" }),
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
      customAttributes: new f.ArrayField(
        new f.SchemaField({
          name: new f.StringField({ required: true, blank: false, initial: "attr" }),
          value: new f.StringField({ required: false, blank: true, initial: "" }),
          max: new f.StringField({ required: false, blank: true, initial: "" }),
        }),
        {
          required: true,
          initial: [
            { name: "hp", value: "" }, { name: "mp", value: "" },
            { name: "ac", value: "" }, { name: "lv", value: "" },
          ],
        }
      ),
      // When true, placing this panel on a scene also creates a companion Token
      // (same position/face image) so it participates in core token mechanics
      // (selectable, combat tracker, etc). See feScreenPanelPlaceOnScene.
      tokenize: new f.BooleanField({ initial: false }),
    };
  }

  /** Clamp defaultFace into the valid range whenever data is prepared. */
  prepareDerivedData() {
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
  if (count === 0) return { name: "", img: "", description: "", overlays: [], linkedActorUuid: "", linkMode: "copy", index: 0, count: 0 };
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
    index: i,
    count,
  };
}

export {
  FE_PANEL_SUBTYPE,
  FE_PANEL_TYPE,
  FE_PANEL_TILE_FLAG,
  FE_PANEL_SOCKET,
  FE_PANEL_DEFAULT_SIZE,
  FE_PANEL_COMMON_ATTR_NAMES,
  feSortAttrItems,
  ScreenPanelData,
  fePanelFace,
};
