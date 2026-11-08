import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// fe-retro-theme.css §3 once set `transition-duration: 1ms !important` on every
// element. Because `transition-property` defaults to `all`, that made every
// restyle of every element diff all animatable properties: measured 2026-11-08,
// retro off 98 ms vs retro on 275 ms for the same restyle, ~190 ms without it,
// and the per-keystroke chat-input restyle doubled (78 -> 155 ms).

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8")
  .replace(/\/\*[\s\S]*?\*\//g, "");

function rules(css) {
  return [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map((m) => ({ sel: m[1].trim(), body: m[2] }));
}

test("the retro theme never puts a transition on every element", () => {
  const offenders = rules(read("styles/fe-retro-theme.css"))
    .filter(({ sel }) => sel.split(",").some((p) => /\*\s*(::?(before|after))?\s*$/.test(p.trim())))
    .filter(({ body }) => /\btransition(-duration|-delay|-property)?\s*:/.test(body))
    .map(({ sel }) => sel.replace(/\s+/g, " "));
  assert.deepEqual(offenders, []);
});

test("the retro animation crush is still there (1ms keeps animationend firing)", () => {
  const css = read("styles/fe-retro-theme.css");
  const crush = rules(css).find(({ sel, body }) =>
    /^body\.fe-retro-theme \*,/.test(sel) && /animation-duration:\s*1ms !important/.test(body));
  assert.ok(crush, "body.fe-retro-theme * must keep animation-duration: 1ms !important");
});

test("the retro HP bar still steps instead of ramping", () => {
  const css = read("styles/fe-combat-tracker.css");
  assert.match(css, /body\.fe-retro-theme \.fe-dbp-bar-fill \{[^}]*transition-duration:\s*1ms;/);
});

// With the global 1ms gone, every retro surface that should stay instant (or that
// core awaits transitionend on) has to state its own 1ms.
test("retro window minimize/restore/close stay instant and still fire transitionend", () => {
  const css = read("styles/fe-retro-common.css");
  const hit = rules(css).find(({ sel, body }) =>
    /\.application\.minimizing/.test(sel) && /\.application\.maximizing/.test(sel)
    && /transition-duration:\s*1ms !important/.test(body));
  assert.ok(hit, ".application.minimizing/.maximizing must carry transition-duration: 1ms");
});

test("retro journal collapse is not blocked by the window transition-property: none", () => {
  const css = read("styles/fe-retro-common.css");
  const hit = rules(css).find(({ sel, body }) =>
    /\.collapsing/.test(sel) && /\.application/.test(sel) && /\.window-app/.test(sel)
    && /transition-property:\s*all !important/.test(body)
    && /transition-duration:\s*1ms !important/.test(body));
  assert.ok(hit, ":is(.application, .window-app).collapsing must re-enable a 1ms transition");
});

test("both tracker HP readings step under retro", () => {
  const css = read("styles/fe-combat-tracker.css");
  assert.match(css, /body\.fe-retro-theme \.fe-ct-hp-fill \{[^}]*transition-duration:\s*1ms;/);
});
