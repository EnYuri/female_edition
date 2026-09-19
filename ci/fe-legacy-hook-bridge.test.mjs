import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import vm from "node:vm";

// The bridge is a classic `scripts` entry (see its header for why it must be), so it has no
// exports to import — evaluate it the way the browser does and take the global it publishes.
const BRIDGE_SRC = readFileSync(new URL("../scripts/fe-legacy-hook-bridge.js", import.meta.url), "utf8");

function loadBridge() {
  const context = vm.createContext({ console });
  vm.runInContext(BRIDGE_SRC, context);
  return context.feInstallLegacyHookBridge;
}

/** A stand-in for core's Hooks with the parts the bridge depends on. */
function makeHooks() {
  const events = {};
  let nextId = 1;
  return {
    events,
    on(hook, fn, { once = false } = {}) {
      // Core defines the bucket non-configurably, which is why the bridge has to prevent
      // the legacy name from ever being used rather than clean it up afterwards.
      if (!(hook in events)) Object.defineProperty(events, hook, { value: [], writable: false });
      const entry = { hook, id: nextId++, fn, once };
      events[hook].push(entry);
      return entry.id;
    },
    off(hook, fn) {
      const bucket = events[hook];
      if (!bucket) return;
      const i = typeof fn === "number"
        ? bucket.findIndex((h) => h.id === fn)
        : bucket.findIndex((h) => h.fn === fn);
      if (i >= 0) bucket.splice(i, 1);
    },
    callAll(hook, ...args) {
      for (const entry of [...(events[hook] ?? [])]) entry.fn(...args);
    },
  };
}

test("a legacy renderChatMessage registration never creates the deprecated bucket", () => {
  const hooks = makeHooks();
  loadBridge()(hooks);

  const seen = [];
  hooks.on("renderChatMessage", (message, html, data) => seen.push([message, html, data]));

  // This is the exact expression core tests before logging the deprecation warning.
  assert.equal("renderChatMessage" in hooks.events, false);
  assert.equal(hooks.events.renderChatMessageHTML.length, 1);

  hooks.callAll("renderChatMessageHTML", "msg", "<li></li>", { some: "data" });
  assert.deepEqual(seen, [["msg", "<li></li>", { some: "data" }]]);
});

test("system-rendered messages do not reach legacy listeners", () => {
  // Core's `this.system.renderHTML` path fires renderChatMessageHTML with TWO arguments and
  // never calls the deprecated hook, so a legacy listener must stay silent there — every
  // dnd5e 6.0 `.compact` card goes down that path.
  const hooks = makeHooks();
  loadBridge()(hooks);

  let calls = 0;
  hooks.on("renderChatMessage", () => calls++);
  hooks.callAll("renderChatMessageHTML", "msg", "<li></li>");
  assert.equal(calls, 0);
});

test("off() with the original function unregisters the bridged listener", () => {
  const hooks = makeHooks();
  loadBridge()(hooks);

  const fn = () => {};
  hooks.on("renderChatMessage", fn);
  assert.equal(hooks.events.renderChatMessageHTML.length, 1);
  hooks.off("renderChatMessage", fn);
  assert.equal(hooks.events.renderChatMessageHTML.length, 0);
});

test("listeners registered before the bridge loads are adopted", () => {
  const hooks = makeHooks();
  let calls = 0;
  hooks.on("renderChatMessage", () => calls++);

  loadBridge()(hooks);

  assert.equal(hooks.events.renderChatMessage.length, 0);
  assert.equal(hooks.events.renderChatMessageHTML.length, 1);
  hooks.callAll("renderChatMessageHTML", "msg", "<li></li>", {});
  assert.equal(calls, 1);
});

test("the bridge ships as a classic script, which is the only slot that wins", () => {
  // Module classic scripts are priority 7 and module esmodules priority 8 in the server's
  // page build, so an esmodule can never beat a module that registers from a classic script
  // (lmrtfy does exactly that). It must also stay out of esmodules, or it runs twice.
  const manifest = JSON.parse(readFileSync(new URL("../module.json", import.meta.url), "utf8"));
  assert.equal(manifest.scripts[0], "scripts/fe-legacy-hook-bridge.js");
  assert.equal(manifest.esmodules.includes("scripts/fe-legacy-hook-bridge.js"), false);
});

test("the bridge uses no module syntax, since a classic script cannot parse it", () => {
  assert.doesNotMatch(BRIDGE_SRC, /^\s*(import|export)\s/m);
});

test("no female_edition script registers the deprecated hook itself", () => {
  // The bridge exists for other modules' registrations; ours must already use the new name.
  const dir = new URL("../scripts/", import.meta.url);
  const offenders = [];
  for (const name of readdirSync(dir)) {
    if (!name.endsWith(".js") || name === "fe-legacy-hook-bridge.js") continue;
    const body = readFileSync(new URL(name, dir), "utf8");
    for (const [i, line] of body.split("\n").entries()) {
      if (/Hooks\.(on|once)\(\s*["']renderChatMessage["']/.test(line)) offenders.push(`${name}:${i + 1}`);
    }
  }
  assert.deepEqual(offenders, []);
});
