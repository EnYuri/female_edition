import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/fe-chat-prune.js", import.meta.url), "utf8");
const installSource = source.slice(source.indexOf("export function feInstallChatLogPrune()"))
  .replace("export function", "function");

function makeChatLog(messages, initialId, failId) {
  const errors = [];
  const attempts = new Map();
  const log = {
    children: initialId ? [{ dataset: { messageId: initialId } }] : [],
    get firstElementChild() { return this.children[0]; },
    get lastElementChild() { return this.children.at(-1); },
    querySelector(selector) {
      const id = selector.match(/data-message-id="([^"]+)"/)?.[1];
      return this.children.find(el => el.dataset.messageId === id) ?? null;
    },
    prepend(...elements) { this.children.unshift(...elements); },
    append(...elements) { this.children.push(...elements); },
  };
  class BaseChatLog {
    rendered = true;
    isPopout = false;
    element = { querySelector: selector => selector === ".chat-log" ? log : null };
    scrollBottom() {}
  }
  const context = {
    CONFIG: { ui: { chat: BaseChatLog } },
    game: {
      settings: { get: () => true },
      messages: { contents: messages },
    },
    Hooks: { onError: (_where, error) => errors.push(error) },
    foundry: { utils: {
      Semaphore: class { add(fn) { return fn(); } },
      debounce: fn => fn,
    } },
    feIsActiveModuleFeatureEnabled: () => false,
    feSetting: () => false,
    feFormat: key => key,
    MODULE_ID: "female_edition",
    S: { PRUNE_ENABLED: "prune", PRUNE_MAX_MESSAGES: "max" },
    console: { log() {} },
  };
  const install = runInNewContext(`${installSource}\nfeInstallChatLogPrune`, context);
  install();
  context.CONFIG.ui.chat.renderMessage = async message => {
    const count = (attempts.get(message.id) ?? 0) + 1;
    attempts.set(message.id, count);
    if (message.id === failId && count === 1) throw new Error("temporary render failure");
    return { dataset: { messageId: message.id } };
  };
  return { app: new context.CONFIG.ui.chat(), log, attempts, errors };
}

function ids(log) { return log.children.map(el => el.dataset.messageId); }

test("backward batch retries a failed message without crossing the gap", async () => {
  const messages = ["m0", "m1", "m2", "m3"].map(id => ({ id, visible: true, logged: false }));
  const { app, log, attempts, errors } = makeChatLog(messages, null, "m1");

  await app.renderBatch(3);
  assert.deepEqual(ids(log), ["m2", "m3"]);
  assert.equal(messages[1].logged, false);

  await app.renderBatch(3);
  assert.deepEqual(ids(log), ["m0", "m1", "m2", "m3"]);
  assert.equal(attempts.get("m1"), 2);
  assert.equal(errors.length, 1);
});

test("forward batch retries a failed message without crossing the gap", async () => {
  const messages = ["m0", "m1", "m2", "m3"].map(id => ({ id, visible: true, logged: false }));
  const { app, log, attempts, errors } = makeChatLog(messages, "m0", "m2");
  await app.scrollBottom();

  await app.renderBatchForward(3);
  assert.deepEqual(ids(log), ["m0", "m1"]);
  assert.equal(messages[2].logged, false);

  await app.renderBatchForward(3);
  assert.deepEqual(ids(log), ["m0", "m1", "m2", "m3"]);
  assert.equal(attempts.get("m2"), 2);
  assert.equal(errors.length, 1);
});
