// Tidy 5e Sheet overrides (split)
// This file intentionally stays light: most of the work is CSS-only.
// Adds a document class when Tidy5e is active so CSS can scope safely if needed.

Hooks.once("ready", () => {
  if (!game?.modules?.get?.("tidy5e-sheet")?.active) return;
  document.documentElement?.classList?.add("female_edition--tidy-ready");
});
