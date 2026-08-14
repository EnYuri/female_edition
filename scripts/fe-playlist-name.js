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
    const file = String(src).split("/").pop();          // 경로 → 파일명
    const dot = file.lastIndexOf(".");
    const base = dot > 0 ? file.slice(0, dot) : file;    // 확장자만 제거(닷파일/무확장자는 유지)
    try { return decodeURIComponent(base); }             // %20 등 디코드
    catch { return base; }                               // 잘못된 % 시퀀스면 원본 그대로
  };
});
