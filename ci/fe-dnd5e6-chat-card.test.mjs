import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import {
  feRestoreMidiDamageTypeIcons,
  feRestoreMidiItemDescription,
} from "../scripts/fe-midi-damage-types.js";

/**
 * dnd5e 6.0 rewrote the chat-card markup. The legacy (≤5.x) and the new
 * `.message.compact` structures COEXIST — old messages already stored in a world
 * keep rendering the legacy DOM — so every rule that styled a card part must now
 * carry BOTH selectors. This suite is a tripwire: it fails if a future cleanup
 * drops either side.
 *
 * Structural mapping (see the "dnd5e 6.0" section of styles/fe-dnd5e-compat.css):
 *   .card-header.description       → .card-description          (description moved out)
 *   header.summary                 → .card-header               (wrapper removed)
 *   .details…​.card-content          → .collapsible-content       (wrapper renamed)
 *   .card-buttons > button         → .icon-row button.icon
 *   ul.card-footer.pills           → .icon-row ul.pills
 */

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

// The archive is one FEATURE split across several files (entry + fe-archive-*.js +
// the popup shell template). These tripwires pin archive BEHAVIOUR, not which file
// currently hosts it, so they read the whole family — otherwise every refactor that
// moves a function between archive modules breaks them for no real reason.
const readArchiveFamily = () => {
  const dir = new URL("../scripts/", import.meta.url);
  const parts = readdirSync(dir)
    .filter((f) => f === "fe-chat-archive.js" || /^fe-archive-.*\.js$/.test(f))
    .sort()
    .map((f) => readFileSync(new URL(f, dir), "utf8"));
  const shell = new URL("../templates/fe-archive-shell.hbs", import.meta.url);
  if (existsSync(shell)) parts.push(readFileSync(shell, "utf8"));
  return parts.join("\n");
};

const DND5E_COMPAT = read("styles/fe-dnd5e-compat.css");
const BG_STRIPPER = read("styles/chat-bg-stripper.css");
const V13_COMPAT = read("styles/fe-chat-v13-compat.css");
const UI_FONT = read("styles/ui-font.css");
const DX3RD_COMPAT = read("styles/fe-dx3rd-compat.css");
const PORTRAIT_JS = read("scripts/fe-chat-portrait.js");
const CHAT_ENHANCE_JS = read("scripts/fe-chat-enhance.js");

/** Every sheet that styles the description region must reach both structures. */
const DESCRIPTION_SHEETS = [
  ["styles/chat-bg-stripper.css", BG_STRIPPER],
  ["styles/fe-chat-v13-compat.css", V13_COMPAT],
];

test("description-region rules reach the legacy AND the dnd5e 6.0 structure", () => {
  for (const [name, css] of DESCRIPTION_SHEETS) {
    assert.match(css, /\.card-header\.description/, `${name}: legacy description selector lost`);
    assert.match(css, /\.card-description/, `${name}: dnd5e 6.0 .card-description selector missing`);
    assert.match(
      css,
      /\.collapsible-content/,
      `${name}: .collapsible-content is the only wrapper the 6.0 description has`,
    );
  }
});

test("the retro card-part background reset covers the 6.0 card parts", () => {
  for (const [name, css] of [
    ["styles/fe-dnd5e-compat.css", DND5E_COMPAT],
    ["styles/fe-dx3rd-compat.css", DX3RD_COMPAT],
  ]) {
    for (const part of [".card-description", ".card-flavor", ".icon-row", ".card-summary"]) {
      assert.ok(css.includes(part), `${name}: ${part} missing from the card-part background reset`);
    }
    // The legacy parts must survive alongside them.
    assert.ok(css.includes(".card-content"), `${name}: legacy .card-content dropped`);
  }
});

test("ui-font keeps both the legacy header.summary path and the 6.0 .card-header path", () => {
  assert.match(UI_FONT, /\.card-header\.description > \.summary/);
  assert.match(UI_FONT, /\.card-description > \.collapsible-content/);
  // dnd5e 6.0 emits a bare `.chat-card` — .item-card / .activation-card are gone.
  assert.match(UI_FONT, /\.chat-card\.item-card, \.chat-card\.activation-card, \.chat-card/);
});

test("fe-dnd5e-compat carries a dnd5e 6.0 section keyed on .message.compact", () => {
  assert.match(DND5E_COMPAT, /dnd5e 6\.0/);
  assert.match(DND5E_COMPAT, /\.compact/);
  // The two card surface variables 6.0 introduced.
  assert.match(DND5E_COMPAT, /--dnd5e-chat-background:/);
  assert.match(DND5E_COMPAT, /--dnd5e-chat-description-background:/);
});

test("texture stripping neutralizes the border dnd5e 6.0 paints on the message itself", () => {
  const idx = BG_STRIPPER.indexOf("2e) dnd5e 6.0");
  assert.notEqual(idx, -1, "the .message.compact strip section is missing");
  const section = BG_STRIPPER.slice(idx);
  assert.match(section, /body\.fe-strip-chat-textures/);
  assert.match(section, /\.compact/);
  assert.match(section, /border-color:\s*transparent !important/);
});

test("the chat-card icon resizer sizes the 6.0 .item-icon wrapper, not just the img", () => {
  assert.match(PORTRAIT_JS, /\.closest\?\.\("\.item-icon, \.activity-icon"\)/);
  assert.match(PORTRAIT_JS, /setProperty\("--size"/);
  assert.match(PORTRAIT_JS, /setProperty\("--gold-icon-size"/);
});

test("midi-qol still ships the LEGACY dnd5e card markup, so its selectors stay untouched", () => {
  // midi-qol 14 renders `.dnd5e2 chat-card midi-chat-card activation-card` with
  // header.summary + .details.collapsible-content.card-content. If this ever
  // changes, the legacy selectors above stop being merely "old message" support
  // and this suite's premise needs revisiting.
  for (const css of [BG_STRIPPER, V13_COMPAT, DND5E_COMPAT]) {
    assert.ok(css.includes(".midi-chat-card"), "midi card selector dropped");
  }
});

/* ------------------------------------------------------------------
 * tidy5e-sheet 14 — Classic 삭제, Quadrone 단독
 * ------------------------------------------------------------------ */

const TIDY_OVERRIDE = read("styles/fe-tidy-override.css");
const TIDY_RETRO = read("styles/fe-tidy-retro.css");

test("tidy Classic rules are KEPT for tidy 13.x worlds", () => {
  // tidy5e-sheet 14 dropped the Classic layout entirely (its main.css contains no
  // "classic" at all). These rules simply stop matching there — they are backward
  // compatibility for a world still on 13.x and for the maintained tidy-classic
  // fork, not dead code to delete. They now live in styles/fe-tidy-retro.css.
  assert.match(TIDY_RETRO, /\.tidy5e-sheet\.application\.classic/);
});

test("tidy Quadrone retro rules reach item/group/encounter/tooltip sheets too", () => {
  // Only `.actor` was covered before; character/npc/vehicle ride along on `.actor`,
  // but item/group/encounter/tooltip did not. `:is()` keeps the specificity at one
  // class, identical to the old `.actor`, so no cascade fight changes.
  assert.match(
    TIDY_RETRO,
    /\.tidy5e-sheet\.application\.quadrone:is\(\.actor, \.item, \.group, \.encounter, \.tooltip\)/,
  );
  assert.doesNotMatch(TIDY_RETRO, /\.tidy5e-sheet\.application\.quadrone\.actor\b/);
});

test("tidy font variable overrides cover both the 13.x and the 14 names", () => {
  for (const legacy of ["--t5e-font-family-body", "--t5e-title-font-family"]) {
    assert.ok(TIDY_OVERRIDE.includes(legacy), `${legacy} (tidy 13.x) dropped`);
  }
  for (const modern of [
    "--t5e-font-family-default",
    "--t5e-font-family-forms",
    "--t5e-font-family-longform",
    "--t5e-font-modesto-condensed",
    "--t5e-font-roboto-condensed",
  ]) {
    assert.ok(TIDY_OVERRIDE.includes(modern), `${modern} (tidy 14) missing`);
  }
});

test("the centralized --t5e-* remap is present and every token declaration wins", () => {
  // The remap sits on plain `.tidy5e-sheet` — NOT `.application` — because the
  // floating Classic context menu is not an .application. All seven Classic
  // sheet classes (character/npc/vehicle/item/container/group/encounter) and
  // the detached info card ride on that one scope.
  const block = TIDY_RETRO.match(/body\.fe-retro-theme \.tidy5e-sheet \{([\s\S]*?)\n\}/);
  assert.ok(block, "the centralized .tidy5e-sheet variable remap is gone");

  // layouts(7) loses to tidy's modules(9) for normal declarations regardless of
  // specificity — `!important` reverses layer precedence, so EVERY token remap
  // in the file must carry it (main --t5e-* block, --dod-* contamination tab,
  // --statblock-* NPC palette, and element-level re-points alike).
  const missing = [
    ...stripComments(TIDY_RETRO).matchAll(
      /(--(?:t5e|dod|statblock)-[\w-]+\s*:[^;{}]*;)/g,
    ),
  ].filter((m) => !m[1].includes("!important"));
  assert.deepEqual(
    missing.map((m) => m[1]),
    [],
    "a token remap declaration lost its !important",
  );
});

/** Selector minus dead arms: any argument or compound carrying `:not(*)` can
 * never match (`*` adds zero specificity and matches everything). Paren groups
 * are folded innermost-first so `:is(.dnd5e2, .tidy5e-sheet:not(*))` keeps its
 * live arm while `:is(.tidy5e-a:not(*), .tidy5e-b:not(*))` dies entirely.
 * Real `:not(...)` arguments are exclusion filters, not positive matches, so
 * their contents are erased before the tidy check (a `.tidy5e` inside
 * `:not(...)` keeps tidy DOM OUT of the rule — the opposite of a leak). */
const stripDeadSelectorArms = (sel) => {
  const DEAD = ""; // sentinel for the `:not(*)` marker
  // Fold one paren group: recursively fold each top-level argument first, drop
  // arguments that are fully dead, then emit the folded group. `:not()` args
  // are exclusions — their content is erased (`:not(#)`), and a `:not()` whose
  // args all died excludes nothing-matcher → everything → dead itself.
  const fold = (text) => {
    let out = "", i = 0;
    while (i < text.length) {
      const open = text.indexOf("(", i);
      if (open === -1) { out += text.slice(i); break; }
      let depth = 0, close = -1;
      for (let j = open; j < text.length; j++) {
        if (text[j] === "(") depth++;
        else if (text[j] === ")") { depth--; if (depth === 0) { close = j; break; } }
      }
      if (close === -1) { out += text.slice(i); break; }
      const fn = text.slice(i, open).match(/(:[a-z-]+)$/)?.[1] || "";
      const inner = text.slice(open + 1, close);
      // split top-level args at depth-0 commas, fold each recursively
      const args = [];
      let d = 0, start = 0;
      for (let j = 0; j <= inner.length; j++) {
        const c = inner[j];
        if (c === "(") d++;
        else if (c === ")") d--;
        if (j === inner.length || (d === 0 && c === ",")) {
          args.push(inner.slice(start, j)); start = j + 1;
        }
      }
      const live = args.map((a) => fold(a.trim())).filter((a) => a && !a.includes(DEAD));
      const folded =
        fn === ":not" ? (live.length ? ":not(#)" : DEAD)
        : live.length ? `${fn}(${live.join(",")})`
        : DEAD;
      out += text.slice(i, open - fn.length) + folded;
      i = close + 1;
    }
    return out;
  };
  let s = fold(sel.replace(/:not\(\*\)/g, DEAD));
  // Drop top-level compounds that still carry the dead marker. A compound may
  // contain balanced parens (e.g. `form.tidy5e-sheet:is(.actor):not(*)`), so
  // split only on separators at paren depth 0.
  let out = "", i = 0;
  while (i < s.length) {
    let j = i, depth = 0;
    while (j < s.length) {
      const c = s[j];
      if (depth === 0 && /[\s,>+~]/.test(c)) break;
      if (c === "(") depth++;
      else if (c === ")") depth--;
      j++;
    }
    if (!s.slice(i, j).includes(DEAD)) out += s.slice(i, j);
    if (j < s.length) out += s[j];
    i = j + 1;
  }
  return out;
};

test("fe-dnd5e-compat.css carries no live Tidy selectors", () => {
  // Every rule matching Tidy sheet DOM lives in fe-tidy-retro.css. A `.tidy5e`
  // class inside dead `:not(*)` padding is kept to preserve a split rule's
  // original specificity — those stay; a LIVE arm must not.
  const offenders = [];
  for (const m of stripComments(DND5E_COMPAT).matchAll(/([^{}]+)\{/g)) {
    if (/\.tidy5e/.test(stripDeadSelectorArms(m[1]))) {
      offenders.push(m[1].trim().slice(0, 120));
    }
  }
  assert.deepEqual(offenders, [], "Tidy rules leaked back into fe-dnd5e-compat.css");
});

test("fe-tidy-retro.css sits in the layouts layer directly after fe-dnd5e-compat.css", () => {
  // Order keeps the split rules in their original sequence; the layouts layer is
  // what makes our !important the winning weight against tidy's modules-layer CSS.
  const manifest = JSON.parse(read("module.json"));
  const i = manifest.styles.findIndex(
    (e) => typeof e === "object" && e.src === "styles/fe-dnd5e-compat.css",
  );
  assert.ok(i >= 0, "fe-dnd5e-compat.css is not registered as an object entry");
  const next = manifest.styles[i + 1];
  assert.equal(next?.src, "styles/fe-tidy-retro.css");
  assert.equal(next?.layer, "layouts");
});

test("the fork's last literal colours are routed through --t5e-* tokens", () => {
  // tidy5e-classic-global.css is edited as source (the LESS sources are
  // unrecoverable). Each of these used to be a hardcoded paint the variable
  // remap could not reach; now a dedicated token carries the same default,
  // and fe-tidy-retro.css re-points it.
  const CLASSIC_GLOBAL = read("tidy-classic/styles/tidy5e-classic-global.css");
  for (const v of [
    "--t5e-secret-background",
    "--t5e-secret-revealed-background",
    "--t5e-facility-card-background",
    "--t5e-facility-card-blend-mode",
    "--t5e-meter-background",
    "--t5e-filter-include-color",
    "--t5e-filter-exclude-color",
    "--t5e-unidentified-glyph-color",
    "--t5e-item-input-disabled-background",
    "--t5e-button-borderless-hover-background",
  ]) {
    assert.ok(CLASSIC_GLOBAL.includes(`${v}:`), `${v} not declared in the fork baseline`);
    assert.ok(TIDY_RETRO.includes(`${v}:`), `${v} not remapped for retro`);
  }
  // …and the consumption sites must actually read the tokens, not a literal.
  for (const pattern of [
    /section\.secret\{[^}]*background:var\(--t5e-secret-background\)/,
    /section\.secret\.revealed\{background:var\(--t5e-secret-revealed-background\)\}/,
    /facility:not\(\.empty\)\{[^}]*background:var\(--t5e-facility-card-background\)/,
    /facility-progress-meter\{[^}]*background-color:var\(--t5e-meter-background\)/,
    /filter-button-toggle\.include[^{]*\{[^}]*color:var\(--t5e-filter-include-color\)/,
    /filter-button-toggle\.exclude[^{]*\{[^}]*color:var\(--t5e-filter-exclude-color\)/,
    /unidentified-glyph i\{color:var\(--t5e-unidentified-glyph-color\)/,
    /input:disabled[^{]*\{[^}]*background:var\(--t5e-item-input-disabled-background\)/,
    /button-borderless:hover\{background:var\(--t5e-button-borderless-hover-background\)\}/,
  ]) {
    assert.match(CLASSIC_GLOBAL, pattern, `fork rule no longer reads its token: ${pattern}`);
  }
});

test("GM speak-as-self leaves midi-qol cards' speaker alone", () => {
  // midi's colorChatMessageHandler colors the message border from the SPEAKER
  // (`if (actor) user = playerForActor(actor)`), and playerForActor falls back to
  // `preferredActiveGM()`. Nulling the speaker made midi fall through to the
  // message author instead — the GM — so every midi card the GM triggered for a
  // player-owned actor was drawn in the GM's color.
  assert.match(CHAT_ENHANCE_JS, /const isMidiCard = .*"midi-qol"/);
  assert.match(CHAT_ENHANCE_JS, /if \(!isMidiCard && !\(msgRolls\.length > 0 && speaker\?\.actor\)\)/);
});

/** CSS comments, removed so an assertion about DECLARATIONS is not tripped by prose. */
const stripComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");

test("our painted chat base re-points dnd5e 6.0's themed text aliases", () => {
  // dnd5e 6.0 takes chat ink from `--color-text-primary`/`--color-text-secondary`, which
  // its `@scope (.theme-dark)` block resolves to near-white. That pairs with dnd5e's own
  // chat background, not with the opaque base this module paints, so a white base in a
  // dark-theme world rendered the speaker name and the chat context menu white-on-white.
  const STYLE_JS = read("scripts/fe-style.js");
  assert.match(STYLE_JS, /classList\.toggle\("fe-chat-bg-light", baseIsLight === true\)/);
  assert.match(STYLE_JS, /classList\.toggle\("fe-chat-bg-dark", baseIsLight === false\)/);

  for (const cls of ["fe-chat-bg-light", "fe-chat-bg-dark"]) {
    const block = BG_STRIPPER.match(
      // Anchored at line start so the explanatory comment above the rule, which names
      // both classes, is not what gets matched.
      new RegExp(`^body\.${cls}[^{]*\{[^}]*\}`, "ms"),
    );
    assert.ok(block, `${cls} is not consumed by chat-bg-stripper.css`);
    for (const v of ["--color-text-primary", "--color-text-secondary"]) {
      assert.ok(block[0].includes(v), `${cls} must re-point ${v}`);
    }
    // `modules` is a LATER layer than `system`, so a normal declaration already wins.
    // Marking it `!important` reverses the layer order and hands the fight back to dnd5e.
    // Comments are stripped first — an explanatory comment may name the keyword.
    assert.doesNotMatch(stripComments(block[0]), /!important/, `${cls} must not use !important`);
  }

  // The fixed popout menu is styled by `#context-menu.dnd5e2 .context-item i`, which our
  // inherited colour cannot reach — it needs the variables in its own scope.
  assert.match(BG_STRIPPER, /body\.fe-chat-bg-light #context-menu\.fe-chat-context-menu/);
});

test("our painted chat base re-points dnd5e 6.0's themed CARD-INTERIOR variables", () => {
  // §1i only covers the `--color-text-*` aliases, which fixes the speaker header and the
  // message body. dnd5e 6.0 themes the card's INSIDE through a second family of variables
  // resolved in the same `@scope (.theme-dark|.theme-light)` blocks, so a white base in a
  // dark-theme world left a blue-gray description panel, blue-gray separators and — the
  // one with no background of its own to hide behind — every inline-roll d20 inverted to
  // white-on-white by `--dnd5e-roll-icon-filter`.
  const CARD_INTERIOR_VARS = [
    "--activity-icon-color",
    "--dnd5e-heading-3-color",
    "--dnd5e-chat-color-die",
    "--dnd5e-chat-damage-filter",
    // dnd5e.css:1871 paints the inline-roll d20 from a BLACK svg and flips it per theme.
    // It lives in a global `:is(.dnd5e, .dnd5e2, .dnd5e2-journal)` rule, outside the chat
    // regions of dnd5e.css — scanning only those regions misses it.
    "--dnd5e-roll-icon-filter",
    "--dnd5e-background-card",
    "--dnd5e-background-parchment",
    "--dnd5e-chat-description-background",
    // Ours, and the one this list originally missed: the description box is painted by
    // our own `background-color: var(--fe-chat-desc-bg) !important` rule, which overrides
    // the dnd5e variable directly above it. Left in :root as a fixed #f0f0f0 it rendered
    // light-grey-on-light-ink (invisible) the moment the base went dark.
    "--fe-chat-desc-bg",
    "--dnd5e-chat-button-background",
    "--dnd5e-border-gold",
    "--dnd5e-chat-breakdown-border",
    "--pill-border",
  ];

  // NOTE: `[^}]*` means a `}` written inside a COMMENT in the block truncates the match
  // and the assertions below fail with a confusing "must re-point X". Keep braces out of
  // the comments in §1j, or teach this to strip comments first.
  const blocksFor = (cls) => [
    ...BG_STRIPPER.matchAll(new RegExp(`^body\\.${cls}[^{]*\\{[^}]*\\}`, "gms")),
  ].map((m) => m[0]);

  for (const cls of ["fe-chat-bg-light", "fe-chat-bg-dark"]) {
    const declared = blocksFor(cls).join("\n");
    assert.ok(declared, `${cls} is not consumed by chat-bg-stripper.css`);
    for (const v of CARD_INTERIOR_VARS) {
      assert.ok(declared.includes(`${v}:`), `${cls} must re-point ${v}`);
    }
    // Same reason as §1i: `modules` is a later layer than `system`, so a normal
    // declaration already wins and `!important` would reverse the layer order.
    assert.doesNotMatch(stripComments(declared), /!important/, `${cls} must not use !important`);
  }

  // The two branches must stay symmetric — a variable repointed for a light base and
  // forgotten for a dark one is exactly the half-converted card this section exists to fix.
  const varsIn = (cls) =>
    new Set(
      [...blocksFor(cls).join("\n").matchAll(/^\s*(--[a-z0-9-]+):/gm)].map((m) => m[1]),
    );
  assert.deepEqual(
    [...varsIn("fe-chat-bg-light")].sort(),
    [...varsIn("fe-chat-bg-dark")].sort(),
    "the light and dark branches must repoint the same variable set",
  );

  // `.roll-breakdown` is a `popover`, so its ink comes from the UA stylesheet's
  // `color: CanvasText` (resolved from `color-scheme`, not from its parent). Repainting
  // the box light without this leaves white-on-parchment.
  for (const cls of ["fe-chat-bg-light", "fe-chat-bg-dark"]) {
    assert.match(
      BG_STRIPPER,
      new RegExp(`body\\.${cls}[^{]*\\.roll-breakdown[^{]*\\{[^}]*color:`, "ms"),
      `${cls} must give the roll-breakdown popover an explicit colour`,
    );
  }
});

test("speakerless system messages get their own light/dark arm in every ink block", () => {
  // `--fe-system-msg-bg` paints `li.fe-system-msg` with a base of its own, so the
  // chat-card lean can be flat wrong for exactly those messages. Measured with a 진회색
  // chat-card base and a white system base: `li.fe-system-msg` painted #ffffff while it
  // still carried `--color-text-primary: #fff` and `--dnd5e-background-card: #252830`
  // from the dark branch — dnd5e's dark card interior on a white card.
  const STYLE_JS = read("scripts/fe-style.js");
  assert.match(STYLE_JS, /classList\.toggle\("fe-sysmsg-bg-light", systemIsLight === true\)/);
  assert.match(STYLE_JS, /classList\.toggle\("fe-sysmsg-bg-dark", systemIsLight === false\)/);
  // Published even when the system base is off (mirroring the chat-card lean), which is
  // what lets the selectors below stay at two arms instead of three.
  assert.match(STYLE_JS, /let systemIsLight = baseIsLight;/);

  for (const tone of ["light", "dark"]) {
    const blocks = [
      ...BG_STRIPPER.matchAll(new RegExp(`^body\.fe-chat-bg-${tone}[^{]*\{[^}]*\}`, "gms")),
    ].map((m) => m[0]);
    assert.ok(blocks.length, `fe-chat-bg-${tone} is not consumed by chat-bg-stripper.css`);
    for (const block of blocks) {
      const selector = block.slice(0, block.indexOf("{"));
      // The context-menu block is body-level by design: our menu inherits the message's
      // colour, and the fixed popout variant is handed that computed value inline by JS.
      if (selector.includes("#context-menu") && !selector.includes(".chat-message")) continue;
      assert.ok(
        selector.includes(":is(.chat-message, .message):not(.fe-system-msg)"),
        `fe-chat-bg-${tone} must exclude system messages:
${selector}`,
      );
      assert.ok(
        selector.includes(`body.fe-sysmsg-bg-${tone}`)
          && selector.includes(":is(.chat-message, .message).fe-system-msg"),
        `fe-chat-bg-${tone} needs a matching fe-sysmsg-bg-${tone} arm:
${selector}`,
      );
    }
  }
});

test("custom conditions spell their movement AE keys for the running dnd5e", () => {
  // dnd5e 6.0 moved system.attributes.movement.<type> to .movement.speeds.<type>.
  // Measured on 6.0.1: both keys still drive the value, because MovementField._shim leaves
  // a SETTER on the old name — but it logs a deprecation and goes away in dnd5e 7.0, after
  // which a condition built on the old key silently stops zeroing the speed. The probe has
  // to read the schema, and it has to read a schema that exists before any init hook:
  // dnd5e fills CONFIG.Actor.dataModels from its OWN init listener, so relying on that
  // alone would make the answer depend on hook order.
  const body = read("scripts/inject-conditions.js");
  assert.match(body, /function feMovementKey\(/);
  assert.match(body, /dnd5e\?\.dataModels\?\.actor\?\.NPCData\?\.schema/);
  assert.match(body, /getField\?\.\("attributes\.movement\.speeds"\)/);

  const offenders = [];
  for (const [i, line] of body.split("\n").entries()) {
    if (/mkOverride\("system\.attributes\.movement\./.test(line)) offenders.push(`${i + 1}`);
  }
  assert.deepEqual(offenders, [], "a hard-coded pre-6.0 movement AE key is back");
});

test("custom damage types register into every table dnd5e still offers", () => {
  // dnd5e 6.0 has only `damageTypes`; dr/di/dv read it through
  // CONFIG.DND5E.traits.<dr|di|dv>.configKey, so ONE registration covers all three —
  // verified live on 6.0.1: all 8 female_* keys appear in each trait's choices.
  // The three legacy tables are kept for older dnd5e and are guarded on both loops.
  const body = read("scripts/inject-damage-type.js");
  assert.match(body, /if \(!table \|\| typeof table !== "object"\) continue;/);
  assert.match(body, /const entry = config\[tableName\]\?\.\[dmgKey\];/);
  assert.match(body, /Only `damageTypes` exists on dnd5e 6\.0/);
});

test("retro keeps chat cards monochrome and unfilled", () => {
  // Three regressions this pins, all found by live measurement (the accent hue was
  // temporarily rotated to green and every surface that stayed grey/parchment was a miss):
  //
  // 1. The description box was the ONE filled surface in an otherwise
  //    "black panel + accent outline" card — measured rgb(56,56,56) = --fe-ac-22.
  // 2. Success / failure carried real hues (a color-mix toward #006c00 / #6e0000, and
  //    #4ade80 / #ff6b6b on the dice pips). Retro carries state on the LIGHTNESS axis.
  // 3. dnd5e's palette CONSTANTS were re-pointed for `.midi-chat-card` only, so a native
  //    dnd5e card still painted --dnd5e-color-gold (#9f9275) icons and white pill lines.
  const RETRO_COMMON = read("styles/fe-retro-common.css");

  // 1 — the chat-scoped description rule carries a FAINT fill + thick dotted
  //     rules (user-directed revision of the earlier transparent+solid look):
  //     --fe-ac-06 is the palette's bottom stop — a hue whisper on black, NOT
  //     the rejected --fe-ac-22 slab (measured rgb(56,56,56)); 3px dotted keeps
  //     dnd5e's own dashed lineage at retro weight; :not(.collapsed) preserves
  //     dnd5e's collapsed border removal; margin-inline:0 undoes the -8px bleed
  //     that pushed the top/bottom rules past the card's side lines.
  const descChat = DND5E_COMPAT.match(
    /:is\(\.chat-message, \.message\)\s+\.card-description:not\(\.collapsed\) \{[^}]*\}/,
  );
  assert.ok(descChat, "the chat-scoped retro description rule is gone");
  assert.match(descChat[0], /background: var\(--fe-ac-06\) !important;/);
  assert.match(descChat[0], /border-block-style: dotted !important;/);
  assert.match(descChat[0], /border-block-width: 3px !important;/);
  assert.match(descChat[0], /margin-inline: 0 !important;/);
  assert.doesNotMatch(descChat[0], /--fe-ac-22/, "the description box is a slab again");

  // …and the treatment must NOT bleed onto the legacy/midi collapsible header
  // block — that element is a foldable title row, not a description body, and
  // the dots+fill showed up there as noise (reported live). It keeps the older
  // transparent surface + thin solid rule.
  const headChat = DND5E_COMPAT.match(
    /:is\(\.chat-message, \.message\)\s+\.card-header\.description\.collapsible:not\(\.collapsed\) \{[^}]*\}/,
  );
  assert.ok(headChat, "the legacy description-header rule is gone");
  assert.match(headChat[0], /background: transparent !important;/);
  assert.match(headChat[0], /border-block-style: solid !important;/);
  assert.doesNotMatch(headChat[0], /dotted/, "the dotted style bled onto the legacy header");

  // 2 — no semantic hue survives in the retro chat palette. Comments are stripped
  // first: the rationale for dropping the old green/red names them, and a raw
  // `includes` over the file would trip on its own explanation. The check is scoped
  // to the four dice-pip blocks — retro DOES keep a red elsewhere (the stage's
  // destructive remove-on-hover), and that one is deliberate.
  const noComments = (css) => css.replace(/\/\*[\s\S]*?\*\//g, "");
  const pipBlocks = noComments(RETRO_COMMON).match(
    /:is\(li\.(?:success|failure|exploded|fumble)[^{]*\{[^}]*\}/g,
  );
  assert.equal(pipBlocks?.length, 4, "a dice-pip state block was renamed or removed");
  for (const block of pipBlocks) {
    for (const hex of ["#4ade80", "#ff6b6b", "#99ffbb", "#ff9999", "#00aa22", "#cc2020"]) {
      assert.ok(!block.includes(hex), `semantic hue ${hex} is back on the dice pips`);
    }
    assert.match(block, /var\(--fe-ac-/, "a dice-pip state stopped reading the accent scale");
  }
  for (const hex of ["#006c00", "#6e0000"]) {
    assert.ok(
      !noComments(DND5E_COMPAT).includes(hex),
      `semantic hue ${hex} is back in the retro chat palette`,
    );
  }
  assert.match(DND5E_COMPAT, /--dnd5e-color-success-background: var\(--fe-ac-22\) !important;/);
  assert.match(DND5E_COMPAT, /--dnd5e-color-failure-background: var\(--fe-ac-06\) !important;/);
  assert.match(DX3RD_COMPAT, /--fe-ac-96:/, "the top lightness stop the monotone scale needs");

  // 3 — the palette constants are re-pointed for EVERY chat card, not just midi's.
  const wide = DND5E_COMPAT.match(
    /:is\(\.chat-message, \.message\) \{[^}]*--dnd5e-color-gold[^}]*\}/,
  );
  assert.ok(wide, "the chat-wide retro palette block is gone");
  assert.doesNotMatch(wide[0], /midi-chat-card/, "the wide block got narrowed back to midi");
  assert.match(wide[0], /--dnd5e-gold-icon-background: transparent !important;/);
  assert.match(wide[0], /--dnd5e-color-blue-gray-3: var\(--fe-ac-33\) !important;/);
});

test("retro carries the monotone sweep past dnd5e's own palette", () => {
  // The `--dnd5e-color-success/-failure` remap only reaches cards that read THOSE
  // names. Measured live (full-document scan for any computed colour whose green
  // channel beat the other two): two survivors sat inside a chat card, and both
  // resolved through a different family —
  //   `.pill.critical`  border → --color-level-success-border (#1b8f23)
  //   `.target.none`    border → --color-level-error-border
  // dnd5e 6.0's `.compact` cards read `--dnd5e-chat-status-*`, which in a dark
  // theme forwards to those same core constants. Remapping them inside the chat
  // scope is what closes the gap; a whole-document remap would be wrong, because
  // notifications/warnings outside chat genuinely need the semantic hue.
  const css = read("styles/fe-dnd5e-compat.css");
  for (const name of [
    "--dnd5e-chat-status-success",
    "--dnd5e-chat-status-failure",
    "--color-level-success",
    "--color-level-success-border",
    "--color-level-error",
    "--color-level-error-border",
  ]) {
    assert.ok(
      css.includes(`${name}: var(--fe-ac-`),
      `${name} is no longer remapped to the monotone palette`,
    );
  }
});

test("retro pixelates chat-card vectors but never the photos", () => {
  // The card's vector art (dnd5e-icon, inline <svg>, *.svg images) is the only
  // smoothly antialiased thing left on a pixel-theme card. `shape-rendering` is an
  // INHERITED SVG property, which is the only way into `dnd5e-icon`'s CLOSED shadow
  // root — it has `:host { display: contents }`, so no box-based effect (filter,
  // transform) can reach it. Portraits/token art must stay smooth, which is why
  // `image-rendering` is never set on the message or card root: it inherits.
  const css = read("styles/fe-dnd5e-compat.css");
  const block = css.match(
    /:is\(dnd5e-icon, svg, \.chat-card svg, img\[src\$="\.svg" i\]\) \{[^}]*\}/,
  );
  assert.ok(block, "the chat-card vector pixelation rule is gone");
  assert.match(block[0], /image-rendering: pixelated !important;/);
  assert.match(block[0], /shape-rendering: crispEdges !important;/);

  const restore = css.match(
    /:is\(img:not\(\[src\$="\.svg" i\]\), img\.fe-chat-portrait, video\) \{[^}]*\}/,
  );
  assert.ok(restore, "the photo opt-out is gone — portraits would go pixelated");
  assert.match(restore[0], /image-rendering: auto !important;/);

  // fe-retro-theme.css already kills font smoothing body-wide, so a per-icon
  // font-smoothing rule here would be a dead declaration. Keep it out.
  assert.doesNotMatch(css, /font-smoothing: none;/);
});

test("retro strips monks-tokenbar's hardcoded save colours", () => {
  // tokenbar.css paints save success #468847 / failure #b94a48 as literals with no
  // variable indirection, exactly like its groove borders — a palette remap cannot
  // reach them. The dnd5e-wide accent sweep hides most of the ink, but it is gated
  // on `.fe-accent-text-override`; with that setting off (and in an export where a
  // player produced it) the green comes back. `a.add-xp` is a filled surface the
  // sweep never touched at all — measured rgb(70,136,71) live.
  const css = read("styles/fe-retro-common.css");
  assert.match(css, /\.dice-result\.success \.total,/);
  assert.match(css, /\.dice-result\.fail \.total,/);
  assert.match(css, /a\.add-xp \{[^}]*background-color: var\(--fe-ac-22\) !important;/);
  // The comment above the block names both literals on purpose, so strip comments
  // before asserting that no DECLARATION reintroduces them.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, "");
  assert.doesNotMatch(bare, /#468847/i);
  assert.doesNotMatch(bare, /#b94a48/i);
});

test("retro strips dnd5e's literal target-pill fills", () => {
  // `ul.unlist.targets.pills > target-pill` is the one place 6.0 paints hit/miss with
  // hardcoded hexes instead of variables (dnd5e.css: #1a6b22 green / #591010 red), so
  // the --color-level-* remap reaches its border and its ::before glyph but not the
  // fill. Measured live before the fix: border rgb(179,179,179) but background
  // rgb(26,107,34). Hit = filled surface, miss = empty one, same idiom as
  // success/failure everywhere else.
  const css = read("styles/fe-dnd5e-compat.css");
  assert.match(
    css,
    /target-pill\.pill\[data-hit\] \{\s*background-color: var\(--fe-ac-22\) !important;/,
  );
  assert.match(
    css,
    /target-pill\.pill\[data-miss\] \{\s*background-color: var\(--fe-ac-06\) !important;/,
  );
  // dnd5e's pill ink is a BLUE white (--dnd5e-color-blue-white, measured
  // rgb(207,210,218)) and its border is dotted; retro allows neither.
  assert.ok(css.includes("--pill-colored-text-color: var(--fe-ac-90) !important;"));
  assert.ok(css.includes("--pill-border-dotted: 1px solid var(--fe-ac-33) !important;"));
});

test("midi-qol's persisted <img> AC icons are pinned to live's 14px", () => {
  // Older midi-qol messages baked reaction/cover AC modifiers as a plain
  // `<img class="midi-qol-ac-icon">` whose data-URL SVG is intrinsically 512px.
  // Live midi only sets `--icon-size: 14px` on the class — a variable <img>
  // ignores (only <dnd5e-icon>'s shadow SVG reads it; the dedicated img rule
  // uses a different class, .midi-qol-ac-icon-img). Without an explicit size
  // the icon floods the whole card in chat AND in the archive export — this is
  // a live-parity fix, so it must NOT be gated on fe-chat-card-icon-sizing.
  const css = read("styles/fe-chat-portrait.css");
  const block = css.match(
    /:is\(#chat-log, \.chat-log, ol\.chat-log, #chat-notifications, #fe-chat-export-log\)[^{]*img\.midi-qol-ac-icon \{[^}]*\}/,
  );
  assert.ok(block, "the img.midi-qol-ac-icon pin is gone");
  assert.match(block[0], /li\.chat-message/);
  assert.match(block[0], /width: 14px !important;/);
  assert.match(block[0], /height: 14px !important;/);
  assert.match(block[0], /object-fit: contain !important;/);
  // The line immediately above the rule must not be the sizing gate — this pin
  // restores live parity and applies even when icon sizing is off.
  const pre = css.slice(0, block.index).trimEnd();
  assert.doesNotMatch(pre, /body\.fe-chat-card-icon-sizing\s*$/);
});

test("midi-qol damage receipts keep their outer archive header hidden", () => {
  const archiveJs = readArchiveFamily();
  const archiveCss = read("styles/fe-chat-archive.css");

  assert.match(
    archiveJs,
    /:scope > \.message-content \.midi-qol-damage-card/,
    "GM damage receipts are no longer classified as headerless",
  );
  assert.match(
    archiveJs,
    /classList\.toggle\("fe-archive-headerless-card", hasDamageCard\)/,
    "the headerless marker is no longer stamped on the message",
  );

  const block = archiveCss.match(
    /#fe-chat-export-container li\.chat-message\.fe-archive-headerless-card > \.message-header,[\s\S]*?\{[^}]*display: none !important;[^}]*\}/,
  );
  assert.ok(block, "the archive damage-receipt header hide is gone");
  assert.match(
    block[0],
    /body\.fe-print-chatlog #fe-chat-export-container li\.chat-message\.fe-archive-headerless-card/,
    "the print path no longer shares the stronger header hide",
  );
  // `li` is load-bearing: the portrait grid is also !important and is inlined
  // later in the same layer, so the old `.chat-message...` selector tied and
  // allowed source order to resurrect the portrait/sender header.
  assert.doesNotMatch(
    block[0],
    /#fe-chat-export-container \.chat-message\.fe-archive-headerless-card/,
  );
});

test("legacy midi damage cards recover type icons from their stored DamageRolls", () => {
  const oldConfig = globalThis.CONFIG;
  const oldGame = globalThis.game;
  globalThis.CONFIG = {
    DND5E: {
      damageTypes: {
        piercing: { icon: "piercing.svg", label: "Piercing" },
        female_thunder: { icon: "thunder.svg", label: "Thunder" },
      },
      healingTypes: {},
    },
  };
  globalThis.game = { i18n: { localize: (key) => `loc:${key}` } };

  const created = [];
  const doc = {
    createElement(tagName) {
      const attributes = {};
      const icon = {
        tagName,
        className: "",
        dataset: {},
        attributes,
        setAttribute(key, value) { attributes[key] = value; },
      };
      created.push(icon);
      return icon;
    },
  };
  const makeRollElement = (className) => {
    const children = [];
    const total = { ownerDocument: doc, appendChild: (child) => children.push(child) };
    return {
      classList: { contains: (name) => className.split(" ").includes(name) },
      querySelector(selector) {
        if (selector === ".midi-damage-type-icon") {
          return children.find((child) => child.className === "midi-damage-type-icon") ?? null;
        }
        if (selector === ".dice-total") return total;
        return null;
      },
      children,
    };
  };
  const base = makeRollElement("dice-roll midi-damage-roll");
  const other = makeRollElement("dice-roll midi-other-damage-roll");
  const root = {
    querySelectorAll: () => [base, other],
    ownerDocument: doc,
  };
  const message = {
    rolls: [
      { options: { type: undefined } }, // attack roll: ignored
      { options: { type: "piercing", types: ["piercing"], "midi-qol": { rollType: "defaultDamage" } } },
      { options: { type: "female_thunder", types: ["female_thunder"], "midi-qol": { rollType: "otherDamage" } } },
    ],
  };

  try {
    assert.equal(feRestoreMidiDamageTypeIcons(message, root), 2);
    assert.equal(base.children[0].attributes.src, "piercing.svg");
    assert.equal(base.children[0].attributes["aria-label"], "loc:Piercing");
    assert.equal(base.children[0].dataset.feRestoredDamageType, "piercing");
    assert.equal(other.children[0].attributes.src, "thunder.svg");
    assert.equal(other.children[0].dataset.feRestoredDamageType, "female_thunder");
    // Idempotence is essential: live re-renders and archive finalization can
    // both encounter an already-modernized card.
    assert.equal(feRestoreMidiDamageTypeIcons(message, root), 0);
    assert.equal(created.length, 2);
  } finally {
    globalThis.CONFIG = oldConfig;
    globalThis.game = oldGame;
  }
});

test("midi damage-type recovery uses a gated next-task retry, not per-message observers", () => {
  const chatEnhance = read("scripts/fe-chat-enhance.js");
  assert.match(
    chatEnhance,
    /if \(restoreDamageTypes \|\| restoreItemDescription\) \{[\s\S]*?setTimeout\(async \(\) => \{/,
    "ChatMessageMidi can still replace the restored roll markup after the core hook returns",
  );
  assert.match(
    chatEnhance,
    /el\.isConnected[\s\S]*?feSnapshotAndRestoreStickyScroll\(\)/,
    "a connected next-task mutation must preserve sticky scroll",
  );
  assert.doesNotMatch(chatEnhance, /new MutationObserver/);
});

test("loaded legacy midi cards receive one cheap ready pass", () => {
  const chatEnhance = read("scripts/fe-chat-enhance.js");
  assert.match(chatEnhance, /function feRefreshLoadedMidiDamageTypes\(/);
  assert.match(chatEnhance, /for \(const log of feGetChatLogsInDocument\(rootDocument\)\)/);
  assert.match(chatEnhance, /feGetMessageFromElementOrCollection\(element\)/);
  assert.match(chatEnhance, /setTimeout\(\(\) => void feRefreshLoadedMidiDamageTypes\(\), 0\)/);
});

test("live midi damage receipts hide their redundant outer header without a JS pass", () => {
  const portraitCss = read("styles/fe-chat-portrait.css");
  assert.match(
    portraitCss,
    /:has\([\s\S]*?\.midi-qol-damage-card[\s\S]*?\)[\s\S]*?> \.message-header \{[\s\S]*?display: none !important;/,
  );
});

test("midi damage-type icons do not push damage totals off center", () => {
  const compatCss = read("styles/fe-dnd5e-compat.css");
  const archiveJs = readArchiveFamily();
  const liveBlock = compatCss.match(
    /\.dice-total\s*>\s*dnd5e-icon\.midi-damage-type-icon\s*\{[^}]*\}/,
  );
  assert.ok(liveBlock, "the live damage-type icon is still participating in total alignment");
  assert.match(liveBlock[0], /position: absolute !important;/);
  assert.match(liveBlock[0], /inset-inline-end: 38px !important;/);
  assert.match(liveBlock[0], /transform: translateY\(-50%\) !important;/);

  // Archive inlining keeps the dnd5e-icon host but changes it to display:contents,
  // so the stronger export rule must restore a positioned host box.
  assert.match(
    archiveJs,
    /#fe-chat-export-log \.dice-total > dnd5e-icon\.midi-damage-type-icon \{[\s\S]*?display: inline-block;[\s\S]*?inset-inline-end: 38px !important;/,
  );
});

test("empty midi damage-tooltip placeholders do not offset side-by-side rolls", () => {
  const compatCss = read("styles/fe-dnd5e-compat.css");
  const block = compatCss.match(
    /\.midi-dice-tooltip:not\(:has\(> \.tooltip-part > \*\)\) \{[^}]*\}/,
  );
  assert.ok(block, "midi's empty 2px damage-only placeholder is visible again");
  assert.match(block[0], /display: none !important;/);
});

test("midi attack and damage cards normalize their direct-child visual order", () => {
  const compatCss = read("styles/fe-dnd5e-compat.css");
  assert.match(
    compatCss,
    /:is\(\.midi-attack-roll, \.midi-damage-roll, \.midi-bonus-damage-roll, \.midi-other-damage-roll\)[\s\S]*?> \.dice-formula \{[\s\S]*?order: 0 !important;/,
  );
  assert.match(
    compatCss,
    /> :is\(\.dice-tooltip-collapser, \.midi-dice-tooltip\) \{[\s\S]*?order: 1 !important;/,
  );
  assert.match(
    compatCss,
    /> \.dice-total \{[\s\S]*?order: 2 !important;/,
  );
});

test("empty dnd5e 6 midi activity descriptions fall back to the parent item", async () => {
  const oldGame = globalThis.game;
  const oldFromUuidSync = globalThis.fromUuidSync;
  const oldFoundry = globalThis.foundry;
  const wrapper = {
    dataset: {},
    textContent: "",
    isConnected: false,
    _html: "",
    querySelector() { return this._html ? {} : null; },
    closest() { return { dataset: {} }; },
    set innerHTML(value) { this._html = value; },
    get innerHTML() { return this._html; },
  };
  const item = {
    type: "weapon",
    actor: { hasPlayerOwner: true },
    isOwner: true,
    system: { description: { value: "<p>Item details</p>" } },
    getRollData: () => ({ actor: true }),
  };
  globalThis.game = {
    user: { isGM: true },
    modules: new Map([["midi-qol", {
      api: {
        configSettings: () => ({
          showItemDetails: "all",
          itemTypeList: ["weapon"],
        }),
      },
    }]]),
  };
  globalThis.fromUuidSync = () => item;
  // v13+ resolves the enricher through the ux namespace; the bare `TextEditor`
  // global is gone in v14, which is what the implementation now calls.
  globalThis.foundry = {
    applications: {
      ux: {
        TextEditor: {
          implementation: {
            enrichHTML: async (source) => `<section>${source}</section>`,
          },
        },
      },
    },
  };
  const root = {
    isConnected: false,
    querySelector: () => wrapper,
  };
  const message = {
    flags: {
      "midi-qol": {
        activityUuid: "Actor.a.Item.i.Activity.x",
      },
    },
  };

  try {
    assert.equal(await feRestoreMidiItemDescription(message, root), 1);
    assert.equal(wrapper.innerHTML, "<section><p>Item details</p></section>");
    assert.equal(wrapper.dataset.feRestoredItemDescription, "1");
    assert.equal(await feRestoreMidiItemDescription(message, root), 0);
  } finally {
    globalThis.game = oldGame;
    globalThis.fromUuidSync = oldFromUuidSync;
    globalThis.foundry = oldFoundry;
  }
});

test("archive damage receipt actions do not depend on Font Awesome embedding", () => {
  const archiveJs = readArchiveFamily();
  const archiveCss = read("styles/fe-chat-archive.css");
  assert.match(archiveJs, /function feNormalizeArchiveMidiDamageButtonIcons\(/);
  assert.match(archiveJs, /\["\.midi-qol-dmg-btn-apply > i", "\\u2713"\]/);
  assert.match(archiveJs, /\["\.midi-qol-dmg-btn-reverse > i", "\\u21BA"\]/);
  assert.match(archiveJs, /feNormalizeArchiveMidiDamageButtonIcons\(node\)/);
  assert.match(
    archiveCss,
    /#fe-chat-export-log \.fe-archive-midi-damage-glyph \{[\s\S]*?font-family: sans-serif !important;/,
  );
});
