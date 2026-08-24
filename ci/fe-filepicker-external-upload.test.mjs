import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

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
