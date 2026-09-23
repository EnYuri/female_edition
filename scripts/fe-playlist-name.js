// fe-playlist-name.js
// Name playlist tracks after the original filename, stripping only the extension.
//
// Core's AudioHelper.getDefaultSoundName drops the extension and then normalizes with
// name.replace(/[-_.]/g, " ").titleCase(), so hyphens, underscores and dots all become
// spaces and the original casing is lost ("bgm_Battle-01" -> "Bgm Battle 01").
//
// Replacing that one static method covers both paths: adding a single sound from the
// sound config dialog, and bulk-adding via folder drag-and-drop (playlist.mjs).

Hooks.once("init", () => {
  const AH = foundry.audio?.AudioHelper;
  if (!AH || typeof AH.getDefaultSoundName !== "function") return;

  AH.getDefaultSoundName = function (src) {
    const file = String(src).split("/").pop();          // path → filename
    const dot = file.lastIndexOf(".");
    const base = dot > 0 ? file.slice(0, dot) : file;    // strip only the extension (keep dotfiles/extensionless)
    try { return decodeURIComponent(base); }             // decode %20 etc.
    catch { return base; }                               // invalid % sequence → keep as-is
  };
});
