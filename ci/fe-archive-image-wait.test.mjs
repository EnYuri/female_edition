import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import { feDownscaleImagesForPrint } from "../scripts/fe-archive-image.js";

const source = readFileSync(new URL("../scripts/fe-archive-image.js", import.meta.url), "utf8");
const start = source.indexOf("function feAwaitImageElements(");
const end = source.indexOf("\nexport async function feDownscaleImagesForPrint", start);

function harness() {
  const timers = new Map();
  let id = 0;
  const wait = runInNewContext(source.slice(start, end) + "\nfeAwaitImageElements", {
    setTimeout: fn => { timers.set(++id, fn); return id; },
    clearTimeout: key => timers.delete(key),
  });
  return { wait, timers };
}

function image(complete = false, naturalWidth = 0) {
  const listeners = new Map();
  return {
    complete, naturalWidth, listeners,
    getAttribute: key => key === "src" ? "art.png" : null,
    addEventListener(type, fn) { listeners.set(type, fn); },
    removeEventListener(type, fn) { if (listeners.get(type) === fn) listeners.delete(type); },
    finish(type) {
      this.complete = true;
      this.naturalWidth = type === "load" ? 64 : 0;
      listeners.get(type)?.();
    },
  };
}

test("settled loaded and broken images need no further event or timeout", async () => {
  const { wait, timers } = harness();
  const images = [image(true, 64), image(true, 0)];
  await wait(images);
  assert.equal(timers.size, 0);
  for (const img of images) {
    assert.equal(img.listeners.size, 0);
    assert.equal(img.getAttribute("src"), "art.png", "original remains available to the embed pass");
  }
});

test("slow images still wait; load/error both release their listeners", async () => {
  const { wait, timers } = harness();
  const slow = image(), broken = image();
  let done = false;
  const promise = wait([slow, broken]).then(() => { done = true; });
  broken.finish("error");
  await Promise.resolve();
  assert.equal(done, false);
  assert.equal(broken.listeners.size, 0);
  assert.equal(slow.listeners.size, 2);
  slow.finish("load");
  await promise;
  assert.equal(slow.listeners.size, 0);
  assert.equal(timers.size, 0);
});

test("timeout removes all listeners without marking pending images failed", async () => {
  const { wait, timers } = harness();
  const slow = image();
  const promise = wait([slow]);
  [...timers.values()][0]();
  await promise;
  assert.equal(slow.listeners.size, 0);
  assert.equal(slow.complete, false);
  assert.equal(slow.getAttribute("src"), "art.png");
  assert.equal(timers.size, 0);
});

test("completion during registration does not strand a wait or skip later images", async () => {
  const { wait, timers } = harness();
  const raced = image(), slow = image();
  const add = raced.addEventListener;
  raced.addEventListener = function(type, fn) {
    add.call(this, type, fn);
    this.complete = true;
  };
  const promise = wait([raced, slow]);
  assert.equal(raced.listeners.size, 0);
  assert.equal(slow.listeners.size, 2);
  assert.equal(timers.size, 1);
  slow.finish("load");
  await promise;
  assert.equal(timers.size, 0);
});

test("a new pending request on a formerly broken image is still awaited", async () => {
  const { wait } = harness();
  const img = image(true, 0);
  await wait([img]);
  img.complete = false;
  const promise = wait([img]);
  assert.equal(img.listeners.size, 2);
  img.finish("load");
  await promise;
});

test("the downscale entry point does not report a broken image as pending", async () => {
  const status = [];
  const broken = image(true, 0);
  const restore = await feDownscaleImagesForPrint({ devicePixelRatio: 1 }, {
    querySelectorAll: () => [broken],
  }, { waitForPendingMs: 8000, meta: value => status.push(value) });
  assert.deepEqual(status, []);
  assert.equal(broken.listeners.size, 0);
  assert.equal(broken.getAttribute("src"), "art.png");
  restore();
});
