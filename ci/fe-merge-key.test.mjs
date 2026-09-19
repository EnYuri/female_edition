/**
 * Node unit tests for the merge-key normalization in fe-render-state.js.
 *
 * Run from the module root:
 *   node --test ci/fe-merge-key.test.mjs
 *
 * `feMergeKey` reads `feSetting()` (→ game.settings) and `game.users` lazily at call
 * time, never at import, so stubbing the globals before importing is enough.
 */

import test from "node:test";
import assert from "node:assert/strict";

const settings = new Map();

globalThis.CONST = {
  CHAT_MESSAGE_STYLES: { OTHER: 0, OOC: 1, IC: 2, EMOTE: 3 },
  DOCUMENT_OWNERSHIP_LEVELS: { OWNER: 3 },
};
globalThis.game = {
  user: { id: "gm1", isGM: true },
  users: { get: (id) => (id === "gm1" ? { id: "gm1", name: "나유리", isGM: true } : null) },
  settings: {
    get: (_mod, key) => settings.get(key),
    set: (_mod, key, value) => settings.set(key, value),
  },
};

const { feMergeKey } = await import("../scripts/fe-render-state.js");

const ROLL_SETTING = "ceMergeIncludeRollMessages";

/** A bare `/r` by the GM with no actor selected: Foundry stamps OTHER + the user's name. */
const roll = () => ({
  authorId: "gm1",
  // scene|token|actor|alias
  speakerKey: "scene1|||나유리",
  whisperKey: "",
  blind: false,
  rollMode: "",
  style: 0, // OTHER
  hasRollMessage: true,
});

/** The same GM's next typed OOC line: OOC + no alias at all. */
const ooc = () => ({
  authorId: "gm1",
  speakerKey: "|||",
  whisperKey: "",
  blind: false,
  rollMode: "",
  style: 1, // OOC
  hasRollMessage: false,
});

test("with the roll setting OFF a roll keeps its own key, exactly as before", () => {
  settings.set(ROLL_SETTING, false);
  const r = feMergeKey(roll(), "actor");
  assert.equal(r, "gm1|||나유리|||||0||||0");
  assert.notEqual(r, feMergeKey(ooc(), "actor"));
});

test("with the roll setting ON a roll shares the key of the same user's OOC line", () => {
  // Foundry stamps a roll differently from a typed line even for the same speaker: the
  // style is OTHER rather than a channel, and `getSpeaker()` falls back to the user's own
  // name for the alias. Both land in the merge key, and `feCanMergePair` compares keys as
  // whole strings — so before this normalization the setting lifted the `noMerge` veto and
  // still changed nothing: a roll could only ever pair with another roll.
  settings.set(ROLL_SETTING, true);
  assert.equal(feMergeKey(roll(), "actor"), feMergeKey(ooc(), "actor"));
});

test("normalizing only one of the two components is not enough", () => {
  settings.set(ROLL_SETTING, false);
  const target = feMergeKey(ooc(), "actor");
  // style fixed, alias left alone
  assert.notEqual(feMergeKey({ ...roll(), style: 1 }, "actor"), target);
  // alias fixed, style left alone
  assert.notEqual(feMergeKey({ ...roll(), speakerKey: "|||" }, "actor"), target);
});

test("a roll whose speaker carries an actor is normalized to IC, not OOC", () => {
  settings.set(ROLL_SETTING, true);
  const icRoll = { ...roll(), speakerKey: "scene1|tok1|actor1|Akra" };
  const icText = { ...ooc(), speakerKey: "scene1|tok1|actor1|Akra", style: 2 };
  assert.equal(feMergeKey(icRoll, "actor"), feMergeKey(icText, "actor"));
  // ...and therefore does NOT collapse into that actor's OOC-styled lines.
  const oocText = { ...ooc(), speakerKey: "scene1|tok1|actor1|Akra", style: 1 };
  assert.notEqual(feMergeKey(icRoll, "actor"), feMergeKey(oocText, "actor"));
});

test("a deliberate custom alias on an actor-less roll is preserved", () => {
  // Blanking the alias outright would fold an in-character narration roll into the
  // author's own OOC chatter. Only the author's OWN name is treated as Foundry's fallback.
  settings.set(ROLL_SETTING, true);
  const aliased = { ...roll(), speakerKey: "scene1|||의문의 목소리" };
  assert.notEqual(feMergeKey(aliased, "actor"), feMergeKey(ooc(), "actor"));
});

test("the normalization never fires for a message that carries no rolls", () => {
  settings.set(ROLL_SETTING, true);
  const plain = { ...roll(), hasRollMessage: false };
  assert.equal(feMergeKey(plain, "actor"), "gm1|||나유리|||||0||||0");
});

test("the stricter `speaker` basis still separates a roll from a typed line", () => {
  // That basis keeps scene + token in the key on purpose — "the exact same token spoke".
  settings.set(ROLL_SETTING, true);
  assert.notEqual(feMergeKey(roll(), "speaker"), feMergeKey(ooc(), "speaker"));
});
