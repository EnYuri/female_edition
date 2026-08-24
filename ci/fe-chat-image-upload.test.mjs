import test from "node:test";
import assert from "node:assert/strict";

import {
  CI_MAX_PROXY_BYTES,
  CI_UPLOAD_MSG,
  ciBuildUploadFileName,
  ciEnsureUploadDirectory,
  ciNormalizeUploadDirectory,
  ciResolveImageExtension,
} from "../scripts/fe-chat-image-upload.js";

test("chat-image upload messages are isolated on their own socket namespace", () => {
  for (const type of Object.values(CI_UPLOAD_MSG)) assert.match(type, /^chat-image:/);
});

test("chat-image proxy keeps the former 17 MB no-permission ceiling", () => {
  assert.equal(CI_MAX_PROXY_BYTES, 17 * 1024 * 1024);
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
