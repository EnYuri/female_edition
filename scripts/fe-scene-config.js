/**
 * fe-scene-config.js — 씬 설정 시트 보정 (테마 무관)
 *
 * 코어 SceneConfig는 `position: {width: 600}`으로 열린다(client/applications/
 * sheets/scene-config.mjs). 탭은 6개이고 nav는 `flex-flow: row nowrap`이라,
 * 라벨 총 폭이 600px를 넘으면 각 항목이 압축되면서 라벨이 공백에서 줄바꿈된다.
 *
 * 한국어 환경에서 특히 심하다. lang-ko의 씬 탭 번역은 v14 이전 id 기준이라
 * `basics`("세부사항 및 수치값")·`grid`("격자 설정") 두 개만 적용되고,
 * v14에서 추가된 `levels`·`visibility`·`environment`·`misc`는 번역이 없어
 * 영어("Miscellaneous" 등)로 남는다. 긴 한글 라벨과 긴 영어 라벨이 섞여
 * 600px를 확실히 초과한다.
 *
 * 대응은 두 갈래이고 둘 다 CORE_UI_SCENE_CONFIG_TABS 하나로 켜고 끈다:
 *   · 줄바꿈 금지 — styles/fe-scene-config.css (body 클래스로 게이트)
 *   · 창 기본 폭 확대 — 이 파일 (DEFAULT_OPTIONS를 직접 조정)
 *
 * 끄면 코어 기본값으로 완전히 되돌아간다. 넓어진 창이 이질적으로 느껴질 수
 * 있어 되돌릴 길을 남겨둔 것이므로, 복원이 부분적이면 설정의 의미가 없다.
 *
 * ── 이 설정이 "새로고침 필요"인 이유 (MUST) ─────────────────────
 * 시트 인스턴스는 문서에 캐시된다. client-document.mjs:213의 `get sheet()`는
 * `this._sheet`가 없을 때만 새로 만들고, 이후로는 같은 인스턴스를 계속 돌려준다.
 * ApplicationV2 생성자는 그 시점의 DEFAULT_OPTIONS를 병합해 `this.options`로
 * 얼려버리므로(application.mjs:39), 이미 한 번 연 씬은 나중에 우리가
 * DEFAULT_OPTIONS.position.width를 되돌려도 계속 넓은 폭을 쓴다.
 *
 * 그래서 런타임 onChange 재적용은 "되는 척"만 한다 — 창이 계속 760px이면
 * 탭은 nowrap이 없어도 어차피 한 줄에 들어가서, 설정을 꺼도 화면이 그대로다.
 * 저장 시 새로고침을 안내하고(fe-settings-menu.js § FE_RELOAD_REQUIRED_KEYS),
 * 여기서는 로드 시점에 한 번만 결정한다. 코어의 `requiresReload: true`는
 * 쓸 수 없다 — SettingsConfig 폼 제출에서만 읽히는데 우리는 config:false다.
 */

// 진입점 스크립트는 공개 API를 fe-chat-enhance.js에서 한 번에 가져오는 것이
// 이 모듈의 관행이다(chat-bg-stripper.js·fe-scene-controls-collapse.js와 동일).
// 하위 모듈만 fe-gm-priority.js를 직접 참조한다.
import { MODULE_ID, S, FE_DEFAULTS, feSetting } from "./fe-chat-enhance.js";

/**
 * 씬 설정 창의 기본 폭(px).
 *
 * 위 라벨 구성의 실측 상한(gap 포함 ~650px)에 커스텀 폰트가 기본 폰트보다
 * 넓은 경우를 감안한 여유를 더한 값이다. 내용 영역도 함께 넓어져 씬 설정의
 * 2열 폼이 덜 답답해지는 부수 효과가 있다.
 * @type {number}
 */
const FE_SCENE_CONFIG_WIDTH = 760;

/** styles/fe-scene-config.css의 줄바꿈 금지 규칙을 여는 body 클래스. */
const FE_SCENE_TABS_CLASS = "fe-scene-config-tabs";

/**
 * 우리가 건드리기 전의 코어 기본 폭. 설정을 껐을 때 정확히 이 값으로
 * 되돌리기 위해 최초 1회만 기록한다 — 매번 읽으면 우리가 쓴 760을 "코어
 * 기본값"으로 오인해 영영 못 돌아간다.
 * @type {number|null}
 */
let _feSceneConfigCoreWidth = null;

// game.settings.get이 아니라 feSetting을 쓴다. feSetting은 GM 우선권 오버라이드
// 저장소 → game.settings → 기본값 순으로 읽으므로, GM이 강제한 값이 각 클라이언트의
// game.settings에 동기화되기 전에도 올바른 값을 본다.
function feSceneConfigTabsEnabled() {
  try { return !!(feSetting(S.CORE_UI_SCENE_CONFIG_TABS) ?? FE_DEFAULTS[S.CORE_UI_SCENE_CONFIG_TABS]); }
  catch { return !!FE_DEFAULTS[S.CORE_UI_SCENE_CONFIG_TABS]; }
}

/**
 * 설정 상태를 실제 UI에 반영한다.
 * @param {boolean} enabled
 */
function feApplySceneConfigTabs(enabled) {
  document.body?.classList.toggle(FE_SCENE_TABS_CLASS, !!enabled);

  // DEFAULT_OPTIONS는 인스턴스마다 _initializeApplicationOptions가 다시 읽어
  // 상속 체인과 병합하며, freeze되는 것은 병합 결과인 this.options뿐이다
  // (client/applications/api/application.mjs:39,438-463). 따라서 여기서 기본값을
  // 바꾸면 "아직 시트가 만들어지지 않은" 씬에 반영된다. 이미 시트가 캐시된
  // 씬은 파일 상단의 설명대로 새로고침 전까지 옛 폭을 유지한다.
  const position = foundry.applications?.sheets?.SceneConfig?.DEFAULT_OPTIONS?.position;
  if ( !position ) return;
  if ( _feSceneConfigCoreWidth === null ) _feSceneConfigCoreWidth = position.width;

  // 코어가 언젠가 기본 폭을 760 이상으로 올리면 우리 값이 오히려 창을 좁힌다.
  position.width = enabled
    ? Math.max(FE_SCENE_CONFIG_WIDTH, _feSceneConfigCoreWidth)
    : _feSceneConfigCoreWidth;
}

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, S.CORE_UI_SCENE_CONFIG_TABS, {
    name: "코어 UI: 씬 설정 탭 한 줄 표시",
    hint: "씬 설정 창의 탭 이름이 두 줄로 접히지 않게 합니다. 창 기본 폭도 함께 넓어집니다. 변경하려면 새로고침이 필요합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.CORE_UI_SCENE_CONFIG_TABS],
    // onChange 없음 — 캐시된 시트에는 닿지 않아 "적용된 척"만 하게 된다.
    // 저장 직후 새로고침을 안내하는 쪽이 fe-settings-menu.js의 책임이다.
  });

  // init에서 한 번 적용해 둔다. 이 시점의 position.width가 아직 코어 기본값이라
  // _feSceneConfigCoreWidth 기록이 정확해지는 이점도 있다.
  feApplySceneConfigTabs(feSceneConfigTabsEnabled());
});

// ready에서 다시 적용한다 — init 시점에는 GM 우선권 오버라이드가 아직 로드되지
// 않아 feSetting이 로컬 값을 돌려줄 수 있고, ready에서야 최종값이 확정된다.
// (chat-bg-stripper.js가 폰트 클래스에 쓰는 것과 같은 init 선적용 → ready 확정 패턴.)
// 여기까지는 씬 설정 시트가 만들어지기 전이라 폭 변경이 아직 유효하다.
Hooks.once("ready", () => feApplySceneConfigTabs(feSceneConfigTabsEnabled()));
