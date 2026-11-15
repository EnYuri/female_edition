import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { FE_EXPORT_IMAGE_TOTAL_BYTES, FE_EXPORT_IMAGE_MAX_COUNT } from "../scripts/fe-archive-fetch.js";

// Run the real orchestration with controlled resource/DOM adapters. This lets us
// inject a failure between preparation stages without a running Foundry world.
function sourceFunction(file, name) {
  const source = readFileSync(new URL(`../scripts/${file}`, import.meta.url), "utf8");
  const start = source.search(new RegExp(`^(?:export )?(?:async )?function ${name}\\(`, "m"));
  assert.ok(start >= 0, name);
  return source.slice(start, source.indexOf("\n}", start) + 2).replace(/^export /, "");
}

function snapshotHarness({ embedImages = true, failEmbed = false, failSerialize = false, scoped = false } = {}) {
  const metaEl = { textContent: "42개 메시지 • 범위 10–51" };
  const changes = [];
  const state = new Set();
  const prepare = (name) => {
    state.add(name);
    changes.push(`apply:${name}`);
    return () => { state.delete(name); changes.push(`undo:${name}`); };
  };
  const node = () => ({ textContent: "", setAttribute() {}, remove() {} });
  const head = { outerHTML: "<head></head>", querySelector: () => null,
    querySelectorAll: () => [], appendChild() {}, prepend() {} };
  const root = { querySelector: () => ({}), attributes: [] };
  const doc = {
    body: scoped ? { attributes: [], appendChild() {} } : root,
    head: { cloneNode: () => head }, documentElement: { attributes: [] },
    getElementById: () => metaEl, querySelector: () => null,
    createElement: () => ({ ...node(), click() {} }),
  };
  doc.body.appendChild = () => {};
  let blob;
  let serializeCount = 0;
  const context = {
    Blob, console: { warn() {} }, MODULE_ID: "female_edition",
    S: { EXPORT_EMBED_IMAGES: "images", EXPORT_EMBED_FONTS: "fonts" },
    FE_EXPORT_IMAGE_TOTAL_BYTES, game: { settings: { get: () => true } },
    window: { location: { href: "http://localhost/game" } },
    URL: { createObjectURL: value => { blob = value; return "blob:test"; }, revokeObjectURL() {} },
    setTimeout: fn => fn(),
    feSetting: key => key === "images" && embedImages,
    feLocalize: key => key, feIsElement: value => value === root,
    feEscapeAttr: value => value, feGetFoundryBaseHref: () => "http://localhost/",
    feSanitizeExportFilename: () => "archive",
    feSnapshotAndRestoreStickyScroll: () => prepare("sticky"),
    feInlineSnapshotStylesheets: async (_head, _doc, progress) => progress("styles in progress"),
    feCreateSnapshotAssetStore: () => ({}), feEmbedSnapshotCssAssets: async () => {},
    feEmbedSnapshotInlineStyleAssets: async parts => parts,
    feFreezeMessageBackgroundsForPrint: () => prepare("background"),
    feNormalizeArchiveShellLayout: () => prepare("shell"),
    feNormalizeArchiveMessageLayout: () => prepare("layout"),
    feUpgradePortraitsForExport: async () => prepare("portrait"),
    fePrepareBodyForHTMLSnapshot: () => prepare("sources"),
    feDownscaleImagesForPrint: async (_win, _log, options) => {
      assert.equal(options.maxTotalBytes, 1_000_000_000);
      options.stats.bytesUsed = 123;
      return prepare("downscale");
    },
    feEmbedImagesInNode: async (_root, options) => {
      assert.equal(options.maxTotalBytes, FE_EXPORT_IMAGE_TOTAL_BYTES - 123);
      if (failEmbed) throw new Error("embed failed");
      options.meta("images in progress");
      return prepare("embed");
    },
    feSerializeBodyToParts: () => {
      serializeCount++;
      if (failSerialize && serializeCount === 1) throw new Error("serialize failed");
      if (failEmbed || serializeCount > 1) {
        assert.equal(state.has("portrait"), false, "fallback must start after portrait undo");
        assert.equal(state.has("downscale"), false, "fallback must start after downscale undo");
      }
      return [`<${scoped ? "section" : "body"}>${metaEl.textContent}</${scoped ? "section" : "body"}>`];
    },
  };
  const names = ["feSerializeElementAttributes", "feBuildArchiveHTMLSnapshotBlob", "feDownloadArchiveHTMLUnlocked"];
  const download = runInNewContext(names.map(name => sourceFunction("fe-archive-snapshot.js", name)).join("\n")
    + "\nfeDownloadArchiveHTMLUnlocked", context);
  return { metaEl, state, changes, get blob() { return blob; },
    save: () => download({ document: doc }, "Archive", { bodyRoot: scoped ? root : null }) };
}

for (const options of [{}, { embedImages: false }, { scoped: true }, { failEmbed: true }, { failSerialize: true }]) {
  test(`HTML retains archive range/count and restores preparation: ${JSON.stringify(options)}`, async () => {
    const harness = snapshotHarness(options);
    assert.equal(await harness.save(), true);
    const html = await harness.blob.text();
    assert.ok(html.includes("42개 메시지 • 범위 10–51"));
    assert.doesNotMatch(html, /in progress|PreparingHtml|EmbeddingImages/);
    assert.equal(harness.metaEl.textContent, "42개 메시지 • 범위 10–51");
    assert.equal(harness.state.size, 0);
    if (options.failEmbed || options.failSerialize) {
      const undo = harness.changes.filter(value => value.startsWith("undo:") && value !== "undo:sticky");
      assert.deepEqual(undo.slice(0, options.failEmbed ? 3 : 4),
        options.failEmbed ? ["undo:downscale", "undo:sources", "undo:portrait"]
          : ["undo:embed", "undo:downscale", "undo:sources", "undo:portrait"]);
    }
  });
}

for (const limit of ["bytes", "count"]) {
  test(`image ${limit} limit still permits cached duplicates after a skipped new source`, async () => {
    const image = src => {
      const attrs = new Map([["src", src], ["srcset", `${src} 2x`], ["loading", "lazy"]]);
      return { getAttribute: key => attrs.get(key) ?? null,
        setAttribute: (key, value) => attrs.set(key, value), removeAttribute: key => attrs.delete(key) };
    };
    const images = [image("a.png"), image("b.png"), image("a.png")];
    const fetched = [];
    const embed = runInNewContext(sourceFunction("fe-archive-assets.js", "feEmbedImagesInNode") + "\nfeEmbedImagesInNode", {
      URL, window: { location: { href: "http://localhost/game", origin: "http://localhost" } },
      FE_EXPORT_IMAGE_TOTAL_BYTES, FE_EXPORT_IMAGE_MAX_COUNT: limit === "count" ? 1 : FE_EXPORT_IMAGE_MAX_COUNT,
      FE_EXPORT_EMBED_CONCURRENCY: 1, FE_EXPORT_RESOURCE_FETCH_TIMEOUT: 12000,
      console: { warn() {} }, feLocalize: key => key, feFormat: key => key,
      feFetchWithTimeout: async url => { fetched.push(url); return new Blob(["1234"]); },
      feBlobToDataURL: async () => "data:image/png;base64,MTIzNA==",
      feCompressImageBlobForEmbed: async () => null,
      feNextTick: async () => {}, feDeduplicateInlineDataUrlsInNode: () => () => {},
    });
    const restore = await embed({ querySelectorAll: () => images }, { maxTotalBytes: limit === "bytes" ? 1 : 100 });
    assert.equal(images[0].getAttribute("src"), "data:image/png;base64,MTIzNA==");
    assert.equal(images[1].getAttribute("src"), "b.png");
    assert.equal(images[2].getAttribute("src"), images[0].getAttribute("src"));
    assert.equal(images[2].getAttribute("srcset"), null);
    assert.deepEqual(fetched, ["http://localhost/a.png"]);
    restore();
    assert.deepEqual(images.map(img => img.getAttribute("src")), ["a.png", "b.png", "a.png"]);
    assert.equal(images[2].getAttribute("srcset"), "a.png 2x");
    assert.equal(images[2].getAttribute("loading"), "lazy");
  });
}

test("large HTML exports share a 1 GB binary budget and a 32,000 distinct-image cap", () => {
  assert.equal(FE_EXPORT_IMAGE_TOTAL_BYTES, 1_000_000_000);
  assert.equal(FE_EXPORT_IMAGE_MAX_COUNT, 32_000);
});
