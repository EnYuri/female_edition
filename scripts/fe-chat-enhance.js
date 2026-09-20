import { feRegisterSetting } from "./fe-settings-data.js";
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
  MODULE_ID, FE_DX3RD_SYSTEM_IDS, feIsDx3rdSystemId, LEGACY_UI_FONT_KEY, S,
  FE_DEFAULTS, FE_EXPORT_PRINT_IMAGE_MODE_CHOICES,
  FE_GM_PRIORITY_OVERRIDES_KEY, FE_GM_PRIORITY_BACKUP_KEY, FE_WORLD_SETTINGS_KEY,
  FE_CORE_PRIORITY_OVERRIDES_KEY, FE_CORE_PRIORITY_BACKUP_KEY,
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

import {
  feSyncingLocalCoreSettings,
  feIsCorePriorityEnabled, feIsCorePriorityKey, feHasCoreOverride,
  feMirrorCoreSetting, feSyncLocalCoreSettings, feRestoreLocalCoreSettings,
  feSeedCoreOverridesFromLocal,
} from "./fe-core-priority.js";

import { feApplyMarkdownOnPreCreate, feMarkdownToHTML, feEscapeHTML, feUnwrapProseMirrorHTML } from "./fe-markdown.js";
import {
  feHasRestorableMidiDamageTypes,
  feRestoreMidiDamageTypeIcons,
  feRestoreMidiItemDescription,
} from "./fe-midi-damage-types.js";

import {
  feSetBodyMergeClasses, feSetChatCardIconCropClass, feSetChatCardFontClass, feSetChatFontChoiceClass,
  feSetUiFontClass, feSetNeodgmModeClass, feSetUserFontMode, feSetRetroThemeClass,
  feApplyDoubleCrossLegacyPixiTheme, feInstallDoubleCrossLegacyPixiTheme,
  feSetUserColorBgClass, feSetUserColorBgBaseClass, feSetPaperOverlayClass, feSetChatGroupOutlineClass,
  feSetHideMsgBorderUserColorClass,
  feNormalizeChoice,
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

// Core timeSince() feeds the (now - timestamp) difference through
// CalendarData._decomposeTimeYears, which maps ANY negative (future) diff to
// year=-1 with ~365 leftover days — formatDuration then renders "11개월 3XX일 전"
// regardless of the real gap. A ChatMessage stamped while the host clock ran
// ahead (drift later corrected by NTP, a manually-set clock, a skewed remote
// server) therefore shows an absurd "past" forever on every client.
// Clamp future inputs to "now" so such cards display as just-posted (TIME.Now).
//
// Two surfaces render the stamp: ChatLog.updateTimestamps() (15s refresh — calls
// foundry.utils.timeSince dynamically, so the wrap covers it) and the
// {{timeSince}} Handlebars helper, which captured the ORIGINAL function when
// core's handlebars module evaluated (long before this init hook) — so the helper
// has to be re-registered with the patched function.
function feInstallFutureTimestampClamp() {
  try {
    const utils = globalThis.foundry?.utils;
    const original = utils?.timeSince;
    if (typeof original !== "function" || original.__feFutureClamped) return;
    const patched = function (timeStamp) {
      const ms = new Date(timeStamp).getTime();
      if (Number.isFinite(ms) && ms > Date.now()) return original.call(this, new Date());
      return original.call(this, timeStamp);
    };
    patched.__feFutureClamped = true;
    utils.timeSince = patched;
    try { globalThis.Handlebars?.registerHelper?.("timeSince", patched); } catch { /* no-op */ }
  } catch {
    /* no-op */
  }
}

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
  await feNormalizeChoiceSetting(S.SYSTEM_MSG_BG_BASE, ["white", "black", "custom"], FE_DEFAULTS[S.SYSTEM_MSG_BG_BASE]);
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
  feApplyStyleClassesToDocument(doc);

  // --- NOT document-scoped: live-client side effects, deliberately excluded from
  // feApplyStyleClassesToDocument so the archive can reuse that list. ---
  // feSetBodyMergeClasses ignores `doc` entirely and writes `document.body`; the
  // archive has feSyncArchiveMergeBodyClasses for its own document instead.
  try { feSetBodyMergeClasses(); } catch { /* no-op */ }
  // feApplyCanvasTextFont mutates CONFIG.canvasTextStyle / CONFIG.defaultFontFamily
  // and redraws canvas text — global PIXI state, meaningless in an export document
  // and undesirable as a side effect of one.
  try { feApplyCanvasTextFont(doc); } catch { /* no-op */ }
}

/**
 * Apply every genuinely DOCUMENT-SCOPED style toggle to `doc`.
 *
 * **The single source of this list.** It used to be inlined a second time inside
 * `feRenderChatArchiveWindow` against the popup's document, and the two copies
 * drifted: the archive's copy was missing `feSetHideMsgBorderUserColorClass` and
 * `feSetForceNormalMsgColorClass`. Both of those toggles' CSS rules name
 * `#fe-chat-export-log` explicitly — i.e. they were written to cover the archive —
 * so the rules sat dead in every archive window and every saved HTML file.
 * Do not re-inline it; add new toggles here and both callers get them.
 *
 * Every call is individually try/caught: one failing toggle must not abandon the
 * rest, because this runs at `setup` where a half-applied UI is the failure mode
 * the whole function exists to prevent.
 */
function feApplyStyleClassesToDocument(doc = document) {
  try { feApplyStyleVarsFromSettings(doc); } catch { /* no-op */ }
  try { feSetChatCardIconCropClass(doc); } catch { /* no-op */ }
  try { feSetChatCardFontClass(doc); } catch { /* no-op */ }
  try { feSetChatFontChoiceClass(doc); } catch { /* no-op */ }
  try { feSetUiFontClass(doc); } catch { /* no-op */ }
  try { feSetNeodgmModeClass(doc); } catch { /* no-op */ }
  // MUST stay next to feSetNeodgmModeClass — user-font mode is the sixth font mode
  // and was once the ONE missing from the archive's copy of this list, so an
  // archive/PDF exported while "유저 로컬 폰트" was active always rendered in the
  // default system stack ("PDF/HTML로 인쇄하면 기본 고딕으로 나온다"). The CSS
  // variable alone was already arriving: feSetUserFontMode writes
  // --fe-user-font-family onto documentElement.style and feSyncArchiveDocumentChrome
  // copies <html>'s whole style attribute. What it does NOT copy is <body>'s class
  // (explicitly skipped there), and the var is only consumed by
  // `body.fe-user-font-mode` rules — so the value was present and unreachable.
  try { feSetUserFontMode(doc); } catch { /* no-op */ }
  try { feSetRetroThemeClass(doc); } catch { /* no-op */ }
  try { feSetUserColorBgClass(doc); } catch { /* no-op */ }
  try { feSetPaperOverlayClass(doc); } catch { /* no-op */ }
  try { feSetUserColorBgBaseClass(doc); } catch { /* no-op */ }
  try { feSetChatGroupOutlineClass(doc); } catch { /* no-op */ }
  try { feSetHideMsgBorderUserColorClass(doc); } catch { /* no-op */ }
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
  feRegisterSetting(S.PRUNE_ENABLED);
  feRegisterSetting(S.PRUNE_MAX_MESSAGES);
  feInstallChatLogPrune();
  feInstallFutureTimestampClamp();

  feRegisterSetting(FE_GM_PRIORITY_OVERRIDES_KEY, () => {
      feApplyGmPriorityUiRefresh(document);
      void feSyncLocalGmPrioritySettings();
    });

  // Per-world settings store (client-scope blob, keyed by world id). See
  // fe-gm-priority.js for hydrate/capture logic.
  feRegisterSetting(FE_WORLD_SETTINGS_KEY);

  // Per-client backup of pre-force values, captured on the first GM-priority
  // overwrite of each key and consumed when enforcement is turned OFF (restore).
  // See fe-gm-priority.js (feSyncLocalGmPrioritySettings / feRestoreLocalGmPrioritySettings).
  feRegisterSetting(FE_GM_PRIORITY_BACKUP_KEY);

  // Core-setting enforcement stores. Same shape as the pair above but for
  // Foundry's own "core" namespace — see fe-core-priority.js.
  feRegisterSetting(FE_CORE_PRIORITY_OVERRIDES_KEY, () => {
      void feSyncLocalCoreSettings();
    });

  feRegisterSetting(FE_CORE_PRIORITY_BACKUP_KEY);

  feRegisterSetting(S.MERGE_ENABLED, () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
      setTimeout(() => feApplyChatMergeToAllLogs(), 200);
    });

  feRegisterSetting(S.MERGE_ONLY_TEXT, () => feApplyChatMergeToAllLogs());

  feRegisterSetting(S.MERGE_INCLUDE_ROLL_MESSAGES, () => feScheduleRenderedStateRefreshForAllLogs({ delay: 0 }));

  feRegisterSetting(S.MERGE_INCLUDE_CHAT_CARDS, () => feScheduleRenderedStateRefreshForAllLogs({ delay: 0 }));

  feRegisterSetting(S.MERGE_DIVIDER, () => feApplyChatMergeToAllLogs());

  feRegisterSetting(S.MERGE_GROUP_SPACING, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.MERGE_MODE, () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
      setTimeout(() => feApplyChatMergeToAllLogs(), 200);
    });

  feRegisterSetting(S.MERGE_FOLLOW_HEADER_STYLE, () => {
      feSetBodyMergeClasses();
      feApplyChatMergeToAllLogs();
      setTimeout(() => feApplyChatMergeToAllLogs(), 200);
    });

  feRegisterSetting(S.MERGE_SPEAKER_BASIS, () => feScheduleRenderedStateRefreshForAllLogs({ delay: 0 }));

  feRegisterSetting(S.EXPORT_ENABLED, () => feFireChatUiUpdated({ reason: "export-settings", document }));

  feRegisterSetting(S.EXPORT_AUTO_PRINT);

  feRegisterSetting(S.EXPORT_OPTIMIZE);

  feRegisterSetting(S.EXPORT_EMBED_FONTS);

  feRegisterSetting(S.EXPORT_EMBED_IMAGES);

  feRegisterSetting(S.EXPORT_EXCLUDE_WHISPERS);

  feRegisterSetting(S.EXPORT_PRINT_IMAGE_MODE);

  // DEPRECATED but INTENTIONALLY still registered — do not delete.
  // Nothing reads this key any more: the Electron export path was rewritten to
  // "save HTML only" and all four readers were removed from fe-chat-archive.js
  // (the external-browser hand-off, the archive window's auto mode, the "브라우저"
  // button, and feOpenArchiveInExternalBrowser's mode gate). The registration is
  // kept so worlds that still have a stored value do not end up holding an
  // unregistered setting, and the name/hint carry the deprecation notice.
  feRegisterSetting(S.EXPORT_DESKTOP_EXTERNAL_MODE);

  // Style settings (CSS vars)

  feRegisterSetting(S.STYLE_ACTOR_NAME_SIZE, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.STYLE_PLAYER_NAME_SIZE, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.STYLE_MESSAGE_TEXT_SIZE, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.STYLE_CHATCARD_TEXT_SIZE, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.STYLE_CHAT_MESSAGE_SPACING, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.STYLE_HEADER_CONTENT_GAP, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.MERGE_INNER_GAP, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.CHAT_CARD_ICON_CROP, () => feSetChatCardIconCropClass(document));

  feRegisterSetting(S.CHAT_FONT_CHOICE, () => {
      feSetChatCardFontClass(document);
      feSetChatFontChoiceClass(document);
      feSetUiFontClass(document);
      feSetNeodgmModeClass(document);
      feApplyCanvasTextFont(document);
    });

  feRegisterSetting(S.CANVAS_TEXT_FONT, () => feApplyCanvasTextFont(document));

  feRegisterSetting(S.CANVAS_DRAWING_FONT, () => feApplyCanvasTextFont(document));

  feRegisterSetting(S.UI_USE_GEURIMILGI, () => feSetUiFontClass(document));

  feRegisterSetting(S.UI_USE_USER_FONT, () => {
      feSetUserFontMode(document);
      feApplyCanvasTextFont(document);
      feSetChatCardFontClass(document);
      // Suppress/restore the module chat-font-choice classes (see feUserFontActive).
      feSetChatFontChoiceClass(document);
      feSetUiFontClass(document);
      feSetNeodgmModeClass(document);
    });

  feRegisterSetting(S.USER_FONT_FAMILY, () => {
      feSetUserFontMode(document);
      feApplyCanvasTextFont(document);
      feSetChatCardFontClass(document);
      // Family going empty/non-empty flips feUserFontActive → refresh module classes.
      feSetChatFontChoiceClass(document);
      feSetUiFontClass(document);
      feSetNeodgmModeClass(document);
    });

  feRegisterSetting(S.UI_RETRO_THEME, () => {
      feSetRetroThemeClass(document);
      feFireChatUiUpdated({ reason: "retro-theme", document });
    });

  feRegisterSetting(S.DX3RD_CARD_BORDER_ALPHA, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.DX3RD_PIXEL_ACCENT, async (value) => {
      // The GM-priority override must be refreshed BEFORE feApplyStyleVarsFromSettings,
      // or accent-h is written from the stale override value.
      await feMirrorGmPrioritySetting(S.DX3RD_PIXEL_ACCENT, value);
      feApplyStyleVarsFromSettings(document);
      feApplyDoubleCrossLegacyPixiTheme(document);
    });

  // Migration-only flag (read by feMigrateLegacySettings, then reset to false).
  // Hidden from the user-facing settings panel.
  feRegisterSetting(LEGACY_UI_FONT_KEY);

  feRegisterSetting(S.USE_USER_COLOR_BG, () => {
      feSetUserColorBgClass(document);
      feApplyUserColorBgToAllLogs(document);
    });

  feRegisterSetting(S.USER_COLOR_BG_BASE, () => {
      // Base mode now drives .fe-has-user-color independently of the tint,
      // so a none↔white/black/custom change must re-classify existing messages.
      feSetUserColorBgBaseClass(document);
      feApplyUserColorBgToAllLogs(document);
    });

  feRegisterSetting(S.USER_COLOR_BG_CUSTOM, () => feSetUserColorBgBaseClass(document));

  feRegisterSetting(S.USER_COLOR_ALPHA, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.SYSTEM_MSG_COLOR, () => {
      feSetSystemMsgColorClass(document);
      feApplyUserColorBgToAllLogs(document);
    });

  // The alpha lives on each tinted element as an inline var, so changing it must
  // re-stamp the elements rather than just re-emitting body vars.
  feRegisterSetting(S.SYSTEM_MSG_ALPHA, () => {
      feApplyUserColorBgToAllLogs(document);
    });

  // All three also re-publish fe-sysmsg-bg-light/dark, which feSetUserColorBgBaseClass
  // owns: system messages carry a base of their own, so which way THEY lean is a
  // separate question from the chat-card base.
  feRegisterSetting(S.SYSTEM_MSG_BG_ENABLED, () => {
      feSetSystemMsgColorClass(document);
      feSetUserColorBgBaseClass(document);
    });

  feRegisterSetting(S.SYSTEM_MSG_BG_BASE, () => {
      feApplyStyleVarsFromSettings(document);
      feSetUserColorBgBaseClass(document);
    });

  feRegisterSetting(S.SYSTEM_MSG_BG_COLOR, () => {
      feApplyStyleVarsFromSettings(document);
      feSetUserColorBgBaseClass(document);
    });

  feRegisterSetting(S.FORCE_NORMAL_MSG_COLOR, () => {
      feSetForceNormalMsgColorClass(document);
      feScheduleRenderedStateRefreshForAllLogs?.({ delay: 0 });
    });

  feRegisterSetting(S.CHAT_GROUP_OUTLINE, () => feSetChatGroupOutlineClass(document));

  feRegisterSetting(S.MSG_BORDER_USER_COLOR, () => feSetHideMsgBorderUserColorClass(document));

  feRegisterSetting(S.ACCENT_TEXT_OVERRIDE, () => {
      feSetAccentTextOverrideClass(document);
      // Override OFF resets every accent-driven surface (text, borders, pattern) to the
      // default white; ON restores the saved accent. feApplyStyleVarsFromSettings does both.
      feApplyStyleVarsFromSettings(document);
      feApplyDoubleCrossLegacyPixiTheme(document);
    });

  feRegisterSetting(S.STYLE_PAPER_OVERLAY_ENABLED, () => feSetPaperOverlayClass(document));

  feRegisterSetting(S.STYLE_BG_SATURATION, () => feApplyStyleVarsFromSettings(document));

  feRegisterSetting(S.MARKDOWN_ENABLED);

  feRegisterSetting(S.EDIT_ENABLED, () => feFireChatUiUpdated({ reason: "edit-settings", document }));

  feRegisterSetting(S.GM_PRIORITY_ENABLED, (value) => {
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
    });

  feRegisterSetting(S.CORE_PRIORITY_ENABLED, (value) => {
      // World-scope toggle — this onChange fires on every connected client.
      if (value) {
        void (async () => {
          if (game.user?.isGM) await feSeedCoreOverridesFromLocal({ force: true });
          await feSyncLocalCoreSettings();
        })();
      } else {
        void feRestoreLocalCoreSettings();
      }
    });

  feRegisterSetting(S.GM_SPEAK_AS_SELF);

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
    const keyPath = String(fullKey ?? "").trim();

    // Foundry's OWN client settings (fe-core-priority.js). Handled before the
    // module-namespace branch below because they live under "core.", not
    // "female_edition.", and would otherwise be filtered out entirely.
    if (keyPath.startsWith("core.")) {
      if (feSyncingLocalCoreSettings) return;
      if (!feIsCorePriorityEnabled()) return;
      const coreKey = keyPath.slice(5);
      if (!feIsCorePriorityKey(coreKey)) return;
      // The GM edited it in Foundry's settings panel → publish to players.
      if (game.user?.isGM) void feMirrorCoreSetting(coreKey, value);
      // A player edited a key the GM is forcing → put it straight back. Without
      // this the enforcement would only hold until the player opened 환경 설정.
      else if (feHasCoreOverride(coreKey)) void feSyncLocalCoreSettings({ keys: [coreKey] });
      return;
    }

    if (feSyncingLocalGmPrioritySettings) return;
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
  // Same two-way handling for Foundry's own client settings. Independent of the
  // module's GM priority above — the two features are separately toggled.
  if (feIsCorePriorityEnabled()) {
    if (game.user?.isGM) await feSeedCoreOverridesFromLocal();
    await feSyncLocalCoreSettings();
  } else {
    await feRestoreLocalCoreSettings();
  }
  // Re-apply now that world settings are hydrated and GM priority is synced —
  // the `setup` pass above painted from un-synced values. Same idempotent call.
  // (Includes feApplyCanvasTextFont: CSS cannot reach PIXI text, so the family
  // goes into CONFIG.canvasTextStyle. Safe before the first canvas draw — later
  // draws clone the updated CONFIG value.)
  feApplyVisualSettingsToDocument(document);
  feInstallDoubleCrossLegacyPixiTheme();
  if (feHasRenderedStateWork()) feScheduleRenderedStateRefreshForAllLogs({ delay: 0 });
  // Guarantee a correct full merge once the log is populated (the incremental
  // path misses groups when messages arrive in a single batch / via chat-prune).
  feScheduleFullMergePass({ delay: 150 });
  setTimeout(() => feScheduleFullMergePass({ delay: 0 }), 600);
  feFireChatUiUpdated({ reason: "ready", root: document, log: null, document });
  // CSS changes repaint existing messages automatically; compatibility DOM
  // grafts do not. Touch only the messages currently loaded in chat (never the
  // full world collection), once, while preserving the reader's scroll anchor.
  setTimeout(() => void feRefreshLoadedMidiDamageTypes(), 0);

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

async function feRefreshLoadedMidiDamageTypes(rootDocument = document) {
  const restoreStickyScroll = feSnapshotAndRestoreStickyScroll();
  try {
    for (const log of feGetChatLogsInDocument(rootDocument)) {
      for (const element of log.querySelectorAll(":scope > .chat-message, :scope > li.message")) {
        const message = feGetMessageFromElementOrCollection(element);
        if (feHasRestorableMidiDamageTypes(message)) {
          feRestoreMidiDamageTypeIcons(message, element);
        }
        if (message?.flags?.["midi-qol"]) {
          await feRestoreMidiItemDescription(message, element);
        }
      }
    }
  } catch {
    /* no-op */
  } finally {
    restoreStickyScroll();
  }
}

// -------------------------------------
// Chat message hooks
// -------------------------------------

Hooks.on("renderChatMessageHTML", (message, html) => {
  const el = feExtractHTMLElement(html);
  if (!el) return;
  const restoreDamageTypes = feHasRestorableMidiDamageTypes(message);
  const restoreItemDescription = !!message?.flags?.["midi-qol"];
  if (restoreDamageTypes || restoreItemDescription) {
    try {
      if (restoreDamageTypes) feRestoreMidiDamageTypeIcons(message, el);
      // ChatMessageMidi resumes after awaiting the core renderer and replaces
      // parts of the card after this hook. One gated next-task retry is enough
      // and avoids installing an observer for every rendered message.
      setTimeout(async () => {
        const restoreStickyScroll = el.isConnected
          ? feSnapshotAndRestoreStickyScroll()
          : () => {};
        try {
          if (restoreDamageTypes) feRestoreMidiDamageTypeIcons(message, el);
          if (restoreItemDescription) await feRestoreMidiItemDescription(message, el);
        } catch {
          /* no-op */
        } finally {
          restoreStickyScroll();
        }
      }, 0);
    } catch {
      /* no-op */
    }
  }
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

    // Never persist a future timestamp: one stamped from a clock that ran ahead
    // displays as "~11 months ago" forever (see feInstallFutureTimestampClamp).
    // Nulling lets the server's own _preCreate fill options.modifiedTime instead.
    try {
      const ts = Number(data?.timestamp ?? message?.timestamp);
      if (Number.isFinite(ts) && ts > Date.now()) {
        message.updateSource({ timestamp: null });
        if (data && typeof data === "object") data.timestamp = null;
      }
    } catch { /* no-op */ }

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
        // An actual staged actor owns its speaker and takes priority over this GM-only
        // speak-as-self override. Theatre's "없음" choice means only that THEATRE does
        // not modify the message; it must not suppress this independent setting, or a
        // controlled PC token remains the speaker and its portrait is persisted/exported.
        const _stageVal = document.querySelector("#fe-stage-nav select.fe-stage-select")?.value;
        const stageActive = !!_stageVal && _stageVal !== "__none__" && _stageVal !== "";
        if (!stageActive) {
          const speaker = data?.speaker ?? message?.speaker ?? {};
          const OWNER = 3;

          // Skip for system-initiated roll messages that already carry an explicit actor
          // speaker (e.g. dx3rd attack/damage rolls). The actor was set intentionally by
          // the system; overriding it would break actor-id tracking and portraits.
          const msgRolls = Array.isArray(data?.rolls) ? data.rolls
            : (Array.isArray(message?.rolls) ? message.rolls : []);

          // Skip midi-qol's own cards. midi colors a message's border from the SPEAKER,
          // not the author (`colorChatMessageHandler`: `if (actor) user =
          // playerForActor(actor)`, chatMessageHandling.ts), and `playerForActor` ends at
          // `preferredActiveGM()` when it cannot resolve a player. Nulling the speaker here
          // therefore drops midi straight to `game.users.get(message.author.id)` — the GM —
          // so EVERY midi card the GM triggers for a player-owned actor came out in the GM's
          // color, which reads as "midi 의 테두리 색 설정이 GM 색으로 고정됐다". These are
          // activity/damage/save cards generated by a module, not GM roleplay speech, so the
          // same rationale as the roll guard above applies: leave their speaker alone.
          // The activity card itself carries no rolls, so the roll guard does NOT cover it.
          const isMidiCard = !!(data?.flags?.["midi-qol"] ?? message?.flags?.["midi-qol"]);

          if (!isMidiCard && !(msgRolls.length > 0 && speaker?.actor)) {
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
  FE_DX3RD_SYSTEM_IDS,
  feIsDx3rdSystemId,
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
  feSetChatCardIconCropClass,
  feSetUiFontClass,
  feSetNeodgmModeClass,
  feSetUserFontMode,
  feApplyCanvasTextFont,
  feSetRetroThemeClass,
  feSetUserColorBgBaseClass,
  feNormalizeChoice,
  feSetUserColorBgClass,
  feSetPaperOverlayClass,
  feSetChatGroupOutlineClass,
  feSetHideMsgBorderUserColorClass,
  feSetAccentTextOverrideClass,
  feSetSystemMsgColorClass,
  feSetForceNormalMsgColorClass,
  // The single source of the document-scoped toggle list — the archive reuses it
  // instead of keeping its own copy. See the function's own comment.
  feApplyStyleClassesToDocument,

  feApplyChatMerge,
  feCaptureMessageRenderFlagsOnPreCreate,
  feCaptureMessageRenderFlagsOnPreUpdate,
  feMessageMergeInfo,
  feMergeKey,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
  feIsUntouchedSpecialMessage,
};
