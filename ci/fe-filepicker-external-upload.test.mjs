import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const PREVIEW_JS = readFileSync(new URL("../scripts/fe-filepicker-preview.js", import.meta.url), "utf8");

test("FilePicker external image input uses a directory separate from chat uploads", () => {
  assert.match(PREVIEW_JS, /const EXTERNAL_UPLOAD_SETTING = S\.CORE_UI_FILEPICKER_UPLOAD_LOCATION/);
  assert.match(PREVIEW_JS, /const EXTERNAL_UPLOAD_DEFAULT = "uploaded-filepicker-images"/);
  assert.doesNotMatch(PREVIEW_JS, /EXTERNAL_UPLOAD_SETTING = "chatImagesUploadLocation"/);
  assert.match(PREVIEW_JS, /ciUploadImageDirect\(file, destination\.directory, destination\)/);
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

test("uploaded images return to the upload destination and become its selected request", () => {
  assert.match(PREVIEW_JS, /app\.request = path;/);
  assert.match(PREVIEW_JS, /app\.activeSource = destination\.source;/);
  assert.match(PREVIEW_JS, /await app\.browse\(destination\.ensureDirectory \? _uploadedDirectory\(path\) : destination\.directory\);/);
  assert.match(PREVIEW_JS, /input\.value = path;/);
  assert.match(PREVIEW_JS, /row\.classList\.toggle\("picked", matches\)/);
});

function uploadHarness({ current = true, source = "data", target = "worlds/test/My Images", canUpload = true } = {}) {
  const uploads = [], browses = [], errors = [], classes = new Set();
  const app = {
    activeSource: source, canUpload,
    sources: {
      data: { target: source === "data" ? target : "other" },
      s3: { target: source === "s3" ? target : "other", bucket: "test-bucket" },
      public: { target },
    },
    get source() { return this.sources[this.activeSource]; },
    async browse(directory) {
      browses.push({ source: this.activeSource, directory, bucket: this.source.bucket });
    },
  };
  const context = {
    game: { settings: { get: () => current } },
    MODULE_ID: "female_edition", S: { CORE_UI_FILEPICKER_UPLOAD_CURRENT: "current" },
    feLocalize: key => key,
    _uploadDirectory: () => "uploaded-filepicker-images",
    ciCanUploadDirect: () => true,
    async ciUploadImageDirect(file, directory, destination) {
      uploads.push({ file, directory, ...destination });
      // Simulate navigation while an upload is pending.
      app.activeSource = "public";
      app.sources.s3.bucket = "other-bucket";
      return destination.source === "s3"
        ? `https://test-bucket.example.com/${directory}/${file.name}`
        : `${directory}/${file.name}`;
    },
    _previewLocal() {},
    _hookRoot: () => null,
    setTimeout: fn => fn(),
    ui: { notifications: { warn: error => errors.push(error), error: error => errors.push(error), info() {} } },
  };
  const destinationStart = PREVIEW_JS.indexOf("function _uploadDestination(");
  const destinationEnd = PREVIEW_JS.indexOf("function _pickerAcceptsImage(", destinationStart);
  const uploadStart = PREVIEW_JS.indexOf("function _uploadedDirectory(");
  const uploadEnd = PREVIEW_JS.indexOf("function _stopExternalTransfer(", uploadStart);
  const upload = runInNewContext(
    `${PREVIEW_JS.slice(destinationStart, destinationEnd)}
     ${PREVIEW_JS.slice(uploadStart, uploadEnd)}
     _uploadExternalImages;`, context
  );
  const aside = { classList: { add: value => classes.add(value), remove: value => classes.delete(value) } };
  return { app, uploads, browses, errors, classes, run: files => upload(files, aside, app) };
}

test("ON uploads a batch to the exact current folder and selects the last image", async () => {
  const h = uploadHarness();
  await h.run([{ name: "first.png" }, { name: "last.png" }]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.uploads.length, 2);
  assert.ok(h.uploads.every(upload => upload.source === "data"
    && upload.directory === "worlds/test/My Images" && upload.ensureDirectory === false));
  assert.equal(h.app.request, "worlds/test/My Images/last.png");
  assert.equal(h.browses[0].directory, "worlds/test/My Images");
  assert.equal(h.app._feFpExternalUploadBusy, false);
  assert.equal(h.classes.size, 0);
});

test("OFF preserves the fixed data folder even when another source is open", async () => {
  const h = uploadHarness({ current: false, source: "public", canUpload: false });
  await h.run([{ name: "image.png" }]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.uploads[0].source, "data");
  assert.equal(h.uploads[0].directory, "uploaded-filepicker-images");
  assert.equal(h.uploads[0].ensureDirectory, true);
  assert.equal(h.app.activeSource, "data");
  assert.equal(h.browses[0].directory, "uploaded-filepicker-images");
});

test("ON preserves the captured S3 source, bucket and key rather than browsing the returned URL", async () => {
  const h = uploadHarness({ source: "s3", target: "art/My Images" });
  await h.run([{ name: "image.png" }]);
  assert.equal(h.errors.length, 0);
  assert.equal(h.uploads[0].bucket, "test-bucket");
  assert.deepEqual(h.browses, [{ source: "s3", directory: "art/My Images", bucket: "test-bucket" }]);
});

test("ON rejects unwritable folders without silently uploading elsewhere", async () => {
  for (const source of ["data", "public"]) {
    const h = uploadHarness({ source, canUpload: false });
    await h.run([{ name: "image.png" }]);
    assert.equal(h.uploads.length, 0);
    assert.equal(h.browses.length, 0);
    assert.equal(h.errors.length, 1);
    assert.equal(h.errors[0].message, "FE.FilepickerPreview.uploadCurrentUnavailable");
    assert.equal(h.app._feFpExternalUploadBusy, false);
    assert.equal(h.classes.size, 0);
  }
});
