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
