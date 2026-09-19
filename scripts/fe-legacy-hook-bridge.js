/**
 * fe-legacy-hook-bridge.js — keeps `renderChatMessage` listeners alive past v15.
 *
 * Core deprecated the `renderChatMessage` hook in v13 in favour of `renderChatMessageHTML`
 * (HTMLElement instead of jQuery) and will REMOVE it in v15. Until then every rendered
 * message pays for it: `ChatMessage#renderHTML` (client/documents/chat-message.mjs:452)
 * checks `"renderChatMessage" in Hooks.events` and, if any module registered it, logs a
 * compatibility warning and calls the old hook. Our own code never uses the old name — the
 * registrations come from third-party modules — but fe-chat-prune.js re-renders messages in
 * batches, so one prune pass reprints the warning once per message.
 *
 * This bridge rewrites the registration instead of the warning: `Hooks.on/once(
 * "renderChatMessage", fn)` is transparently redirected to `renderChatMessageHTML` with a
 * wrapper that hands `fn` the jQuery object it expects. Two things follow:
 *
 *   1. The key is never created in `Hooks.events`, so core's check is false and the warning
 *      never fires.
 *   2. Those listeners keep working in v15, where core stops calling the old hook at all.
 *
 * WHY PATCHING THE REGISTRATION IS THE ONLY OPTION. Moving the listeners after the fact
 * cannot silence the warning: `Hooks.on` creates the bucket with
 * `Object.defineProperty(events, hook, {value: [], writable: false})` — non-configurable —
 * so once the name has been used even once, `"renderChatMessage" in Hooks.events` stays
 * true forever, no matter how many listeners are removed. The bucket must never be created,
 * which means intercepting before anyone registers.
 *
 * HENCE THE LOAD ORDER (MUST), AND WHY THIS IS A CLASSIC `scripts` ENTRY, NOT AN ESMODULE.
 * The server builds the page's script list with fixed priorities
 * (`dist/server/views/view.mjs#_getStaticContent`): library module scripts 3, library module
 * esmodules 4, system scripts 5, system esmodules 6, **module scripts 7, module esmodules
 * 8**, world 9/10. So EVERY module's classic script runs before ANY module's esmodule, and
 * a bridge shipped as an esmodule can never beat a module that registers from a classic
 * script. Measured live on v14.367: lmrtfy is exactly that case — `modules/lmrtfy/src/
 * lmrtfy.js:429` has a top-level `Hooks.on('renderChatMessage', LMRTFY.hideBlind)`, and with
 * the bridge in `esmodules` the bucket already existed by the time we loaded. As a `scripts`
 * entry we share priority 7 with it, the sort is stable, and package order puts
 * `female_edition` ahead of `lmrtfy`.
 *
 * That is also why this file uses NO import/export: a classic `scripts` entry is loaded as a
 * plain `<script>`, where module syntax is a parse error. It publishes
 * `globalThis.feInstallLegacyHookBridge` instead, which is what the test evaluates.
 *
 * A module that still beats us (a library module's script, priority 3) is handled by
 * `feLegacyHookBridgeAdopt`: it moves any already-registered listener across so it survives
 * v15 — the warning is then unavoidable for that session, for the reason above.
 *
 * BEHAVIOUR IS PRESERVED EXACTLY, and the third argument is why. Core fires
 * `renderChatMessageHTML` from two places: the legacy template path, WITH `messageData`,
 * followed by the deprecated hook; and the system-data-model path (`this.system.renderHTML`
 * — every dnd5e 6.0 `.compact` card), with only two arguments and NO deprecated call at
 * all. So a legacy listener is, today, not invoked for system-rendered messages. The
 * wrapper reproduces that by forwarding only when `messageData` is present. Without that
 * check this file would start running old handlers on cards they have never seen, which is
 * a functional change dressed up as a deprecation fix.
 */

(() => {

const FE_LEGACY_HOOK = "renderChatMessage";
const FE_MODERN_HOOK = "renderChatMessageHTML";

/**
 * Wrappers we created, keyed by the caller's original function, so `Hooks.off(hook, fn)`
 * with the original still finds something to remove. A function may be registered more
 * than once, so each entry holds a stack.
 * @type {Map<Function, Function[]>}
 */
const _feLegacyWrappers = new Map();

/**
 * @param {Function} fn  The legacy callback.
 * @returns {Function}   A `renderChatMessageHTML` listener that calls it the old way.
 */
function feWrapLegacyChatListener(fn) {
  const wrapper = (message, html, messageData) => {
    // See the header: only the legacy render path passes messageData, and only that path
    // used to reach this listener.
    if ( messageData === undefined ) return;
    // jQuery is still global in v13/v14; if it ever is not, the element is strictly better
    // than throwing.
    const jq = typeof globalThis.$ === "function" ? globalThis.$(html) : html;
    return fn(message, jq, messageData);
  };
  const existing = _feLegacyWrappers.get(fn);
  if ( existing ) existing.push(wrapper);
  else _feLegacyWrappers.set(fn, [wrapper]);
  return wrapper;
}

/** @param {Function} fn */
function feTakeLegacyWrapper(fn) {
  const stack = _feLegacyWrappers.get(fn);
  if ( !stack?.length ) return null;
  const wrapper = stack.pop();
  if ( !stack.length ) _feLegacyWrappers.delete(fn);
  return wrapper;
}

/**
 * @param {object} [hooks]  The Hooks class; injectable so the bridge can be unit-tested.
 */
function feInstallLegacyHookBridge(hooks = globalThis.Hooks) {
  if ( !hooks || hooks._feLegacyChatBridge ) return;

  const on = hooks.on.bind(hooks);
  const off = hooks.off.bind(hooks);

  // Hooks.once delegates to `this.on`, so overriding `on` covers both.
  hooks.on = function feBridgedHooksOn(hook, fn, options) {
    if ( (hook === FE_LEGACY_HOOK) && (typeof fn === "function") ) {
      return on(FE_MODERN_HOOK, feWrapLegacyChatListener(fn), options);
    }
    return on(hook, fn, options);
  };

  // Callers unregister with the function they handed us, which is not the one core knows.
  // An ID-based off() needs no translation — the ID we returned is the wrapper's.
  hooks.off = function feBridgedHooksOff(hook, fn) {
    if ( (hook === FE_LEGACY_HOOK) && (typeof fn === "function") ) {
      const wrapper = feTakeLegacyWrapper(fn);
      if ( wrapper ) return off(FE_MODERN_HOOK, wrapper);
    }
    return off(hook, fn);
  };

  hooks._feLegacyChatBridge = true;
  feLegacyHookBridgeAdopt(hooks, on, off);
}

/**
 * Move listeners that were registered before this file was imported.
 * @param {object} hooks
 * @param {Function} on
 * @param {Function} off
 */
function feLegacyHookBridgeAdopt(hooks, on, off) {
  const registered = hooks.events?.[FE_LEGACY_HOOK];
  if ( !registered?.length ) return;
  // `registered` is the live bucket and off() splices it, so count before the loop.
  const moved = registered.length;
  for ( const entry of [...registered] ) {
    if ( typeof entry?.fn !== "function" ) continue;
    off(FE_LEGACY_HOOK, entry.fn);
    on(FE_MODERN_HOOK, feWrapLegacyChatListener(entry.fn), { once: entry.once });
  }
  console.warn(
    `female_edition | moved ${moved} legacy ${FE_LEGACY_HOOK} listener(s) to `
    + `${FE_MODERN_HOOK}; they were registered before this module loaded, so core's `
    + `deprecation warning cannot be suppressed for this session.`
  );
}

// Published for the CI test, which evaluates this file in a vm context with a fake Hooks.
globalThis.feInstallLegacyHookBridge = feInstallLegacyHookBridge;

// Guarded so evaluating this file outside Foundry does nothing.
if ( typeof globalThis.Hooks !== "undefined" ) feInstallLegacyHookBridge();

})();
