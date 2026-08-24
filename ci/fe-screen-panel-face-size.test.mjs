import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const DATA_JS = readFileSync(new URL("../scripts/fe-screen-panel-data.js", import.meta.url), "utf8");
const PANEL_JS = readFileSync(new URL("../scripts/fe-screen-panel.js", import.meta.url), "utf8");
const SHEET_JS = readFileSync(new URL("../scripts/fe-screen-panel-sheet.js", import.meta.url), "utf8");
const SHEET_HBS = readFileSync(new URL("../templates/screen-panel-sheet.hbs", import.meta.url), "utf8");

test("screen panel dimensions are stored on every face, not edited at panel level", () => {
  assert.match(DATA_JS, /img: new f\.FilePathField[\s\S]*?width: new f\.NumberField[\s\S]*?height: new f\.NumberField/);
  assert.match(SHEET_HBS, /name="system\.faces\.\{\{face\.index\}\}\.width"/);
  assert.match(SHEET_HBS, /name="system\.faces\.\{\{face\.index\}\}\.height"/);
  assert.doesNotMatch(SHEET_HBS, /name="system\.(?:width|height)"/);
});

test("choosing face art initializes its dimensions from the decoded image", () => {
  assert.match(SHEET_JS, /img\.naturalWidth[\s\S]*?img\.naturalHeight/);
  assert.match(SHEET_JS, /face\.width = natural\.width;[\s\S]*?face\.height = natural\.height;/);
  assert.match(SHEET_JS, /file-picker\.fe-sp-face-image-picker/);
  assert.match(SHEET_JS, /picker\.value \?\? input\?\.value/);
  assert.match(SHEET_JS, /#syncFaceSizeInputs\(faceIndex\)[\s\S]*?system\.faces\.\$\{faceIndex\}\.width[\s\S]*?system\.faces\.\$\{faceIndex\}\.height/);
  assert.match(SHEET_JS, /feSeedFaceSizeFromImage\(face, natural\);[\s\S]*?await this\.#updateFaces\(faces\);[\s\S]*?this\.#syncFaceSizeInputs\(faceIndex\);/);
});

test("canvas placement and face changes enforce the current face's exact size", () => {
  assert.match(PANEL_JS, /function feResolvedPanelFaceSize\(actor, face, natW, natH\)/);
  assert.match(PANEL_JS, /if \(faceW > 0 && faceH > 0\) return \{ w: Math\.round\(faceW\), h: Math\.round\(faceH\) \}/);
  assert.match(PANEL_JS, /const face = fePanelFace\(actor, flag\.currentFace \?\? 0\);[\s\S]*?feResolvedPanelFaceSize\(actor, face, natW, natH\)/);
  assert.match(PANEL_JS, /texture: \{ src: img \|\| "", fit: "fill"/);
  assert.match(PANEL_JS, /flagChange\.currentFace[\s\S]*?enforcePanelTileSize\(obj, \{ concreteOnly: textureChanged \}\);/);
  const updateStart = PANEL_JS.indexOf("function onPanelPlaceableUpdate(doc, changes)");
  const updateEnd = PANEL_JS.indexOf('Hooks.on("updateTile"', updateStart);
  const updateBody = PANEL_JS.slice(updateStart, updateEnd);
  assert.ok(updateBody.indexOf("enforcePanelTileSize(obj, { concreteOnly: textureChanged })")
    < updateBody.indexOf("if (textureChanged) return"));
});

test("explicit face dimensions do not require a loaded texture", () => {
  const start = PANEL_JS.indexOf("function enforcePanelTileSize(tile,");
  const end = PANEL_JS.indexOf("function applyPanelTileVisibility", start);
  const body = PANEL_JS.slice(start, end);
  assert.ok(body.indexOf("const actor = feResolvePanelPlacementActor(doc)") < body.indexOf("const tex = tile.texture"));
  assert.doesNotMatch(body, /if \(!\(natW > 0\) \|\| !\(natH > 0\)\) return/);
});

test("linked artwork changes seed natural face dimensions", () => {
  assert.match(SHEET_HBS, /class="fe-sp-face-link-mode" data-face-index="\{\{face\.index\}\}"/);
  assert.match(SHEET_JS, /#setFaceLinkMode\(faceIndex, linkMode\)[\s\S]*?feSeedFaceSizeFromImage\(face, natural\)/);
  assert.match(SHEET_JS, /#updateFaceLinkedActor\(faceIndex, uuid\)[\s\S]*?feSeedFaceSizeFromImage\(face, natural\)/);
  assert.match(PANEL_JS, /async function feSyncLinkedFaceImages\(panelActor\)[\s\S]*?face\.width = item\.natural\.w;[\s\S]*?face\.height = item\.natural\.h;/);
});

test("blank current-face artwork clears placed and prototype textures", () => {
  assert.match(PANEL_JS, /if \(\(actor\.prototypeToken\?\.texture\?\.src \?\? ""\) !== target\) sync\["prototypeToken\.texture\.src"\] = target/);
  assert.match(PANEL_JS, /if \(isGM && tileSrc !== \(curFace\.img \|\| ""\)\) tile\.document\.update\(\{ "texture\.src": curFace\.img \|\| "" \}\)/);
  assert.doesNotMatch(PANEL_JS, /isGM && curFace\.img && tileSrc !== curFace\.img/);
});

test("legacy shared sizes migrate to per-face dimensions without a visual jump", () => {
  assert.match(PANEL_JS, /async function feMigratePanelFaceSizes\(actor\)/);
  assert.match(PANEL_JS, /feResolvedPanelFaceSize\(actor, face, nat\?\.w, nat\?\.h\)/);
  assert.match(PANEL_JS, /for \(const actor of game\.actors \?\? \[\]\) void feMigratePanelFaceSizes\(actor\)/);
});
