import test from "node:test";
import assert from "node:assert/strict";
import { feCanUserSeeChatMessage, feRunArchiveDocumentOperation } from "../scripts/fe-archive-output.js";

test("blind-roll authors cannot export hidden results from documents or raw database rows", () => {
  const player = { id: "player", isGM: false };
  const gm = { id: "gm", isGM: true };
  for (const identity of [{ author: "player" }, { author: { id: "player" } }, { user: "player" }]) {
    const blindRoll = { ...identity, blind: true, whisper: ["gm"], content: "secret result" };
    assert.equal(feCanUserSeeChatMessage(blindRoll, player), false);
    assert.equal(feCanUserSeeChatMessage(blindRoll, gm), true);
    // Recipient membership must not bypass core's blind-author rule either.
    assert.equal(feCanUserSeeChatMessage({ ...blindRoll, whisper: ["player", "gm"] }, player), false);
    assert.equal(feCanUserSeeChatMessage({ ...blindRoll, blind: false }, player), true);
  }
});

test("archive still includes public messages and authorized whispers", () => {
  const player = { id: "player", isGM: false };
  const message = { author: "other", whisper: ["player"] };
  assert.equal(feCanUserSeeChatMessage(message, player), true);
  assert.equal(feCanUserSeeChatMessage({ ...message, whisper: ["someoneElse"] }, player), false);
  assert.equal(feCanUserSeeChatMessage({ ...message, whisper: [] }, player), true);
  assert.equal(feCanUserSeeChatMessage({ ...message, whisper: [], hidden: true }, player), false);
});

test("archive output restores screen rendering after failure and releases its operation lock", async () => {
  const previousDocument = globalThis.document;
  const previousUi = globalThis.ui;
  const previousGame = globalThis.game;
  globalThis.document = { querySelectorAll: () => [] };
  globalThis.ui = {};
  globalThis.game = {};
  const classes = new Set(["fe-archive-screen-ready"]);
  const doc = { body: { classList: {
    contains: key => classes.has(key),
    add: key => classes.add(key),
    remove: key => classes.delete(key),
  } } };
  try {
    await assert.rejects(feRunArchiveDocumentOperation(doc, async () => {
      assert.equal(classes.has("fe-archive-screen-ready"), false);
      throw new Error("output failed");
    }), /output failed/);
    assert.equal(classes.has("fe-archive-screen-ready"), true);
    assert.equal(await feRunArchiveDocumentOperation(doc, async () => {
      assert.equal(classes.has("fe-archive-screen-ready"), false);
      return "complete";
    }), "complete");
    assert.equal(classes.has("fe-archive-screen-ready"), true);
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousUi === undefined) delete globalThis.ui;
    else globalThis.ui = previousUi;
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
});
