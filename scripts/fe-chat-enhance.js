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
  FE_GM_PRIORITY_OVERRIDES_KEY,
} from "./fe-constants.js";

import {
  feIsElementNode, feExtractHTMLElement, feBindMessageToElement, feIsNotificationMessageElement,
  feGetChatLogs, feGetChatLogsInDocument, feDedupeChatMessagesInLog,
  feGetMessageIdFromElement, feNormalizeChatMessageId, feCssEscape,
  feDeferTask, feWindowRequestFrame, feSnapshotAndRestoreStickyScroll,
  feGetMessageFromElementOrCollection,
} from "./fe-util.js";

import {
  feSyncingLocalGmPrioritySettings,
  feIsGmPrioritySettingKey, feHasGmPriorityOverride,
  feMirrorGmPrioritySetting, feSyncLocalGmPrioritySettings,
  feSeedGmPriorityOverridesFromLocal,
  feFireChatUiUpdated, feSetting,
} from "./fe-gm-priority.js";

import { feApplyMarkdownOnPreCreate } from "./fe-markdown.js";

import {
  feSetBodyMergeClasses, feSetChatCardFontClass, feSetChatFontChoiceClass,
  feSetUiFontClass, feSetNeodgmModeClass, feSetDx3rdPixelThemeClass,
  feSetUserColorBgClass, feSetUserColorBgBaseClass,
  feApplyStyleVarsFromSettings,
} from "./fe-style.js";

import {
  feGetStoredRenderState, feStoreRenderStateOverride, feHydrateRenderStateOverride,
  feChangeTouchesRenderState,
  feCaptureMessageRenderFlagsOnPreCreate, feCaptureMessageRenderFlagsOnPreUpdate,
  feGetPendingMessageSource,
  feIsNarratorToolsMessage, feIsRoundMarkerMessage, feIsUntouchedSpecialMessage,
  feApplyUserColorBgToMessageElement, feApplyUserColorBgToAllLogs, feApplyUserColorBgToLog,
  feStampRenderedStateAttributes,
  feMessageMergeInfo, feMergeKey, feCanMergePair,
  feGetMessageUserColor, feGetSpeakerActorFromMessage,
} from "./fe-render-state.js";

import { feSnapshotOrRestoreInlineRolls, feClearInlineRollSnapshot, feIsMessageFreezeInProgress } from "./fe-inline-rolls.js";

import {
  feClearMergeClassesFromMessageElement,
  feApplyChatMerge, feApplyChatMergeToAllLogs, feApplyChatMergeAroundElement,
  fePreApplyMergeHint, feSetMergeScheduleCallback,
} from "./fe-merge.js";

import { feMarkdownToHTML } from "./fe-markdown.js";
import { feStripChatTexturesInWindow } from "./fe-texture.js";

// Wire the merge retry back-reference so fe-merge.js can call feScheduleRenderedLogRefresh
// without a circular import.
feSetMergeScheduleCallback((logEl, opts) => feScheduleRenderedLogRefresh(logEl, opts));

// -------------------------------------
// Helpers
// -------------------------------------

function feHasRenderedStateWork() {
  try {
    return !!feSetting(S.MERGE_ENABLED) || !!feSetting(S.USE_USER_COLOR_BG);
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

  await feNormalizeChoiceSetting(S.CHAT_FONT_CHOICE, ["cookie", "geurimilgi"], FE_DEFAULTS[S.CHAT_FONT_CHOICE]);
  await feNormalizeChoiceSetting(S.MERGE_MODE, ["standard", "simple"], FE_DEFAULTS[S.MERGE_MODE]);
  await feNormalizeChoiceSetting(S.MERGE_FOLLOW_HEADER_STYLE, ["hide", "name", "portrait"], FE_DEFAULTS[S.MERGE_FOLLOW_HEADER_STYLE]);
  await feNormalizeChoiceSetting(S.MERGE_SPEAKER_BASIS, ["token", "actor", "author"], FE_DEFAULTS[S.MERGE_SPEAKER_BASIS]);
  await feNormalizeChoiceSetting(S.USER_COLOR_BG_BASE, ["white", "black", "none"], FE_DEFAULTS[S.USER_COLOR_BG_BASE]);
  await feNormalizeChoiceSetting(S.EXPORT_PRINT_IMAGE_MODE, Object.keys(FE_EXPORT_PRINT_IMAGE_MODE_CHOICES), FE_DEFAULTS[S.EXPORT_PRINT_IMAGE_MODE]);
  await feNormalizeChoiceSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE, ["off", "button", "auto"], FE_DEFAULTS[S.EXPORT_DESKTOP_EXTERNAL_MODE]);
}

// -------------------------------------
// GM priority UI refresh (needs style + fire — lives here to avoid circular)
// -------------------------------------

function feApplyGmPriorityUiRefresh(doc = document) {
  try {
    feApplyStyleVarsFromSettings(doc);
  } catch {
    /* no-op */
  }
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

  game.settings.register(MODULE_ID, S.MERGE_ENABLED, {
    name: "채팅 병합(연속 메시지 시각적 묶기)",
    hint: "같은 화자/유저의 연속 메시지를 하나처럼 보이도록 묶습니다(문서 편집 없음).",
    scope: "client",
    config: true,
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
    config: true,
    type: Boolean,
    default: false,
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.MERGE_INCLUDE_ROLL_MESSAGES, {
    name: "채팅 병합: 주사위 결과 메시지도 포함",
    hint: "끄면 .dice-roll / .dice-result / ChatMessage.rolls 메시지는 병합에서 제외합니다. 켜면 같은 화자의 연속 주사위 결과 메시지도 병합할 수 있습니다. midi/dnd5e 채팅 카드는 계속 제외됩니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feScheduleRenderedStateRefreshForAllLogs({ delay: 0 }),
  });

  game.settings.register(MODULE_ID, S.MERGE_DIVIDER, {
    name: "채팅 병합: 그룹 구분선 표시",
    hint: "다른 화자의 새 그룹이 시작될 때 얇은 구분선을 표시합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.MERGE_MODE, {
    name: "채팅 병합 방식",
    hint: "표준은 메시지 박스 경계까지 붙여 묶고, 간소화는 같은 화자의 후속 메시지에서 헤더만 숨깁니다.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      standard: "표준(경계/간격까지 묶기)",
      simple: "간소화(후속 헤더만 숨김)",
    },
    default: "simple",
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
    config: true,
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
    config: true,
    type: String,
    choices: {
      token:  "토큰(기본) — 토큰+액터+씬 모두 일치해야 병합",
      actor:  "액터 — 같은 액터면 병합 (토큰 무시)",
      author: "플레이어(작성자) — 같은 유저면 병합",
    },
    default: "token",
    onChange: () => feApplyChatMergeToAllLogs(),
  });

  game.settings.register(MODULE_ID, S.EXPORT_ENABLED, {
    name: "채팅 로그 PDF 내보내기 버튼",
    hint: "채팅 입력창 옆에 PDF(인쇄) 버튼을 추가합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feFireChatUiUpdated({ reason: "export-settings", document }),
  });

  game.settings.register(MODULE_ID, S.EXPORT_AUTO_PRINT, {
    name: "PDF 버튼: 자동 인쇄창 열기",
    hint: "켜면 PDF 버튼 클릭 시 아카이브 창을 연 뒤 자동으로 인쇄(프린트) 다이얼로그를 엽니다. 끄면 아카이브만 열립니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: false,
  });

  game.settings.register(MODULE_ID, S.EXPORT_OPTIMIZE, {
    name: "내보내기 최적화(용량/멈춤 방지)",
    hint: "아카이브/인쇄 시 parchment/texture 이미지와 그림자 등을 강제로 제거하여 PDF 용량과 메모리 사용량을 크게 줄입니다(권장).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EMBED_FONTS, {
    name: "HTML 저장: 커스텀 폰트 포함",
    hint: "HTML로 저장할 때 CookieRun 폰트를 파일 안에 포함시켜(임베드) 나중에 단독으로 열어도 폰트가 유지되게 합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_EMBED_IMAGES, {
    name: "HTML 저장: 이미지 포함",
    hint: "HTML로 저장할 때 채팅 로그의 이미지(포트레이트/아이콘 등)를 파일 안에 포함시킵니다. 같은 이미지가 반복되면 자동으로 중복을 제거하여 용량을 절약합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EXPORT_PRINT_IMAGE_MODE, {
    name: "PDF/인쇄: 이미지 처리",
    hint: "크롬/일렉트론 인쇄(PDF)에서 이미지가 많으면 메모리가 급증해 멈출 수 있습니다. PDF 안정성을 위해 아바타/이미지를 숨기거나 다운스케일할 수 있습니다.",
    scope: "client",
    config: true,
    type: String,
    choices: FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
    default: "downscaleLite",
  });

  game.settings.register(MODULE_ID, S.EXPORT_DESKTOP_EXTERNAL_MODE, {
    name: "FVTT 데스크톱: 외부 브라우저로 아카이브 열기",
    hint: "데스크톱(Electron) 앱에서 인쇄(PDF) 시 메모리/멈춤 문제가 있을 때, 아카이브를 HTML 파일로 만들어 시스템 기본 브라우저로 열 수 있습니다. (Electron/Node API 접근이 가능한 경우에만 동작)",
    scope: "client",
    config: true,
    type: String,
    choices: {
      off: "사용 안 함",
      button: "아카이브 창에 버튼 표시",
      auto: "PDF 아이콘 클릭 시 자동",
    },
    default: "button",
  });

  // Style settings (CSS vars)

  game.settings.register(MODULE_ID, S.STYLE_ACTOR_NAME_SIZE, {
    name: "채팅: 액터 이름 크기(px)",
    hint: "채팅 메시지 헤더의 액터(캐릭터) 이름 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_ACTOR_NAME_SIZE],
    range: { min: 10, max: 40, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_PLAYER_NAME_SIZE, {
    name: "채팅: 플레이어 이름 크기(px)",
    hint: "채팅 메시지 헤더의 플레이어 이름(서브타이틀) 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_PLAYER_NAME_SIZE],
    range: { min: 8, max: 28, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_MESSAGE_TEXT_SIZE, {
    name: "채팅: 메시지 글자 크기(px)",
    hint: "일반 채팅 텍스트(메시지 내용)의 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 14,
    range: { min: 9, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_CHATCARD_TEXT_SIZE, {
    name: "채팅: 주문/아이템/피처 설명 글자 크기(px)",
    hint: "dnd5e 채팅 카드(주문/아이템/피처) 설명 영역의 기본 글자 크기입니다.",
    scope: "client",
    config: true,
    type: Number,
    default: 12,
    range: { min: 9, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_CHAT_MESSAGE_SPACING, {
    name: "채팅: 메시지 카드 간격(px)",
    hint: "Foundry 기본 변수 chat-sidebar { --chat-message-spacing } 값을 덮어씁니다. 메시지 카드 사이 간격을 조절합니다.",
    scope: "client",
    config: true,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_CHAT_MESSAGE_SPACING],
    range: { min: 0, max: 24, step: 1 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.CHATCARD_USE_CUSTOM_FONT, {
    name: "채팅 카드(설명) 커스텀 폰트 적용",
    hint: "주문/아이템/피처 설명 박스(Details/Description)에도 UI 커스텀 폰트(CookieRun/그림일기)를 적용합니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다. 아이콘/특수문자 표시가 깨지면 끄세요.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feSetChatCardFontClass(),
  });

  game.settings.register(MODULE_ID, S.CHAT_FONT_CHOICE, {
    name: "채팅 글꼴 선택",
    hint: "채팅 메시지 본문/헤더에 사용할 기본 글꼴을 선택합니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다.",
    scope: "client",
    config: true,
    type: String,
    choices: {
      cookie: "쿠키런",
      geurimilgi: "그림일기",
    },
    default: "cookie",
    onChange: () => feSetChatFontChoiceClass(document),
  });

  game.settings.register(MODULE_ID, S.UI_USE_GEURIMILGI, {
    name: "UI/시트 기본 글꼴: 그림일기 사용(쿠키런 대체)",
    hint: "html/body, #ui/#interface, dnd5e2 능력치 라벨(ability-scores/abilities) 등 기본 UI 글꼴을 그림일기 폰트로 바꿉니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_USE_GEURIMILGI],
    onChange: () => feSetUiFontClass(document),
  });

  game.settings.register(MODULE_ID, S.UI_NEODGM_MODE, {
    name: "커스텀 폰트: NeoDGM 픽셀 폰트로 전체 교체",
    hint: "CookieRun/그림일기 등 모든 커스텀 폰트를 NeoDGM(픽셀) 폰트 하나로 교체합니다. '커스텀 폰트 적용'이 꺼져 있으면 효과가 없습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_NEODGM_MODE],
    onChange: () => feSetNeodgmModeClass(document),
  });

  game.settings.register(MODULE_ID, S.UI_DX3RD_PIXEL_THEME, {
    name: "[DX3rd] 픽셀 고대비 테마",
    hint: "모든 UI 요소를 각지게(border-radius 0), 안티에일리어싱 OFF, 트랜지션 즉각 반응으로 변환합니다. double-cross-3rd 시스템 전용 레이아웃 보정 포함. NeoDGM 폰트 모드와 함께 사용 권장.",
    scope: "client",
    config: true,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_DX3RD_PIXEL_THEME],
    onChange: () => feSetDx3rdPixelThemeClass(document),
  });

  game.settings.register(MODULE_ID, S.UI_OVERRIDE_FONT_H1_COOKIE, {
    name: "헤딩 글꼴(--font-h1): 쿠키런으로 덮어쓰기",
    hint: "Foundry/테마가 사용하는 CSS 변수 --font-h1 값을 쿠키런 폰트로 덮어씌웁니다. 일부 테마의 제목/헤딩 글꼴이 바뀔 수 있습니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: FE_DEFAULTS[S.UI_OVERRIDE_FONT_H1_COOKIE],
    onChange: () => feApplyStyleVarsFromSettings(document),
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
    config: true,
    type: Boolean,
    default: FE_DEFAULTS[S.USE_USER_COLOR_BG],
    onChange: () => {
      feSetUserColorBgClass(document);
      feApplyUserColorBgToAllLogs(document);
    },
  });

  game.settings.register(MODULE_ID, S.USER_COLOR_BG_BASE, {
    name: "채팅 메시지 배경: 유저 색상 하부 배경(불투명)",
    hint: "유저 색상 틴트 아래에 불투명한 배경(흰색/검정)을 깔아 가독성을 높입니다. (유저 색상 배경이 켜져 있을 때만 의미가 있습니다)",
    scope: "client",
    config: true,
    type: String,
    choices: {
      white: "흰색(권장)",
      black: "검정",
      none: "사용 안 함(기존 방식)",
    },
    default: "white",
    onChange: () => feSetUserColorBgBaseClass(document),
  });

  game.settings.register(MODULE_ID, S.STYLE_BG_SATURATION, {
    name: "채팅: 배경 채도(페이퍼 오버레이 알파)",
    hint: "텍스쳐 제거 시 사용하는 '페이퍼 오버레이'의 알파 값입니다. 값이 높을수록 더 밝고(채도 약화), 낮을수록 더 진해집니다.",
    scope: "client",
    config: true,
    type: Number,
    default: FE_DEFAULTS[S.STYLE_BG_SATURATION],
    range: { min: 0.05, max: 1.0, step: 0.01 },
    onChange: () => feApplyStyleVarsFromSettings(document),
  });

  game.settings.register(MODULE_ID, S.MARKDOWN_ENABLED, {
    name: "채팅 입력 마크다운 지원",
    hint: "채팅 입력 텍스트를 마크다운으로 처리합니다(이미지/링크/제목/굵게/기울임/취소선/인용구).",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
  });

  game.settings.register(MODULE_ID, S.EDIT_ENABLED, {
    name: "채팅 수정(편집) 다이얼로그",
    hint: "메시지 수정 버튼 클릭 시 마크다운 기반 편집 다이얼로그를 사용합니다.",
    scope: "client",
    config: true,
    type: Boolean,
    default: true,
    onChange: () => feFireChatUiUpdated({ reason: "edit-settings", document }),
  });

  game.settings.register(MODULE_ID, S.GM_PRIORITY_ENABLED, {
    name: "GM 설정 전역 강제",
    hint: "활성화 시 GM의 모듈 설정(채팅 병합, 폰트, 스타일 등)이 모든 플레이어에게 강제 적용됩니다. 아카이브/편집 설정은 개인 설정을 유지합니다.",
    scope: "world",
    config: true,
    restricted: true,
    type: Boolean,
    default: true,
    onChange: () => {
      feApplyGmPriorityUiRefresh(document);
      void feSyncLocalGmPrioritySettings();
    },
  });

  game.settings.register(MODULE_ID, S.GM_SPEAK_AS_SELF, {
    name: "GM: PC 토큰 선택 시 본인 이름으로 채팅",
    hint: "활성화 시 GM이 플레이어 소유 캐릭터 토큰을 선택한 상태에서 채팅을 보내도 해당 캐릭터가 아닌 GM 본인으로 표시됩니다.",
    scope: "client",
    config: true,
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

Hooks.on("clientSettingChanged", (fullKey, value) => {
  try {
    if (feSyncingLocalGmPrioritySettings) return;
    const keyPath = String(fullKey ?? "").trim();
    if (!keyPath.startsWith(`${MODULE_ID}.`)) return;
    const key = keyPath.slice(MODULE_ID.length + 1);
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

Hooks.once("ready", async () => {
  await feMigrateLegacySettings();
  if (game.user?.isGM) await feSeedGmPriorityOverridesFromLocal();
  await feSyncLocalGmPrioritySettings();
  feApplyStyleVarsFromSettings(document);
  feSetBodyMergeClasses();
  feSetChatCardFontClass(document);
  feSetChatFontChoiceClass(document);
  feSetUiFontClass(document);
  feSetNeodgmModeClass(document);
  feSetDx3rdPixelThemeClass(document);
  feSetUserColorBgClass(document);
  feSetUserColorBgBaseClass(document);
  if (feHasRenderedStateWork()) feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });
  feFireChatUiUpdated({ reason: "ready", root: document, log: null, document });
});

// -------------------------------------
// Rendered state application
// -------------------------------------

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

function feApplyRenderedStateToLog(logEl, { allowNarratorMerge = false } = {}) {
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
    if (feSetting(S.MERGE_ENABLED)) feApplyChatMerge(logEl, { allowNarratorMerge, preNodes: nodes });
  } catch {
    /* no-op */
  }
}

function feApplyRenderedStateToAllLogs() {
  try {
    for (const log of feGetChatLogs()) feApplyRenderedStateToLog(log);
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
      const opts = fePendingRenderedLogOptions.get(log) ?? {};
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

function feScheduleRenderedLogRefresh(logEl, { delay = 24, allowNarratorMerge = false } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    if (!feIsElementNode(logEl)) return;
    const opts = fePendingRenderedLogOptions.get(logEl) ?? { allowNarratorMerge: false };
    opts.allowNarratorMerge = opts.allowNarratorMerge || !!allowNarratorMerge;
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

function feScheduleRenderedStateRefreshForAllLogs({ delay = 24, allowNarratorMerge = false } = {}) {
  try {
    if (!feHasRenderedStateWork()) return;
    for (const log of feGetChatLogs()) feScheduleRenderedLogRefresh(log, { delay, allowNarratorMerge });
  } catch {
    /* no-op */
  }
}

function feScheduleRenderedStateRefreshForMessageId(messageId, { delay = 24, allowNarratorMerge = false, doc = document } = {}) {
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
      feScheduleRenderedStateRefreshForAllLogs({ delay, allowNarratorMerge });
      return;
    }
    for (const log of logs) feScheduleRenderedLogRefresh(log, { delay, allowNarratorMerge });
  } catch {
    feScheduleRenderedStateRefreshForAllLogs({ delay, allowNarratorMerge });
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
    let missing = false;
    try {
      for (const log of logs) {
        if (!feIsElementNode(log)) continue;
        try { feDedupeChatMessagesInLog(log); } catch {}
        const anchors = new Set();
        for (const id of ids) {
          const el = log.querySelector?.(`li.chat-message[data-message-id="${id}"], li.chat-message[data-document-id="${id}"]`);
          if (!el) { missing = true; continue; }
          anchors.add(el);
        }
        for (const el of anchors) {
          const msgId = feGetMessageIdFromElement(el);
          const msg = feGetMessageFromElementOrCollection(el) || (msgId ? game?.messages?.get?.(msgId) : null);
          feApplyRenderedStateToMessageElement(msg, el, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge });
          if (feSetting(S.MERGE_ENABLED)) feApplyChatMergeAroundElement(el, { allowNarratorMerge: feQueuedRenderedMessageNarratorMerge, skipDedup: true });
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
});

Hooks.on("createChatMessage", (message, _options, userId) => {
  try {
    feHydrateRenderStateOverride(message, null, userId);
    feDeferTask(() => feScheduleRenderedStateRefreshForMessageId(message?.id ?? message?._id, { delay: 42 }));
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

    if (game.user?.isGM && feSetting(S.GM_SPEAK_AS_SELF)) {
      try {
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

  feNormalizeChatMessageId,
  feGetMessageIdFromElement,

  feGetChatLogs,
  feMarkdownToHTML,
  feGetSpeakerActorFromMessage,
  feGetMessageUserColor,

  feApplyStyleVarsFromSettings,
  feStripChatTexturesInWindow,
  feApplyUserColorBgToMessageElement,
  feApplyRenderedStateToMessageElement,
  feApplyRenderedStateToLog,
  feApplyRenderedStateToAllLogs,
  feScheduleRenderedStateRefreshForAllLogs,
  feScheduleRenderedStateRefreshForMessageId,
  feSetChatFontChoiceClass,
  feSetChatCardFontClass,
  feSetUiFontClass,
  feSetNeodgmModeClass,
  feSetDx3rdPixelThemeClass,
  feSetUserColorBgBaseClass,
  feSetUserColorBgClass,

  feApplyChatMerge,
  feCaptureMessageRenderFlagsOnPreCreate,
  feCaptureMessageRenderFlagsOnPreUpdate,
  feMessageMergeInfo,
  feMergeKey,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feIsUntouchedSpecialMessage,
};
