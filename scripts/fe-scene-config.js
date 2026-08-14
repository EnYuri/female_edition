/**
 * fe-scene-config.js — Scene Config sheet fixes (theme-independent).
 *
 * Core opens SceneConfig at `position: {width: 600}` with 6 tabs in a `row nowrap` nav, so
 * once the labels exceed 600px they compress and wrap at spaces. Korean makes this worse:
 * lang-ko only translates the pre-v14 tab ids (`basics`, `grid`), leaving v14's `levels`,
 * `visibility`, `environment` and `misc` in English, and the mix overflows reliably.
 *
 * Two halves, both gated on CORE_UI_SCENE_CONFIG_TABS: nowrap comes from
 * styles/fe-scene-config.css (via a body class), the wider default window from this file
 * (DEFAULT_OPTIONS). Turning it off must restore core exactly — a partial restore would
 * make the setting pointless.
 *
 * WHY THIS SETTING REQUIRES A RELOAD (MUST): a Document caches its sheet instance in
 * `_sheet` (client-document.mjs:213) and ApplicationV2 freezes `this.options` at
 * construction (application.mjs:39), so an already-opened scene keeps the old width
 * forever. A runtime onChange would only look like it worked — at 760px the tabs fit on
 * one line even without nowrap, so turning the setting off would change nothing on screen.
 * fe-settings-menu.js § FE_RELOAD_REQUIRED_KEYS prompts for the reload; core's own
 * `requiresReload` is inert here because it is read only by SettingsConfig's submit and
 * every setting in this module is `config: false`.
 */

// Entry-point scripts pull the public API from fe-chat-enhance.js in one import (same as
// chat-bg-stripper.js and fe-scene-controls-collapse.js); only sub-modules reach into
// fe-gm-priority.js directly.
import { MODULE_ID, S, FE_DEFAULTS, feSetting } from "./fe-chat-enhance.js";

/**
 * Scene Config window default width in px. The measured label run tops out around 650px
 * including gaps; the rest is headroom for custom fonts wider than the default.
 * @type {number}
 */
const FE_SCENE_CONFIG_WIDTH = 760;

/** Body class that opens the nowrap rules in styles/fe-scene-config.css. */
const FE_SCENE_TABS_CLASS = "fe-scene-config-tabs";

/**
 * Core's default width, captured ONCE before we touch it. Re-reading it every time would
 * mistake our own 760 for the core default and make the off state unreachable.
 * @type {number|null}
 */
let _feSceneConfigCoreWidth = null;

// feSetting, not game.settings.get: it reads the GM-priority override store first, so a
// GM-forced value is correct even before it syncs into each client's game.settings.
function feSceneConfigTabsEnabled() {
  try { return !!(feSetting(S.CORE_UI_SCENE_CONFIG_TABS) ?? FE_DEFAULTS[S.CORE_UI_SCENE_CONFIG_TABS]); }
  catch { return !!FE_DEFAULTS[S.CORE_UI_SCENE_CONFIG_TABS]; }
}

/**
 * @param {boolean} enabled
 */
function feApplySceneConfigTabs(enabled) {
  document.body?.classList.toggle(FE_SCENE_TABS_CLASS, !!enabled);

  // DEFAULT_OPTIONS is re-read per instance by _initializeApplicationOptions; only the
  // merged result (this.options) is frozen. So changing it here reaches scenes whose sheet
  // has not been constructed yet — already-cached ones keep the old width until reload.
  const position = foundry.applications?.sheets?.SceneConfig?.DEFAULT_OPTIONS?.position;
  if ( !position ) return;
  if ( _feSceneConfigCoreWidth === null ) _feSceneConfigCoreWidth = position.width;

  // Never narrow the window if core ever raises its own default past ours.
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
    // No onChange — it cannot reach cached sheets, so it would only pretend to apply.
    // fe-settings-menu.js owns the reload prompt.
  });

  // Applying at init also means position.width is still core's own value when
  // _feSceneConfigCoreWidth is captured.
  feApplySceneConfigTabs(feSceneConfigTabsEnabled());
});

// Re-apply at ready: GM-priority overrides are not loaded at init, so feSetting can return
// the local value there. Still before any SceneConfig sheet is constructed.
Hooks.once("ready", () => feApplySceneConfigTabs(feSceneConfigTabsEnabled()));
