// Per-MESSAGE archive rendering for fe-chat-archive.js.
//
// Sub-module of fe-chat-archive.js. Owns one <li> at a time: how it is produced
// (live clone / system render / from-scratch fallback, and the heuristic that
// picks between them), and every normalization applied to it afterwards —
// timestamps, controls, portraits, collapsed sections, recorded targets, midi
// viewer role, dnd5e icon inlining, empty-tray stripping, root cleanup.
//
// Message scope only. Window- and document-level chrome lives in
// `fe-archive-document.js`; WHICH messages get here is `fe-archive-collect.js`.


// The ONE place an exported timestamp string is produced. Both the from-scratch
// header builder and the live-clone normalizer below go through it.
import { feLocalize, feFormat } from "./fe-i18n.js";
import {
  feSetting,
  feFireChatUiUpdated,
  feApplyRenderedStateToMessageElement,
  feGetMessageIdFromElement,
  feIsNarratorToolsMessage,
  feIsRoundMarkerMessage,
} from "./fe-chat-enhance.js";
import { feChatPortraitUpsert } from "./fe-chat-portrait.js";
import { cpMaybeApplyHQResample } from "./fe-chat-portrait-image.js";
import {
  feRestoreMidiDamageTypeIcons,
  feRestoreMidiItemDescription,
} from "./fe-midi-damage-types.js";
import {
  feOptimizeArchiveNodeImages,
  feMirrorLiveMessageStyles,
} from "./fe-archive-clone.js";
import {
  feRestoreOriginalPortraitSources,
  feNormalizeExportNode,
  feNormalizeArchiveMessageLayout,
  feGetFoundryBaseHref,
  feIsElement,
} from "./fe-archive-output.js";
import {
  FE_EXPORT_PORTRAIT_MARKER_SELECTOR,
  FE_EXPORT_RENDER_BATCH,
  FE_EXPORT_RENDER_CONCURRENCY,
  FE_EXPORT_STATUS_EVERY,
  feArchiveWindowClosed,
  feMaybeYieldForUI,
  feStampArchiveMessageIdentity,
  feTryFoundryRenderMessage,
} from "./fe-archive-runtime.js";

export function feFormatArchiveTimestamp(msg) {
  try {
    const ts = Number(msg?.timestamp);
    if (!Number.isFinite(ts) || ts <= 0) return "";
    return new Date(ts).toLocaleString();
  } catch {
    return "";
  }
}

// An archive read a year later must say WHEN, so every timestamp is the absolute
// locale string — never core's relative one.
//
// Core rewrites `<time.message-timestamp>` in the live log to a relative string
// ("9일 19시간 전") from `ChatLog#updateTimestamps`, on a timer. Messages the
// exporter CLONES from the live DOM therefore carry that text, while messages it
// rebuilds from the database get the absolute date — and which path a message
// takes depends only on whether it is still in the (pruned) live log. Measured on
// a 2938-message export: 2664 absolute + 274 relative, the 274 being the newest
// tail. Two formats in one document, changing mid-scroll.
//
// Relative text is also just wrong once saved: "9일 전" is anchored to the export
// moment and silently rots as the file ages.
export function feNormalizeArchiveTimestamps(node, msg) {
  try {
    if (!feIsElement(node)) return;
    const text = feFormatArchiveTimestamp(msg);
    if (!text) return;
    for (const el of node.querySelectorAll?.("time.message-timestamp") ?? []) {
      el.textContent = text;
    }
  } catch {}
}

// Live-cloned messages drag their header CONTROLS along — this module's own edit
// pencil (`a.message-edit.fe-message-edit`, fe-chat-edit.js) and core's delete "X".
// They are dead buttons in an export, and because they sit inside
// `.message-metadata` right before the timestamp they also shove the date sideways,
// so the affected messages look misaligned next to rebuilt ones. Same 274 messages
// as the relative-timestamp problem above (perfect 1:1 on the measured export) —
// both are symptoms of "came from the live DOM".
//
// Scoped to `.message-metadata` on purpose: message CONTENT anchors (content links,
// inline rolls, dx3rd item buttons) must survive untouched.
export function feStripArchiveMessageControls(node) {
  try {
    if (!feIsElement(node)) return;
    for (const el of node.querySelectorAll?.(".message-metadata a, a.message-edit") ?? []) {
      el.remove();
    }
  } catch {}
}

export function feNormalizeArchivePortraitImages(rootEl, renderProfile = null) {
  try {
    if (!rootEl?.querySelectorAll) return;
    const body = rootEl.ownerDocument?.body;
    const explicitlyHidden = !!(
      body?.classList?.contains?.("fe-hide-chat-portrait-wrap") ||
      body?.classList?.contains?.("fe-print-hide-avatars") ||
      body?.classList?.contains?.("fe-print-hide-all")
    );

    for (const img of rootEl.querySelectorAll("img.fe-chat-portrait")) {
      const src = img.getAttribute("src");
      if (src) {
        try {
          img.src = new URL(src, rootEl.ownerDocument?.baseURI || window.location.href).href;
        } catch {
          try { img.src = new URL(src, window.location.href).href; } catch {}
        }
      }
      img.setAttribute("loading", renderProfile?.normalizeImageLoading || "eager");
      img.setAttribute("decoding", renderProfile?.normalizeImageDecoding || "sync");

      // Re-apply the HQ downscale AFTER the src normalization above.
      //
      // MUST stay: `feRestoreOriginalPortraitSources` deliberately puts the original file
      // path back into `src` (the saved-HTML path needs real files to embed), and it runs
      // per node during render — i.e. AFTER `feChatPortraitUpsert` already resolved the
      // HQ data URL. Nothing else re-invokes the resample once the render pass is over, so
      // without this call the archive window keeps painting full-resolution bitmaps
      // (e.g. 832x1216) inside a 64px `object-fit: cover` box — exactly the Chromium
      // low-quality clipped-downscale path the HQ pipeline exists to avoid.
      //
      // Cheap by design: `cpMaybeApplyHQResample` is a cache hit for any portrait already
      // processed by the live sidebar, and a no-op when the <img> is still lazy-deferred
      // (it re-enters on that image's own `load`). The snapshot builder calls
      // `feRestoreOriginalPortraitSources` again with its own undo, so the saved HTML is
      // unaffected by the data URLs we put back here.
      try {
        cpMaybeApplyHQResample(
          img,
          Math.max(16, Number(feSetting("chatPortraitSize") ?? 64) || 64),
          String(feSetting("chatPortraitShape") ?? "circle"),
          true
        );
      } catch {}
      if (!explicitlyHidden) {
        // Inline !important is intentional: v13 systems/themes can carry their
        // own broad @media print image rules, which otherwise beat module CSS.
        img.style.setProperty("display", "block", "important");
        img.style.setProperty("visibility", "visible", "important");
      } else {
        // A live clone may already carry the archive override. Remove it so the
        // user's explicit hide mode remains authoritative.
        img.style.removeProperty("display");
        img.style.removeProperty("visibility");
      }
    }
  } catch {
    /* no-op */
  }
}

export function feRefreshPortraitsForLog(logEl, renderProfile = null, { nodes = null } = {}) {
  if (!logEl?.querySelectorAll) return;
  let failed = 0;
  let firstFailedId = "";
  for (const el of (Array.isArray(nodes) ? nodes : logEl.querySelectorAll("li.chat-message"))) {
    try {
      const id = feGetMessageIdFromElement(el);
      const msg = (id ? game.messages?.get(id) : null) || el.__feMessage || null;
      if (!msg) continue;
      feChatPortraitUpsert(msg, el);
      feNormalizeArchivePortraitImages(el, renderProfile);
    } catch {
      failed += 1;
      if (!firstFailedId) firstFailedId = feGetMessageIdFromElement(el) || "unknown";
    }
  }
  // One malformed/system-specific message must never abort portrait injection
  // for the rest of its render batch. Keep diagnostics aggregate-only: retaining
  // errors or per-message records for a multi-thousand-message log would add
  // memory precisely where the archive is already under pressure.
  if (failed > 0) {
    console.warn(feFormat("FE.Diagnostics.ChatArchive.feRefreshPortraitsForLog", { failed: failed, firstFailedId: firstFailedId }));
  }
}

/**
 * Last-chance repair for messages whose portrait DOM is absent immediately
 * before print preparation. This deliberately scans the live HTMLCollection
 * instead of materializing an array and touches ONLY missing portraits, so the
 * pass adds constant bookkeeping memory and does not restart HQ work for the
 * portraits that are already healthy.
 */
export function feRepairMissingArchivePortraitsForPrint(logEl, renderProfile = null) {
  if (!logEl?.children || !feSetting("chatPortraitEnabled")) return;

  let repaired = 0;
  let failed = 0;
  let firstFailedId = "";
  for (const el of logEl.children) {
    try {
      if (!el?.matches?.("li.chat-message")) continue;
      if (el.querySelector?.("img.fe-chat-portrait")) continue;

      const id = feGetMessageIdFromElement(el);
      const msg = (id ? game.messages?.get(id) : null) || el.__feMessage || null;
      if (!msg) continue;

      feChatPortraitUpsert(msg, el);
      if (!el.querySelector?.("img.fe-chat-portrait")) continue;
      feNormalizeArchivePortraitImages(el, renderProfile);
      repaired += 1;
    } catch {
      failed += 1;
      if (!firstFailedId) firstFailedId = feGetMessageIdFromElement(el) || "unknown";
    }
  }

  if (repaired > 0) console.info(feFormat("FE.Diagnostics.ChatArchive.feRepairMissingArchivePortraitsForPrint", { repaired: repaired }));
  if (failed > 0) {
    console.warn(feFormat("FE.Diagnostics.ChatArchive.feRepairMissingArchivePortraitsForPrint2", { failed: failed, firstFailedId: firstFailedId }));
  }
}

// ===========================================================================
// Message State & Normalization  (portrait, empty-check, special-state, root cleanup)
// ===========================================================================

export function feHasPortraitMarkup(rootEl) {
  try {
    return !!rootEl?.querySelector?.(FE_EXPORT_PORTRAIT_MARKER_SELECTOR);
  } catch {
    return false;
  }
}

export function feArchiveMessageContentLooksEmpty(node) {
  try {
    const content = node?.querySelector?.(':scope > .message-content');
    if (!content) return true;
    if (content.querySelector?.('.round-marker, img, video, audio, canvas, svg, table, iframe, .chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dx3rd-item-chat, .dx3rd-item-info, .dice-roll, .dice-result, blockquote, pre, hr, ul, ol')) {
      return false;
    }
    const text = String(content.textContent ?? '').replace(/ /g, ' ').trim();
    return !text;
  } catch {
    return false;
  }
}

// Every collapsible thing in an exported log is forced OPEN. A caret cannot be
// clicked on paper, so a collapsed section is simply lost information — and the
// export pipeline breaks the clipping those collapsers rely on (see the
// "ALWAYS EXPANDED" block in styles/fe-chat-archive.css), which made a collapsed
// die breakdown print ON TOP of the total row.
//
// TWO different mechanisms, and removing `.collapsed` only covers the first:
//   dnd5e2 `.collapsible`  → collapsed is the OPT-IN state (`.collapsed`)
//   core/dnd5e `.dice-roll`→ expanded is the OPT-IN state (`.expanded`); the
//                            tooltip (`.dice-tooltip`) and dnd5e's
//                            `.dice-tooltip-collapser` both sit at
//                            `grid-template-rows: 0fr` until then.
//   modern dx3rd `.collapsible-content` → a THIRD mechanism, see below.
//   original dx3rd `.effect-list` / `.weapon-list` / `.item-description`
//                                     → always display:none in the system sheet.
// Measured on the 2026-08-12 export: `collapsible collapsed` occurred 0 times
// (already handled) while `dice-roll expanded` also occurred 0 times across all
// 252 dice rolls — i.e. every single roll breakdown was collapsed.
//
// dx3rd-emanim puts `collapsed` on the CONTENT element itself and never emits a
// `.collapsible` wrapper anywhere (`class="[^"]*\bcollapsible\b[^-]` matches 0
// times in the whole system). So `.collapsible.collapsed` — and every
// `.collapsible .collapsible-content` rule in styles/fe-chat-archive.css —
// misses it completely, and an exported dx3rd item card loses its description,
// effect, weapon and technique sections outright.
//
// Two independent things hide them, so BOTH must be undone here:
//   1. `:is(.dx3rd-item-chat, .dx3rd-item-info) .collapsible-content.collapsed{display:none!important}`
//      (dx3rd styles.css:2347). dx3rd's sheets are in `layer(system)`, which for
//      `!important` OUTRANKS our `layer(modules)` archive sheet — a CSS override
//      there could never win. Dropping the class is the layer-proof fix.
//   2. an inline `style="display:none"`, from two places: `renderChatMessageHTML`
//      (chat-ui.js:195) when the world's `expandChatItemCards` is off, and the
//      card builder itself, which bakes it into the stored message content
//      (actor-chat.js:684, :692). Inline styles beat any layered rule that is not
//      `!important`, and they are part of the message HTML — so clear the
//      property rather than trying to out-specify it.
// Only `display` is cleared, never the whole style attribute: dx3rdSlideToggle
// also parks `height`/`overflow`/`transition` there mid-animation.
//
// A THIRD hiding source, found on a live-collapsed dnd5e item card: the
// computed-style mirror (feMirrorLiveMessageStyles, which runs BEFORE this)
// bakes the collapsed computed state inline with `!important` —
// `opacity: 0; grid: 0px / 255px`. Inline !important outranks the doubled
// ALWAYS-EXPANDED rules in fe-chat-archive.css, so class/display clearing alone
// still printed the section collapsed (description silently lost). Every
// property a collapser uses to hide or size-away its content is cleared here:
// the archive stylesheet then owns the expanded state outright.
const FE_COLLAPSIBLE_HIDE_PROPS = [
  "opacity", "visibility",
  "grid", "grid-template", "grid-template-rows", "grid-template-columns",
  "grid-template-areas", "grid-area",
  "height", "max-height", "overflow", "transition",
];

function feClearCollapsibleHideStyles(el) {
  try {
    const s = el?.style;
    if (!s) return;
    if (s.getPropertyValue?.("display") === "none") s.removeProperty("display");
    for (const p of FE_COLLAPSIBLE_HIDE_PROPS) {
      try { s.removeProperty(p); } catch {}
    }
  } catch {}
}

export function feExpandCollapsedArchiveSections(node) {
  try {
    if (!feIsElement(node)) return;
    for (const el of node.querySelectorAll?.(".collapsible.collapsed") ?? []) {
      try { el.classList.remove("collapsed"); } catch {}
    }
    for (const el of node.querySelectorAll?.(".dice-roll") ?? []) {
      try { el.classList.add("expanded"); } catch {}
    }
    // `.dice-tooltip` / `.dice-tooltip-collapser` collapse by the same
    // 0fr-grid mechanism and take the same mirrored-inline hit, so they are
    // cleared alongside `.collapsible-content`.
    for (const el of node.querySelectorAll?.(
      ".collapsible-content, .dice-tooltip, .dice-tooltip-collapser"
    ) ?? []) {
      try {
        el.classList.remove("collapsed");
        feClearCollapsibleHideStyles(el);
      } catch {}
    }
    for (const el of node.querySelectorAll?.(
      ".dx3rd-item-info .effect-list, .dx3rd-item-info .weapon-list, .dx3rd-item-info .item-description"
    ) ?? []) {
      try {
        if (el.style?.display === "none") el.style.removeProperty("display");
        el.style?.removeProperty?.("height");
        el.style?.removeProperty?.("overflow");
      } catch {}
    }
  } catch {}
}

// Item-description collapsibles (dnd5e/midi card `.card-header.description`)
// are expanded only on the FIRST occurrence of each ITEM in the export and
// collapsed on every repeat — the one thing the "always expanded" rule above
// intentionally overrides. Identity is the item UUID (`data-item-uuid` on midi
// cards); where only a raw `data-item-id` exists it is keyed with the owning
// actor's UUID so two characters holding the same-named item still count as
// distinct items. Cards with neither attribute keep the always-expanded
// baseline: a description we cannot dedupe must never be hidden.
//
// Token-scoped uuids — `Scene.X.Token.Y.Actor.Z.Item.W`, which midi stamps on
// cards rolled through a token — are normalized down to the `Actor.*`
// document portion first. Two scene tokens of the same actor roll the same
// item; treating them as distinct items would re-expand the description once
// per token, not once per item.
function feArchiveItemKey(holder) {
  try {
    const uuid = String(holder?.dataset?.itemUuid || "");
    if (uuid) {
      const i = uuid.lastIndexOf("Actor.");
      return i > 0 ? uuid.slice(i) : uuid;
    }
    const itemId = String(holder?.dataset?.itemId || "");
    if (!itemId) return "";
    let actor = String(holder?.dataset?.actorUuid || holder?.dataset?.actorId || "");
    const i = actor.lastIndexOf("Actor.");
    if (i > 0) actor = actor.slice(i);
    return `${actor}::${itemId}`;
  } catch {
    return "";
  }
}

// `seenItems` is a Set shared across the whole export and this runs in the
// ordered commit loop of feRenderMessagesIntoLog — never inside the parallel
// renderOne pass — so "first" means first in document order, not first to
// finish rendering.
export function feCollapseRepeatedItemDescriptions(node, seenItems) {
  try {
    if (!feIsElement(node)) return 0;
    let collapsed = 0;
    for (const el of node.querySelectorAll?.(
      ".collapsible.description .collapsible-content, .card-header.description .collapsible-content"
    ) ?? []) {
      try {
        const key = feArchiveItemKey(el.closest?.("[data-item-uuid], [data-item-id]"));
        if (!key || !seenItems) continue;
        if (seenItems.has(key)) {
          el.classList.add("fe-archive-repeat-collapsed");
          // Inline !important: a mirrored expanded state would beat any
          // stylesheet hide, and the saved HTML has no toggle JS anyway.
          el.style?.setProperty?.("display", "none", "important");
          collapsed += 1;
          continue;
        }
        seenItems.add(key);
        // First occurrence is guaranteed open even if this section arrived
        // after the generic pass (e.g. a description restored from item data).
        feClearCollapsibleHideStyles(el);
        el.closest?.(".collapsible.collapsed")?.classList?.remove?.("collapsed");
      } catch {}
    }
    return collapsed;
  } catch {
    return 0;
  }
}

// midi-qol's damage-application cards are self-titled ("HP 업데이트 됨" and a
// per-target table) and are whispered to the GM. Their sender header is pure
// noise in an export — it repeats the GM's own name, adds a "To: <GM>" subtitle
// and (because our portrait injector treats them like any other message) a 64px
// portrait, for a card that is a bookkeeping receipt.
//
// midi-qol hides that header itself for the two variants it tags in JS:
//   .midi-qol-dmg-app-msg    .message-header { display:none }   (css/styles.css:686)
//   .midi-qol-player-dmg-msg .message-header { display:none }   (css/styles.css:912)
// Those classes come from `ChatMessageMidi._addMarkerClasses`, which keys off
// `.xmidi-qol-flex-container` / `.midi-qol-player-damage-card` — neither of which
// the GM template `templates/damage-results.html` emits (its root is a bare
// `.midi-qol-damage-card.collapsible.dnd5e2-collapsible`). So the GM variant is
// the one card in the family midi's own rules miss.
//
// Match the whole family on the ROOT card class instead of the marker classes,
// so all three variants (and the "classic" card style) behave the same.
export function feMarkHeaderlessArchiveCards(node) {
  try {
    if (!feIsElement(node)) return;
    const hasDamageCard = !!node.querySelector?.(
      ":scope > .message-content .midi-qol-damage-card, :scope > .message-content .midi-qol-player-damage-card"
    );
    node.classList.toggle("fe-archive-headerless-card", hasDamageCard);
  } catch {}
}

// dnd5e 6.0 emits <recorded-targets> as an EMPTY container — every child is
// built by RecordedTargetsElement#connectedCallback in the live document
// (buildTargetContainer + buildTargetsList). In the archive document there is
// no dnd5e JS, so the element never upgrades and system-rendered/fallback
// messages lose the entire targets row; live clones survive via the already-
// built DOM — the same split as the dnd5e-icon case below. Rebuild a static
// equivalent from msg.system.targets — each descriptor already carries
// {ac, actor, img, name, token} (TargetsField.getDescriptors) — mirroring the
// live markup: section.icon-row > ul.targets.pills > li > target-pill > label +
// datalist>option.
export function fePopulateArchiveRecordedTargets(node, msg, targetDoc) {
  try {
    if (!feIsElement(node)) return;
    const doc = targetDoc || node.ownerDocument || document;
    const descriptors = Array.isArray(msg?.system?.targets) ? msg.system.targets : [];
    for (const el of node.querySelectorAll?.("recorded-targets") ?? []) {
      // A live clone already carries the built list — never replace real content.
      if (el.querySelector("ul.targets") || el.querySelector("target-pill")) continue;
      const row = doc.createElement("section");
      row.className = "icon-row";
      // Live prepends targetSourceControl — an icon button toggling the
      // targeted/selected source mode. Inert here, but kept for visual parity:
      // it is part of the row's chrome on every live card.
      const sourceControl = doc.createElement("button");
      sourceControl.type = "button";
      sourceControl.classList.add("icon", "target-source-toggle");
      sourceControl.toggleAttribute("data-tooltip", true);
      const list = doc.createElement("ul");
      list.classList.add("targets", "unlist", "pills");
      // If this element is ever adopted into the LIVE document (the in-document
      // export path), RecordedTargetsElement#connectedCallback would wipe our
      // children — unless `targetList`/`targetSourceControl` are already set and
      // rebuilds are suspended. Point them at our own nodes so the upgrade
      // becomes a no-op. Inert in the popup/iframe, where nothing upgrades.
      // _refreshTargetMode(): the default "targeted" mode + disabled when the
      // message recorded no targets.
      sourceControl.dataset.mode = "targeted";
      sourceControl.disabled = !descriptors.length;
      try {
        el.targetList = list;
        el.targetSourceControl = sourceControl;
        el.setAttribute("suspended", "");
      } catch {}
      if (!descriptors.length) {
        const li = doc.createElement("li");
        li.classList.add("none", "pill", "target", "transparent");
        try {
          li.textContent = String(game.i18n?.localize?.("DND5E.Tokens.NoTargets") ?? "") || "No Targets";
        } catch {
          li.textContent = "No Targets";
        }
        list.appendChild(li);
      } else {
        // Group per actor like live's token.getGroupingKey → "3× Goblin".
        const groups = new Map();
        for (const d of descriptors) {
          const key = String(d?.actor ?? d?.token ?? d?.name ?? "");
          if (!groups.has(key)) groups.set(key, []);
          groups.get(key).push(d);
        }
        for (const members of groups.values()) {
          const first = members[0] ?? {};
          const name = String(first.name ?? "");
          const li = doc.createElement("li");
          const pill = doc.createElement("target-pill");
          const label = doc.createElement("label");
          if (members.length > 1) {
            try {
              label.textContent = game.i18n.format("DND5E.CHATMESSAGE.Targets.Count", { name, number: members.length });
            } catch {
              label.textContent = `${members.length}× ${name}`;
            }
          } else {
            label.textContent = name;
          }
          const dl = doc.createElement("datalist");
          for (const m of members) {
            const opt = doc.createElement("option");
            if (m?.token) opt.value = String(m.token);
            opt.toggleAttribute("data-checked", true);
            opt.append(String(m?.name ?? ""));
            dl.appendChild(opt);
          }
          pill.append(label, dl);
          li.appendChild(pill);
          list.appendChild(li);
        }
      }
      row.append(sourceControl, list);
      el.replaceChildren(row);
    }
  } catch {}
}

// dnd5e 6.0's interactive trays — <damage-application> (damage-card.hbs) and
// <effect-application> (usage-card.hbs) — are emitted EMPTY too: the whole
// apply-damage / apply-effect UI is built by the element's JS in the live
// document. A rebuilt message therefore carries an element with no children,
// which feExpandCollapsedArchiveSections would happily un-collapse into an
// empty box — while a live clone of the same card shows the full control
// surface. The controls are dead UI in an export either way, but an EMPTY one
// is pure noise, so strip only the empty ones (clones keep their real content).
export function feStripEmptyArchiveTrays(node) {
  try {
    if (!feIsElement(node)) return;
    for (const el of node.querySelectorAll?.("damage-application, effect-application") ?? []) {
      try {
        if (!el.querySelector("*")) el.remove();
      } catch {}
    }
  } catch {}
}

// midi-qol's renderChatMessage hook edits the DOM per VIEWER ROLE, in JS — it
// removes one of the two name spans every save/hit row carries
// (.midi-qol-gmTokenName vs .midi-qol-playerTokenName) and, for GMs, hides
// .midi-qol-target-npc-Player (hideAll → inline display:none). Live clones copy
// the already-edited DOM and are fine; system-rendered and fallback messages
// carry the raw template with BOTH name spans, so the target's name rendered
// twice. Re-run the same unconditional edits here: remove the span the current
// user would not see live, and apply the GM-only hide. The remaining player-
// side items (hits-display when autoCheckHit is "gmOnly", confirm buttons,
// author checks) depend on midi config / per-message authorship and are left
// alone. Safe on clones: the wrong-role span is already gone there, and hiding
// an already-hidden element is a no-op — the function is idempotent.
export function feApplyMidiQolViewerRole(node) {
  try {
    if (!feIsElement(node)) return;
    const isGM = !!game?.user?.isGM;
    for (const el of node.querySelectorAll?.(isGM ? ".midi-qol-playerTokenName" : ".midi-qol-gmTokenName") ?? []) {
      try { el.remove(); } catch {}
    }
    if (isGM) {
      for (const el of node.querySelectorAll?.(".midi-qol-target-npc-Player") ?? []) {
        try { el.style.display = "none"; } catch {}
      }
    }
  } catch {}
}

// Font Awesome webfonts are not reliably embedded by every browser's PDF
// backend. Keep these two damage-receipt controls legible in saved HTML/PDF by
// replacing only their icon-font nodes with ordinary Unicode text.
export function feNormalizeArchiveMidiDamageButtonIcons(node) {
  try {
    if (!feIsElement(node)) return;
    const replacements = [
      [".midi-qol-dmg-btn-apply > i", "\u2713"],
      [".midi-qol-dmg-btn-reverse > i", "\u21BA"],
    ];
    const doc = node.ownerDocument || document;
    for (const [selector, glyph] of replacements) {
      for (const icon of node.querySelectorAll?.(selector) ?? []) {
        const span = doc.createElement("span");
        span.className = "fe-archive-midi-damage-glyph";
        span.setAttribute("aria-hidden", "true");
        span.textContent = glyph;
        icon.replaceWith(span);
      }
    }
  } catch {}
}

// ---------------------------------------------------------------------------
// dnd5e-icon inlining
//
// dnd5e renders its SVG icons through a CUSTOM ELEMENT whose content lives in a
// **closed** shadow root (`attachShadow({mode:"closed"})`, dnd5e.mjs IconElement,
// `:host{display:contents}`). Two consequences for an export:
//   1. `cloneNode` never copies a shadow root, so our cloned message carries an
//      empty `<dnd5e-icon src="…">`.
//   2. The archive popup / saved HTML file has no dnd5e JS, so the element is
//      never upgraded and nothing is ever painted — not even a broken-image glyph,
//      because an undefined custom element is just an empty inline box.
// Measured on the 2026-08-12 export: 57 `<dnd5e-icon>` tags, 0 containing an
// `<svg>`. Every dnd5e icon was missing (damage types, statuses, the healing
// icon next to a heal total); only the last one was noticed.
//
// Fix: fetch each distinct SVG ONCE from the live (same-origin) document and
// graft it into the element as a light-DOM child, reproducing IconElement.CSS in
// the archive stylesheet. No shadow root, no custom element, no network at view
// time — and the snapshot serializer picks it up for free because it is now
// ordinary inline markup.
// ---------------------------------------------------------------------------

export const FE_DND5E_ICON_SVG_CACHE = new Map(); // src → Promise<string|null>
export const FE_DND5E_ICON_FETCH_TIMEOUT = 4000;

export function feFetchDnd5eIconSvg(src) {
  if (FE_DND5E_ICON_SVG_CACHE.has(src)) return FE_DND5E_ICON_SVG_CACHE.get(src);
  const promise = (async () => {
    try {
      // A bare relative fetch resolves against the current URL (/game), not the
      // app root — same trap as fe-animated-tile.js. Go through the <base href>.
      const base = feGetFoundryBaseHref() || document.baseURI;
      const url = new URL(src, base).href;
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), FE_DND5E_ICON_FETCH_TIMEOUT);
      let text = null;
      try {
        const res = await fetch(url, { signal: ctrl.signal });
        if (res.ok) text = await res.text();
      } finally {
        clearTimeout(timer);
      }
      return text;
    } catch {
      return null;
    }
  })();
  FE_DND5E_ICON_SVG_CACHE.set(src, promise);
  return promise;
}

export async function feInlineDnd5eIcons(rootEl, targetDoc) {
  try {
    if (!feIsElement(rootEl)) return;
    const doc = targetDoc || rootEl.ownerDocument || document;
    const nodes = Array.from(
      rootEl.querySelectorAll?.("dnd5e-icon[src], i.dnd5e-icon[data-src]") ?? []
    ).filter((el) => el.dataset?.feIconInlined !== "1" && !el.querySelector?.("svg"));
    if (!nodes.length) return;

    // Group by source so a chat log with 57 icons issues ~10 fetches.
    const bySrc = new Map();
    for (const el of nodes) {
      const src = el.getAttribute("src") || el.dataset?.src;
      if (!src) continue;
      if (!bySrc.has(src)) bySrc.set(src, []);
      bySrc.get(src).push(el);
    }

    await Promise.all(
      Array.from(bySrc.entries()).map(async ([src, els]) => {
        const text = await feFetchDnd5eIconSvg(src);
        if (!text) return;
        let template = null;
        try {
          const parsed = new DOMParser().parseFromString(text, "image/svg+xml");
          const root = parsed.documentElement;
          if (!root || root.nodeName.toLowerCase() !== "svg") return;
          // Defensive: an SVG can carry <script>/on* handlers. The archive is
          // written to a file the user opens directly, so strip them.
          for (const bad of root.querySelectorAll("script, foreignObject")) bad.remove();
          for (const el of [root, ...root.querySelectorAll("*")]) {
            for (const attr of Array.from(el.attributes ?? [])) {
              if (/^on/i.test(attr.name)) el.removeAttribute(attr.name);
            }
          }
          template = root;
        } catch { return; }
        for (const el of els) {
          try {
            const svg = doc.importNode(template, true);
            svg.classList.add("fe-dnd5e-icon-svg");
            // Width/height come from CSS (IconElement.CSS), matching live sizing.
            svg.removeAttribute("width");
            svg.removeAttribute("height");
            el.replaceChildren(svg);
            el.dataset.feIconInlined = "1";
          } catch {}
        }
      })
    );
  } catch (err) {
    console.warn(feLocalize("FE.Diagnostics.ChatArchive.feInlineDnd5eIcons"), err);
  }
}

export function feFinalizeArchiveSpecialMessageState(node, msg, liveEl = null) {
  try {
    if (!feIsElement(node)) return;

    const isNarrator = !!(
      feIsNarratorToolsMessage(msg, node) ||
      liveEl?.classList?.contains?.('narrator-chat') ||
      liveEl?.classList?.contains?.('fe-narrator-chat')
    );

    const isRoundMarker = !!(
      feIsRoundMarkerMessage(msg, node) ||
      liveEl?.classList?.contains?.('round-marker') ||
      liveEl?.classList?.contains?.('fe-round-marker-chat') ||
      liveEl?.dataset?.feIsRoundMarker === '1' ||
      liveEl?.querySelector?.('.round-marker')
    );

    node.classList.toggle('narrator-chat', isNarrator);
    node.classList.toggle('fe-narrator-chat', isNarrator);
    node.classList.toggle('round-marker', isRoundMarker);
    node.classList.toggle('fe-round-marker-chat', isRoundMarker);

    if (isRoundMarker) {
      node.dataset.feIsRoundMarker = '1';
      node.setAttribute?.('data-fe-is-round-marker', '1');
    } else {
      delete node.dataset.feIsRoundMarker;
      node.removeAttribute?.('data-fe-is-round-marker');
    }

    if (isNarrator || isRoundMarker) {
      // Mirror feApplyUserColorBgToMessageElement's early return: narrator and
      // round-marker messages never carry user-color machinery. A live clone can
      // still bring a stale fe-system-gm-tint/fe-system-msg stamped before its
      // narrator class existed (imported logs, no stored render state), so all
      // three classes — and the tint var — come off here.
      node.classList.remove('fe-has-user-color', 'fe-system-msg', 'fe-system-gm-tint');
      node.style?.removeProperty?.('--fe-user-color-rgb');
      node.style?.removeProperty?.('--fe-user-color-alpha');
    }

    if (!isRoundMarker) {
      node.classList.remove('fe-round-marker-empty-content');
      return;
    }

    const header = node.querySelector?.(':scope > .message-header');
    const sender = header?.querySelector?.('.message-sender');
    const metadata = header?.querySelector?.('.message-metadata');
    const portrait = header?.querySelector?.('img.fe-chat-portrait, .fe-chat-portrait-wrap');
    try { sender?.style?.setProperty?.('display', 'none', 'important'); } catch {}
    try { metadata?.style?.setProperty?.('display', 'none', 'important'); } catch {}
    try { portrait?.style?.setProperty?.('display', 'none', 'important'); } catch {}

    node.classList.toggle('fe-round-marker-empty-content', feArchiveMessageContentLooksEmpty(node));
  } catch {
    /* no-op */
  }
}

export function feNormalizeArchiveMessageRoot(targetDoc, node) {
  try {
    if (!feIsElement(node)) return null;
    if (node.matches?.("li.chat-message")) return node;

    // Notification tray roots in FVTT v13 can be .message instead of li.chat-message.
    // Normalize them to the archive's expected list-item structure.
    const wrapper = targetDoc?.createElement?.("li") || document.createElement("li");
    const classNames = new Set(["chat-message", "message"]);
    for (const cls of Array.from(node.classList ?? [])) classNames.add(cls);
    wrapper.className = Array.from(classNames).join(" ");

    for (const attr of Array.from(node.attributes ?? [])) {
      const name = String(attr?.name ?? "");
      if (!name || name === "class") continue;
      wrapper.setAttribute(name, String(attr?.value ?? ""));
    }

    // Notification tray messages intentionally opt out of FE's visual merge.
    // If we use them as a fidelity fallback for export, start from a clean state and let
    // the archive log compute its own merge classes later.
    for (const cls of ["fe-merge-start", "fe-merge-mid", "fe-merge-end", "fe-merge-follow", "fe-divider-before"]) {
      wrapper.classList.remove(cls);
    }
    wrapper.removeAttribute?.("data-fe-merge-sig");

    while (node.firstChild) wrapper.appendChild(node.firstChild);
    return wrapper;
  } catch {
    return node;
  }
}

export function feFireArchiveRenderUpdated(targetDoc, logEl) {
  try {
    feFireChatUiUpdated({
      reason: "archive-render",
      root: logEl,
      log: logEl,
      document: targetDoc,
    });
  } catch {
    /* no-op */
  }
}

// ===========================================================================
// Message Rendering Pipeline  (batch render, live-clone, system render, fallback)
// ===========================================================================

export async function feRenderMessagesIntoLog({
  targetDoc,
  logEl,
  messages,
  metaEl = null,
  yieldWindow = window,
  liveMessageMap = null,
  annotateExportMessage = false,
  renderProfile = null,
} = {}) {
  if (!targetDoc || !logEl || !Array.isArray(messages) || !messages.length) return 0;

  const flushEvery = Math.max(1, Number(renderProfile?.renderBatch) || FE_EXPORT_RENDER_BATCH);
  const concurrency = Math.max(1, Number(renderProfile?.renderConcurrency) || FE_EXPORT_RENDER_CONCURRENCY);
  const deferPortraits = !!renderProfile?.deferPortraits;
  const imageRegistry = renderProfile?.collapseDuplicateImages ? new Map() : null;
  // Shared across the whole export so "first occurrence" of an item UUID is a
  // document-order decision — consumed only in the ordered commit loop below.
  const itemDescriptionRegistry = new Set();
  let renderedCount = 0;
  let frag = targetDoc.createDocumentFragment();
  let fragCount = 0;

  const flush = async () => {
    if (fragCount) {
      logEl.appendChild(frag);
      frag = targetDoc.createDocumentFragment();
      fragCount = 0;
    }
    await feMaybeYieldForUI(yieldWindow);
  };

  const renderOne = async (item) => {
    const msg = item?.msg ?? null;
    const explicitLive = item?.liveEl ?? null;
    const msgId = String(item?.id ?? msg?.id ?? msg?._id ?? "");
    const liveEl = explicitLive || (msgId && typeof liveMessageMap?.get === "function" ? liveMessageMap.get(msgId) : null) || null;
    const node = await feRenderExportMessageNode(targetDoc, msg, { liveEl, renderProfile });
    if (!feIsElement(node)) return null;

    if (annotateExportMessage) node.classList.add("fe-export-message");

    feNormalizeExportNode(node, {
      loading: renderProfile?.normalizeImageLoading,
      decoding: renderProfile?.normalizeImageDecoding,
    });
    if (msg) feApplyRenderedStateToMessageElement(msg, node);
    if (msg) feNormalizeArchiveTimestamps(node, msg);
    feStripArchiveMessageControls(node);

    if (!deferPortraits) {
      try {
        if (msg && !feHasPortraitMarkup(node)) feChatPortraitUpsert(msg, node);
      } catch {}
    }

    // Portrait upsert can create a new <img> after the first normalization
    // pass above. Normalize existing clones and newly inserted portraits alike.
    feNormalizeArchivePortraitImages(node, renderProfile);

    return node;
  };

  for (let start = 0; start < messages.length; start += concurrency) {
    // The user can close the archive popup mid-render. Without this the loop keeps
    // building thousands of nodes into a dead document — and every downstream asset
    // wait (feWaitForImages/feWaitForFonts) then burns its full 10–12 s timeout on
    // images that can never load. Stop at the batch boundary instead.
    if (feArchiveWindowClosed(yieldWindow)) break;

    const slice = messages.slice(start, start + concurrency);
    const nodes = await Promise.all(slice.map((msg) => renderOne(msg)));

    for (let i = 0; i < nodes.length; i += 1) {
      renderedCount += 1;
      if (metaEl && (renderedCount === 1 || renderedCount % FE_EXPORT_STATUS_EVERY === 0 || renderedCount === messages.length)) {
        try {
          metaEl.textContent = feFormat("FE.ChatArchive.Status.Rendering", { rendered: renderedCount, total: messages.length });
        } catch {}
      }

      const node = nodes[i];
      const item = slice[i];
      const itemId = String(item?.id ?? item?.msg?.id ?? item?.msg?._id ?? "");
      if (feIsElement(node)) {
        feOptimizeArchiveNodeImages(node, { targetDoc, renderProfile, imageRegistry });
        feCollapseRepeatedItemDescriptions(node, itemDescriptionRegistry);
        frag.appendChild(node);
        fragCount += 1;
      }
      // Release the live element reference now — the imported clone in archive doc
      // no longer needs it. For harvested clones, this lets the original be GC'd
      // progressively instead of pinning the entire history until render completes.
      if (item) item.liveEl = null;
      if (itemId) liveMessageMap?.delete?.(itemId);
    }

    if (fragCount >= flushEvery) await flush();
  }

  if (fragCount) await flush();
  return renderedCount;
}

export function feArchiveShouldPreferLiveClone(msg, liveEl = null, renderProfile = null) {
  try {
    if (!feIsElement(liveEl)) return false;
    if (!msg) return true;
    if (!renderProfile?.lean) return true;
    if (feArchiveMessageLooksComplex(msg, liveEl)) return true;

    const cl = liveEl.classList;
    if (
      cl?.contains?.("fe-has-chat-portrait") ||
      cl?.contains?.("fe-has-user-color") ||
      cl?.contains?.("narrator-chat") ||
      cl?.contains?.("fe-narrator-chat") ||
      cl?.contains?.("round-marker") ||
      cl?.contains?.("fe-round-marker-chat") ||
      cl?.contains?.("fe-merge-start") ||
      cl?.contains?.("fe-merge-mid") ||
      cl?.contains?.("fe-merge-end") ||
      cl?.contains?.("fe-merge-follow") ||
      cl?.contains?.("fe-divider-before")
    ) return true;

    if (liveEl.querySelector?.(FE_EXPORT_PORTRAIT_MARKER_SELECTOR)) return true;
    if (liveEl.querySelector?.('.message-content :is(img, video, blockquote, pre, code, table, ul, ol, hr)')) return true;
  } catch {
    /* no-op */
  }
  return false;
}

export function feArchiveShouldTrySystemRender(msg, liveEl = null) {
  try {
    if (!msg) return false;
    if (feIsNarratorToolsMessage(msg, liveEl) || feIsRoundMarkerMessage(msg, liveEl)) return true;
    if (feArchiveMessageLooksComplex(msg, liveEl)) return true;
    return false;
  } catch {
    return false;
  }
}

export async function feRenderExportMessageNode(targetDoc, msg, { liveEl = null, renderProfile = null } = {}) {
  let node = null;
  const shouldCloneLive = feArchiveShouldPreferLiveClone(msg, liveEl, renderProfile);
  try {
    if (shouldCloneLive && feIsElement(liveEl)) node = targetDoc.importNode(liveEl, true);
  } catch {
    node = null;
  }

  if (!feIsElement(node) && feArchiveShouldTrySystemRender(msg, liveEl)) {
    try {
      const rendered = await feTryFoundryRenderMessage(msg);
      if (feIsElement(rendered)) node = targetDoc.importNode(rendered, true);
    } catch {
      node = null;
    }
  }

  if (!feIsElement(node)) {
    try {
      node = feFallbackRenderChatMessage(targetDoc || document, msg);
    } catch {
      node = null;
    }
  }

  if (feIsElement(node) && shouldCloneLive && feIsElement(liveEl)) {
    try {
      feMirrorLiveMessageStyles(liveEl, node, { renderProfile });
    } catch {
      /* no-op */
    }
  }

  if (feIsElement(node)) {
    try {
      node = feNormalizeArchiveMessageRoot(targetDoc || document, node) || node;
      node.__feMessage = msg || node.__feMessage || null;
      feStampArchiveMessageIdentity(node, msg || { id: feGetMessageIdFromElement(liveEl) || undefined });
      feFinalizeArchiveSpecialMessageState(node, msg, liveEl);
      feMarkPlainArchiveMessage(node, msg, liveEl);
    } catch {}
  }

  if (feIsElement(node) && renderProfile?.restoreOriginalPortraitSources) {
    try {
      feRestoreOriginalPortraitSources(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feNormalizeArchiveMessageLayout(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feExpandCollapsedArchiveSections(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feRestoreMidiDamageTypeIcons(msg, node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      await feRestoreMidiItemDescription(msg, node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feMarkHeaderlessArchiveCards(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      fePopulateArchiveRecordedTargets(node, msg, targetDoc || document);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feStripEmptyArchiveTrays(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feApplyMidiQolViewerRole(node);
    } catch {}
  }

  if (feIsElement(node)) {
    try {
      feNormalizeArchiveMidiDamageButtonIcons(node);
    } catch {}
  }

  return feIsElement(node) ? node : null;
}

// ===========================================================================
// Render Decision & Fallback  (complexity heuristic, plain-message fast path,
//                              HTML fallback renderer)
// ===========================================================================

export function feArchiveMessageLooksComplex(msg, liveEl = null) {
  try {
    const el = liveEl;
    if (el?.querySelector?.('.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .dice-roll, .dice-result, .round-marker, .chat-images-container, .ci-message-image, img, video, table, blockquote, pre, iframe')) return true;
  } catch {}
  try {
    // Roll messages store the dice total in content, not the .dice-roll card HTML.
    // The card is generated by Foundry's template at render time, so we must use
    // the system render path whenever a message carries actual dice rolls.
    if (Array.isArray(msg?.rolls) && msg.rolls.length > 0) return true;
  } catch {}
  try {
    const content = String(msg?.content ?? '');
    if (!content) return false;
    return /(?:chat-card|midi-chat-card|dice-roll|dice-result|round-marker|chat-images-container|ci-message-image|<img\b|<video\b|<table\b|<blockquote\b|<pre\b|<iframe\b)/i.test(content);
  } catch {
    return false;
  }
}

export function feArchiveShouldUseStandardFallback(msg, liveEl = null) {
  try {
    if (!msg) return true;
    if (feArchiveMessageLooksComplex(msg, liveEl)) return false;
    return true;
  } catch {
    return true;
  }
}

export function feMarkPlainArchiveMessage(node, msg, liveEl = null) {
  try {
    if (!feIsElement(node)) return;
    const plain = feArchiveShouldUseStandardFallback(msg, liveEl);
    node.classList.toggle('fe-msg-plain', !!plain);
  } catch {}
}

export function feFallbackRenderChatMessage(doc, msg) {
  if (!doc) throw new Error("No document provided");
  const li = doc.createElement("li");
  li.className = "chat-message message flexcol fe-pseudo-sanitized";

  try {
    const id = msg?.id ?? msg?._id;
    if (id) {
      li.dataset.messageId = String(id);
      li.dataset.documentId = String(id);
    }
  } catch {}

  try {
    const style = Number(msg?.style ?? msg?.type ?? -1);
    // v14: CONST.CHAT_MESSAGE_STYLES | v13: CONST.CHAT_MESSAGE_TYPES (same numeric values)
    const styles = CONST?.CHAT_MESSAGE_STYLES || CONST?.CHAT_MESSAGE_TYPES || {};
    if (style === styles.OTHER) li.classList.add("other");
    else if (style === styles.IC) li.classList.add("ic");
    else if (style === styles.OOC) li.classList.add("ooc");
    else if (style === styles.EMOTE) li.classList.add("emote");
    else if (style === styles.WHISPER) li.classList.add("whisper");
    else if (style === styles.ROLL) li.classList.add("roll");
  } catch {}
  try {
    if (Array.isArray(msg?.whisper) && msg.whisper.length) li.classList.add("whisper");
  } catch {}

  // Core parity — the message border color.
  //
  // `ChatMessage#renderHTML` (client/documents/chat-message.mjs:428) does exactly
  // one thing with it: `if (style === CHAT_MESSAGE_STYLES.OOC) borderColor =
  // author.color.css`. So ONLY OOC messages get the author's color; IC / emote /
  // roll keep the theme's `--chat-message-border-color` (#6f6c66). It reaches the
  // DOM as an inline `style="border-color:…"`, which means the live-clone and
  // core-render paths inherit it for free — and this fresh-build path was the only
  // one that dropped it, so OOC messages older than the sidebar's live DOM window
  // rendered gray in the archive while the recent ones were colored
  // ("이전 페이지들만 유저색 테두리가 없음"). Verified live: messages carrying the
  // `ic` class had no inline border-color, non-IC ones did.
  //
  // Do NOT widen this to every message — coloring IC borders too would make the
  // archive stop matching the live chat, which is the opposite of the point.
  try {
    const styles = CONST?.CHAT_MESSAGE_STYLES || CONST?.CHAT_MESSAGE_TYPES || {};
    if (Number(msg?.style ?? msg?.type ?? -1) === styles.OOC) {
      const author = msg?.author ?? msg?.user;
      const color = author?.color;
      const css = typeof color === "string" ? color : color?.css;
      if (css) li.style.borderColor = String(css);
    }
  } catch {}

  const actorName = (() => {
    try { if (msg?.speaker?.alias) return String(msg.speaker.alias); } catch {}
    try {
      const actor = game.actors?.get?.(msg?.speaker?.actor) || game.actors?.tokens?.[msg?.speaker?.token];
      if (actor?.name) return String(actor.name);
    } catch {}
    try { const a = msg?.author ?? msg?.user; if (a?.name) return String(a.name); } catch {}
    return "Unknown";
  })();
  const playerName = (() => {
    try { const a = msg?.author ?? msg?.user; return String(a?.name || "").trim(); } catch { return ""; }
  })();

  const timestampText = feFormatArchiveTimestamp(msg);

  const header = doc.createElement("header");
  header.className = "message-header flexrow";

  const sender = doc.createElement("h4");
  sender.className = "message-sender chat-portrait-text-size-name-dnd5e chat-portrait-text-header-name-dnd5e";
  const wrap = doc.createElement("span");
  wrap.className = "name-stacked";
  const title = doc.createElement("span");
  title.className = "title";
  title.textContent = actorName;
  wrap.appendChild(title);
  if (playerName && playerName !== actorName) {
    const sub = doc.createElement("span");
    sub.className = "subtitle";
    sub.textContent = playerName;
    wrap.appendChild(sub);
  }
  sender.appendChild(wrap);

  const isNarratorMessage = !!feIsNarratorToolsMessage(msg, null);
  const isRoundMarkerMessage = !!feIsRoundMarkerMessage(msg, null);
  if (isNarratorMessage) li.classList.add("narrator-chat", "fe-narrator-chat");
  if (isRoundMarkerMessage) li.classList.add("round-marker", "fe-round-marker-chat");

  const hideSender = isRoundMarkerMessage;
  if (hideSender) sender.style.setProperty("display", "none", "important");

  const meta = doc.createElement("span");
  meta.className = "message-metadata";
  if (timestampText) {
    const time = doc.createElement("time");
    time.className = "message-timestamp";
    time.textContent = timestampText;
    meta.appendChild(time);
  }

  const flavor = String(msg?.flavor ?? "").trim();
  header.appendChild(sender);
  header.appendChild(meta);
  if (flavor) {
    const flavorEl = doc.createElement("span");
    flavorEl.className = "message-flavor";
    flavorEl.textContent = flavor;
    header.appendChild(flavorEl);
  }

  const content = doc.createElement("div");
  content.className = "message-content fe-archive-standard-content";
  try {
    content.innerHTML = String(msg?.content ?? "");
  } catch {
    content.textContent = String(msg?.content ?? "");
  }

  li.appendChild(header);
  li.appendChild(content);
  return li;
}
