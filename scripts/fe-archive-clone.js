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
  "background-position", "background-position-x", "background-position-y",
  "background-repeat", "background-attachment", "background-clip",
  "background-origin", "background-blend-mode",
  "border", "border-color", "border-style", "border-width", "border-top",
  "border-right", "border-bottom", "border-left", "border-radius", "box-shadow",
  "outline", "outline-color", "outline-style", "outline-width", "filter",
  "backdrop-filter", "clip-path", "mask-image", "mix-blend-mode", "isolation",
  "opacity", "visibility", "display", "float", "clear", "padding", "margin",
  "align-items", "justify-content",
  "align-self", "justify-self", "justify-items", "align-content", "place-items",
  "place-content", "grid-template-columns", "grid-template-rows",
  "grid-template-areas", "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-area", "grid-column", "grid-column-start", "grid-column-end", "grid-row",
  "grid-row-start", "grid-row-end", "gap", "column-gap", "row-gap", "white-space",
  "overflow", "text-overflow", "position", "top", "right", "bottom", "left",
  "z-index", "width", "height", "min-width", "min-height", "max-width",
  "max-height", "box-sizing", "overflow-x", "overflow-y", "flex", "flex-direction", "flex-wrap", "flex-grow",
  "flex-shrink", "flex-basis", "transform", "transform-origin", "translate",
  "scale", "rotate", "order", "vertical-align", "object-fit", "object-position",
  "aspect-ratio", "writing-mode",
];

const FE_ARCHIVE_TEXT_STYLE_PROPS = [
  // NOTE: `font-family` is deliberately NOT mirrored. The archive's font is owned
  // entirely by the embedded-font <style> (feBuildEmbeddedCookieRunFontCSS): it
  // routes text to the data-URL "FE … Embedded" faces via body classes + --fe-font-*
  // vars. Mirroring copies the live sidebar's *computed* font-family — which names
  // the LIVE faces ("FE CookieRun", not "…Embedded") — inline with !important, and
  // that inline rule OVERRIDES the embedded routing. In a standalone HTML file the
  // live faces load from Foundry-origin absolute url()s that 404 offline, so those
  // elements fall back to the system default. Only the live-CLONED messages mirror
  // (recent messages, clustered on the LAST pages), so the symptom was "마지막
  // 페이지만 기본 폰트". Fresh-built messages never mirror and were always correct;
  // dropping font-family here makes cloned messages match them. (font-size/weight/
  // style/line-height stay — they vary per message and have no offline-face issue.)
  "color", "font-size", "font-style", "font-weight", "line-height",
  "font-variant", "font-stretch", "letter-spacing", "word-spacing", "text-shadow",
  "text-transform", "text-align", "text-decoration", "text-decoration-color",
  "text-decoration-line", "text-decoration-style", "text-decoration-thickness",
  "text-indent", "white-space", "word-break", "overflow-wrap", "hyphens",
  "direction", "unicode-bidi", "list-style", "list-style-position", "list-style-type",
  "border-collapse", "border-spacing", "caption-side", "empty-cells",
];

// Fixed dimensions are unsafe on the message/card shell because they retain the
// narrow sidebar width. They are desirable on UI-scale components whose size is
// part of the chat format: portraits, avatars, icons, badges, and controls.
const FE_ARCHIVE_COMPONENT_STYLE_PROPS = Array.from(new Set([
  ...FE_ARCHIVE_CONTAINER_STYLE_PROPS,
  ...FE_ARCHIVE_TEXT_STYLE_PROPS,
]));

const FE_ARCHIVE_COMPONENT_SELECTOR = [
  ':scope .chat-portrait-container',
  ':scope img[class*="chat-portrait-message-portrait"]',
  ':scope img[class*="chat-portrait-image-size"]',
  ':scope img.avatar',
  ':scope .message-header img',
  ':scope .message-header :is(i, svg)',
  ':scope .chat-card .card-header img',
  ':scope .midi-chat-card .card-header img',
  ':scope .dnd5e.chat-card .card-header img',
  ':scope .dnd5e2.chat-card .card-header img',
  ':scope :is(.icon, .badge, .tag, .pill)',
].join(", ");

const FE_ARCHIVE_CUSTOM_PROPERTY_PREFIXES = [
  "--fe-", "--chat-", "--user-", "--color-", "--font-", "--dnd5e-", "--midi-",
];
const FE_ARCHIVE_CUSTOM_PROPERTY_MAX = 96;

const FE_ARCHIVE_FIXED_SIZE_PROPS = ["width", "height", "min-width", "min-height", "max-width", "max-height"];
const FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_CONTAINER_STYLE_PROPS.filter((p) => !FE_ARCHIVE_FIXED_SIZE_PROPS.includes(p));
const FE_ARCHIVE_TREE_STYLE_PROPS = Array.from(new Set([...FE_ARCHIVE_CONTAINER_STYLE_PROPS, ...FE_ARCHIVE_TEXT_STYLE_PROPS]));
const FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE = Array.from(new Set([...FE_ARCHIVE_CONTAINER_STYLE_PROPS_NO_FIXED_SIZE, ...FE_ARCHIVE_TEXT_STYLE_PROPS]));
const FE_ARCHIVE_CARD_TREE_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE;
const FE_ARCHIVE_MIXED_STYLE_PROPS_NO_FIXED_SIZE = FE_ARCHIVE_TREE_STYLE_PROPS_NO_FIXED_SIZE;
const FE_ARCHIVE_TREE_MAX_SIMPLE = 72;

// The message HEADER layout (standard flexrow vs. the portrait GRID) is owned
// entirely by the export stylesheet — NOT by whatever geometry the live sidebar
// happened to compute at its narrow (~300px) width. Mirroring copies the live
// computed flex/grid/justify/align/display onto the clone with `!important`,
// which overrides the export's portrait grid and traps the timestamp inside a
// sidebar-width slice (the "타임스탬프가 사이드바 폭에 갇힘" bug). After mirroring
// we therefore STRIP these layout-geometry inline props from the header region so
// the export CSS (and feNormalizeArchiveMessageLayout) governs the header layout.
// Visual props (color, background, border, font, text, opacity, filter) are kept.
const FE_ARCHIVE_HEADER_LAYOUT_RESET_PROPS = [
  "flex", "flex-grow", "flex-shrink", "flex-basis", "flex-direction", "flex-wrap", "order",
  "justify-content", "justify-items", "justify-self",
  "align-items", "align-content", "align-self", "place-items", "place-content",
  "grid-template-columns", "grid-template-rows", "grid-template-areas",
  "grid-auto-columns", "grid-auto-rows", "grid-auto-flow",
  "grid-area", "grid-column", "grid-column-start", "grid-column-end",
  "grid-row", "grid-row-start", "grid-row-end",
  "gap", "column-gap", "row-gap",
  "display", "position", "top", "right", "bottom", "left", "float", "clear",
  "margin", "padding",
  "width", "inline-size", "min-width", "max-width", "height", "min-height", "max-height",
];
// Header text/meta boxes whose placement the export owns. The portrait <img> is
// deliberately excluded — its size IS mirrored as a chat-format component, and
// its grid-area matches the export grid.
const FE_ARCHIVE_HEADER_LAYOUT_RESET_SELECTORS = [
  ":scope > .message-header",
  ":scope > .message-header .message-sender",
  ":scope > .message-header .message-sender .name-stacked",
  ":scope > .message-header .message-sender .title",
  ":scope > .message-header .message-sender .subtitle",
  ":scope > .message-header .message-metadata",
  ":scope > .message-header .message-flavor",
  ":scope > .message-header .flavor-text",
  ":scope > .message-header .whisper-to",
  ':scope > .message-header [class*="chat-portrait-whisper-to-"]',
];

// The message ROOT's OUTER spacing is owned by the export — never mirrored.
//
// `fe-chat-archive.css` (~1042) and `feNormalizeArchiveMessageLayout`
// (fe-archive-output.js) both lock every archive message to
// `width: 100% !important`. On a width-locked box a mirrored horizontal margin
// cannot shrink anything — it can only push the box past the container's right
// edge. In print that lands outside the `@page` area, so the right border is
// clipped off the sheet entirely.
//
// The live value is core's `.chat-message { margin: var(--chat-message-spacing) }`
// (foundry2.css:9943) = 4px on all four sides. That variable is defined ONLY on
// `.chat-sidebar` (foundry2.css:9797), so in the archive document it is
// undefined → the declaration is invalid at computed-value time → margin 0.
// Fresh-built messages are therefore correct by construction; only the
// live-CLONED tail carried the sidebar's 4px inline with `!important`.
//
// Measured on a real 654-page export (A4, `@page { margin: 10mm }` → printable
// x ∈ [28.50, 567.00]pt): fresh-built boxes sat at exactly [28.50, 567.00]pt,
// live-cloned boxes at [31.49, 569.98]pt — identical 538.5pt width, shifted
// +2.99pt = +4 CSS px, with the right 4px (the border) off the page. The
// transition landed mid-page 649, exactly where the sidebar's live DOM window
// (prune) begins. Vertical margins happen to match because the merge spacing
// rules (fe-chat-enhance.css:199/261) include `#fe-chat-export-log` in their
// selectors and so apply natively in the archive too — which is also why
// stripping the vertical inline values here changes nothing visually.
//
// Do NOT "fix" this by adding `margin: 0 !important` to the archive stylesheet:
// an inline `!important` outranks every stylesheet rule regardless of layer.
const FE_ARCHIVE_ROOT_SPACING_RESET_PROPS = [
  "margin", "margin-top", "margin-right", "margin-bottom", "margin-left",
  "margin-block", "margin-block-start", "margin-block-end",
  "margin-inline", "margin-inline-start", "margin-inline-end",
];

// The root itself plus the two width-locked shells below it. The header region
// is already covered by feStripHeaderLayoutInlineStyles.
const FE_ARCHIVE_ROOT_SPACING_RESET_SELECTORS = [
  ":scope",
  ":scope > .message-content",
];

function feStripOwnedSpacingInlineStyles(cloneEl) {
  try {
    if (!feIsElement(cloneEl)) return;
    for (const selector of FE_ARCHIVE_ROOT_SPACING_RESET_SELECTORS) {
      for (const el of feSelectScoped(cloneEl, selector)) {
        const style = el?.style;
        if (!style?.removeProperty) continue;
        for (const prop of FE_ARCHIVE_ROOT_SPACING_RESET_PROPS) {
          try { style.removeProperty(prop); } catch { /* no-op */ }
        }
      }
    }
  } catch {
    /* no-op */
  }
}

function feStripHeaderLayoutInlineStyles(cloneEl) {
  try {
    if (!feIsElement(cloneEl)) return;
    for (const selector of FE_ARCHIVE_HEADER_LAYOUT_RESET_SELECTORS) {
      for (const el of feSelectScoped(cloneEl, selector)) {
        const style = el?.style;
        if (!style?.removeProperty) continue;
        for (const prop of FE_ARCHIVE_HEADER_LAYOUT_RESET_PROPS) {
          try { style.removeProperty(prop); } catch { /* no-op */ }
        }
      }
    }
  } catch {
    /* no-op */
  }
}
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

function feCopyComputedCustomProperties(srcEl, dstEl) {
  try {
    const view = srcEl?.ownerDocument?.defaultView ?? window;
    const cs = view.getComputedStyle?.(srcEl);
    if (!cs) return;
    let copied = 0;
    for (let i = 0; i < cs.length && copied < FE_ARCHIVE_CUSTOM_PROPERTY_MAX; i += 1) {
      const prop = String(cs.item?.(i) ?? cs[i] ?? "");
      if (!prop.startsWith("--")) continue;
      if (!FE_ARCHIVE_CUSTOM_PROPERTY_PREFIXES.some((prefix) => prop.startsWith(prefix))) continue;
      // NEVER mirror a font-ROUTING custom property (any `--…font…` var:
      // --fe-font-primary/secondary/geurimilgi, --fe-chat-font-family,
      // --font-primary/sans/serif/h1…, --dnd5e-font-*, --fe-ui-font-family, …).
      // The archive's font is owned entirely by the embedded-font <style>
      // (feBuildEmbeddedCookieRunFontCSS), which routes these vars to the data-URL
      // "FE … Embedded" faces at :root. The LIVE sidebar computes them to the
      // NON-embedded faces ("FE Geurimilgi", "FE CookieRun" — no "…Embedded"),
      // and copying that inline with !important shadows the embedded routing for
      // the whole message subtree. In a standalone file:// HTML the live faces
      // 404, so text falls to the next candidate — for --fe-font-secondary that
      // is "FE CookieRun", so the mixed "쿠키런 + 그림일기" preset silently painted
      // its Geurimilgi text (card descriptions / metadata) in CookieRun. All
      // `font`-named vars are global routing/weight values (never per-message
      // dynamic), so excluding them loses nothing. This is the same
      // export-owns-the-font rule as the FE_ARCHIVE_TEXT_STYLE_PROPS `font-family`
      // drop and feStripHeaderLayoutInlineStyles.
      if (prop.includes("font")) continue;
      const value = cs.getPropertyValue(prop);
      if (!value) continue;
      dstEl.style.setProperty(prop, value.trim(), "important");
      copied += 1;
    }
  } catch {
    /* no-op */
  }
}

function feMirrorLiveElementState(srcEl, dstEl) {
  try {
    const tag = String(srcEl?.tagName ?? "").toUpperCase();
    if (!tag || tag !== String(dstEl?.tagName ?? "").toUpperCase()) return;

    if (tag === "INPUT") {
      dstEl.checked = !!srcEl.checked;
      if (srcEl.checked) dstEl.setAttribute("checked", "");
      else dstEl.removeAttribute("checked");
      if (!["file", "password", "hidden"].includes(String(srcEl.type || "").toLowerCase())) {
        dstEl.value = srcEl.value;
        dstEl.setAttribute("value", srcEl.value);
      }
    } else if (tag === "TEXTAREA") {
      dstEl.value = srcEl.value;
      dstEl.textContent = srcEl.value;
    } else if (tag === "SELECT") {
      dstEl.value = srcEl.value;
      const srcOptions = Array.from(srcEl.options ?? []);
      const dstOptions = Array.from(dstEl.options ?? []);
      for (let i = 0; i < Math.min(srcOptions.length, dstOptions.length); i += 1) {
        dstOptions[i].selected = !!srcOptions[i].selected;
        if (srcOptions[i].selected) dstOptions[i].setAttribute("selected", "");
        else dstOptions[i].removeAttribute("selected");
      }
    } else if (tag === "DETAILS" || tag === "DIALOG") {
      dstEl.open = !!srcEl.open;
      if (srcEl.open) dstEl.setAttribute("open", "");
      else dstEl.removeAttribute("open");
    } else if (tag === "PROGRESS" || tag === "METER") {
      dstEl.value = srcEl.value;
      dstEl.setAttribute("value", String(srcEl.value));
    }
  } catch {
    /* no-op */
  }
}

function feCopyComputedStyleSubset(srcEl, dstEl, propNames = []) {
  try {
    if (!srcEl || !dstEl) return;
    const view = srcEl?.ownerDocument?.defaultView ?? window;
    const cs = view.getComputedStyle?.(srcEl);
    if (!cs) return;
    for (const prop of propNames) {
      const value = cs.getPropertyValue?.(prop);
      // The mirrored value is the final live computed result. Marking it
      // important prevents system/module !important rules in the archive
      // document from undoing that result. Later archive normalization uses
      // inline !important too and can still intentionally replace it.
      if (value) dstEl.style.setProperty(prop, value.trim(), "important");
    }
    feMirrorLiveElementState(srcEl, dstEl);
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
      // Imported live clones should be structurally identical. If a system hook
      // changed one tree, positional pairing beyond this point would put styles
      // on the wrong elements, so stop rather than corrupt the remainder.
      if (liveNode.tagName !== cloneNode.tagName) break;
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
    // Harvested history entries are detached clones. getComputedStyle() on a
    // detached source returns incomplete/default geometry and must never be
    // allowed to overwrite the styles captured while that message was live.
    if (!liveEl.isConnected) return;
    const hasCard = !!liveEl.querySelector?.(".chat-card, .midi-chat-card, .dnd5e.chat-card, .dnd5e2.chat-card");
    const lean = !!renderProfile?.lean;
    const mirrorTree = renderProfile?.mirrorTree !== false;
    const mirrorCardTree = renderProfile?.mirrorCardTree !== false;

    // Per-message/user color variables are often inherited from the live
    // sidebar rather than declared on descendants. Preserve the bounded set on
    // the archive message root before copying resolved element properties.
    feCopyComputedCustomProperties(liveEl, cloneEl);

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
    sync(FE_ARCHIVE_COMPONENT_SELECTOR, FE_ARCHIVE_COMPONENT_STYLE_PROPS);
    // cloneNode/importNode copy attributes, not every live form/disclosure
    // property. Preserve the state users actually saw even in lean profiles.
    sync(":scope :is(input, textarea, select, details, dialog, progress, meter)", []);

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

    // MUST run last: undo the header-region layout geometry copied from the narrow
    // live sidebar so the export stylesheet owns the header layout (fixes the
    // last-page / live-cloned timestamp being trapped in a sidebar-width slice).
    feStripHeaderLayoutInlineStyles(cloneEl);
    // Same rule for the message ROOT's outer spacing: the sidebar's 4px margin on
    // a width:100%-locked archive box overflows right and the PDF clips the right
    // border. See FE_ARCHIVE_ROOT_SPACING_RESET_PROPS.
    feStripOwnedSpacingInlineStyles(cloneEl);
  } catch {
    /* no-op */
  }
}
