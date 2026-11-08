import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { S, FE_DEFAULTS, FE_MENU_DEFAULTS, FE_SETTING_DEFINITIONS } from "../scripts/fe-settings-data.js";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");

test("chat plain-text paste is a client setting, default on, in the menu", () => {
  assert.equal(S.CHAT_PASTE_PLAIN_TEXT, "ceChatPastePlainText");
  assert.equal(FE_DEFAULTS[S.CHAT_PASTE_PLAIN_TEXT], true);
  assert.equal(FE_MENU_DEFAULTS[S.CHAT_PASTE_PLAIN_TEXT], true);
  assert.equal(FE_SETTING_DEFINITIONS[S.CHAT_PASTE_PLAIN_TEXT].scope, "client");
  assert.match(read("templates/fe-settings-menu.hbs"), /name="ceChatPastePlainText"/);
  assert.match(read("scripts/fe-settings.js"), /bool\(S\.CHAT_PASTE_PLAIN_TEXT\)/);
});

// Scoped to the chat input only, routed through ProseMirror's own plain-text path,
// and guarded against pasteText() re-entering handlePaste.
test("plain-text paste stays scoped to the chat input and re-entry safe", () => {
  const src = read("scripts/fe-chat-enhance.js");
  const start = src.indexOf("function feInstallChatPlainTextPaste");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /addEventListener\("plugins"/);
  assert.match(body, /closest\?\.\("prose-mirror#chat-message"\)/);
  assert.match(body, /view\.pasteText\(text, pasteEvent\)/);
  assert.match(body, /_fePlainPasteActive \|\|/);
  assert.match(body, /data\.files\?\.length/);
  assert.match(src, /Hooks\.once\("setup", \(\) => \{\s*feInstallChatMenuTypingFastPath\(\);\s*feInstallChatPlainTextPaste\(\);/);
});
