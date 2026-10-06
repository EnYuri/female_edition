import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const PREVIEW_JS = readFileSync(new URL("../scripts/fe-filepicker-preview.js", import.meta.url), "utf8");

test("FilePicker external image input uses a directory separate from chat uploads", () => {
  assert.match(PREVIEW_JS, /const EXTERNAL_UPLOAD_SETTING = S\.CORE_UI_FILEPICKER_UPLOAD_LOCATION/);
  assert.match(PREVIEW_JS, /const EXTERNAL_UPLOAD_DEFAULT = "uploaded-filepicker-images"/);
  assert.doesNotMatch(PREVIEW_JS, /EXTERNAL_UPLOAD_SETTING = "chatImagesUploadLocation"/);
  assert.match(PREVIEW_JS, /ciUploadImageDirect\(file, directory\)/);
  assert.doesNotMatch(PREVIEW_JS, /ciUploadImageViaAuthority/);
});

test("only the active GM canonicalizes the FilePicker world upload path", () => {
  assert.match(PREVIEW_JS, /cleaned !== value && game\.user === game\.users\.activeGM/);
  assert.match(PREVIEW_JS, /game\.settings\.set\(MODULE_ID, S\.CORE_UI_FILEPICKER_UPLOAD_LOCATION, cleaned\)/);
});

test("FilePicker captures image paste and drop without swallowing other transfers", () => {
  assert.match(PREVIEW_JS, /document\.addEventListener\("paste", event => \{/);
  assert.match(PREVIEW_JS, /const activeApp = _activePasteContext;/);
  assert.match(PREVIEW_JS, /addEventListener\("drop", event => \{/);
  assert.match(PREVIEW_JS, /const files = _transferImageFiles\(event\.clipboardData, activeApp\);/);
  assert.match(PREVIEW_JS, /if \(!files\.length && !urls\.length && !_hasImageTransfer/);
  assert.match(PREVIEW_JS, /_stopExternalTransfer\(event\);/);
});

test("external files remain droppable when dragover hides their MIME and File objects", () => {
  const start = PREVIEW_JS.indexOf("function _bindExternalImages(");
  const end = PREVIEW_JS.indexOf("// ─── Preview rendering", start);
  assert.ok(start >= 0 && end > start);
  const handlers = new Map();
  const classes = new Set();
  const aside = { classList: {
    add: name => classes.add(name),
    remove: name => classes.delete(name),
  } };
  const el = { addEventListener: (name, handler) => handlers.set(name, handler) };
  runInNewContext(`${PREVIEW_JS.slice(start, end)}; _bindExternalImages(aside, el, app);`, {
    aside, el, app: {},
    _hasImageTransfer: () => false,
  });

  let prevented = false;
  handlers.get("dragover")({
    dataTransfer: { types: ["Files"], items: [{ kind: "file", type: "" }] },
    preventDefault: () => { prevented = true; },
  });
  assert.equal(prevented, true);
  assert.equal(classes.has("fe-fp-dragover"), true);
});

test("FilePicker recovers clipboard images which are exposed as blobs or HTML URLs", () => {
  assert.match(PREVIEW_JS, /navigator\?\.clipboard\?\.read/);
  assert.match(PREVIEW_JS, /transfer\?\.getData\?\.\("text\/html"\)/);
  assert.match(PREVIEW_JS, /await _readClipboardApiImages\(app\)/);
  assert.match(PREVIEW_JS, /await _downloadImageUrls\(urls, app\)/);
});

test("uploaded images move the picker to data and become its selected request", () => {
  assert.match(PREVIEW_JS, /app\.request = path;/);
  assert.match(PREVIEW_JS, /if \(app\.sources\?\.data\) app\.activeSource = "data";/);
  assert.match(PREVIEW_JS, /await app\.browse\(_uploadedDirectory\(path\)\);/);
  assert.match(PREVIEW_JS, /input\.value = path;/);
  assert.match(PREVIEW_JS, /row\.classList\.toggle\("picked", matches\)/);
});
