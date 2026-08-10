// Tidy 5e Sheet overrides (split)
// This file intentionally stays light: most of the work is CSS-only.
// Adds a document class when Tidy5e is active so CSS can scope safely if needed.

// `setup`, NOT `ready`: this only reads game.modules (already populated at `init`)
// and writes one class. `Game#setupGame` awaits `canvas.initializing` with no timeout
// BEFORE calling the `ready` hook, and a scene whose tile is a stalled video hangs
// there forever — every `ready` handler is then skipped. A pure classList write has
// no reason to sit behind that. `ready` is kept as an idempotent second pass so a
// client that somehow reaches it still ends up in the same state.
function feTidyApplyScopeClass() {
  if (!game?.modules?.get?.("tidy5e-sheet")?.active) return;
  document.documentElement?.classList?.add("female_edition--tidy-ready");
}

Hooks.once("setup", feTidyApplyScopeClass);
Hooks.once("ready", feTidyApplyScopeClass);
