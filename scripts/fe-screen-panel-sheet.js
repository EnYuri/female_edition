// female_edition: Screen Panel — Actor sheet (ApplicationV2 / Handlebars).
//
// Edits the shared panel definition: the ordered list of faces (name + image +
// hover description) plus the default placement size and default face. Per-
// placement state (current face / disabled) is NOT edited here — it lives on the
// Tile and is changed via the on-canvas dropdown menu (fe-screen-panel-menu.js).
//
// AppV2 so it is forward-clean for v14; it also runs on v13.

import { MODULE_ID } from "./fe-constants.js";

const { HandlebarsApplicationMixin } = foundry.applications.api;
const { ActorSheetV2 } = foundry.applications.sheets;

class ScreenPanelSheet extends HandlebarsApplicationMixin(ActorSheetV2) {
  static DEFAULT_OPTIONS = {
    classes: ["female-edition", "fe-screen-panel-sheet"],
    position: { width: 560, height: "auto" },
    // Drop the inherited token-related header controls — panels do not use tokens.
    window: { controls: [] },
    form: { submitOnChange: true, closeOnSubmit: false },
    actions: {
      feAddFace: ScreenPanelSheet.#onAddFace,
      feRemoveFace: ScreenPanelSheet.#onRemoveFace,
      feMoveFaceUp: ScreenPanelSheet.#onMoveFaceUp,
      feMoveFaceDown: ScreenPanelSheet.#onMoveFaceDown,
      fePlaceOnScene: ScreenPanelSheet.#onPlaceOnScene,
    },
  };

  static PARTS = {
    form: { template: `modules/${MODULE_ID}/templates/screen-panel-sheet.hbs` },
  };

  /** @override */
  async _prepareContext(options) {
    const context = await super._prepareContext(options);
    const sys = this.document.system;
    const faces = (sys.faces ?? []).map((face, index) => ({
      index,
      num: index + 1,
      name: face.name ?? "",
      img: face.img ?? "",
      description: face.description ?? "",
    }));
    context.fe = {
      faces,
      defaultFace: sys.defaultFace ?? 0,
      width: sys.width,
      height: sys.height,
      locked: sys.locked,
      editable: this.isEditable,
      faceCount: faces.length,
    };
    return context;
  }

  /** Rebuild + persist the faces array (preserves all current input edits via re-render). */
  async #updateFaces(faces) {
    return this.document.update({ "system.faces": faces });
  }

  static async #onAddFace() {
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    faces.push({ name: "", img: "", description: "" });
    await this.#updateFaces(faces);
  }

  static async #onRemoveFace(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (!Number.isInteger(i) || i < 0 || i >= faces.length) return;
    faces.splice(i, 1);
    await this.#updateFaces(faces);
  }

  static async #onMoveFaceUp(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (i <= 0 || i >= faces.length) return;
    [faces[i - 1], faces[i]] = [faces[i], faces[i - 1]];
    await this.#updateFaces(faces);
  }

  static async #onMoveFaceDown(event, target) {
    const i = Number(target.dataset.index);
    const faces = foundry.utils.deepClone(this.document.system.faces ?? []);
    if (i < 0 || i >= faces.length - 1) return;
    [faces[i + 1], faces[i]] = [faces[i], faces[i + 1]];
    await this.#updateFaces(faces);
  }

  static async #onPlaceOnScene() {
    // Delegated to the entry module to avoid a circular import.
    const fn = globalThis.feScreenPanelPlaceOnScene;
    if (typeof fn === "function") await fn(this.document);
    else ui.notifications?.warn("Screen Panel: placement API not ready.");
  }
}

export { ScreenPanelSheet };
