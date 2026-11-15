import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/fe-archive-print.js", import.meta.url), "utf8");
const printSource = source.slice(source.indexOf("export async function feArchivePrint(")).replace(/^export /, "");

function harness({ mode = "full", afterprint = true, throwPrint = false, failedPortrait = false } = {}) {
  const image = (src, avatar = false) => {
    const attrs = new Map([["src", src], ["loading", "lazy"]]);
    return { complete: false, naturalWidth: 0,
      classList: { contains: cls => avatar && cls === "avatar" },
      getAttribute: key => attrs.get(key) ?? null, setAttribute: (key, value) => attrs.set(key, value),
      removeAttribute: key => attrs.delete(key), matches: () => false, closest: () => null };
  };
  const portrait = image("screen-portrait.png", true);
  const content = image("content.png");
  const images = [portrait, content];
  const classes = new Set(["fe-print-downscale-lite"]);
  const classList = { contains: cls => classes.has(cls), toggle: (cls, on) => on ? classes.add(cls) : classes.delete(cls) };
  const meta = { textContent: "메시지 2개 • 장면" };
  const listeners = new Set();
  const timers = new Map();
  const calls = [];
  let waitCount = 0;
  let stickyRestores = 0;
  let printed;
  const log = { querySelectorAll: selector => selector === "img" ? images : [] };
  const doc = { body: { classList, offsetHeight: 1 },
    getElementById: id => id === "fe-chat-export-meta" ? meta : log };
  const win = {
    document: doc, focus() {}, requestAnimationFrame: fn => fn(),
    addEventListener: (_event, fn) => listeners.add(fn),
    removeEventListener: (_event, fn) => listeners.delete(fn),
    print() {
      printed = { meta: meta.textContent, sources: images.map(img => img.getAttribute("src")) };
      if (throwPrint) throw new Error("printer unavailable");
      if (afterprint) for (const listener of [...listeners]) listener();
    },
  };
  const swap = (img, src, name) => {
    const previous = img.getAttribute("src");
    img.setAttribute("src", src);
    return () => { calls.push(name); img.setAttribute("src", previous); };
  };
  const print = runInNewContext(printSource + "\nfeArchivePrint", {
    console: { warn() {} }, S: { EXPORT_PRINT_IMAGE_MODE: "mode" }, FE_DEFAULTS: {},
    FE_EXPORT_WAIT_IMAGES_MAX: 800, FE_EXPORT_WAIT_IMAGES_TIMEOUT: 20000,
    FE_EXPORT_WAIT_FONTS_TIMEOUT: 12000, FE_EXPORT_PAINT_FRAME_TIMEOUT: 400,
    feLocalize: key => key, feFormat: key => key, feSetting: () => mode, feIsElectron: () => false,
    feGetArchiveRenderProfile: () => ({}), feNormalizeArchivePortraitImages() {},
    feRepairMissingArchivePortraitsForPrint() {},
    feSnapshotAndRestoreStickyScroll: () => () => { stickyRestores++; },
    feFreezeMessageBackgroundsForPrint: () => () => calls.push("background"),
    feUpgradePortraitsForExport: async () => swap(portrait, failedPortrait ? "original-portrait.png" : "blob:portrait", "portrait"),
    fePrepareArchiveImagesForOutput: () => {
      for (const img of images) img.setAttribute("loading", "eager");
      return () => calls.push("prepare");
    },
    feWaitForImages: async (_root, _timeout, options) => {
      waitCount++;
      assert.ok(options.maxImages >= images.length);
      for (const img of images) {
        if (failedPortrait && img === portrait) continue;
        img.complete = true;
        img.naturalWidth = 100;
      }
      return failedPortrait ? 1 : 0;
    },
    feDownscaleImagesForPrint: async () => swap(content, "blob:content", "downscale"),
    feEnsureArchiveEmbeddedFonts: async () => {}, feWaitForFonts: async () => {},
    fePrepareImagesForPageBreaks: () => () => calls.push("pageBreaks"),
    setTimeout: fn => { const id = timers.size + 1; timers.set(id, fn); return id; },
    clearTimeout: id => timers.delete(id),
  });
  return { print: () => print(win), images, classes, meta, calls, listeners, timers,
    get printed() { return printed; }, get waitCount() { return waitCount; },
    get stickyRestores() { return stickyRestores; } };
}

for (const mode of ["full", "hideAvatars", "downscale", "downscaleLite", "hideAll"]) {
  test(`print ${mode} waits for visible images and restores the archive`, async () => {
    const h = harness({ mode });
    await h.print();
    assert.equal(h.waitCount, mode === "hideAll" ? 0 : 1);
    if (mode === "full" || mode === "hideAvatars") assert.equal(h.printed.sources[1], "content.png");
    if (mode === "hideAvatars" || mode === "hideAll") assert.match(h.printed.sources[0], /^data:image\/gif/);
    assert.equal(h.printed.meta, "메시지 2개 • 장면");
    assert.equal(h.meta.textContent, "메시지 2개 • 장면");
    assert.deepEqual(h.images.map(img => img.getAttribute("src")), ["screen-portrait.png", "content.png"]);
    assert.deepEqual([...h.classes], ["fe-print-downscale-lite"]);
    assert.equal(h.calls.filter(call => call === "background").length, 1);
    assert.equal(h.stickyRestores, 1);
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
  });
}

test("a timed-out original portrait is restored after straggler undo, never left on the print source", async () => {
  const h = harness({ failedPortrait: true, mode: "downscale" });
  await h.print();
  assert.match(h.printed.sources[0], /^data:image\/gif/);
  assert.equal(h.images[0].getAttribute("src"), "screen-portrait.png");
  assert.deepEqual(h.calls, ["pageBreaks", "downscale", "prepare", "portrait", "background"]);
});

for (const throwPrint of [false, true]) {
  test(`print cleanup without afterprint (print throws: ${throwPrint}) releases old callbacks`, async () => {
    const h = harness({ afterprint: false, throwPrint });
    if (throwPrint) await assert.rejects(h.print(), /printer unavailable/);
    else await h.print();
    assert.equal(h.listeners.size, 0);
    assert.equal(h.timers.size, 0);
    assert.equal(h.images[0].getAttribute("src"), "screen-portrait.png");
    assert.equal(h.meta.textContent, "메시지 2개 • 장면");
    assert.equal(h.stickyRestores, 1);
  });
}
