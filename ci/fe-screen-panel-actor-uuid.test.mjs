import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const SHEET_JS = readFileSync(new URL("../scripts/fe-screen-panel-sheet.js", import.meta.url), "utf8");
const SHEET_HBS = readFileSync(new URL("../templates/screen-panel-sheet.hbs", import.meta.url), "utf8");
const ATTRS_HBS = readFileSync(new URL("../templates/screen-panel-sheet-attributes.hbs", import.meta.url), "utf8");
const SHEET_CSS = readFileSync(new URL("../styles/fe-screen-panel.css", import.meta.url), "utf8");

test("face and overlay actor links expose pasteable UUID fields while retaining complete ArrayField inputs", () => {
  assert.doesNotMatch(SHEET_HBS, /fe-sp-face-actor-drop/);
  assert.match(ATTRS_HBS, /fe-sp-face-actor-drop[\s\S]*?fe-sp-actor-uuid-input/);
  assert.match(SHEET_HBS, /fe-sp-overlay-link[\s\S]*?fe-sp-actor-uuid-input/);
  assert.match(ATTRS_HBS, /fe-sp-actor-uuid-name[\s\S]*?fe\.activeFace\.linkedActorName/);
  assert.match(SHEET_HBS, /fe-sp-actor-uuid-name[\s\S]*?ov\.linkedActorName/);
  assert.match(ATTRS_HBS, /placeholder="\{\{localize "FESP\.Sheet\.FaceActorDropHintBig"\}\}"/);
  assert.match(SHEET_HBS, /placeholder="\{\{localize "FESP\.Sheet\.OverlayLinkHint"\}\}"/);
  assert.match(SHEET_HBS, /type="hidden" name="system\.faces\.\{\{face\.index\}\}\.linkedActorUuid"/);
  assert.match(SHEET_HBS, /type="hidden" name="system\.faces\.\{\{face\.index\}\}\.linkMode"/);
  assert.match(SHEET_HBS, /type="hidden" name="system\.faces\.\{\{face\.index\}\}\.overlays\.\{\{ov\.index\}\}\.linkedActorUuid"/);
  assert.match(SHEET_JS, /#wireActorUuidFields[\s\S]*?fromUuid\(requested\)[\s\S]*?documentName !== "Actor"/);
});

test("overlay UUID field occupies its own padded row", () => {
  assert.match(SHEET_CSS, /\.fe-sp-overlay-link\s*\{[\s\S]*?grid-column: 2 \/ -1;[\s\S]*?grid-row: 2;/);
  assert.match(SHEET_CSS, /\.fe-sp-overlay-row\s*\{[\s\S]*?padding: 2px 0 10px;/);
  assert.match(SHEET_CSS, /\.fe-sp-overlay-row \+ \.fe-sp-overlay-row[\s\S]*?border-top:/);
});

test("face attribute action labels never wrap inside their buttons", () => {
  assert.match(ATTRS_HBS, /fe-sp-faces-header fe-sp-face-attrs-header/);
  assert.match(SHEET_CSS, /\.fe-sp-face-attrs-header\s*\{[\s\S]*?flex-direction: column;/);
  assert.match(SHEET_CSS, /:is\(\.fe-sp-face-attrs-header, \.fe-sp-custom-attrs-header\) h3\s*\{[\s\S]*?font-size: 20px;/);
  assert.match(SHEET_CSS, /\.fe-sp-face-attr-actions \.fe-sp-btn\s*\{[\s\S]*?white-space: nowrap;/);
});

test("copied face fields stay above the linked Actor source list and custom attributes", () => {
  const heading = ATTRS_HBS.indexOf("fe-sp-face-attrs-header");
  const actorField = ATTRS_HBS.indexOf("fe-sp-face-actor-section");
  const copiedNote = ATTRS_HBS.indexOf("FESP.Sheet.FaceAttrLinkedNote");
  const copiedFields = ATTRS_HBS.indexOf("fe-sp-face-attr-row");
  const sourceList = ATTRS_HBS.indexOf('<ul class="fe-sp-face-attrs">');
  const custom = ATTRS_HBS.indexOf("fe-sp-custom-attrs-header");
  assert.ok(heading >= 0 && actorField > heading);
  assert.ok(copiedNote > actorField && copiedFields > copiedNote);
  assert.ok(sourceList > copiedFields && custom > sourceList);
});

test("both attribute-section headings share the 20px title size", () => {
  assert.match(ATTRS_HBS, /fe-sp-faces-header fe-sp-custom-attrs-header/);
  assert.match(SHEET_CSS, /:is\(\.fe-sp-face-attrs-header, \.fe-sp-custom-attrs-header\) h3/);
});

test("resolved Actor names appear after UUID inputs without taking over the row", () => {
  assert.match(SHEET_CSS, /\.fe-sp-actor-uuid-input\s*\{[\s\S]*?flex: 1 1 auto;/);
  assert.match(SHEET_CSS, /\.fe-sp-actor-uuid-name\s*\{[\s\S]*?max-width: 34%;[\s\S]*?text-overflow: ellipsis;/);
});

test("DX3rd copied attributes use curated actor resources instead of condition schema noise", () => {
  assert.match(SHEET_JS, /feIsDx3rdSystemId\(game\.system\?\.id\)/);
  assert.match(SHEET_JS, /#extractDx3rdAttributes\(actor\)[\s\S]*?pushBar\("hp"[\s\S]*?pushBar\("encroachment"/);
  assert.match(SHEET_JS, /\["body", "sense", "mind", "social"\]/);
  const start = SHEET_JS.indexOf("  #extractDx3rdAttributes(actor) {");
  const end = SHEET_JS.indexOf("#extractCopiedAttributes(actor)", start);
  const body = SHEET_JS.slice(start, end);
  assert.doesNotMatch(body, /attrs\.conditions|push(?:Bar|Scalar)\([^)]*extra-turn/);
});
