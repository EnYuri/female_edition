/* female_edition: Chat Enhancements for Foundry VTT v13
 *
 * Features:
 *  - Chat merge (visual grouping; no document edits)
 *  - Chat log export to PDF (prints current log; no popup windows)
 *  - Standard Markdown in chat input (headings, quotes, links, images, bold/italic/strike/hr)
 *  - Edit existing chat message (with Markdown support)
 *
 * Notes:
 *  - Updated for FVTT v13 data model: ChatMessage#author, ChatMessage#style, ChatMessage#rolls
 *  - Avoids deprecated hooks (renderChatMessage) and deprecated fields (#user, #type)
 */

import {
  MODULE_ID, LEGACY_UI_FONT_KEY, S,
  FE_DEFAULTS, FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  FE_GM_PRIORITY_OVERRIDES_KEY, FE_GM_PRIORITY_BACKUP_KEY, FE_WORLD_SETTINGS_KEY,
} from "./fe-constants.js";

import {
  feIsElementNode, feExtractHTMLElement, feBindMessageToElement, feIsNotificationMessageElement,
  feGetChatLogs, feGetChatLogsInDocument, feDedupeChatMessagesInLog,
  feGetMessageIdFromElement, feNormalizeChatMessageId, feCssEscape,
  feDeferTask, feWindowRequestFrame, feSnapshotAndRestoreStickyScroll,
  feFollowIncomingChatMessage, feRepinFollowingChatLogs,
  feGetMessageFromElementOrCollection,
} from "./fe-util.js";

import {
  feSyncingLocalGmPrioritySettings,
  feIsGmPrioritySettingKey, feHasGmPriorityOverride,
  feMirrorGmPrioritySetting, feSyncLocalGmPrioritySettings,
  feRestoreLocalGmPrioritySettings,
  feSeedGmPriorityOverridesFromLocal, feIsGmPriorityEnabled,
  feHydrateWorldSettings, feCaptureWorldSettings, feIsPerWorldSettingKey,
  feFireChatUiUpdated, feSetting,
} from "./fe-gm-priority.js";

import { feApplyMarkdownOnPreCreate, feMarkdownToHTML, feEscapeHTML, feUnwrapProseMirrorHTML } from "./fe-markdown.js";

import {
  feSetBodyMergeClasses, feSetChatCardFontClass, feSetChatFontChoiceClass,
  feSetUiFontClass, feSetNeodgmModeClass, feSetUserFontMode, feSetRetroThemeClass,
  feSetUserColorBgClass, feSetUserColorBgBaseClass, feSetPaperOverlayClass, feSetChatGroupOutlineClass,
  feSetAccentTextOverrideClass,
  feSetSystemMsgColorClass,
  feSetForceNormalMsgColorClass,
  feApplyStyleVarsFromSettings,
  feApplyCanvasTextFont,
} from "./fe-style.js";

import {
  feStoreRenderStateOverride, feHydrateRenderStateOverride,
  feChangeTouchesRenderState,
  feCaptureMessageRenderFlagsOnPreCreate, feCaptureMessageRenderFlagsOnPreUpdate,
  feGetPendingMessageSource,
  feIsNarratorToolsMessage, feIsRoundMarkerMessage, feIsUntouchedSpecialMessage,
  feApplyUserColorBgToMessageElement, feApplyUserColorBgToAllLogs,
  feUserColorBgFeatureActive,
  feStampRenderedStateAttributes,
  feMessageMergeInfo, feMergeKey,
  feGetMessageUserColor, feGetSpeakerActorFromMessage,
} from "./fe-render-state.js";

import { feSnapshotOrRestoreInlineRolls, feClearInlineRollSnapshot, feIsMessageFreezeInProgress } from "./fe-inline-rolls.js";

import {
  feClearMergeClassesFromMessageElement,
  feApplyChatMerge, feApplyChatMergeToAllLogs, feApplyChatMergeAroundElement,
  fePreApplyMergeHint, feSetMergeScheduleCallback,
} from "./fe-merge.js";

import { feStripChatTexturesInWindow } from "./fe-texture.js";
import { feInstallChatLogPrune } from "./fe-chat-prune.js";

// Wire the merge retry back-reference so fe-merge.js can call feScheduleRenderedLogRefresh
// without a circular import.
feSetMergeScheduleCallback((logEl, opts) => feScheduleRenderedLogRefresh(logEl, opts));

// -------------------------------------
// Helpers
// -------------------------------------

function feHasRenderedStateWork() {
  try {
    return !!feSetting(S.MERGE_ENABLED) || feUserColorBgFeatureActive();
  } catch {
    return true;
  }
}

// -------------------------------------
// Legacy migration
// -------------------------------------

async function feNormalizeChoiceSetting(key, allowedValues, fallback) {
  try {
    const allowed = new Set(Array.isArray(allowedValues) ? allowedValues : []);
    const value = String(feSetting(key) ?? fallback ?? "").trim();
    if (!allowed.has(value)) await game.settings.set(MODULE_ID, key, fallback);
  } catch (_err) {
    // ignore
  }
}

async function feMigrateLegacySettings() {
  try {
    const legacy = Boolean(game.settings.get(MODULE_ID, LEGACY_UI_FONT_KEY));
    if (legacy) {
      const current = Boolean(feSetting(S.UI_USE_GEURIMILGI));
      if (!current) await game.settings.set(MODULE_ID, S.UI_USE_GEURIMILGI, true);
      await game.settings.set(MODULE_ID, LEGACY_UI_FONT_KEY, false);
    }
  } catch (err) {
    // ignore
  }

  await feNormalizeChoiceSetting(S.CHAT_FONT_CHOICE, ["cookie", "cookieAll", "geurimilgi", "neodgm", "mona", "galmuri"], FE_DEFAULTS[S.CHAT_FONT_CHOICE]);
  await feNormalizeChoiceSetting(S.MERGE_MODE, ["standard", "simple"], FE_DEFAULTS[S.MERGE_MODE]);
  await feNormalizeChoiceSetting(S.MERGE_FOLLOW_HEADER_STYLE, ["hide", "name", "portrait"], FE_DEFAULTS[S.MERGE_FOLLOW_HEADER_STYLE]);
  await feNormalizeChoiceSetting(S.MERGE_SPEAKER_BASIS, ["token", "actor", "author"], FE_DEFAULTS[S.MERGE_SPEAKER_BASIS]);
  await feNormalizeChoiceSetting(S.USER_COLOR_BG_BASE, ["white", "black", "none", "custom"], FE_DEFAULTS[S.USER_COLOR_BG_BASE]);
  await feNormalizeChoiceSetting(S.EXPORT_PRINT_IMAGE_MODE, Object.keys(FE_EXPORT_PRINT_IMAGE_MODE_CHOICES), FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]);
  await feNormalizeChoiceSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE, ["off", "button", "auto"], FE_DEFAULTS[S.EXPORT_DESKTOP_EXTERNAL_MODE]);
}

// -------------------------------------
// GM priority UI refresh (needs style + fire — lives here to avoid circular)
// -------------------------------------

// Every purely visual apply — CSS variables and body classes. Touches only the
// document and the settings store, never the canvas or the chat log, so it is
// safe to run as early as `setup`.
//
// MUST stay callable before `ready` (measured 2026-08-04, live v14.365): a scene
// whose tile is a .webm hangs Foundry's video-texture load forever when the tab
// is not visible — `<video>` never leaves readyState 0 (reproduced with a blob
// URL too, so it is Chrome's media pipeline, not the network: the same file
// `fetch`es in 5ms). Foundry has no timeout there, so `canvas.draw()` never
// resolves and `canvas.ready` → `game.ready` → the `ready` hook never fire. When
// that happened, everything below was skipped and the module rendered half-
// applied — no retro theme, no accent variables, no merge classes. Calling this
// from `setup` decouples the look of the UI from whether the canvas ever loads.
function feApplyVisualSettingsToDocument(doc = document) {
  try { feApplyStyleVarsFromSettings(doc); } catch { /* no-op */ }
  try { feSetBodyMergeClasses(); } catch { /* no-op */ }
  try { feSetChatCardFontClass(doc); } catch { /* no-op */ }
  try { feSetChatFontChoiceClass(doc); } catch { /* no-op */ }
  try { feSetUiFontClass(doc); } catch { /* no-op */ }
  try { feSetNeodgmModeClass(doc); } catch { /* no-op */ }
  try { feSetUserFontMode(doc); } catch { /* no-op */ }
  try { feApplyCanvasTextFont(doc); } catch { /* no-op */ }
  try { feSetRetroThemeClass(doc); } catch { /* no-op */ }
  try { feSetUserColorBgClass(doc); } catch { /* no-op */ }
  try { feSetPaperOverlayClass(doc); } catch { /* no-op */ }
  try { feSetUserColorBgBaseClass(doc); } catch { /* no-op */ }
  try { feSetChatGroupOutlineClass(doc); } catch { /* no-op */ }
  try { feSetAccentTextOverrideClass(doc); } catch { /* no-op */ }
  try { feSetSystemMsgColorClass(doc); } catch { /* no-op */ }
  try { feSetForceNormalMsgColorClass(doc); } catch { /* no-op */ }
}

function feApplyGmPriorityUiRefresh(doc = document) {
  feApplyVisualSettingsToDocument(doc);
  try {
    feFireChatUiUpdated({ reason: "gm-priority-overrides", root: doc, log: null, document: doc });
  } catch {
    /* no-op */
  }
}

// -------------------------------------
// Settings registration
// -------------------------------------

Hooks.once("init", () => {
  // DOM pruning must be registered and installed early in init so CONFIG.ui.chat
  // is replaced before Foundry instantiates the ChatLog sidebar.
  game.settings.register(MODULE_ID, S.PRUNE_ENABLED, {
    name: "채팅 DOM 정리(성능 최적화)",
    hint: "메시지가 많이 쌓이면 오래된 메시지를 DOM에서 제거하여 성능을 개선합니다. 위로 스크롤하면 이전 메시지를 다시 불러옵니다. (변경 후 새로고침 필요)",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    requiresReload: true,
  });
  game.settings.register(MODULE_ID, S.PRUNE_MAX_MESSAGES, {
    name: "채팅 DOM 정리: 최대 유지 메시지 수",
    hint: "DOM에 동시에 유지할 최대 메시지 수입니다. 이 수를 초과하면 오래된 메시지를 제거합니다. 스크롤 1회에 이 값의 절반만큼 불러옵니다. (즉시 적용)",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.PRUNE_MAX_MESSAGES],
    range: { min: 20, max: 200, step: 10 },
  });
  feInstallChatLogPrune();

  game.settings.register(MODULE_ID, FE_GM_PRIORITY_OVERRIDES_KEY, {
    name: "(internal) GM-priority range overrides",
    scope: "world",
    config: false,
    type: Object,
    default: {},
    onChange: () => {
      feApplyGmPriorityUiRefresh(document);
      void feSyncLocalGmPrioritySettings();
    },
  });

  // Per-world settings store (client-scope blob, keyed by world id). See
  // fe-gm-priority.js for hydrate/capture logic.
  game.settings.register(MODULE_ID, FE_WORLD_SETTINGS_KEY, {
    name: "(internal) per-world settings",
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });

  // Per-client backup of pre-force values, captured on the first GM-priority
  // overwrite of each key and consumed when enforcement is turned OFF (restore).
  // See fe-gm-priority.js (feSyncLocalGmPrioritySettings / feRestoreLocalGmPrioritySettings).
  game.settings.register(MODULE_ID, FE_GM_PRIORITY_BACKUP_KEY, {
    name: "(internal) GM-priority value backup",
    scope: "client",
    config: false,
    type: Object,
    default: {},
  });

  game.settings.register(MODULE_ID, S.MERGE_ENABLED, {
    name: "채팅 병합(연속 메시지 시각적 묶기)",
    hint: "같은 화자/유저의 연속 메시지를 하나처럼 보이도록 묶습니다(문서 편집 없음).",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
      setTimeout(() => feApplyChatMergeToAllLogs(), 200);
    },
  });

  game.settings.register(MODULE_ID, S.MERGE_ONLY_TEXT, {
    name: "채팅 병합: 텍스트 메시지만",
    hint: "인라인 롤이 섞인 일반 텍스트는 병합할 수 있습니다. 전용 주사위 결과 카드 병합은 아래 옵션으로 켤 수 있으며, midi/dnd5e 채팅 카드는 기본적으로 병합하지 않습니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.MERGE_INCLUDE_ROLL_MESSAGES, {
    name: "채팅 병합: 주사위 결과 메시지도 포함",
    hint: "끄면 .dice-roll / .dice-result / ChatMessage.rolls 메시지는 병합에서 제외합니다. 켜면 같은 화자의 연속 주사위 결과 메시지도 병합할 수 있습니다. midi/dnd5e 채팅 카드는 계속 제외됩니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => feScheduleRenderedStateRefreshForAllLogs({ delay: 0 }),
  });

  game.settings.register(MODULE_ID, S.MERGE_DIVIDER, {
    name: "채팅 병합: 그룹 구분선 표시",
    hint: "다른 화자의 새 그룹이 시작될 때 얇은 구분선을 표시합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.MERGE_GROUP_SPACING, {
    name: "채팅 병합: 그룹 간 간격(px)",
    hint: "서로 다른 화자(그룹) 사이의 추가 여백(px)입니다. dnd5e 채팅카드처럼 병합에서 제외되는 메시지 전후에도 동일하게 적용됩니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.MERGE_GROUP_SPACING],
    range: { min: 0, max: 40, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.MERGE_MODE, {
    name: "채팅 병합 방식",
    hint: "표준은 메시지 박스 경계까지 붙여 묶고, 간소화는 같은 화자의 후속 메시지에서 헤더만 숨깁니다.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      standard: "표준(경계/간격까지 묶기)",
      simple: "간소화(후속 헤더만 숨김)",
    },
    default: FE_DEFAULTS[S.MERGE_MODE],
    onChange: () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
      setTimeout(() => feApplyChatMergeToAllLogs(), 200);
    },
  });

  game.settings.register(MODULE_ID, S.MERGE_FOLLOW_HEADER_STYLE, {
    name: "채팅 병합: 후속 메시지 헤더 표시 방식",
    hint: "같은 화자의 연속 메시지(두 번째부터)의 헤더 표시를 설정합니다.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      hide: "헤더 완전 숨김",
      name: "이름만 남김",
      portrait: "포트레이트만 남김",
    },
    default: "hide",
    onChange: () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
      setTimeout(() => feApplyChatMergeToAllLogs(), 200);
    },
  });

  game.settings.register(MODULE_ID, S.MERGE_SPEAKER_BASIS, {
    name: "채팅 병합: 화자 그룹 기준",
    hint: [
      "연속 메시지를 묶을 때 '같은 화자'를 어떻게 판단할지 결정합니다.",
      "토큰(기본): 씬에 배치된 토큰 단위로 구분 — GM이 같은 액터를 다른 토큰으로 운용하면 별도 그룹.",
      "액터: 액터 단위 — 같은 액터라면 다른 토큰이어도 병합.",
      "플레이어(작성자): 작성 유저 단위 — 같은 플레이어가 보낸 메시지는 화자에 무관하게 병합.",
    ].join(" / "),
    scope: "client",
    config: false,
    type: String,
    choices: {
      token:  "토큰(기본) — 토큰+액터+씬 모두 일치해야 병합",
      actor:  "액터 — 같은 액터면 병합 (토큰 무시)",
      author: "플레이어(작성자) — 같은 유저면 병합",
    },
    default: FE_DEFAULTS[S.MERGE_SPEAKER_BASIS],
    // Re-STAMP (not just re-merge): the merge key cached in each message's
    // data-fe-merge-key is computed with the speaker-basis in effect at stamp time.
    // feApplyChatMergeToAllLogs reuses that stale key, so a bare re-merge would not
    // reflect the new basis until messages re-rendered. feScheduleRenderedStateRefreshForAllLogs
    // re-stamps every message (recomputing the key) before re-merging.
    onChange: () => feScheduleRenderedStateRefreshForAllLogs({ delay: 0 }),
  });

  game.settings.register(MODULE_ID, S.EXPORT_ENABLED, {
    name: "채팅 로그 PDF 내보내기 버튼",
    hint: "채팅 입력창 옆에 PDF(인쇄) 버튼을 추가합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => feFireChatUiUpdated({ reason: "export-settings", document }),
  });

  game.settings.register(MODULE_ID, S.EXPORT_AUTO_PRINT, {
    name: "PDF 버튼: 자동 인쇄창 열기",
    hint: "켜면 PDF 버튼 클릭 시 아카이브 창을 연 뒤 자동으로 인쇄(프린트) 다이얼로그를 엽니다. 끄면 아카이브만 열립니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, S.EXPORT_OPTIMIZE, {
    name: "내보내기 최적화(용량/멈춤 방지)",
    hint: "아카이브/인쇄 시 parchment/texture 이미지와 그림자 등을 강제로 제거하여 PDF 용량과 메모리 사용량을 크게 줄입니다(권장).",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EMBED_FONTS, {
    name: "HTML 저장: 커스텀 폰트 포함",
    hint: "HTML로 저장할 때 CookieRun 폰트를 파일 안에 포함시켜(임베드) 나중에 단독으로 열어도 폰트가 유지되게 합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EMBED_IMAGES, {
    name: "HTML 저장: 이미지 포함",
    hint: "HTML로 저장할 때 채팅 로그의 이미지(포트레이트/아이콘 등)를 파일 안에 포함시킵니다. 같은 이미지가 반복되면 자동으로 중복을 제거하여 용량을 절약합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EXCLUDE_WHISPERS, {
    name: "아카이브: 귓속말 제외",
    hint: "아카이브/저장/인쇄에서 귓속말을 제외합니다. GM은 모든 귓속말을 볼 수 있으므로, 켜지 않으면 GM이 저장한 로그에는 비공개 대화가 그대로 포함됩니다. 로그를 다른 사람과 공유할 예정이라면 켜세요.",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, S.EXPORT_PRINT_IMAGE_MODE, {
    name: "PDF/인쇄: 이미지 처리",
    hint: "크롬/일렉트론 인쇄(PDF)에서 이미지가 많으면 메모리가 급증해 멈출 수 있습니다. PDF 안정성을 위해 아바타/이미지를 숨기거나 다운스케일할 수 있습니다.",
    scope: "client",
    config: false,
    type: String,
    choices: FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
    default: "downscaleLite",
  });

  // DEPRECATED but INTENTIONALLY still registered — do not delete.
  // Nothing reads this key any more: the Electron export path was rewritten to
  // "save HTML only" and all four readers were removed from fe-chat-archive.js
  // (the external-browser hand-off, the archive window's auto mode, the "브라우저"
  // button, and feOpenArchiveInExternalBrowser's mode gate). The registration is
  // kept so worlds that still have a stored value do not end up holding an
  // unregistered setting, and the name/hint carry the deprecation notice.
  game.settings.register(MODULE_ID, S.EXPORT_DESKTOP_EXTERNAL_MODE, {
    name: "[이전 버전 호환] FVTT 데스크톱 외부 브라우저 열기",
    hint: "더 이상 사용되지 않습니다. FVTT 데스크톱 앱에서는 HTML 아카이브만 저장하며, 저장한 파일을 브라우저에서 열어 PDF로 저장하세요.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      off: "사용 안 함(앱 내부 인쇄)",
      button: "시스템 브라우저에서 열기",
      auto: "시스템 브라우저에서 열기",
    },
    default: "button",
  });

  // Style settings (CSS vars)

  game.settings.register(MODULE_ID, S.STYLE_ACTOR_NAME_SIZE, {
    name: "채팅: 액터 이름 크기(px)",
    hint: "채팅 메시지 헤더의 액터(캐릭터) 이름 글자 크기입니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_ACTOR_NAME_SIZE],
    range: { min: 10, max: 40, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_PLAYER_NAME_SIZE, {
    name: "채팅: 플레이어 이름 크기(px)",
    hint: "채팅 메시지 헤더의 플레이어 이름(서브타이틀) 글자 크기입니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_PLAYER_NAME_SIZE],
    range: { min: 8, max: 28, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_MESSAGE_TEXT_SIZE, {
    name: "채팅: 메시지 글자 크기(px)",
    hint: "일반 채팅 텍스트(메시지 내용)의 글자 크기입니다.",
    scope: "client",
    config: false,
    type: Number,
    default: 14,
    range: { min: 9, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_CHATCARD_TEXT_SIZE, {
    name: "채팅: 주문/아이템/피처 설명 글자 크기(px)",
    hint: "dnd5e 채팅 카드(주문/아이템/피처) 설명 영역의 기본 글자 크기입니다.",
    scope: "client",
    config: false,
    type: Number,
    default: 12,
    range: { min: 9, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_CHAT_MESSAGE_SPACING, {
    name: "채팅: 메시지 카드 간격(px)",
    hint: "모든 채팅 메시지 카드 사이의 기본 간격(flex gap)입니다. 병합 여부와 무관하게 적용됩니다. (v14 사이드바 부작용 방지를 위해 --fe-chat-message-spacing 변수로 관리합니다)",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_CHAT_MESSAGE_SPACING],
    range: { min: 0, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_HEADER_CONTENT_GAP, {
    name: "채팅: 헤더-콘텐츠 간격(px)",
    hint: "메시지 헤더(액터 이름·포트레이트)와 메시지 내용 사이의 세로 여백입니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_HEADER_CONTENT_GAP],
    range: { min: 0, max: 20, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.MERGE_INNER_GAP, {
    name: "채팅 병합: 연속 메시지 내부 간격(px)",
    hint: "같은 화자의 연속 병합 메시지 사이의 세로 여백(px)입니다. 간소화 모드: 박스 간 실질 간격 = 이 값. 표준 모드: 상하 패딩 합산(×2)이 컨텐츠 간 실질 간격이 됩니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.MERGE_INNER_GAP],
    range: { min: 0, max: 40, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.CHAT_FONT_CHOICE, {
    name: "채팅/UI 글꼴 선택",
    hint: "채팅 메시지·헤더·UI에 사용할 기본 글꼴을 선택합니다. '쿠키런 + 그림일기'는 UI/시트 기본 글꼴도 그림일기로 처리합니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      cookie: "쿠키런 + 그림일기",
      cookieAll: "쿠키런",
      geurimilgi: "그림일기",
      neodgm: "NeoDGM",
      mona: "Mona10(웹폰트)",
      galmuri: "갈무리11(웹폰트)",
    },
    default: FE_DEFAULTS[S.CHAT_FONT_CHOICE],
    onChange: () => {
      feSetChatCardFontClass(document);
      feSetChatFontChoiceClass(document);
      feSetUiFontClass(document);
      feSetNeodgmModeClass(document);
      feApplyCanvasTextFont(document);
    },
  });

  game.settings.register(MODULE_ID, S.CANVAS_TEXT_FONT, {
    name: "토큰 이름표·커서 글꼴",
    hint: "씬 위에 그려지는 텍스트(토큰 이름표, 다른 유저 커서 이름, 측정/템플릿 라벨 등)에도 위에서 고른 글꼴을 적용합니다. 이 텍스트는 CSS가 아니라 캔버스에 직접 그려지므로 별도 적용이 필요합니다. '커스텀 폰트 적용'이 켜져 있어야 합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.CANVAS_TEXT_FONT],
    onChange: () => feApplyCanvasTextFont(document),
  });

  game.settings.register(MODULE_ID, S.CANVAS_DRAWING_FONT, {
    name: "캔버스 글꼴 (그리기·지도 노트)",
    hint: "모듈 글꼴을 Foundry의 글꼴 목록에 등록해, 그리기(드로잉)·지도 노트·저널 편집기의 글꼴 선택 창에서 직접 고를 수 있게 합니다. 이 설정을 켜면 글꼴이 '기본값'인 그리기/노트는 위에서 고른 글꼴로 표시되고, 끄면 Foundry 기본 글꼴로 돌아갑니다(목록 등록은 유지). '커스텀 폰트 적용'이 켜져 있어야 합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.CANVAS_DRAWING_FONT],
    onChange: () => feApplyCanvasTextFont(document),
  });

  game.settings.register(MODULE_ID, S.UI_USE_GEURIMILGI, {
    name: "(internal) UI/시트 그림일기 동기화",
    hint: "레거시 호환용 내부 값입니다. 현재는 '채팅/UI 글꼴 선택'의 '쿠키런 + 그림일기' 프리셋에서 자동으로 동기화됩니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_USE_GEURIMILGI],
    onChange: () => feSetUiFontClass(document),
  });

  game.settings.register(MODULE_ID, S.UI_USE_USER_FONT, {
    name: "유저(로컬) 폰트 사용",
    hint: "켜면 이 모듈의 커스텀 폰트(쿠키런/그림일기) 대신, 아래에서 고른 '유저 폰트'(컴퓨터에 설치된 폰트 또는 모듈 font 폴더의 폰트)를 채팅·UI 전체에 적용합니다. '커스텀 폰트 적용'이 켜져 있어야 합니다. (개인 설정 — GM 전역 강제 대상 아님)",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_USE_USER_FONT],
    onChange: () => {
      feSetUserFontMode(document);
      feApplyCanvasTextFont(document);
      feSetChatCardFontClass(document);
      // Suppress/restore the module chat-font-choice classes (see feUserFontActive).
      feSetChatFontChoiceClass(document);
      feSetUiFontClass(document);
      feSetNeodgmModeClass(document);
    },
  });

  game.settings.register(MODULE_ID, S.USER_FONT_FAMILY, {
    name: "유저 폰트 패밀리",
    hint: "적용할 폰트의 패밀리 이름(예: Malgun Gothic). 설정 메뉴에서 설치 폰트 목록·모듈 폰트 중 선택하거나 직접 입력할 수 있습니다.",
    scope: "client",
    config: false,
    type: String,
    default: FE_DEFAULTS[S.USER_FONT_FAMILY],
    onChange: () => {
      feSetUserFontMode(document);
      feApplyCanvasTextFont(document);
      feSetChatCardFontClass(document);
      // Family going empty/non-empty flips feUserFontActive → refresh module classes.
      feSetChatFontChoiceClass(document);
      feSetUiFontClass(document);
      feSetNeodgmModeClass(document);
    },
  });

  game.settings.register(MODULE_ID, S.UI_RETRO_THEME, {
    name: "레트로 테마 (픽셀 고대비)",
    hint: "모든 UI 요소를 각지게(border-radius 0), 안티에일리어싱 OFF, 트랜지션 즉각 반응으로 변환합니다. 모든 시스템에서 사용할 수 있으며, DX3rd·D&D 5e 전용 레이아웃 보정은 해당 시스템에서만 적용됩니다. NeoDGM 폰트 모드와 함께 사용 권장.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_RETRO_THEME],
    onChange: () => {
      feSetRetroThemeClass(document);
      feFireChatUiUpdated({ reason: "retro-theme", document });
    },
  });

  game.settings.register(MODULE_ID, S.DX3RD_CARD_BORDER_ALPHA, {
    name: "[DX3rd] 채팅 카드 테두리 투명도",
    hint: "픽셀 테마에서 채팅 카드의 플레이어 컬러 테두리 알파값입니다. 0 = 완전 투명, 1 = 완전 불투명.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.DX3RD_CARD_BORDER_ALPHA],
    range: { min: 0, max: 1, step: 0.05 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.DX3RD_PIXEL_ACCENT, {
    name: "[DX3rd] 픽셀 테마 강조색",
    hint: "픽셀 테마에서 테두리·글자·체커보드 무늬에 적용되는 강조 색상입니다. 채팅 컨트롤의 색상 스와치로 변경하세요.",
    scope: "client",
    config: false,
    type: String,
    default: FE_DEFAULTS[S.DX3RD_PIXEL_ACCENT],
    onChange: async (value) => {
      // GM priority override를 먼저 갱신해야 feSetting()이 새 값을 반환.
      // 갱신 전 feApplyStyleVarsFromSettings를 호출하면 낡은 override 값으로 accent-h가 덮어써짐.
      await feMirrorGmPrioritySetting(S.DX3RD_PIXEL_ACCENT, value);
      feApplyStyleVarsFromSettings(document);
    },
  });

  // Migration-only flag (read by feMigrateLegacySettings, then reset to false).
  // Hidden from the user-facing settings panel.
  game.settings.register(MODULE_ID, LEGACY_UI_FONT_KEY, {
    name: "(legacy) UI font toggle",
    scope: "client",
    config: false,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, S.USE_USER_COLOR_BG, {
    name: "채팅 메시지 배경: 유저 색상 적용(Chat Portrait 스타일)",
    hint: "각 메시지 배경을 화자(액터 소유자/작성자)의 유저 색상으로 틴트합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.USE_USER_COLOR_BG],
    onChange: () => {
      feSetUserColorBgClass(document);
      feApplyUserColorBgToAllLogs(document);
    },
  });

  game.settings.register(MODULE_ID, S.USER_COLOR_BG_BASE, {
    name: "채팅 메시지 배경: 채팅카드 하부 배경(불투명)",
    hint: "채팅카드에 불투명한 배경(흰색/검정/사용자 지정)을 깔아 가독성을 높입니다. 유저 색상 틴트와 독립적으로 동작하므로, 틴트가 꺼져 있어도 단독으로 적용됩니다.",
    scope: "client",
    config: false,
    type: String,
    choices: {
      white: "흰색(권장)",
      black: "검정",
      none: "사용 안 함(기존 방식)",
      custom: "사용자 지정 색상",
    },
    default: FE_DEFAULTS[S.USER_COLOR_BG_BASE],
    onChange: () => {
      // Base mode now drives .fe-has-user-color independently of the tint,
      // so a none↔white/black/custom change must re-classify existing messages.
      feSetUserColorBgBaseClass(document);
      feApplyUserColorBgToAllLogs(document);
    },
  });

  game.settings.register(MODULE_ID, S.USER_COLOR_BG_CUSTOM, {
    name: "채팅 메시지 배경: 사용자 지정 하부 배경색",
    hint: "하부 배경을 '사용자 지정 색상'으로 설정했을 때 사용할 색.",
    scope: "client",
    config: false,
    type: String,
    default: FE_DEFAULTS[S.USER_COLOR_BG_CUSTOM],
    onChange: () => feSetUserColorBgBaseClass(document),
  });

  game.settings.register(MODULE_ID, S.USER_COLOR_ALPHA, {
    name: "채팅 메시지 배경: 유저 색상 틴트 농도",
    hint: "유저 색상이 배경에 입혀지는 진하기(0.05~0.6). 값이 클수록 진해집니다.",
    scope: "client",
    config: false,
    type: Number,
    range: { min: 0.05, max: 0.6, step: 0.01 },
    default: FE_DEFAULTS[S.USER_COLOR_ALPHA],
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.SYSTEM_MSG_COLOR, {
    name: "시스템 메시지에도 GM 유저 색상 틴트 적용",
    hint: "화자(캐릭터)가 없는 시스템 메시지에 GM의 유저 색상과 틴트 농도를 적용합니다. 내레이터 채팅(/narrate·/describe·/note)은 제외됩니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.SYSTEM_MSG_COLOR],
    onChange: () => {
      feSetSystemMsgColorClass(document);
      feApplyUserColorBgToAllLogs(document);
    },
  });

  game.settings.register(MODULE_ID, S.SYSTEM_MSG_BG_ENABLED, {
    name: "시스템 메시지 하부 배경색 적용",
    hint: "화자 없는 시스템 메시지에 지정한 불투명 하부 배경색을 적용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.SYSTEM_MSG_BG_ENABLED],
    onChange: () => feSetSystemMsgColorClass(document),
  });

  game.settings.register(MODULE_ID, S.SYSTEM_MSG_BG_COLOR, {
    name: "시스템 메시지 하부 배경색",
    hint: "시스템 메시지 하부 배경색 적용이 켜져 있을 때 사용할 색입니다.",
    scope: "client",
    config: false,
    type: String,
    default: FE_DEFAULTS[S.SYSTEM_MSG_BG_COLOR],
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.FORCE_NORMAL_MSG_COLOR, {
    name: "일반 메시지 카드·글씨 색 강제 정의(시스템 기본값)",
    hint: "켜면 일반 채팅 메시지(특수 메시지·유저 색상 제외)의 카드 배경과 글씨 색을 시스템/테마 기본값으로 강제합니다. Carolingian UI 등 채팅을 통째로 다시 칠하는 모듈이 일반 메시지를 덮어써 가독성이 떨어질 때 되돌리는 용도입니다. 끄면 해당 모듈의 채팅 스타일을 그대로 둡니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.FORCE_NORMAL_MSG_COLOR],
    onChange: () => {
      feSetForceNormalMsgColorClass(document);
      feScheduleRenderedStateRefreshForAllLogs?.({ delay: 0 });
    },
  });

  game.settings.register(MODULE_ID, S.CHAT_GROUP_OUTLINE, {
    name: "채팅: 병합 그룹 외곽선",
    hint: "병합된 메시지 그룹(또는 단일 메시지)을 외곽선(유저 색상)으로 감싸 박스처럼 표시합니다. 끄면 색조 배경만 사용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.CHAT_GROUP_OUTLINE],
    onChange: () => feSetChatGroupOutlineClass(document),
  });

  game.settings.register(MODULE_ID, S.ACCENT_TEXT_OVERRIDE, {
    name: "레트로: 텍스트 색조 오버라이드",
    hint: "레트로 테마의 강조색(텍스트·테두리·체커보드 무늬)을 픽셀 테마 강조색 스와치 기반 톤으로 통일합니다. 끄면 강조색 전체를 기본 백색(흰/회색)으로 되돌리고 채팅 컨트롤의 강조색 스와치 버튼도 숨깁니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.ACCENT_TEXT_OVERRIDE],
    onChange: () => {
      feSetAccentTextOverrideClass(document);
      // 오버라이드 OFF → 강조색 전체(텍스트·테두리·무늬)를 기본 백색으로 되돌리고,
      // ON → 저장된 강조색을 복원. feApplyStyleVarsFromSettings 가 두 경우를 모두 처리.
      feApplyStyleVarsFromSettings(document);
    },
  });

  game.settings.register(MODULE_ID, S.STYLE_PAPER_OVERLAY_ENABLED, {
    name: "채팅: 페이퍼 톤 오버레이",
    hint: "텍스쳐 제거 시 평면 미색 오버레이를 추가해 채도를 낮춥니다. 별도 선택 기능이며 기본값은 꺼짐입니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: FE_DEFAULTS[S.STYLE_PAPER_OVERLAY_ENABLED],
    onChange: () => feSetPaperOverlayClass(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_BG_SATURATION, {
    name: "채팅: 페이퍼 톤 오버레이 농도",
    hint: "페이퍼 톤 오버레이를 켰을 때 적용되는 미색층의 알파 값입니다. 값이 높을수록 더 밝고 채도가 약해집니다.",
    scope: "client",
    config: false,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_BG_SATURATION],
    range: { min: 0.05, max: 1.0, step: 0.01 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.MARKDOWN_ENABLED, {
    name: "채팅 입력 마크다운 지원",
    hint: "채팅 입력 텍스트를 마크다운으로 처리합니다(이미지/링크/제목/굵게/기울임/취소선/인용구).",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EDIT_ENABLED, {
    name: "채팅 수정(편집) 다이얼로그",
    hint: "메시지 수정 버튼 클릭 시 마크다운 기반 편집 다이얼로그를 사용합니다.",
    scope: "client",
    config: false,
    type: Boolean,
    default: true,
    onChange: () => feFireChatUiUpdated({ reason: "edit-settings", document }),
  });

  game.settings.register(MODULE_ID, S.GM_PRIORITY_ENABLED, {
    name: "GM 설정 전역 강제",
    hint: "활성화 시 아래 3가지를 제외한 GM의 모든 모듈 설정이 모든 플레이어에게 강제 적용됩니다(채팅 병합·외형·색상, 이미지 호버, 무대, DOM 정리, 타이핑 등 포함). 항상 개인 유지: 커스텀 폰트 유무/유저 로컬 폰트 · 채팅 아카이브/내보내기 · 툴바 접기. 플레이어가 개인 취향대로 쓰게 하려면 이 기능을 끄세요.",
    scope: "world",
    config: false,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: (value) => {
      feApplyGmPriorityUiRefresh(document);
      // World-scope toggle — this onChange fires on every connected client.
      if (value) {
        // Turning ON: the GM (re)seeds the override store from its CURRENT local
        // values (force, so changes made while OFF are captured), then every
        // client force-syncs them into local settings (backing up own values).
        void (async () => {
          if (game.user?.isGM) await feSeedGmPriorityOverridesFromLocal({ force: true });
          await feSyncLocalGmPrioritySettings();
        })();
      } else {
        // Turning OFF: every client restores its own pre-force values, so nothing
        // stays forced once enforcement is disabled.
        void feRestoreLocalGmPrioritySettings();
      }
    },
  });

  game.settings.register(MODULE_ID, S.GM_SPEAK_AS_SELF, {
    name: "GM: PC 토큰 선택 시 본인 이름으로 채팅",
    hint: "활성화 시 GM이 플레이어 소유 캐릭터 토큰을 선택한 상태에서 채팅을 보내도 해당 캐릭터가 아닌 GM 본인으로 표시됩니다.",
    scope: "client",
    config: false,
    restricted: true,
    type: Boolean,
    default: false,
  });

  Hooks.on("renderChatLog", (_app, html) => {
    try {
      const root = feExtractHTMLElement(html) ?? html?.element?.[0] ?? null;
      const log = root?.matches?.("ol.chat-log, #chat-log")
        ? root
        : root?.querySelector?.("ol.chat-log, #chat-log") ?? null;

      if (log) feScheduleRenderedLogRefresh(log, { delay: 0 });
      else feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });

      // The incremental refresh above does not reliably mark merge groups when the
      // log is (re)populated all at once. Follow with an authoritative full pass.
      feScheduleFullMergePass({ delay: 120 });

      feFireChatUiUpdated({
        reason: "renderChatLog",
        root: root ?? log ?? null,
        log: log ?? null,
        document: (root?.ownerDocument ?? log?.ownerDocument ?? document),
      });
    } catch {
      /* no-op */
    }
  });
});

// Persist any client-scope setting changed OUTSIDE the settings menu (e.g. the
// chat-controls accent swatch, font toggle) into this world's per-world slice.
// Otherwise feHydrateWorldSettings on the next load would re-apply the stale
// slice value and silently revert the change. Debounced to coalesce bursts.
let _feWorldCaptureTimer = null;
function _feScheduleWorldCapture() {
  if (_feWorldCaptureTimer) clearTimeout(_feWorldCaptureTimer);
  _feWorldCaptureTimer = setTimeout(() => {
    _feWorldCaptureTimer = null;
    void feCaptureWorldSettings();
  }, 400);
}

Hooks.on("clientSettingChanged", (fullKey, value) => {
  try {
    if (feSyncingLocalGmPrioritySettings) return;
    const keyPath = String(fullKey ?? "").trim();
    if (!keyPath.startsWith(`${MODULE_ID}.`)) return;
    const key = keyPath.slice(MODULE_ID.length + 1);
    // Capture per-world for ALL client-scope keys (incl. GM-priority-excluded
    // ones like fonts/export), not just GM-priority keys. feCaptureWorldSettings
    // no-ops during hydration, so this never loops on its own FE_WORLD_SETTINGS_KEY write.
    if (feIsPerWorldSettingKey(key)) _feScheduleWorldCapture();
    if (!feIsGmPrioritySettingKey(key)) return;
    if (game.user?.isGM) void feMirrorGmPrioritySetting(key, value);
    else if (feHasGmPriorityOverride(key)) {
      feApplyGmPriorityUiRefresh(document);
      void feSyncLocalGmPrioritySettings({ keys: [key] });
    }
  } catch {
    /* no-op */
  }
});

// Paint the UI from settings as soon as the settings store is populated, without
// waiting for the canvas. `setup` fires after world documents are prepared and
// BEFORE the canvas is drawn, so this survives a canvas that never finishes
// loading (see feApplyVisualSettingsToDocument). GM priority overrides are not
// synced yet at this point, so a player may briefly paint their own pre-force
// values; the identical call in `ready` below runs after the sync and corrects
// them. Every apply is an idempotent classList/style write, so running twice is
// free.
Hooks.once("setup", () => {
  try { feApplyVisualSettingsToDocument(document); } catch { /* no-op */ }
});

Hooks.once("ready", async () => {
  await feMigrateLegacySettings();
  // Apply this world's saved settings (or seed on first visit) BEFORE GM
  // priority so the GM seeds from per-world-correct values.
  await feHydrateWorldSettings();
  if (feIsGmPriorityEnabled()) {
    if (game.user?.isGM) await feSeedGmPriorityOverridesFromLocal();
    await feSyncLocalGmPrioritySettings();
  } else {
    // Enforcement is off — undo any forced values left over from a previous
    // session (e.g. the GM disabled it while this client was offline).
    await feRestoreLocalGmPrioritySettings();
  }
  // Re-apply now that world settings are hydrated and GM priority is synced —
  // the `setup` pass above painted from un-synced values. Same idempotent call.
  // (Includes feApplyCanvasTextFont: CSS cannot reach PIXI text, so the family
  // goes into CONFIG.canvasTextStyle. Safe before the first canvas draw — later
  // draws clone the updated CONFIG value.)
  feApplyVisualSettingsToDocument(document);
  if (feHasRenderedStateWork()) feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });
  // Guarantee a correct full merge once the log is populated (the incremental
  // path misses groups when messages arrive in a single batch / via chat-prune).
  feScheduleFullMergePass({ delay: 150 });
  setTimeout(() => feScheduleFullMergePass({ delay: 0 }), 600);
  feFireChatUiUpdated({ reason: "ready", root: document, log: null, document });

  // Keep the bottom-pin when the chat becomes visible again after being hidden, for
  // readers who were following. The inactive sidebar tab is display:none (measurements
  // read 0) and core's _onActivate does not re-scroll, so a message that arrives while
  // the chat tab is in the background leaves the log scrolled-up on return. Gated on
  // core's persistent app.isAtBottom inside feRepinFollowingChatLogs (scroll-up readers
  // are never yanked). Covers: sidebar tab switch (changeSidebarTab → chat), sidebar
  // re-expand (collapseSidebar), and browser tab/window refocus (visibilitychange/focus).
  Hooks.on("changeSidebarTab", (app) => {
    if (app === ui.chat) feRepinFollowingChatLogs();
  });
  Hooks.on("collapseSidebar", (_app, collapsed) => {
    if (!collapsed) feRepinFollowingChatLogs();
  });
  try {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden) feRepinFollowingChatLogs();
    });
    window.addEventListener("focus", () => feRepinFollowingChatLogs());
  } catch { /* no-op */ }
});

// A scene draw that happens before the @font-face files finish loading paints the
// nameplates with the fallback family and never repaints on its own (PIXI caches
// the rendered text texture). Re-apply per scene: feApplyCanvasTextFont awaits
// document.fonts and re-assigns the style, which marks every text dirty.
Hooks.on("canvasReady", () => {
  try { feApplyCanvasTextFont(document); } catch { /* no-op */ }
});

// -------------------------------------
// Rendered state application
// -------------------------------------

// `allowNarratorMerge` is INTENTIONALLY unused here — do not delete the parameter.
// It was live until the merge call was lifted out of this function into the batch
// level (feApplyRenderedStateToLog / feFlushQueuedRenderedMessageRefreshes); the
// signature was kept deliberately (the removal commit left an explicit
// `void allowNarratorMerge;` marker, later dropped). Two reasons it must stay:
// this is an exported function that fe-chat-archive.js calls, and
// feApplyRenderedStateToLog forwards feArchiveMergeOptions() straight through, so
// both must accept the same options shape. Narrator/round-marker classification
// itself is recomputed inside feStampRenderedStateAttributes and does not need it.
function feApplyRenderedStateToMessageElement(message, messageEl, { allowNarratorMerge = false } = {}) {
  try {
    const el = feExtractHTMLElement(messageEl);
    if (!el) return;
    feBindMessageToElement(message, el);
    if (feIsNotificationMessageElement(el)) feClearMergeClassesFromMessageElement(el);
    feStampRenderedStateAttributes(message, el);
    feApplyUserColorBgToMessageElement(message, el);
  } catch {
    /* no-op */
  }
}

// `edgeLookahead` defaults OFF so the ARCHIVE caller (fe-chat-archive.js:3449,
// which passes feArchiveMergeOptions()) can never turn a deliberately truncated
// export range into a "continues outside the file" render. That archive call is
// the ONLY direct one; every live path arrives via feScheduleRenderedLogRefresh,
// which supplies `true` by default — see the note on that function.
function feApplyRenderedStateToLog(logEl, { allowNarratorMerge = false, edgeLookahead = false } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    if (!feIsElementNode(logEl)) return;
    const nodes = Array.from(logEl.querySelectorAll?.("li.chat-message") ?? []);
    for (const li of nodes) {
      const msgId = feGetMessageIdFromElement(li);
      const msg = feGetMessageFromElementOrCollection(li) || (msgId ? game?.messages?.get?.(msgId) : null);
      if (!msg) continue;
      feApplyRenderedStateToMessageElement(msg, li, { allowNarratorMerge });
    }
    if (feSetting(S.MERGE_ENABLED)) feApplyChatMerge(logEl, { allowNarratorMerge, preNodes: nodes, edgeLookahead });
  } catch {
    /* no-op */
  }
}

// -------------------------------------
// Scheduling / queue system
// -------------------------------------

const fePendingRenderedLogs = new Set();
const fePendingRenderedLogOptions = new WeakMap();
const fePendingRenderedLogFrames = new Map();

// TWO handles, two ROLES — not a redundant pair. Do not collapse them.
//   RAF   → renderChatMessageHTML. Runs BEFORE the browser paints the new element,
//           so the merge classes (header visibility / height) are final at first
//           paint. Dropping this brings back the merge-class flicker it was added for.
//   Timer → updateChatMessage and the retry backoff below. Post-paint refresh.
//
// Known asymmetry, left ALONE on purpose: feScheduleRenderedMessageRefresh guards on
// the timer only (not the RAF), and this flush clears the timer handle even when it
// was entered from the RAF — both are pre-RAF code the RAF commit did not revisit.
// The effect is bounded and self-healing: the flush is idempotent and returns
// immediately on an empty queue, so a duplicate pass is a no-op. The only real loss
// is that a ghost timer can pre-empt the retry backoff (feQueuedRenderedMessagePass),
// which the authoritative feScheduleFullMergePass covers anyway. "Fixing" the
// symmetry means re-tuning the paint-relative timing that was already tuned once —
// not worth the flicker regression risk. Measure before touching.
const feQueuedRenderedMessageIds = new Set();
let feQueuedRenderedMessageTimer = null;
let feQueuedRenderedMessageRAF = null;
let feQueuedRenderedMessagePass = 0;
let feQueuedRenderedMessageNarratorMerge = false;

function feQueueMergeForRAF(messageOrId, { allowNarratorMerge = false } = {}) {
  try {
    const id = feNormalizeChatMessageId(messageOrId?.id ?? messageOrId?._id ?? messageOrId);
    if (!id) return;
    feQueuedRenderedMessageIds.add(id);
    feQueuedRenderedMessageNarratorMerge = feQueuedRenderedMessageNarratorMerge || !!allowNarratorMerge;
    if (feQueuedRenderedMessageTimer || feQueuedRenderedMessageRAF) return;
    feQueuedRenderedMessageRAF = requestAnimationFrame(() => {
      feQueuedRenderedMessageRAF = null;
      feFlushQueuedRenderedMessageRefreshes();
    });
  } catch {
    feDeferTask(() => feScheduleRenderedMessageRefresh(messageOrId, { delay: 0, allowNarratorMerge }));
  }
}

function feFlushRenderedLogsForWindow(win = window) {
  const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
  try {
    const pending = Array.from(fePendingRenderedLogs).filter((log) => (log?.ownerDocument?.defaultView ?? window) === win);
    for (const log of pending) {
      fePendingRenderedLogs.delete(log);
      // Defensive only — feScheduleRenderedLogRefresh always stores opts before
      // adding the log. The fallback mirrors that scheduler's defaults so a lost
      // WeakMap entry cannot silently downgrade a live log to no-lookahead.
      const opts = fePendingRenderedLogOptions.get(log) ?? { allowNarratorMerge: false, edgeLookahead: true };
      fePendingRenderedLogOptions.delete(log);
      try {
        feDedupeChatMessagesInLog(log);
        feApplyRenderedStateToLog(log, opts);
      } catch { /* no-op */ }
    }
  } finally {
    restoreStickyScroll();
    fePendingRenderedLogFrames.delete(win);
  }
}

// `edgeLookahead` defaults **ON** here, unlike feApplyRenderedStateToLog (which
// defaults OFF to protect its one direct caller, the ARCHIVE at
// fe-chat-archive.js:3449). Every route into THIS scheduler is a live-log path —
// the render/create/delete/settings hooks and fe-merge.js's missing-doc retry —
// so opting in per call site is exactly the bookkeeping that already failed once:
// the parameter was threaded all the way to feApplyRenderedStateToLog and then
// dropped here, so every scheduled refresh re-ran a full feApplyChatMerge WITHOUT
// lookahead and stripped the continuation classes the merge pass had just applied
// (a visible flicker on create, and a permanent misclassification on DELETE, whose
// path schedules no trailing feScheduleFullMergePass to repair it).
// An explicit `false` still wins — destructuring defaults only fill `undefined` —
// so fe-merge.js's retry keeps forwarding the archive's OFF verdict intact. And if
// an export log ever does reach here (feGetChatLogs also finds the inline export
// container), feApplyChatMerge's own feIsExportLogElement guard is the backstop.
function feScheduleRenderedLogRefresh(logEl, { delay = 24, allowNarratorMerge = false, edgeLookahead = true } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    if (!feIsElementNode(logEl)) return;
    const opts = fePendingRenderedLogOptions.get(logEl) ?? { allowNarratorMerge: false, edgeLookahead: false };
    opts.allowNarratorMerge = opts.allowNarratorMerge || !!allowNarratorMerge;
    opts.edgeLookahead = opts.edgeLookahead || !!edgeLookahead;
    fePendingRenderedLogOptions.set(logEl, opts);
    fePendingRenderedLogs.add(logEl);

    const win = logEl?.ownerDocument?.defaultView ?? window;
    const existing = fePendingRenderedLogFrames.get(win);
    if (existing) return;

    const wait = Math.max(0, Number(delay) || 0);
    const kickoff = () => {
      const raf = feWindowRequestFrame(win, () => feFlushRenderedLogsForWindow(win));
      fePendingRenderedLogFrames.set(win, raf);
    };

    if (wait > 0) {
      const timeout = setTimeout(kickoff, wait);
      fePendingRenderedLogFrames.set(win, timeout);
    } else {
      kickoff();
    }
  } catch {
    /* no-op */
  }
}

function feScheduleRenderedStateRefreshForAllLogs({ delay = 24, allowNarratorMerge = false, edgeLookahead = true } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    for (const log of feGetChatLogs()) feScheduleRenderedLogRefresh(log, { delay, allowNarratorMerge, edgeLookahead });
  } catch {
    /* no-op */
  }
}

// Authoritative, debounced full-log merge pass.
//
// The incremental per-message merge path (feFlushQueuedRenderedMessageRefreshes →
// feApplyChatMergeAroundElement) only re-merges a local neighborhood, and when
// messages stream in one-per-frame (initial load, chat-prune backward render) the
// overlapping local slices leave most groups unmarked — verified live: a full
// feApplyChatMerge produced 11 group classes where the incremental path produced 0.
// A single full feApplyChatMerge over the (pruned, small) live DOM is cheap and
// authoritative, so we run one after the log settles. Debounced so a burst of
// renders/creates coalesces into one pass.
let feFullMergePassTimer = null;
function feScheduleFullMergePass({ delay = 120 } = {}) {
  try {
    if (!feSetting(S.MERGE_ENABLED)) return;
    if (feFullMergePassTimer) clearTimeout(feFullMergePassTimer);
    feFullMergePassTimer = setTimeout(() => {
      feFullMergePassTimer = null;
      try { feApplyChatMergeToAllLogs(); } catch { /* no-op */ }
    }, Math.max(0, Number(delay) || 0));
  } catch {
    /* no-op */
  }
}

function feScheduleRenderedStateRefreshForMessageId(messageId, { delay = 24, allowNarratorMerge = false, edgeLookahead = true, doc = document } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    const id = feNormalizeChatMessageId(messageId);
    const rootDoc = doc?.querySelectorAll ? doc : document;
    const logs = new Set();
    if (id) {
      const escaped = feCssEscape(id);
      const selector = `[data-message-id="${escaped}"], [data-document-id="${escaped}"], [data-document-id$=".${escaped}"]`;
      rootDoc.querySelectorAll?.(selector)?.forEach?.((node) => {
        const li = node?.closest?.("li.chat-message");
        const log = li?.closest?.("ol.chat-log, #chat-log") ?? node?.closest?.("ol.chat-log, #chat-log");
        if (feIsElementNode(log)) logs.add(log);
      });
    }
    if (!logs.size) {
      const fallbackLogs = feGetChatLogsInDocument(rootDoc);
      for (const log of fallbackLogs) logs.add(log);
    }
    if (!logs.size) {
      feScheduleRenderedStateRefreshForAllLogs({ delay, allowNarratorMerge, edgeLookahead });
      return;
    }
    for (const log of logs) feScheduleRenderedLogRefresh(log, { delay, allowNarratorMerge, edgeLookahead });
  } catch {
    feScheduleRenderedStateRefreshForAllLogs({ delay, allowNarratorMerge, edgeLookahead });
  }
}

function feFlushQueuedRenderedMessageRefreshes() {
  try {
    const ids = Array.from(feQueuedRenderedMessageIds);
    feQueuedRenderedMessageIds.clear();
    feQueuedRenderedMessageTimer = null;

    if (!ids.length) {
      feQueuedRenderedMessagePass = 0;
      feQueuedRenderedMessageNarratorMerge = false;
      return;
    }

    const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
    const logs = feGetChatLogs();
    // Escape once, not per (log × id). An unescaped id that is not a valid CSS
    // identifier makes querySelector THROW, and the outer catch would silently drop
    // the whole queued batch — feScheduleRenderedStateRefreshForMessageId already
    // escapes for exactly this reason.
    const escapedIds = ids.map((id) => feCssEscape(id));
    let missing = false;
    try {
      for (const log of logs) {
        if (!feIsElementNode(log)) continue;
        try { feDedupeChatMessagesInLog(log); } catch {}
        const anchors = new Set();
        for (const id of escapedIds) {
          const el = log.querySelector?.(`li.chat-message[data-message-id="${id}"], li.chat-message[data-document-id="${id}"]`);
          if (!el) { missing = true; continue; }
          anchors.add(el);
        }
        for (const el of anchors) {
          const msgId = feGetMessageIdFromElement(el);
          const msg = feGetMessageFromElementOrCollection(el) || (msgId ? game?.messages?.get?.(msgId) : null);
          feApplyRenderedStateToMessageElement(msg, el, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge });
        }
        if (feSetting(S.MERGE_ENABLED)) {
          // anchors > 1: one full-log pass (1× querySelectorAll+sort) beats N neighborhood passes.
          // anchors ≤ 1: targeted neighborhood is lighter — skip the full-log class-write sweep.
          if (anchors.size > 1) {
            feApplyChatMerge(log, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge, edgeLookahead: true });
          } else {
            for (const el of anchors)
              feApplyChatMergeAroundElement(el, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge, skipDedup: true, edgeLookahead: true });
          }
        }
      }
    } finally {
      restoreStickyScroll();
    }

    if (missing && feQueuedRenderedMessagePass < 2) {
      feQueuedRenderedMessagePass += 1;
      for (const id of ids) feQueuedRenderedMessageIds.add(id);
      feQueuedRenderedMessageTimer = setTimeout(feFlushQueuedRenderedMessageRefreshes, 28 + (feQueuedRenderedMessagePass * 18));
      return;
    }

    feQueuedRenderedMessagePass = 0;
    feQueuedRenderedMessageNarratorMerge = false;
  } catch {
    feQueuedRenderedMessageTimer = null;
    feQueuedRenderedMessagePass = 0;
    feQueuedRenderedMessageNarratorMerge = false;
  }
}

function feScheduleRenderedMessageRefresh(messageOrId, { delay = 16, allowNarratorMerge = false } = {}) {
  try {
    const id = feNormalizeChatMessageId(messageOrId?.id ?? messageOrId?._id ?? messageOrId);
    if (!id) return;
    feQueuedRenderedMessageIds.add(id);
    feQueuedRenderedMessageNarratorMerge = feQueuedRenderedMessageNarratorMerge || !!allowNarratorMerge;
    if (feQueuedRenderedMessageTimer) return;
    feQueuedRenderedMessageTimer = setTimeout(feFlushQueuedRenderedMessageRefreshes, Math.max(0, Number(delay) || 0));
  } catch {
    /* no-op */
  }
}

// -------------------------------------
// Chat message hooks
// -------------------------------------

Hooks.on("renderChatMessageHTML", (message, html) => {
  const el = feExtractHTMLElement(html);
  if (!el) return;
  try {
    feSnapshotOrRestoreInlineRolls(message, el);
  } catch {
    /* no-op */
  }
  try {
    feApplyRenderedStateToMessageElement(message, el);
  } catch {
    /* no-op */
  }
  try {
    fePreApplyMergeHint(message, el);
  } catch {
    /* no-op */
  }
  feQueueMergeForRAF(message?.id ?? message?._id);
  // Authoritative trailing full merge. Covers EVERY message-render path — initial
  // load, live posts, and chat-prune scroll-batch (re)renders — because the
  // incremental per-message/around-element path can leave groups unmarked. Debounced
  // so a burst of renders coalesces into a single pass over the (pruned) DOM.
  feScheduleFullMergePass({ delay: 120 });
});

Hooks.on("createChatMessage", (message, _options, userId) => {
  try {
    // Capture the pre-append bottom state NOW (before ChatLog#postOne renders/appends
    // the new message) and guarantee a re-pin after our portrait/merge mutations settle.
    // Core only auto-scrolls an incoming OTHER-player message when its cached isAtBottom
    // is true, which a prior async reflow can wrongly flip to false while the user is in
    // another window — stranding the new message. This makes following robust.
    feFollowIncomingChatMessage();
  } catch {
    /* no-op */
  }
  try {
    feHydrateRenderStateOverride(message, null, userId);
    // Safety refresh for the create→update race: when feQueueMergeForRAF fired from
    // renderChatMessageHTML the element may not have been in the DOM yet. This is NOT
    // redundant with the 120ms full pass — it also (re)stamps and re-applies the user
    // colour background, which the merge-only pass does not do.
    // The 42ms delay is TUNED, not arbitrary: an earlier build scheduled a second
    // 18ms merge here and it produced a visible double-flash of merge classes.
    feDeferTask(() => feScheduleRenderedStateRefreshForMessageId(message?.id ?? message?._id, { delay: 42 }));
    // (Full merge pass is scheduled from the renderChatMessageHTML hook, which fires
    // for every rendered message — including these newly created ones.)
  } catch {
    /* no-op */
  }
});

Hooks.on("deleteChatMessage", (message) => {
  try {
    feClearInlineRollSnapshot(message?.id ?? message?._id);
    feStoreRenderStateOverride(message?.id ?? message?._id, null);
    feScheduleRenderedStateRefreshForAllLogs({ delay: 24 });
  } catch {
    /* no-op */
  }
});

Hooks.on("updateChatMessage", (message, change, _options, userId) => {
  try {
    const msgId = message?.id ?? message?._id;
    // Protect the snapshot only when this update is our own freeze (content-only, no rolls).
    // Any other update — including midi-qol updating rolls or flags — must clear the
    // snapshot so stale advantage/normal anchors are not restored on re-render.
    const isOurFreezeContentUpdate = feIsMessageFreezeInProgress(msgId)
      && Object.prototype.hasOwnProperty.call(change ?? {}, "content")
      && !Object.prototype.hasOwnProperty.call(change ?? {}, "rolls");
    if (!isOurFreezeContentUpdate)
      feClearInlineRollSnapshot(msgId);
    if (feChangeTouchesRenderState(change)) feHydrateRenderStateOverride(message, null, userId);
    // Skip re-render when the update only touches another module's flags (e.g. dx3rd button-
    // completion flags). Those modules handle their own DOM updates via renderChatMessageHTML;
    // triggering a full re-render here would cause unnecessary flicker and wasted cycles.
    const onlyExternalFlags = (() => {
      const keys = Object.keys(change ?? {}).filter(k => k !== "_id");
      if (!keys.length || !keys.every(k => k === "flags")) return false;
      const ns = Object.keys(change.flags ?? {});
      return ns.length > 0 && !ns.includes(MODULE_ID);
    })();
    if (!onlyExternalFlags) feDeferTask(() => feScheduleRenderedMessageRefresh(msgId, { delay: 0 }));
  } catch {
    /* no-op */
  }
});

Hooks.on("preCreateChatMessage", (message, data, _options, userId) => {
  try {
    if (userId !== game.user.id) return;

    // Screen panel actors are display boards, not characters — never let them be chat speakers.
    // Main risk: a tokenized panel selected on canvas → getSpeaker() resolves to the panel actor.
    try {
      const sp = data?.speaker ?? message?.speaker ?? {};
      let spActor = sp.actor ? (game.actors?.get(sp.actor) ?? null) : null;
      if (!spActor && sp.token && sp.scene) {
        const sc = game.scenes?.get(sp.scene);
        spActor = sc?.tokens?.get(sp.token)?.actor ?? null;
      }
      if (spActor?.type === "female_edition.screenPanel") {
        message.updateSource({
          speaker: { scene: null, actor: null, token: null, alias: game.user.name },
        });
      }
    } catch { /* no-op */ }

    if (game.user?.isGM && feSetting(S.GM_SPEAK_AS_SELF)) {
      try {
        // Theatre stage hook (registered later in module load order) takes priority.
        // Its "없음" choice is an explicit core-speaker pass-through: preserve the
        // speaker ChatMessage.getSpeaker() derived from the controlled canvas token
        // (or its normal user-character/user fallback), instead of applying this GM-only
        // speak-as-self override. An actual staged actor also owns its speaker.
        const _stageVal = document.querySelector("#fe-stage-nav select.fe-stage-select")?.value;
        const stageActive = !!_stageVal && _stageVal !== "__none__" && _stageVal !== "";
        const stageCorePassThrough = _stageVal === "__none__";
        if (!stageActive && !stageCorePassThrough) {
          const speaker = data?.speaker ?? message?.speaker ?? {};
          const OWNER = 3;

          // Skip for system-initiated roll messages that already carry an explicit actor
          // speaker (e.g. dx3rd attack/damage rolls). The actor was set intentionally by
          // the system; overriding it would break actor-id tracking and portraits.
          const msgRolls = Array.isArray(data?.rolls) ? data.rolls
            : (Array.isArray(message?.rolls) ? message.rolls : []);
          if (!(msgRolls.length > 0 && speaker?.actor)) {
            let actor = null;
            if (speaker?.actor) {
              actor = game.actors?.get(speaker.actor) ?? null;
            }
            if (!actor && speaker?.token && speaker?.scene) {
              const scene = game.scenes?.get(speaker.scene);
              const tokenDoc = scene?.tokens?.get(speaker.token);
              actor = tokenDoc?.actor ?? null;
            }

            if (actor) {
              const ownership = actor.ownership ?? {};
              const hasPlayerOwner = Object.entries(ownership).some(([uid, level]) => {
                if (uid === "default") return false;
                const user = game.users?.get(uid);
                return user && !user.isGM && level >= OWNER;
              });

              if (hasPlayerOwner) {
                const gmSpeaker = {
                  scene: null,
                  actor: null,
                  token: null,
                  alias: game.user.name,
                };
                message.updateSource({ speaker: gmSpeaker });
              }
            }
          }
        }
      } catch {
        /* no-op */
      }
    }

    feApplyMarkdownOnPreCreate(message, data, userId);
    feCaptureMessageRenderFlagsOnPreCreate(message, feGetPendingMessageSource(message, data), userId);
  } catch {
    /* no-op */
  }
});

Hooks.on("preUpdateChatMessage", (message, changed, _options, userId) => {
  try {
    if (userId !== game.user.id) return;
    const modFlags = changed?.flags?.[MODULE_ID] ?? null;
    const rawEditPending = !!(modFlags && typeof modFlags === "object" && (
      Object.prototype.hasOwnProperty.call(modFlags, "raw") ||
      Object.prototype.hasOwnProperty.call(modFlags, "plain")
    ));
    if (!rawEditPending) {
      feCaptureMessageRenderFlagsOnPreUpdate(message, changed, userId);
    }
  } catch {
    /* no-op */
  }
});

// -------------------------------------
// Exports (same public API as before)
// -------------------------------------

export {
  MODULE_ID,
  S,
  FE_DEFAULTS,
  FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  feSetting,
  feFireChatUiUpdated,
  feCaptureWorldSettings,

  feNormalizeChatMessageId,
  feGetMessageIdFromElement,

  feGetChatLogs,
  feMarkdownToHTML,
  feEscapeHTML,
  feUnwrapProseMirrorHTML,
  feGetSpeakerActorFromMessage,
  feGetMessageUserColor,

  feApplyStyleVarsFromSettings,
  feStripChatTexturesInWindow,
  feApplyUserColorBgToMessageElement,
  feApplyRenderedStateToMessageElement,
  feApplyRenderedStateToLog,
  feScheduleRenderedStateRefreshForAllLogs,
  feScheduleRenderedStateRefreshForMessageId,
  feSetChatFontChoiceClass,
  feSetChatCardFontClass,
  feSetUiFontClass,
  feSetNeodgmModeClass,
  feSetUserFontMode,
  feApplyCanvasTextFont,
  feSetRetroThemeClass,
  feSetUserColorBgBaseClass,
  feSetUserColorBgClass,
  feSetPaperOverlayClass,
  feSetChatGroupOutlineClass,
  feSetAccentTextOverrideClass,
  feSetSystemMsgColorClass,
  feSetForceNormalMsgColorClass,

  feApplyChatMerge,
  feCaptureMessageRenderFlagsOnPreCreate,
  feCaptureMessageRenderFlagsOnPreUpdate,
  feMessageMergeInfo,
  feMergeKey,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feIsUntouchedSpecialMessage,
};
