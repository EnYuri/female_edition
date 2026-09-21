/**
 * fe-combat-tracker-dbp.js
 *
 * The dynamic battle portrait (동적 배틀 포트레이트) — the status panel drawn over
 * or under each portrait, and everything that animates it: the HP dial, the spin,
 * the hit shake and the floating damage number. The HP reading has a second, still
 * form — COMBAT_TRACKER_DBP_HP_STYLE = "bar" swaps the dial for a status-panel-style
 * bar (feDbpBarHp), which has no spin and therefore no ticker.
 *
 * Split out of fe-combat-tracker.js because it is a self-contained feature with
 * its own clock: the tracker rebuilds the strip from a template, while this owns
 * a rAF ticker and four module-level Maps of in-flight animation state. That
 * state IS the boundary — the tracker never touches the Maps, it calls the four
 * small accessors at the bottom of this file instead.
 *
 * Imports fe-combat-tracker-core.js and nothing from the entry, which is what
 * keeps the family acyclic; rerenders are requested through core's injected
 * scheduler. See docs/combat-tracker.md.
 */
import { feFormat } from "./fe-i18n.js";
import { S } from "./fe-constants.js";
import { feHpMasked } from "./fe-hp-mask.js";
import {
  TRACKER_DOM_ID,
  feCtDbpEnabled,
  feCtDbpHpStyle,
  feCtEnabled,
  feCtGetCombat,
  feCtOriginalActive,
  feCtResolveHp,
  feCtScheduleRender,
  feCtSetting,
} from "./fe-combat-tracker-core.js";

// ── dynamic battle portrait (동적 배틀 포트레이트) ──────────────────────────
//
// A MOTHER-style status box covering the bottom 2/5 of the portrait frame:
// row 1 the name, row 2 「HP dial / max HP」, row 3 status-effect and AE icons.
// Drawn only for the vertical aspects (1.5 / 2) and, when drawn, it REPLACES the
// ordinary .fe-ct-name caption.
//
// Two layouts, chosen by COMBAT_TRACKER_DYNAMIC_PORTRAIT_LAYOUT: "insert" (the
// default) appends the panel under the artwork and lengthens the card, "overlay"
// lays it over the bottom 2/5 of the frame. The markup is identical — only where
// the template emits it, and a handful of CSS rules, differ.
//
// When HP changes: (a) the artwork shakes as if hit, (b) the delta floats up out
// of the dial, (c) the dial spins for 3.5~6s and stops on the new value. A second
// hit mid-spin simply restarts the spin toward the newest value, so the dial never
// settles on an intermediate number.
//
// The spin is deliberately NOT an accurate count-down: it holds the old value for
// a beat, scrambles fast through random digits, then lands on the final value just
// before the end. Only the first and last moments carry information.
//
// All progress lives in module-level Maps as timestamps — feCtRender rebuilds the
// whole strip with innerHTML on every hook, so for the same reason as the entrance
// animation (docs/combat-tracker.md) no state may live in the DOM. The shake and
// the floating number are handed the remaining time as a negative animation-delay
// and resume in CSS; only the dial needs a per-frame write, so it gets its own rAF
// ticker.

// The separator between the value and the max is a SOLIDUS that is DRAWN, not typed:
// there is no separator character anywhere in this file or in the template, only an
// empty cell that styles/fe-combat-tracker.css fills with a rotated bar.
//
// A real "/" was tried first and is what the middle dot before it was working around:
// in several of the faces this module is used with (CookieRun, the pixel faces) a
// solidus at dial size is a near-perfect 7, so "105/300" read as a six-digit number
// with a stray 7 in it. Drawing the stroke ourselves keeps the shape a reader expects
// between a value and a max while making it independent of whichever face the cascade
// landed on — the one thing the substitute character could not do.
//
// The consequence here is that the ink metric must NOT measure a separator any more
// (see DBP_INK_GLYPHS) and the bar caption emits the max alone.
const DBP_DIGITS_MIN = 3;              // a 3-reel dial by default
const DBP_DIGITS_MAX = 5;              // …widened to 5 only for absurd HP pools
// The floor is what the BAR's lock schedule has to fit inside: five places
// DBP_BAR_LOCK_MS apart is 1.35s of settling, so a shorter animation would spend most
// of its life already locked and the scramble would barely register.
const DBP_SPIN_MIN_MS = 3500;
const DBP_SPIN_MAX_MS = 6000;
const DBP_SPIN_LEAD_MS = 120;    // hold the pre-change value before the reels break loose
const DBP_SPIN_CRUISE = 0.55;    // fraction of the spin at full speed before the ramp-down
const DBP_SPIN_TURNS = 12;       // full revolutions of the units reel over one spin
const DBP_SPIN_STAGGER = 0.06;   // each more significant reel finishes this much earlier
// The BAR style's answer to the spin (feDbpBarRoll). Nothing rolls, so the digits
// themselves scramble and then lock, one place at a time from the left.
const DBP_BAR_LOCK_MS = 270;     // gap between two successive locks
const DBP_BAR_SCRAMBLE_MS = 60;  // how often an unlocked place picks a new number
const DBP_POP_MS = 1400; // must match @keyframes fe-dbp-pop
const DBP_HIT_MS = 460;  // must match @keyframes fe-dbp-shake
// One randomised shake profile per hit. The ranges are peaks: the card's first
// kick lands somewhere in them and every later stop is that peak decayed and
// jittered again, so two hits on the same card never trace the same path.
const DBP_SHAKE_STOPS = 6;       // must match the intermediate @keyframes stops
const DBP_SHAKE_X = [7, 13];     // % of card width
const DBP_SHAKE_Y = [1, 4.5];    // % of card height
// There is no rotation peak and there must not be one: the shake is pure
// displacement. A card is a framed portrait in a row of framed portraits, and
// tilting it read as the frame coming loose rather than as the thing inside being
// hit. @keyframes fe-dbp-shake composes no rotate() either — the two have to agree.
const DBP_SHAKE_JITTER = [0.5, 1];
// The first stop keeps a high floor: it is the impact itself, and a shake whose
// hardest kick landed on the third stop read as a wobble that built up rather than
// as something being hit.
const DBP_SHAKE_JITTER_FIRST = [0.85, 1];
const DBP_SHAKE_DECAY = 1.3;     // >1 = the tail dies off faster than linearly
// A bigger hit shakes harder. Damage at or above each threshold moves the card up
// one tier, and the tier scales both peaks. Damage only — healing moves the
// dial and the floating number and nothing else, so it never reaches this.
// The gains stay modest on purpose: the card overlaps its neighbours while it
// swings (that is what its z-index is for), and past roughly 2x the top tier reads
// as the card coming loose from the strip rather than as a heavy hit.
const DBP_SHAKE_TIERS = [27, 39, 50];
const DBP_SHAKE_TIER_GAIN = [1, 1.28, 1.55, 1.85];
const DBP_EFF_ROWS = 2;  // status icon rows; the overflow folds into a "…"
const DBP_POP_MAX = 4;   // floating numbers alive at once

const _dbpAnim = new Map();   // combatantId → {from, to, start, dur, hidden}
const _dbpPops = new Map();   // combatantId → [{text, heal, start}]
const _dbpHit = new Map();    // combatantId → {start, shake}
const _dbpLastHp = new Map(); // combatantId → last observed HP (the delta baseline)
let _dbpTickRaf = 0;

// "insert" (default) appends the panel under the artwork and lengthens the card;
// "overlay" lays it over the bottom 2/5 of the frame.
function feCtDbpInsertLayout() {
  return String(feCtSetting(S.COMBAT_TRACKER_DYNAMIC_PORTRAIT_LAYOUT) || "insert") !== "overlay";
}

// Per-actor secrecy is not this feature's own switch: it is the shared "hide the
// numbers" flag the status panel toggles from the actor sheet header (fe-hp-mask.js),
// where absent means masked. The tracker's updateActor hook already reschedules a
// render for any flag change on a combatant, so the toggle is visible immediately.
function feDbpRevealed(actor) {
  return !feHpMasked(actor);
}

function feDbpDigits(max) {
  const n = String(Math.max(0, Math.round(Number(max) || 0))).length;
  return Math.min(DBP_DIGITS_MAX, Math.max(DBP_DIGITS_MIN, n));
}

// The hidden dial's drums, left to right — `digits` wide, the same width the revealed
// dial uses (feDbpDigits(max)), so the reading never changes width when an actor is
// revealed or when a spin starts.
//
// With ceCombatTrackerHiddenPartial on, every LEADING ZERO opens. Those places are zero
// by construction, so there is nothing there to hide: the mode can never print a digit
// the value actually has, and what it publishes is the value's digit COUNT, i.e. an
// upper bound. On a 5-drum dial:
//
//   5 digits → "?????"   nothing above the top digit, so nothing opens
//   4 digits → "0????"
//   3 digits → "00???"
//   2 digits → "000??"
//   1 digit  → "0000?"   the ones place is never one of the leading zeros
//   0        → "00000"   zero has no significant digit at all, so every drum is one
//
// The drums that open are always strictly to the LEFT of every digit the value has,
// which is why a one-digit value cannot expose its ones place no matter how wide the
// dial is. Zero is the one reading this mode states outright, and deliberately: 1-9 and
// 0 are indistinguishable by digit count, so the ones drum is the only place that can
// say "down" at all, and a downed combatant is not the secret the feature protects.
function feDbpHiddenCells(value, digits) {
  const cells = new Array(digits).fill("?");
  if (feCtSetting(S.COMBAT_TRACKER_HIDDEN_PARTIAL) === true) {
    // Clamped, so `used` is at most `digits` and a full-width value opens nothing.
    const v = feDbpClampValue(Math.round(Number(value) || 0), digits);
    const used = v === 0 ? 0 : String(v).length;
    for (let i = 0; i < digits - used; i++) cells[i] = "0";
  }
  return cells;
}

function feDbpClampValue(v, digits) {
  const cap = Math.pow(10, digits) - 1;
  return Math.max(0, Math.min(cap, v));
}

// One reel's offset for an exact value. Digit j (0 = rightmost) rests on its own
// digit and only slides during the carry, so the dial reads crisply at rest.
//
// The carry window is 0.2 in VALUE units for every reel, not a fraction of that
// reel's own decade: a real counter turns its tens wheel only at the very end of
// the units wheel's revolution. Scaling the window by 10^j instead would start the
// hundreds wheel moving at v=80 and render 099 as something like "1?9".
function feDbpReelOffset(v, j) {
  const step = Math.pow(10, j);
  const val = Math.max(0, v);
  const base = Math.floor(val / step) % 10;
  const r = val % step; // distance travelled inside this reel's current step
  const t = Math.max(0, Math.min(1, (r - (step - 0.2)) / 0.2));
  return base + t * t * (3 - 2 * t);
}

function feDbpReelSet(v, digits) {
  const val = feDbpClampValue(v, digits);
  const out = [];
  for (let k = digits - 1; k >= 0; k--) out.push(Number(feDbpReelOffset(val, k).toFixed(3)));
  return out; // most significant → least significant
}

// Normalized travel of a reel at spin progress p (0..1): full speed until
// DBP_SPIN_CRUISE, then a cosine ramp down to a dead STOP at p = 1 — the reel's
// velocity reaches exactly zero as it lands, so the final value is eased into
// rather than snapped to. The division by `total` is what makes it reach 1.
function feDbpSpinEase(p) {
  const c = DBP_SPIN_CRUISE;
  const total = c + (1 - c) / 2; // area under the velocity profile
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  if (p <= c) return p / total;
  const u = (p - c) / (1 - c);
  return (c + 0.5 * (p - c) + ((1 - c) / (2 * Math.PI)) * Math.sin(Math.PI * u)) / total;
}

// Every reel offset of a running spin, most significant first — ONE continuous
// function of time, which is the whole point: the old implementation held the old
// number, cut to a random scramble, then cut again to the final number, and those
// two cuts were the visible hitch. Here reel j leaves its old digit, turns whole
// revolutions, and decelerates onto its new digit with no discontinuity anywhere.
//
// Construction: position(p) = mod(t + dir * S * (1 - ease(p)), 10) lands on the
// target offset t at p = 1 for ANY S, so S is picked to also make p = 0 land on the
// old offset f — S = 10 * turns + mod(dir * (f - t), 10). `dir` follows the HP
// change, so damage rolls the reels down and healing rolls them up.
function feDbpSpinReels(anim, now, digits) {
  const to = feDbpClampValue(anim.to, digits);
  const from = feDbpClampValue(anim.from, digits);
  const dir = anim.to > anim.from ? 1 : -1;
  const elapsed = now - anim.start;
  const lead = anim.lead ?? DBP_SPIN_LEAD_MS;
  const out = [];
  for (let j = digits - 1; j >= 0; j--) {
    const t = feDbpReelOffset(to, j);
    const f = feDbpReelOffset(from, j);
    if (elapsed < lead) { out.push(Number(f.toFixed(3))); continue; }
    // More significant reels finish earlier, so the dial settles right-to-left.
    const span = Math.max(1, (anim.dur - lead) * Math.max(0.35, 1 - j * DBP_SPIN_STAGGER));
    const p = Math.min(1, (elapsed - lead) / span);
    const turns = Math.max(3, DBP_SPIN_TURNS - 3 * j);
    const s = 10 * turns + ((((dir * (f - t)) % 10) + 10) % 10);
    const d = (((t + dir * s * (1 - feDbpSpinEase(p))) % 10) + 10) % 10;
    out.push(Number(d.toFixed(3)));
  }
  return out;
}

// A hidden actor's reels never land, so they get plain unending motion instead.
function feDbpScrambleSet(now, digits) {
  const out = [];
  for (let j = digits - 1; j >= 0; j--) {
    const v = ((now / 1000) * (26 + 7 * j) + j * 3.7) % 10;
    out.push(Number(v.toFixed(3)));
  }
  return out;
}

// Status / AE icons: conditions (effects carrying a status id) first, plain active
// effects after. How many fit per row is computed from the portrait width here
// rather than left to CSS wrapping, so the overflow can be folded into an exact
// "…" instead of being silently clipped.
function feDbpCollectEffects(actor, size) {
  const list = [];
  const seen = new Set();
  const src = actor?.appliedEffects?.length ? actor.appliedEffects : (actor?.effects?.contents ?? []);
  for (const e of src) {
    if (!e || e.disabled) continue;
    const img = e.img ?? e.icon;
    if (!img) continue;
    const name = String(e.name ?? "");
    const key = `${name}|${img}`;
    if (seen.has(key)) continue;
    seen.add(key);
    list.push({ img, name, status: !!(e.statuses?.size) });
  }
  // Array#sort is stable, so the original order survives inside each group.
  list.sort((a, b) => (b.status ? 1 : 0) - (a.status ? 1 : 0));

  const icon = Math.max(8, Math.round(size * 0.11));
  const perRow = Math.max(2, Math.floor((size - 6) / (icon + 2)));
  const cap = perRow * DBP_EFF_ROWS;
  if (list.length <= cap) return { list, moreTip: "", icon };
  const shown = list.slice(0, cap - 1);
  const rest = list.slice(cap - 1);
  const names = rest.map((e) => e.name).filter(Boolean).join(", ");
  const more = feFormat("FECT.Dbp.MoreEffects", { count: rest.length });
  return { list: shown, moreTip: names ? `${more}: ${names}` : more, icon };
}

// One pseudo-random digit for place `j` at scramble step `step`. Deterministic, and
// that is the requirement rather than a preference: the whole animation has to be a
// pure function of (anim, now), because feCtRender can rebuild the strip on any hook
// and the applier re-derives the caption from scratch right afterwards. Math.random()
// here would make every rebuild jump to a different scramble instead of continuing.
function feDbpBarDigit(seed, step, j) {
  const x = Math.sin(seed * 0.0013 + step * 12.9898 + j * 78.233) * 43758.5453;
  return Math.floor((x - Math.floor(x)) * 10);
}

// The bar's counterpart to the dial's spin: the current-HP digits scramble fast, then
// LOCK onto their final value one place at a time from the LEFT, DBP_BAR_LOCK_MS apart,
// the rightmost landing one full interval BEFORE the animation ends. That last interval
// is not slack — the end of the animation comes back through a rerender (feDbpTick), so
// a schedule that locked the rightmost place at exactly `dur` would have it replaced by
// the resting markup on the next frame and the settle would never be seen.
//
// Left to right, not right to left: the leading place is the one that says how bad it
// was, so committing it first reads as a counter settling on an answer. The dial
// settles the other way round for the opposite reason — a real odometer's units wheel
// is the last thing still turning.
//
// The lead hold is the dial's: for DBP_SPIN_LEAD_MS the caption keeps the PRE-change
// value, so the reading the player was looking at is still there when the shake lands.
function feDbpBarRoll(anim, now) {
  const elapsed = now - anim.start;
  const lead = anim.lead ?? DBP_SPIN_LEAD_MS;
  if (elapsed < lead) return String(Math.max(0, Math.round(anim.from)));
  const target = String(Math.max(0, Math.round(anim.to)));
  const step = Math.floor((elapsed - lead) / DBP_BAR_SCRAMBLE_MS);
  let out = "";
  for (let j = 0; j < target.length; j++) {
    // Place j locks this far before the end; j = 0 (leftmost) is the earliest, and the
    // rightmost gets one interval of fully-settled reading before the rerender.
    const lockAt = anim.dur - (target.length - j) * DBP_BAR_LOCK_MS;
    out += elapsed >= lockAt ? target[j] : String(feDbpBarDigit(anim.start, step, j));
  }
  return out;
}

// When the FILL may start moving: the moment the first place locks. Until then the
// track holds the pre-change ratio, because a bar that jumps to the truth in frame one
// has already answered what the caption spends the rest of the animation settling on.
function feDbpBarFillAt(anim) {
  const n = String(Math.max(0, Math.round(anim.to))).length;
  return anim.dur - n * DBP_BAR_LOCK_MS;
}

// A masked actor's caption never locks, exactly as the hidden dial's drums never land:
// plain unending motion at the dial's own width, and feDbpTick asks for a rerender when
// the clock runs out so the "?" reading comes back.
function feDbpBarSecretRoll(now, digits) {
  const step = Math.floor(now / DBP_BAR_SCRAMBLE_MS);
  let out = "";
  for (let j = 0; j < digits; j++) out += String(feDbpBarDigit(0, step, j));
  return out;
}

// The HP reading as a BAR instead of a dial (COMBAT_TRACKER_DBP_HP_STYLE = "bar"):
// a track with a proportional fill over a "value/max" caption, i.e. the same reading
// the status panel gives, so a table that turned the status panel off in favour of the
// tracker (ceDx3rdRuiYieldToTracker) still gets the reading it was used to.
//
// Secrecy follows the dial's policy exactly rather than inventing a second one: with
// ceCombatTrackerHiddenPartial off, a masked actor gets an EMPTY track and an all-"?"
// caption; with it on, the fill is drawn (a ratio is an approximation, not the number)
// and the caption opens its leading zeros through the same feDbpHiddenCells the dial
// uses — so the bar can never publish a digit the dial would have hidden.
//
// The caption is split in two — `cur` (the current value, the only part that moves)
// and `max` (the resting number after the drawn slash) — so feDbpApplyBarRoll can
// write one text node per frame instead of rebuilding the whole reading.
//
// What this returns is always the RESTING state, never the momentary one, and `roll`
// only says that an animation owns the element. That is the same contract the dial
// has: per-frame state stays out of the markup, so two renders taken at different
// moments of the same animation produce byte-identical HTML and feCtRender can skip
// the rebuild entirely. The applier runs right after every render, so a freshly built
// bar is never painted one frame at the wrong reading.
//
// `anim.hidden` is captured when the animation starts and is OR-ed with the live flag,
// exactly as the dial does it: flipping an actor to hidden mid-animation scrambles the
// rest of it instead of finishing on real numbers.
function feDbpBarHp(raw, revealed, anim) {
  const secret = !revealed || anim?.hidden === true;
  if (!secret) {
    return {
      bar: true,
      fill: true,
      roll: !!anim,
      pct: raw.pct,
      color: raw.color,
      cur: String(Math.round(raw.value)),
      max: String(Math.round(raw.max)),
    };
  }
  const digits = feDbpDigits(raw.max);
  const partial = feCtSetting(S.COMBAT_TRACKER_HIDDEN_PARTIAL) === true;
  return {
    bar: true,
    fill: partial,
    roll: !!anim,
    pct: partial ? raw.pct : 0,
    color: raw.color,
    cur: feDbpHiddenCells(raw.value, digits).join(""),
    max: new Array(digits).fill("?").join(""),
  };
}

function feDbpData(c, size, now, insert) {
  const actor = c.actor;
  const anim = _dbpAnim.get(c.id);
  const raw = feCtResolveHp(actor);
  let hp = null;
  if (raw) {
    const revealed = feDbpRevealed(actor);
    // The bar style short-circuits the whole dial apparatus — no reels, no glyph
    // cells, no cell count to size the type against.
    if (feCtDbpHpStyle() === "bar") hp = feDbpBarHp(raw, revealed, anim);
    // A hidden actor still gets "shake + spin → ???", so the dial is drawn while
    // the spin runs. The ticker scrambles it and max HP stays ??? throughout, so
    // nothing leaks.
    // The dial keeps the REAL width (feDbpDigits(max)) while hidden — an explicit
    // choice: the drum count does disclose the pool's order of magnitude, and in
    // exchange the digit-count hint keeps working on a 4- or 5-digit pool and the
    // reading never jumps width on reveal or when a spin starts.
    else if (!revealed && !anim) {
      // `glyphs` rather than `reels`: these drums do not roll, they are parked on a
      // character each. The max is "?" per drum — its VALUE stays secret; only the
      // width, which the value drums already show, is shared.
      const glyphs = feDbpHiddenCells(raw.value, feDbpDigits(raw.max));
      hp = {
        unknown: true,
        glyphs,
        maxCells: new Array(glyphs.length).fill("?"),
        cells: glyphs.length * 2 + 1,
      };
    }
    else {
      // `anim.hidden` is captured when the spin starts, so it is OR-ed with the live
      // flag: whichever of the two says "hidden" wins. Flipping an actor to hidden
      // mid-spin therefore scrambles the rest of that spin instead of finishing it on
      // real numbers, and the max goes back to "?" for the remainder.
      const secret = !revealed || anim?.hidden === true;
      const digits = feDbpDigits(raw.max);
      // A rebuild lands mid-spin all the time (any render hook does it), so the
      // markup must carry the reels' CURRENT position, not their destination —
      // emitting anim.to here made every rebuild flash the final number for one
      // frame, which is the other half of the "spin stutters" report. It would
      // also leak a hidden actor's HP for that frame.
      let reels;
      if (!anim) reels = feDbpReelSet(raw.value, digits);
      else if (secret) reels = feDbpScrambleSet(now, digits);
      else reels = feDbpSpinReels(anim, now, digits);
      // The max is a row of parked drums, padded with leading zeros to the same
      // width the value reels use (digits): a counter reads "027/027", never
      // "027/27" — a short max is just a reading whose leading drums sit on 0.
      // The separator is a drum of its own — the whole reading is one counter
      // rather than a dial with a caption after it. `cells` is what sizes the
      // type: value + sep + max.
      const maxCells = secret
        ? new Array(digits).fill("?")
        : [...String(Math.round(raw.max)).padStart(digits, "0")];
      hp = { reels, maxCells, cells: reels.length + 1 + maxCells.length };
    }
  }

  const pops = [];
  for (const pop of _dbpPops.get(c.id) ?? []) {
    const delay = pop.start - now;
    if (delay > -DBP_POP_MS) pops.push({ text: pop.text, heal: pop.heal, delay: Math.round(delay) });
  }

  const eff = feDbpCollectEffects(actor, size);
  return { insert, hp, pops, effects: eff.list, moreTip: eff.moreTip };
}

// Accept one HP change. A spin already in flight is simply restarted toward the
// newest value — since the middle of a spin is random anyway, there is nothing to
// carry over, and the dial can only ever come to rest on the final HP.
function feDbpBeginHpAnim(c, prev, next) {
  const now = performance.now();
  const hidden = !feDbpRevealed(c.actor);
  // No lead hold when a spin is already running: the reels are in mid-flight, and
  // parking them on a real number for 120ms there would be both a visible cut and
  // a pointless reading of an already-stale HP.
  const lead = _dbpAnim.has(c.id) ? 0 : DBP_SPIN_LEAD_MS;
  // `bar` picks the animation, not just the drawing: the dial rolls drums through
  // feDbpApplyOffsets, the bar scrambles digits through feDbpApplyBarRoll, and the
  // ticker has to know which of the two this entry belongs to. It is captured HERE
  // rather than read per frame so a style change mid-animation cannot hand a running
  // animation to the other applier, which would look like the reading freezing.
  _dbpAnim.set(c.id, {
    from: prev,
    to: next,
    start: now,
    lead,
    dur: DBP_SPIN_MIN_MS + Math.random() * (DBP_SPIN_MAX_MS - DBP_SPIN_MIN_MS),
    hidden,
    bar: feCtDbpHpStyle() === "bar",
  });

  // The delta is never floated for a hidden actor — the number IS the HP info.
  if (!hidden) {
    const delta = next - prev;
    const pops = _dbpPops.get(c.id) ?? [];
    pops.push({
      text: `${delta > 0 ? "+" : "-"}${Math.abs(Math.round(delta))}`,
      heal: delta > 0,
      start: now,
    });
    while (pops.length > DBP_POP_MAX) pops.shift();
    _dbpPops.set(c.id, pops);
  }
  // The shake means "took a hit", so only on a decrease. Healing moves the dial
  // and the number, nothing else.
  if (next < prev) _dbpHit.set(c.id, { start: now, shake: feDbpShakeProfile(prev - next) });

  feDbpStartTicker();
  feCtScheduleRender();
}

// The rolling drums of one dial, most significant first. The dial also holds the
// separator cell and the max, which are parked drums — [data-dbp-roll] is what separates the
// two, so the ticker can never write an offset into a cell that must not move.
//
// It returns the STRIPS, not the reels: --fe-dbp-d is written on the element that
// reads it, because a custom property written on the reel invalidates all 11 of its
// digit cells every frame just to inherit a value none of them uses (~6× the style
// recalc — see the @property note in fe-combat-tracker.css). One per rolling reel
// either way, so the offset arrays are unchanged.
function feDbpRollStrips(dial) {
  return dial ? dial.querySelectorAll("[data-dbp-roll] > .fe-dbp-strip") : [];
}

// Writes one precomputed offset per rolling reel (most significant first, matching
// the DOM order). Every producer above returns that same shape.
function feDbpWriteOffsets(strips, offsets) {
  for (let k = 0; k < strips.length && k < offsets.length; k++) {
    strips[k].style.setProperty("--fe-dbp-d", String(offsets[k]));
  }
}

function feDbpDialFor(id) {
  const root = document.getElementById(TRACKER_DOM_ID);
  if (!root) return null;
  try {
    return root.querySelector(`.fe-ct-portrait[data-combatant-id="${CSS.escape(id)}"] .fe-dbp-dial[data-dbp-dial]`);
  } catch { return null; }
}

/**
 * Write every dial's CURRENT offsets straight into the DOM.
 *
 * The template deliberately emits no --fe-dbp-d at all, and this is the other half
 * of that decision: with the offsets out of the markup, two renders taken at
 * different moments of the same spin produce byte-identical HTML, which is what
 * lets feCtRender skip the innerHTML rebuild entirely (see there — the rebuild
 * mid-spin was the last visible hitch). It runs right after every render, so a
 * fresh dial is never painted one frame at the wrong position.
 */
function feDbpApplyOffsets(root, now) {
  const dials = root.querySelectorAll(".fe-dbp-dial[data-dbp-dial]");
  if (!dials.length) return;
  const combat = feCtGetCombat();
  for (const dial of dials) {
    const id = dial.closest("[data-combatant-id]")?.dataset?.combatantId;
    if (!id) continue;
    const strips = feDbpRollStrips(dial);
    if (!strips.length) continue;
    const anim = _dbpAnim.get(id);
    let offsets;
    if (anim) {
      offsets = anim.hidden
        ? feDbpScrambleSet(now, strips.length)
        : feDbpSpinReels(anim, now, strips.length);
    }
    else {
      const raw = feCtResolveHp(combat?.combatants?.get?.(id)?.actor);
      offsets = feDbpReelSet(raw ? raw.value : 0, strips.length);
    }
    feDbpWriteOffsets(strips, offsets);
  }
}

/**
 * Write every rolling BAR's current caption and fill straight into the DOM.
 *
 * The bar's half of the contract feDbpApplyOffsets holds for the dial: the markup
 * carries only the resting reading, this runs right after every render AND on every
 * frame of the ticker, and everything it needs is re-derived from _dbpAnim plus the
 * live actor — nothing about the animation's progress is read back out of the DOM.
 */
function feDbpApplyBarRoll(root, now) {
  const wraps = root.querySelectorAll(".fe-dbp-hpbar[data-dbp-bar-roll]");
  if (!wraps.length) return;
  const combat = feCtGetCombat();
  for (const wrap of wraps) {
    const id = wrap.closest("[data-combatant-id]")?.dataset?.combatantId;
    const anim = id ? _dbpAnim.get(id) : null;
    if (!anim) continue;
    const actor = combat?.combatants?.get?.(id)?.actor;
    const raw = feCtResolveHp(actor);
    const secret = !feDbpRevealed(actor) || anim.hidden === true;
    const cur = wrap.querySelector(".fe-dbp-bar-cur");
    if (cur) {
      cur.textContent = secret
        ? feDbpBarSecretRoll(now, feDbpDigits(raw ? raw.max : 0))
        : feDbpBarRoll(anim, now);
    }
    // The fill holds the pre-change ratio until the first place locks; after that the
    // resting percentage the markup already carries is correct, so the hold is dropped
    // and the CSS width transition eases the last step.
    //
    // --fe-dbp-bar-hold is a SEPARATE property, and that is not tidiness: the template
    // writes --fe-dbp-bar-pct into this same element's style attribute, so holding the
    // old ratio there would clobber the resting value and dropping the hold would delete
    // it outright — the fill would collapse to its 0% fallback exactly when it should
    // finally move.
    const track = wrap.querySelector(".fe-dbp-bar");
    if (!track || !raw) continue;
    if (now - anim.start < feDbpBarFillAt(anim)) {
      const from = Math.max(0, Math.min(100, (Math.max(0, anim.from) / raw.max) * 100));
      track.style.setProperty("--fe-dbp-bar-hold", `${from}%`);
    }
    else track.style.removeProperty("--fe-dbp-bar-hold");
  }
}

// Every character a dial can show. The digits decide where the type is CENTRED;
// "?" only has to not be clipped, which is why it is measured separately — it can
// reach further above and below the digits, and centring on it would push the
// numbers off-centre to make room.
//
// The separator is NOT in this set and must not be put back: it is drawn by CSS, not
// typed, so it has no ink in the user's face to measure. Measuring a stand-in
// character would clamp the whole row against a glyph the dial never shows — which is
// exactly what the old "/" did, reaching further above the digits than any of them and
// pulling the row off-centre through the clamp below.
const DBP_INK_DIGITS = "0123456789";
const DBP_INK_GLYPHS = "?";
const _dbpLineHeight = new Map(); // font shorthand → line-height in em
let _dbpInkCtx = null;

// A glyph's position inside a line box is decided by the FONT's ascent and descent,
// not by the box, so `line-height: 1em` centres the digits in their 1em window only
// by luck. CookieRun happens to land at 0.505; the stock sans-serif sits at 0.565
// and has its feet clipped off by the window's overflow — which is exactly what
// "다이얼이 덜 돌아간 것 같다" looks like, on a dial that is in fact parked dead on its
// digit. The separator and the max drums show it too, and they never rotate at all:
// that is the tell that separates this from a spin that did not finish.
//
// The font is the user's, so this is measured rather than assumed. With A and D the
// font's ascent/descent and H the line-height, all in em:
//
//   baseline(H) = (H - (A + D)) / 2 + A        ← the box is top-aligned in the cell
//   want          baseline = 0.5 + (inkAscent - inkDescent) / 2
//   so            H = 2 * (want - A) + A + D
//
// Solving for H moves the GLYPH without moving anything else: the cell box stays
// exactly 1em, so the seam, the drum geometry and the em-based offsets are all
// untouched. Shifting the strip instead would drag the seams off the window edges.
function feDbpInkLineHeight(font) {
  const cached = _dbpLineHeight.get(font);
  if (cached !== undefined) return cached;
  try {
    _dbpInkCtx ??= document.createElement("canvas").getContext("2d");
    if (!_dbpInkCtx) return 1;
    _dbpInkCtx.font = font;
    // A face that has not finished loading measures as the fallback, and caching
    // that would keep the wrong value for the session. Renders are frequent enough
    // that simply not caching it is the whole recovery.
    const loaded = document.fonts?.check?.(font) !== false;
    const em = 100;
    const m0 = _dbpInkCtx.measureText("0");
    const asc = m0.fontBoundingBoxAscent / em;
    const desc = m0.fontBoundingBoxDescent / em;
    if (!(asc > 0)) return 1;
    let inkUp = 0, inkDown = 0, allUp = 0, allDown = 0;
    for (const ch of DBP_INK_DIGITS + DBP_INK_GLYPHS) {
      const m = _dbpInkCtx.measureText(ch);
      const up = m.actualBoundingBoxAscent / em;
      const down = m.actualBoundingBoxDescent / em;
      allUp = Math.max(allUp, up);
      allDown = Math.max(allDown, down);
      if (DBP_INK_DIGITS.includes(ch)) {
        inkUp = Math.max(inkUp, up);
        inkDown = Math.max(inkDown, down);
      }
    }
    // Centre on the digits, then pull back inside the window so the tallest glyph
    // of the whole set still fits. The clamp is what keeps the "?" off the edges.
    let want = 0.5 + (inkUp - inkDown) / 2;
    want = Math.min(Math.max(want, allUp), 1 - allDown);
    const h = 2 * (want - asc) + asc + desc;
    const out = Number.isFinite(h) && h > 0 ? Number(h.toFixed(4)) : 1;
    if (loaded) _dbpLineHeight.set(font, out);
    return out;
  }
  catch { return 1; }
}

// Measured off a REAL dial, not off the tracker root: the family and the weight are
// whatever the cascade actually landed on (the retro theme swaps in a pixel face,
// and a user font can replace it again), and the root does not necessarily carry
// the same pair. Only the RATIO matters, so one measurement at a nominal 100px
// serves every portrait size. Runs after the rebuild, in the same task, like the
// dial offsets and the shake profile.
function feDbpApplyInkMetric(root) {
  const el = root.querySelector(".fe-dbp-hp") || root;
  const cs = getComputedStyle(el);
  const font = `${cs.fontWeight || "bold"} 100px ${cs.fontFamily || "sans-serif"}`;
  root.style.setProperty("--fe-dbp-lh", `${feDbpInkLineHeight(font)}em`);
}

// One hit's shake, as DBP_SHAKE_STOPS pairs of [x%, y%]. The shape is
// still a decaying wobble — that is what reads as an impact rather than as a
// vibration — but every factor inside it is drawn fresh: the peak of each axis,
// the per-stop magnitude, and which way the first kick goes. X alternates sign so
// the card swings back and forth; Y picks its own sign each stop, because a Y that
// mirrored X in lockstep just tilted the whole wobble onto one diagonal.
function feDbpRand([min, max]) {
  return min + Math.random() * (max - min);
}

// Absolute HP, not a fraction of the pool: the thresholds are what the table reads
// as a big hit, and a 50-point hit is a 50-point hit whether it landed on a boss or
// on a goblin. A system whose numbers run on a different scale would want its own.
function feDbpShakeGain(damage) {
  let tier = 0;
  for (const t of DBP_SHAKE_TIERS) if (damage >= t) tier++;
  return DBP_SHAKE_TIER_GAIN[tier] ?? 1;
}

function feDbpShakeProfile(damage) {
  const gain = feDbpShakeGain(Math.abs(Number(damage) || 0));
  const ax = feDbpRand(DBP_SHAKE_X) * gain;
  const ay = feDbpRand(DBP_SHAKE_Y) * gain;
  const dir = Math.random() < 0.5 ? -1 : 1;
  const out = [];
  for (let i = 0; i < DBP_SHAKE_STOPS; i++) {
    const decay = Math.pow(1 - i / DBP_SHAKE_STOPS, DBP_SHAKE_DECAY);
    const sign = dir * (i % 2 === 0 ? 1 : -1);
    const jitter = i === 0 ? DBP_SHAKE_JITTER_FIRST : DBP_SHAKE_JITTER;
    out.push([
      Number((sign * ax * decay * feDbpRand(jitter)).toFixed(2)),
      Number(((Math.random() < 0.5 ? -1 : 1) * ay * decay * feDbpRand(jitter)).toFixed(2)),
    ]);
  }
  return out;
}

// The profile is written to the card AFTER each render rather than emitted into the
// markup, for the same reason the dial's offsets are: the template stays byte-stable
// so feCtRender can skip the rebuild. It has to run in the same task as the rebuild,
// which it does — the keyframes would otherwise resolve against their fallbacks for
// one frame and the shake would visibly start over the old fixed profile.
function feDbpApplyShake(root) {
  for (const el of root.querySelectorAll(".fe-ct-portrait.is-hit")) {
    const id = el.dataset?.combatantId;
    const shake = id ? _dbpHit.get(id)?.shake : null;
    if (!shake) continue;
    for (let i = 0; i < shake.length; i++) {
      el.style.setProperty(`--fe-dbp-k${i + 1}x`, `${shake[i][0]}%`);
      el.style.setProperty(`--fe-dbp-k${i + 1}y`, `${shake[i][1]}%`);
    }
  }
}

function feDbpTick() {
  _dbpTickRaf = 0;
  const now = performance.now();
  let needRender = false;
  let bars = false;
  for (const [id, anim] of [..._dbpAnim]) {
    const done = now - anim.start >= anim.dur;
    const dial = anim.bar ? null : feDbpDialFor(id);
    if (done) {
      _dbpAnim.delete(id);
      // A hidden actor's dial has to turn back into ???, which only a rerender can
      // do. A revealed one already shows its final number, so leave it alone.
      // A bar always needs the rerender: the resting markup is what drops the
      // [data-dbp-bar-roll] marker and hands the caption back to the template.
      if (anim.hidden || anim.bar) needRender = true;
      else if (dial) {
        const strips = feDbpRollStrips(dial);
        feDbpWriteOffsets(strips, feDbpReelSet(anim.to, strips.length));
      }
      continue;
    }
    // One pass for every rolling bar rather than a lookup per animation — they all
    // live under the same root and the applier already re-derives everything it needs.
    if (anim.bar) { bars = true; continue; }
    if (!dial) continue; // panel off or combatant gone — the clock still runs out
    const strips = feDbpRollStrips(dial);
    feDbpWriteOffsets(strips, anim.hidden
      ? feDbpScrambleSet(now, strips.length)
      : feDbpSpinReels(anim, now, strips.length));
  }
  if (bars) {
    const root = document.getElementById(TRACKER_DOM_ID);
    if (root) feDbpApplyBarRoll(root, now);
  }
  if (needRender) feCtScheduleRender();
  if (_dbpAnim.size) _dbpTickRaf = requestAnimationFrame(feDbpTick);
}

function feDbpStartTicker() {
  if (!_dbpTickRaf && _dbpAnim.size) _dbpTickRaf = requestAnimationFrame(feDbpTick);
}

function feDbpReset() {
  if (_dbpTickRaf) cancelAnimationFrame(_dbpTickRaf);
  _dbpTickRaf = 0;
  _dbpAnim.clear();
  _dbpPops.clear();
  _dbpHit.clear();
  _dbpLastHp.clear();
}

// HP change detection. updateActor fires after the document has been updated, so
// the new value is read from the document and the old one comes from _dbpLastHp,
// which we keep ourselves. An unlinked token's actor can share its id with the
// prototype, so combatants are matched on uuid.
function feDbpObserveActorHp(actor) {
  if (!actor || !feCtEnabled() || feCtOriginalActive() || !feCtDbpEnabled()) return;
  const combat = feCtGetCombat();
  if (!combat?.turns?.length) return;
  const hp = feCtResolveHp(actor);
  if (!hp) return;
  const uuid = actor.uuid;
  for (const c of combat.turns) {
    if (!c?.actor || c.actor.uuid !== uuid) continue;
    const prev = _dbpLastHp.get(c.id);
    _dbpLastHp.set(c.id, hp.value);
    if (prev == null || prev === hp.value) continue;
    feDbpBeginHpAnim(c, prev, hp.value);
  }
}

// The per-actor HP secrecy toggle used to live here as a second actor-sheet header
// button of its own. It is the status panel's "수치 숨기기" entry now — one flag, one
// toggle (fe-hp-mask.js); a sheet showing two buttons for the same bit was the whole
// reason to merge them.

// ── the state boundary ────────────────────────────────────────────
//
// The four Maps above are this module's alone. These are everything the tracker
// needs from them, deliberately shaped as questions about a combatant rather than
// as the Maps themselves — exporting the Maps would hand every rule about when a
// stamp is dropped back to the caller.

// A combatant that left must not keep its animation state, or rejoining would
// replay a phantom hit against a stale HP baseline.
export function feDbpPruneState(liveIds) {
  for (const m of [_dbpAnim, _dbpPops, _dbpHit, _dbpLastHp]) {
    for (const id of [...m.keys()]) if (!liveIds.has(id)) m.delete(id);
  }
}

// The HP-change baseline is seeded from a render because updateActor fires AFTER
// the document is updated and would otherwise see no previous value.
export function feDbpHasHpBaseline(id) {
  return _dbpLastHp.has(id);
}

export function feDbpSeedHpBaseline(id, value) {
  _dbpLastHp.set(id, value);
}

// Remaining shake time as a NEGATIVE delay, so an innerHTML rebuild resumes a
// shake in flight instead of rewinding it. null = not shaking; a stamp that has
// run out is dropped here.
export function feDbpHitDelay(id, now) {
  const start = _dbpHit.get(id)?.start;
  if (start == null) return null;
  const d = start - now;
  if (d > -DBP_HIT_MS) return d;
  _dbpHit.delete(id);
  return null;
}

export {
  feCtDbpInsertLayout,
  feDbpApplyBarRoll,
  feDbpApplyInkMetric,
  feDbpApplyOffsets,
  feDbpApplyShake,
  feDbpData,
  feDbpObserveActorHp,
  feDbpReset,
  feDbpStartTicker,
};
