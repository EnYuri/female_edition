import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const source = readFileSync(new URL("../scripts/fe-turn-notice.js", import.meta.url), "utf8");

test("the original Your Turn portrait is hidden only when its encounter ends", () => {
  const start = source.indexOf("function feTnEndYourTurnCombat(");
  const end = source.indexOf("\nfunction feTnSyncYourTurn(", start);
  const classes = new Set(["fe-yourturn-up"]);
  const api = runInNewContext(`
    const YOUR_TURN_ID = "your-turn";
    const YT_ENDED_CLASS = "fe-yourturn-ended";
    const YT_UP_CLASS = "fe-yourturn-up";
    let _ytCombatId = null;
    ${source.slice(start, end)}
    ({ track: feTnTrackYourTurnCombat, end: feTnEndYourTurnCombat });
  `, {
    game: { modules: { get: () => ({ active: true }) } },
    document: { body: { classList: {
      add: (name) => classes.add(name),
      remove: (name) => classes.delete(name),
    } } },
  });

  api.track({ id: "active", started: true, active: true }, { turn: 0 });
  api.end({ id: "other" });
  assert.equal(classes.has("fe-yourturn-ended"), false);
  api.end({ id: "active" });
  assert.equal(classes.has("fe-yourturn-ended"), true);
  assert.equal(classes.has("fe-yourturn-up"), false);
  assert.match(source, /if \(banner && !banner\.classList\.contains\("removing"\)\) \{\s*body\.classList\.remove\(YT_ENDED_CLASS\)/);
  assert.match(readFileSync(new URL("../styles/fe-turn-notice.css", import.meta.url), "utf8"),
    /body\.fe-yourturn-ended #yourTurnCurrentImg\s*\{\s*visibility:\s*hidden/);
});

test("the retro entrance is stepped on one tick and never interpolates", () => {
  const css = readFileSync(new URL("../styles/fe-turn-notice.css", import.meta.url), "utf8");
  const rule = (sel) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `missing rule ${sel}`);
    return css.slice(at, css.indexOf("}", at));
  };
  // Band: blocks left to right, one block per tick.
  const band = rule("body.fe-retro-theme .fe-tn-band");
  assert.match(band, /steps\(var\(--fe-tn-retro-band-blocks\), jump-end\)/);
  // Portrait: column wipe after the band, no scale/fade, and `backwards` (not
  // `both`) so the finished clip-path falls back to none and the shadow returns.
  const portrait = rule("body.fe-retro-theme .fe-tn-portrait");
  assert.match(portrait, /fe-tn-wipe-retro/);
  assert.match(portrait, /steps\(var\(--fe-tn-retro-portrait-blocks\), jump-end\)/);
  assert.match(portrait, /\bbackwards;/);
  assert.match(portrait, /--fe-tn-anim-delay: calc\(var\(--fe-tn-retro-tick\) \* var\(--fe-tn-retro-band-blocks\)\)/);
  // Text: revealed WITH the band — same keyframe-driven clip pinned to the band
  // edge, same duration/delay/step count, so step k lands on the same frame.
  const text = rule("body.fe-retro-theme .fe-tn-text");
  assert.match(text, /fe-tn-text-wipe-in-retro [^;]*steps\(var\(--fe-tn-retro-band-blocks\), jump-end\)[^;]*backwards;/);
  assert.match(text, /--fe-tn-anim-dur: calc\(var\(--fe-tn-retro-tick\) \* var\(--fe-tn-retro-band-blocks\)\)/);
  assert.match(text, /--fe-tn-anim-delay: 0ms;/);
  assert.match(css, /@keyframes fe-tn-text-wipe-in-retro \{\s*from \{ clip-path: inset\(-4px calc\(100% \+ var\(--fe-tn-text-x\)\) -4px -4px\); \}\s*to\s+\{ clip-path: inset\(-4px calc\(100% \+ var\(--fe-tn-text-x\) - 100vw\) -4px -4px\); \}/);
  // The wipe's x origin and the text's real position must be the same variable.
  assert.match(rule(".fe-tn-text"), /left: var\(--fe-tn-text-x\);/);
  // Timing must ride the two variables fe-retro-theme.css's crush exception
  // re-asserts with !important; a literal duration/delay would lose to it.
  for (const r of [band, portrait, text]) assert.doesNotMatch(r, /animation-(duration|delay)\s*:/);
  const retro = readFileSync(new URL("../styles/fe-retro-theme.css", import.meta.url), "utf8");
  assert.match(retro, /#fe-turn-notice :is\(\.fe-tn-banner, \.fe-tn-band, \.fe-tn-portrait, \.fe-tn-text\)/);
});

test("the retro exit is the entrance reversed, stepped, and ends on TN_OUT_MS", () => {
  const css = readFileSync(new URL("../styles/fe-turn-notice.css", import.meta.url), "utf8");
  const rule = (sel) => {
    const at = css.indexOf(`${sel} {`);
    assert.ok(at >= 0, `missing rule ${sel}`);
    return css.slice(at, css.indexOf("}", at));
  };
  const out = "body.fe-retro-theme .fe-tn-banner.is-out";
  // No opacity fade on the banner itself.
  assert.match(rule(out), /animation: none;/);
  // Text leaves LAST, with the band block it sits on: same timing as the band.
  const text = rule(`${out} .fe-tn-text`);
  assert.match(text, /fe-tn-text-wipe-out-retro [^;]*steps\(var\(--fe-tn-retro-band-blocks\), jump-end\)[^;]*both;/);
  assert.match(text, /--fe-tn-anim-delay: calc\(var\(--fe-tn-retro-out-tick\) \* var\(--fe-tn-retro-portrait-blocks\)\)/);
  // Portrait columns, then band blocks, right to left.
  const portrait = rule(`${out} .fe-tn-portrait`);
  assert.match(portrait, /fe-tn-wipe-out-retro/);
  assert.match(portrait, /steps\(var\(--fe-tn-retro-portrait-blocks\), jump-end\)/);
  const band = rule(`${out} .fe-tn-band`);
  assert.match(band, /fe-tn-band-out [^;]*steps\(var\(--fe-tn-retro-band-blocks\), jump-end\)/);
  assert.match(band, /--fe-tn-anim-delay: calc\(var\(--fe-tn-retro-out-tick\) \* var\(--fe-tn-retro-portrait-blocks\)\)/);
  assert.match(css, /@keyframes fe-tn-wipe-out-retro \{\s*from \{ clip-path: inset\(0 0 0 0\); \}\s*to\s+\{ clip-path: inset\(0 100% 0 0\); \}/);
  // The exit tick divides --fe-tn-out by the TOTAL block count, so the last block
  // lands exactly when fe-turn-notice.js removes the node after TN_OUT_MS.
  assert.match(css, /--fe-tn-retro-out-tick: calc\(var\(--fe-tn-out\)\s*\/ \(var\(--fe-tn-retro-band-blocks\) \+ var\(--fe-tn-retro-portrait-blocks\)\)\)/);
  assert.match(source, /setTimeout\(\(\) => banner\.remove\(\), TN_OUT_MS\)/);
});

test("the retro band's player-colour edges are solid at a quarter saturation", () => {
  const css = readFileSync(new URL("../styles/fe-turn-notice.css", import.meta.url), "utf8");
  const band = css.slice(css.indexOf("body.fe-retro-theme .fe-tn-band {"));
  const bandRule = band.slice(0, band.indexOf("}"));
  assert.match(bandRule, /--fe-tn-edge-color: hsl\(from var\(--fe-tn-color\) h calc\(s \/ 4\) l\);/);
  assert.match(bandRule, /border-color: var\(--fe-tn-edge-color\);/);
  // The dithered-edge variant was dropped: no strips, fill not clipped.
  assert.doesNotMatch(css, /\.fe-tn-band::(before|after)/);
  assert.doesNotMatch(bandRule, /background-clip/);
});

test("a leave that arrives mid-entrance waits for the entrance to finish", () => {
  // The exit keyframes start from the FULL state, so starting them over a
  // half-drawn entrance snaps band/text/portrait to full for a beat.
  const start = source.indexOf("function feTnLeave(");
  const body = source.slice(start, source.indexOf("\nfunction ", start + 1));
  assert.match(body, /const entranceLeft = TN_IN_MS - \(performance\.now\(\) - _tnShownAt\);/);
  // Re-armed on the hold timer, so a newer feTnShow / teardown cancels it.
  assert.match(body, /_tnHoldTimer = setTimeout\(feTnLeave, entranceLeft\);/);
  // The deferral has to run BEFORE the banner is marked as leaving.
  assert.ok(body.indexOf("entranceLeft > 0") < body.indexOf('classList.add("is-out")'));
  const show = source.slice(source.indexOf("function feTnShow("));
  assert.ok(show.indexOf("replaceChildren") < show.indexOf("_tnShownAt = performance.now();"));
});
