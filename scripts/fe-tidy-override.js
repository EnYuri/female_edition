// Tidy 5e Sheet overrides (split)
// This file intentionally stays light: most of the work is CSS-only.

import { MODULE_ID } from "./fe-chat-enhance.js";

Hooks.once("ready", () => {
  // If tidy sheet is not installed, do nothing.
  if (!game?.modules?.get?.("tidy5e-sheet")?.active && !document.querySelector(".tidy5e-sheet")) return;

  // Mark the document so CSS can scope more safely if needed.
  document.documentElement?.classList?.add(`${MODULE_ID}--tidy-ready`);
});
