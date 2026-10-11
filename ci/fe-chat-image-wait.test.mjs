import test from "node:test";
import assert from "node:assert/strict";
import { feInstallChatImageWaitGuard } from "../scripts/fe-util.js";

function image(loading) {
  const listeners = new Map();
  return {
    loading,
    complete: false,
    addEventListener(type, fn) {
      if (!listeners.has(type)) listeners.set(type, new Set());
      listeners.get(type).add(fn);
    },
    removeEventListener(type, fn) { listeners.get(type)?.delete(fn); },
    finish(type = "load") {
      this.complete = true;
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
  };
}

test("chat scroll waits for eager images but a deferred image cannot block it", async () => {
  const previousConfig = globalThis.CONFIG;
  let originalCalls = 0;
  class ChatLog {
    static waitForImages(element) {
      originalCalls++;
      return Promise.all(element.querySelectorAll("img")
        .filter(img => !img.complete)
        .map(img => new Promise(resolve => img.addEventListener("load", resolve))));
    }
  }
  globalThis.CONFIG = { ui: { chat: ChatLog } };
  try {
    feInstallChatImageWaitGuard();
    const lazy = image("lazy");
    const eager = image("eager");
    const log = { querySelectorAll: () => [lazy, eager] };
    let settled = false;
    const waiting = ChatLog.waitForImages(log).then(() => { settled = true; });
    await Promise.resolve();
    assert.equal(settled, false, "eager artwork must still finish loading");
    eager.finish();
    await waiting;
    assert.equal(lazy.complete, false, "the deferred image was not cancelled or fabricated as loaded");
    assert.equal(originalCalls, 0, "core's wait must not include the off-screen lazy image");

    const eagerOnly = image("eager");
    const regular = ChatLog.waitForImages({ querySelectorAll: () => [eagerOnly] });
    assert.equal(originalCalls, 1, "without lazy images the normal Foundry path remains active");
    eagerOnly.finish();
    await regular;
  } finally {
    globalThis.CONFIG = previousConfig;
  }
});
