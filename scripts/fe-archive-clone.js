// Archive clone helpers: duplicate-image optimization and computed-style
// mirroring. Self-contained so the archive entry module does not need to own
// the large property tables or DOM traversal implementation.

const FE_ARCHIVE_DUPLICATE_IMAGE_KEEP = 1;

function feArchiveGetImageSourceKey(img, baseHref = null) {
  try {
    const raw = img?.getAttribute?.("src") || img?.currentSrc || img?.src || "";
    if (!raw) return "";
    if (/^(?:data:|blob:)/i.test(raw)) return raw;
    return new URL(raw, baseHref || img?.ownerDocument?.baseURI || document.baseURI).href;
  } catch {
    return String(img?.getAttribute?.("src") || img?.currentSrc || img?.src || "");
  }
}

function feArchiveIsProtectedImage(img) {
  try {
    if (!img) return true;
    if (img.closest?.('.chat-card .card-header, .midi-chat-card .card-header, .dnd5e.chat-card .card-header, .dnd5e2.chat-card .card-header')) return true;
  } catch {
    /* no-op */
  }
  return false;
}

function feArchiveShouldCollapseDuplicateImage(img, renderProfile = null) {
  try {
    if (!renderProfile?.collapseDuplicateImages) return false;
    const src = feArchiveGetImageSourceKey(img);
    if (!src || /^(?:data:|blob:)/i.test(src)) return false;
    if (feArchiveIsProtectedImage(img)) return false;
    if (renderProfile?.collapseDuplicateImagesAggressive) return true;
    if (img.classList?.contains("ci-message-image")) return true;
    if (img.closest?.('.chat-images-container, .ci-message-image, .message-content, figure, .editor-content')) return true;
    return false;
  } catch {
    return false;
  }
}

function fePrepareArchiveSharedImage(img, src, occurrence = 2) {
  try {
    if (!img || !src) return;
    img.classList?.add?.("fe-archive-shared-image");
    img.dataset.feArchiveSharedImage = "1";
    img.dataset.feArchiveSharedSrc = src;
    img.dataset.feArchiveSharedOccurrence = String(Math.max(2, Number(occurrence) || 2));
    img.setAttribute("src", src);
    img.removeAttribute("srcset");
    if (!img.getAttribute("loading")) img.setAttribute("loading", "lazy");
    if (!img.getAttribute("decoding")) img.setAttribute("decoding", "async");

    const label = String(img.getAttribute("title") || img.getAttribute("alt") || "").trim();
    const suffix = occurrence > 1 ? ` (shared ×${occurrence})` : "";
    if (label) img.setAttribute("title", `${label}${suffix}`);
    else img.setAttribute("title", `shared image${suffix}`);
  } catch {
    /* no-op */
  }
}

export function feOptimizeArchiveNodeImages(rootEl, { targetDoc = document, renderProfile = null, imageRegistry = null } = {}) {
  try {
    if (!imageRegistry || !renderProfile?.collapseDuplicateImages || !rootEl?.querySelectorAll) return 0;
    let collapsed = 0;
    const imgs = Array.from(rootEl.querySelectorAll('img[src]'));
    for (const img of imgs) {
      if (!feArchiveShouldCollapseDuplicateImage(img, renderProfile)) continue;
      const srcKey = feArchiveGetImageSourceKey(img, targetDoc?.baseURI || rootEl?.ownerDocument?.baseURI || document.baseURI);
      if (!srcKey || /^(?:data:|blob:)/i.test(srcKey)) continue;

      const entry = imageRegistry.get(srcKey) ?? { count: 0 };
      entry.count += 1;
      imageRegistry.set(srcKey, entry);
      if (entry.count <= FE_ARCHIVE_DUPLICATE_IMAGE_KEEP) continue;

      fePrepareArchiveSharedImage(img, srcKey, entry.count);
      collapsed += 1;
    }
    return collapsed;
  } catch {
    return 0;
  }
}

const FE_ARCHIVE_CONTAINER_STYLE_PROPS = [
  "color", "background-color", "background-image", "background-size",
  "background-position", "background-repeat", "background-blend-mode",
  "border", "border-color", "border-style", "border-width", "border-top",
  "border-right", "border-bottom", "border-left", "border-radius", "box-shadow",
  "outline", "outline-color", "outline-style", "outline-width", "filter",
  "opacity", "display", "padding", "margin", "align-items", "justify-content",
  "align-self", "justify-self", "justify-items", "align-content", "place-items",
  "place-content", "grid-template-columns", "grid-template-rows",
  "grid-template-areas", "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-area", "grid-column", "grid-column-start", "grid-column-end", "grid-row",
  "grid-row-start", "grid-row-end", "gap", "column-gap", "row-gap", "white-space",
  "overflow", "text-overflow", "position", "top", "right", "bottom", "left",
  "z-index", "width", "height", "min-width", "min-height", "max-width",
  "max-height", "box-sizing", "flex", "flex-direction", "flex-wrap", "flex-grow",
  "flex-shrink", "flex-basis", "transform", "transform-origin", "translate",
  "scale", "rotate", "vertical-align",
];

const FE_ARCHIVE_TEXT_STYLE_PROPS = [
  "color", "font-family", "font-size", "font-style", "font-weight", "line-height",
  "letter-spacing", "text-shadow", "text-transform", "text-align", "white-space",
];

const FE_ARCHIVE_FIXED_SIZE_PROPS = ["width", "height", "min-width", "min-height", "max-width", "max-height"];
const FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_CONTAINER_STYLE_PROPS.filter((p) => !FE_ARCHIVE_FIXED_SIZE_PROPS.includes(p));
const FE_ARCHIVE_TREE_STYLE_PROPS = Array.from(new Set([...FE_ARCHIVE_CONTAINER_STYLE_PROPS, ...FE_ARCHIVE_TEXT_STYLE_PROPS]));
const FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE = Array.from(new Set([...FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE, ...FE_ARCHIVE_TEXT_STYLE_PROPS]));
const FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE;
const FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE;
const FE_ARCHIVE_TREE_MAX_SIMPLE = 72;
const FE_ARCHIVE_TREE_MAX_PORTRAIT = 112;
const FE_ARCHIVE_TREE_MAX_COMPLEX = 260;

function feIsElement(node) {
  return !!node && node.nodeType === 1;
}

function feGetArchiveTreeMirrorBudget(liveEl) {
  try {
    const hasCard = !!liveEl?.querySelector?.('.chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card, .details.card-content, .details.collapsible-content.card-content');
    if (hasCard) return FE_ARCHIVE_TREE_MAX_COMPLEX;
    if (liveEl?.classList?.contains?.('fe-has-chat-portrait')) return FE_ARCHIVE_TREE_MAX_PORTRAIT;
  } catch {
    /* no-op */
  }
  return FE_ARCHIVE_TREE_MAX_SIMPLE;
}

function feCopyComputedStyleSubset(srcEl, dstEl, propNames = []) {
  try {
    if (!srcEl || !dstEl) return;
    const view = srcEl?.ownerDocument?.defaultView ?? window;
    const cs = view.getComputedStyle?.(srcEl);
    if (!cs) return;
    for (const prop of propNames) {
      const value = cs.getPropertyValue?.(prop);
      if (value) dstEl.style.setProperty(prop, value.trim());
    }
  } catch {
    /* no-op */
  }
}

function feSelectScoped(root, selector) {
  try {
    if (!root) return [];
    if (selector === ":scope") return [root];
    return Array.from(root.querySelectorAll?.(selector) ?? []);
  } catch {
    return [];
  }
}

function feMirrorLiveTreeStyles(liveEl, cloneEl, { maxNodes = 80, propNames = FE_ARCHIVE_TREE_STYLE_PROPS } = {}) {
  try {
    if (!feIsElement(liveEl) || !feIsElement(cloneEl)) return;
    const liveWalker = (liveEl.ownerDocument ?? document).createTreeWalker(liveEl, NodeFilter.SHOW_ELEMENT);
    const cloneWalker = (cloneEl.ownerDocument ?? document).createTreeWalker(cloneEl, NodeFilter.SHOW_ELEMENT);
    let liveNode = liveWalker.currentNode;
    let cloneNode = cloneWalker.currentNode;
    let count = 0;
    while (liveNode && cloneNode && count < maxNodes) {
      feCopyComputedStyleSubset(liveNode, cloneNode, propNames);
      liveNode = liveWalker.nextNode();
      cloneNode = cloneWalker.nextNode();
      count += 1;
    }
  } catch {
    /* no-op */
  }
}

export function feMirrorLiveMessageStyles(liveEl, cloneEl, { renderProfile = null } = {}) {
  try {
    if (!feIsElement(liveEl) || !feIsElement(cloneEl)) return;
    const hasCard = !!liveEl.querySelector?.(".chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card");
    const lean = !!renderProfile?.lean;
    const mirrorTree = renderProfile?.mirrorTree !== false;
    const mirrorCardTree = renderProfile?.mirrorCardTree !== false;

    if (mirrorTree && (!hasCard || mirrorCardTree)) {
      feMirrorLiveTreeStyles(liveEl, cloneEl, {
        maxNodes: feGetArchiveTreeMirrorBudget(liveEl),
        propNames: hasCard ? FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE : FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE,
      });
    }

    const sync = (selector, props) => {
      const srcList = feSelectScoped(liveEl, selector);
      const dstList = feSelectScoped(cloneEl, selector);
      const n = Math.min(srcList.length, dstList.length);
      for (let i = 0; i < n; i++) feCopyComputedStyleSubset(srcList[i], dstList[i], props);
    };

    sync(":scope", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-sender", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-sender .name-stacked", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-sender .name-stacked .title, :scope > .message-header .message-sender .title", FE_ARCHIVE_TEXT_STYLE_PROPS);
    sync(":scope > .message-header .message-sender .name-stacked .subtitle, :scope > .message-header .message-sender .subtitle", FE_ARCHIVE_TEXT_STYLE_PROPS);
    sync(":scope > .message-header .message-flavor, :scope > .message-header .flavor-text", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);
    sync(":scope > .message-header .message-metadata", FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE);

    if (hasCard) {
      sync(":scope .chat-card, :scope .midi-chat-card, :scope .dnd5e.chat-card, :scope .dnd5e2.chat-card", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      sync(":scope .chat-card .card-header, :scope .midi-chat-card .card-header, :scope .dnd5e.chat-card .card-header, :scope .dnd5e2.chat-card .card-header", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      sync(":scope .chat-card .card-content, :scope .midi-chat-card .card-content, :scope .dnd5e.chat-card .card-content, :scope .dnd5e2.chat-card .card-content, :scope .details.card-content, :scope .details.collapsible-content.card-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      sync(":scope .chat-card .name-stacked .title, :scope .midi-chat-card .name-stacked .title, :scope .chat-card .name-stacked .subtitle, :scope .midi-chat-card .name-stacked .subtitle", FE_ARCHIVE_TEXT_STYLE_PROPS);
      sync(":scope .chat-card button, :scope .midi-chat-card button, :scope .dnd5e.chat-card button, :scope .dnd5e2.chat-card button, :scope .chat-card .pill, :scope .midi-chat-card .pill", FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE);
      const midiSelector = lean
        ? ":scope .midi-chat-card :is(.dice-roll, .dice-result, .dice-formula, .dice-tooltip, .dice-total, .dice-flavor, .dice-target, .dice-targets, .targets, .target)"
        : ":scope .midi-chat-card :is(.dice-roll, .dice-result, .dice-formula, .dice-tooltip, .dice-total, .dice-flavor, .dice-target, .dice-targets, .targets, .target, [class*=\"midi\"], [class*=\"roll\"], [class*=\"damage\"], [class*=\"attack\"] )";
      sync(midiSelector, lean ? FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE : FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE);
    }

    const isNarratorLike = !!(liveEl.classList?.contains?.("narrator-chat") || liveEl.classList?.contains?.("fe-narrator-chat"));
    const isRoundMarkerLike = !!(
      liveEl.classList?.contains?.("round-marker") ||
      liveEl.classList?.contains?.("fe-round-marker-chat") ||
      liveEl.dataset?.feIsRoundMarker === "1" ||
      liveEl.querySelector?.(".round-marker")
    );
    if (isNarratorLike || isRoundMarkerLike) {
      sync(":scope, :scope > .message-header, :scope > .message-content", FE_ARCHIVE_CONTAINER_STYLE_PROPS);
      sync(":scope .message-content, :scope .round-marker", FE_ARCHIVE_TEXT_STYLE_PROPS);
    }
  } catch {
    /* no-op */
  }
}
