import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import vm from "node:vm";
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

test("plain-text paste stays scoped to chat and bypasses rich clipboard parsers", () => {
  const src = read("scripts/fe-chat-enhance.js");
  const start = src.indexOf("function feInstallChatPlainTextPaste");
  assert.ok(start > 0);
  const body = src.slice(start, src.indexOf("\n}\n", start));
  assert.match(body, /addEventListener\("plugins"/);
  assert.match(body, /closest\?\.\("prose-mirror#chat-message"\)/);
  assert.doesNotMatch(body, /view\.pasteText\(/);
  assert.match(body, /replaceSelection\(slice\)\.setStoredMarks\(\[\]\)/);
  assert.match(body, /data\.files\?\.length/);
  assert.match(src, /Hooks\.once\("setup", \(\) => \{\s*feInstallChatMenuTypingFastPath\(\);\s*feInstallChatPlainTextPaste\(\);/);
});

// Exercise real ProseMirror transactions using the installed core's dependencies.
// Portable source checks above still run on CI hosts without Foundry installed.
const corePackage = join(process.env.FOUNDRY_APP_PATH ??
  join(process.env.ProgramFiles ?? "C:/Program Files", "Foundry Virtual Tabletop", "resources", "app"), "package.json");
const pm = existsSync(corePackage) ? createRequire(corePackage) : null;

test("plain paste strips clipboard/cursor marks, preserves text and respects opt-out", { skip: !pm }, () => {
  const { Schema } = pm("prosemirror-model");
  const { EditorState, TextSelection, Plugin } = pm("prosemirror-state");
  const schema = new Schema({
    nodes: {
      doc: { content: "block+" },
      paragraph: { content: "inline*", group: "block" },
      text: { group: "inline" },
      hard_break: { inline: true, group: "inline" },
      image: { inline: true, group: "inline", attrs: { src: { default: "" } } },
    },
    marks: { strong: {}, color: { attrs: { color: {} } }, link: { attrs: { href: {} } } },
  });
  const source = read("scripts/fe-chat-enhance.js");
  const installer = source.match(/^function feInstallChatPlainTextPaste\(\) \{[\s\S]*?^\}/m)[0];
  let listener;
  let enabled = true;
  let restored = 0;
  vm.runInNewContext(`${installer}\nfeInstallChatPlainTextPaste()`, {
    game: { release: { generation: 14 } }, foundry: { prosemirror: { Plugin } },
    document: { addEventListener: (_name, fn) => { listener = fn; } },
    S, feSetting: () => enabled,
    feSnapshotAndRestoreStickyScroll: () => () => { restored++; },
  });
  const event = { target: { closest: () => true }, plugins: {} };
  listener(event);
  const paste = event.plugins.fePlainTextPaste.props.handlePaste;
  const bold = schema.marks.strong.create();
  const doc = schema.node("doc", null, [schema.node("paragraph", null, schema.text("AB", [bold]))]);
  const initial = EditorState.create({ schema, doc, selection: TextSelection.create(doc, 2), storedMarks: [bold] });
  let transactions = 0;
  const view = { state: initial, dispatch(tr) { transactions++; this.state = this.state.apply(tr); } };
  const clipboard = (plain, html = "", files = []) => ({ clipboardData: {
    files, getData: type => type === "text/plain" ? plain : html,
  } });
  const plainMarks = () => {
    const nodes = [];
    view.state.doc.descendants(n => { if (n.isText) nodes.push(n); });
    return nodes;
  };

  assert.equal(paste(view, clipboard("복사", "<b style='color:red'>복사</b>")), true);
  assert.equal(view.state.doc.textContent, "A복사B");
  assert.equal(view.state.doc.childCount, 1, "inline paste must not split the paragraph");
  assert.equal(plainMarks().find(n => n.text === "복사").marks.length, 0);
  assert.equal(plainMarks()[0].marks[0].type.name, "strong", "existing text keeps its formatting");
  assert.equal(view.state.storedMarks.length, 0);

  view.state = initial;
  assert.equal(paste(view, clipboard("첫째\r\n\r\n셋째")), true);
  assert.equal(view.state.doc.textBetween(0, view.state.doc.content.size, "\n"), "A첫째\n\n셋째B");
  assert.equal(plainMarks().filter(n => /첫째|셋째/.test(n.text)).every(n => !n.marks.length), true);

  view.state = initial;
  const rich = schema.node("doc", null, [schema.node("paragraph", null, [
    schema.text("HTML", [bold, schema.marks.color.create({ color: "red" })]),
    schema.node("hard_break"), schema.text("링크", [schema.marks.link.create({ href: "https://example.com" })]),
  ])]).slice(0);
  assert.equal(paste(view, clipboard("", "<strong>HTML</strong><br><a>링크</a>"), rich), true);
  assert.equal(view.state.doc.textBetween(0, view.state.doc.content.size, "\n"), "AHTML\n링크B");
  assert.equal(plainMarks().filter(n => /HTML|링크/.test(n.text)).every(n => !n.marks.length), true);

  const count = transactions;
  enabled = false;
  assert.equal(paste(view, clipboard("off", "<b>off</b>")), false);
  enabled = true;
  assert.equal(paste(view, clipboard("image", "", [{}])), false);
  const image = schema.node("doc", null, [schema.node("paragraph", null, schema.node("image"))]).slice(0);
  assert.equal(paste(view, clipboard("", "<img>"), image), false);
  assert.equal(transactions, count);
  assert.equal(restored, transactions);
});
