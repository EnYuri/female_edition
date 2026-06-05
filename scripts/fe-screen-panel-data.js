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
});

const FE_PANEL_DEFAULT_SIZE = 400;

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
        }),
        { required: true, initial: [] }
      ),
      defaultFace: new f.NumberField({ required: true, integer: true, min: 0, initial: 0, nullable: false }),
      width: new f.NumberField({ required: true, integer: true, min: 1, initial: FE_PANEL_DEFAULT_SIZE, nullable: false }),
      height: new f.NumberField({ required: true, integer: true, min: 1, initial: FE_PANEL_DEFAULT_SIZE, nullable: false }),
      locked: new f.BooleanField({ initial: false }),
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
  if (count === 0) return { name: "", img: "", description: "", index: 0, count: 0 };
  if (i < 0) i = 0;
  if (i >= count) i = count - 1;
  const face = faces[i] ?? {};
  return {
    name: face.name ?? "",
    img: face.img ?? "",
    description: face.description ?? "",
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
  ScreenPanelData,
  fePanelFace,
};
