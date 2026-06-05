// fe-playlist-name.js
// 플레이리스트 트랙 자동 이름을 "원본 파일명 그대로"(확장자만 제거)로.
//
// 코어 기본: AudioHelper.getDefaultSoundName 은 파일명에서 확장자를 떼고
//   name.replace(/[-_.]/g, " ").titleCase() 로 정규화한다 → 하이픈·언더스코어·점이
//   공백으로 바뀌고 대소문자도 titleCase 로 손실된다(예: "bgm_Battle-01" → "Bgm Battle 01").
//
// 이 모듈은 그 정적 메서드를 교체해 확장자만 제거하고 파일명을 그대로 사용한다.
//   단일 추가(소리 설정창)와 일괄 추가(폴더/드래그드롭, playlist.mjs) 양쪽이 모두
//   이 함수를 호출하므로 한 곳만 바꿔도 둘 다 적용된다.

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
