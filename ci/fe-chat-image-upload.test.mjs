import test from "node:test";
import assert from "node:assert/strict";

import {
  CI_DEFAULT_MAX_UPLOAD_MB,
  CI_MIN_MAX_UPLOAD_MB,
  CI_MAX_MAX_UPLOAD_MB,
  CI_UPLOAD_MSG,
  ciMaxUploadBytes,
  ciMaxUploadMB,
  ciBuildUploadFileName,
  ciEnsureUploadDirectory,
  ciNormalizeUploadDirectory,
  ciResolveImageExtension,
} from "../scripts/fe-chat-image-upload.js";

test("chat-image upload messages are isolated on their own socket namespace", () => {
  for (const type of Object.values(CI_UPLOAD_MSG)) assert.match(type, /^chat-image:/);
});

// The size ceiling is a world setting now. Every read of it is a size check on a
// user-supplied file, including the GM-authority one, so a missing/garbage value
// must fall back to the shipped default rather than to "no limit".
function withMaxUploadSetting(value, fn) {
  const previousGame = globalThis.game;
  globalThis.game = {
    settings: {
      get(namespace, key) {
        if (namespace !== "female_edition" || key !== "chatImagesMaxUploadMB") throw new Error("unexpected setting read");
        if (value === "throw") throw new Error("not registered");
        return value;
      },
    },
  };
  try { return fn(); }
  finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
}

test("chat-image size ceiling comes from the world setting", () => {
  assert.equal(withMaxUploadSetting(20, ciMaxUploadMB), 20);
  assert.equal(withMaxUploadSetting(20, ciMaxUploadBytes), 20 * 1024 * 1024);
});

test("an unusable size setting falls back to the default, never to unlimited", () => {
  assert.equal(CI_DEFAULT_MAX_UPLOAD_MB, 12);
  // Infinity is deliberately grouped here, not with the clamp cases: a non-finite
  // value is garbage, and answering "the maximum" to garbage would turn a corrupt
  // setting into the largest ceiling instead of the safest one.
  for (const bad of ["throw", undefined, null, "", "많이", NaN, Infinity]) {
    assert.equal(withMaxUploadSetting(bad, ciMaxUploadMB), CI_DEFAULT_MAX_UPLOAD_MB);
  }
});

test("the size setting is clamped to its registered bounds", () => {
  assert.equal(withMaxUploadSetting(0, ciMaxUploadMB), CI_MIN_MAX_UPLOAD_MB);
  assert.equal(withMaxUploadSetting(-500, ciMaxUploadMB), CI_MIN_MAX_UPLOAD_MB);
  assert.equal(withMaxUploadSetting(4096, ciMaxUploadMB), CI_MAX_MAX_UPLOAD_MB);
  assert.equal(withMaxUploadSetting("24", ciMaxUploadMB), 24);
});

test("upload directory is forced to a relative path below the data source", () => {
  assert.equal(ciNormalizeUploadDirectory("E:\\FoundryVTT\\Data\\uploaded chat images"), "uploaded-chat-images");
  assert.equal(ciNormalizeUploadDirectory("~data/assets/../chat"), "assets/chat");
  assert.equal(ciNormalizeUploadDirectory("/nested//chat images/"), "nested/chat-images");
});

test("image extension validation rejects disguised non-images", () => {
  assert.equal(ciResolveImageExtension("portrait.html", "image/png"), ".png");
  assert.equal(ciResolveImageExtension("portrait.png", "text/html"), "");
  assert.equal(ciResolveImageExtension("portrait.jpeg", "image/jpeg"), ".jpeg");
  assert.equal(ciResolveImageExtension("portrait", "image/webp"), ".webp");
  assert.equal(ciResolveImageExtension("portrait.avif", ""), ".avif");
});

test("uploaded image names keep a safe recognizable stem plus a collision suffix", () => {
  assert.equal(ciBuildUploadFileName("portrait.png", "image/png", "abc123"), "portrait-abc123.png");
  assert.equal(ciBuildUploadFileName("C:\\Users\\me\\내 초상화.jpg", "image/jpeg", "id-7"), "내-초상화-id-7.jpg");
  assert.equal(ciBuildUploadFileName("../../portrait.html", "image/png", "safe"), "portrait-safe.png");
  assert.equal(ciBuildUploadFileName("bad<script>.png", "image/png", "safe"), "bad-script-safe.png");
  assert.equal(ciBuildUploadFileName("notes.txt", "text/plain", "safe"), "");
});

test("directory creation does not mistake Foundry's root fallback for the requested folder", async () => {
  const previousConfig = globalThis.CONFIG;
  const existing = new Set();
  const created = [];
  globalThis.CONFIG = {
    ux: {
      FilePicker: {
        async browse(_source, target) {
          return { target: existing.has(target) ? target : "." };
        },
        async createDirectory(_source, target) {
          existing.add(target);
          created.push(target);
        },
      },
    },
  };

  try {
    assert.equal(await ciEnsureUploadDirectory("chat images"), "chat-images");
    assert.deepEqual(created, ["chat-images"]);
  } finally {
    if (previousConfig === undefined) delete globalThis.CONFIG;
    else globalThis.CONFIG = previousConfig;
  }
});
