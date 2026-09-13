import test from "node:test";
import assert from "node:assert/strict";
import { feRunArchiveDocumentOperation } from "../scripts/fe-archive-output.js";

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
