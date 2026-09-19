/**
 * Offline repair for dnd5e 6.0's ItemGrant UUID validation gap.
 *
 * Class items whose `system.advancement.<id>.configuration.items[].uuid` holds a
 * RELATIVE UUID (`.id` / `.Item.id`) or an EMBEDDED UUID (`Actor.x.Item.y`) fail
 * `DocumentUUIDField({ type:"Item", embedded:false, relative:false })` at document
 * init — the whole item drops out of its parent, taking class-derived HP and
 * attributes with it. dnd5e's own migration never rewrites these. These entries
 * were produced by Plutonium imports under dnd5e 5.x: the pool points at the
 * imported features it already granted to the actor.
 *
 * LevelDB layout (Foundry v13+): embedded documents are separate records —
 * `!actors.items!<actorId>.<itemId>` — not nested inside `!actors!<id>`.
 *
 * Repair strategy per bad entry, resolved against the sibling item the uuid
 * points at:
 *   - sibling is a world item        -> `Item.<id>` (exact, non-embedded)
 *   - sibling is an embedded item    -> replicate the OFFICIAL compendium uuid
 *     its Plutonium hash describes: class/subclass/species items in the dnd5e
 *     system packs carry the canonical grant pools, so we re-derive
 *     `Compendium.dnd5e.<pack>.Item.<id>` from `flags.plutonium.{page,hash}`
 *   - sibling has no Plutonium data  -> its `_stats.compendiumSource`
 *   - unresolvable                   -> drop the pool entry (granted items stay)
 *
 * Usage (Foundry must be STOPPED — LevelDB is single-writer):
 *   node repair-itemgrant-uuids.mjs --scan   "<worldDir>" [--packs "<dnd5ePacksDir>"]
 *   node repair-itemgrant-uuids.mjs --repair "<worldDir>" [--packs "<dnd5ePacksDir>"]
 *
 * Scans every LevelDB collection under <worldDir>/data. --repair backs each
 * touched database up to <world>/repair-backup-<timestamp>/ first.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";

const require = createRequire("C:/Program Files/Foundry Virtual Tabletop/resources/app/main.mjs");
const { ClassicLevel } = require("classic-level");

const [mode, worldDir, ...rest] = process.argv.slice(2);
if (!["--scan", "--repair"].includes(mode) || !worldDir) {
  console.error('usage: node repair-itemgrant-uuids.mjs --scan|--repair "<worldDir>" [--packs "<dnd5ePacksDir>"]');
  process.exit(1);
}
const packsIdx = rest.indexOf("--packs");
const packsDir = packsIdx >= 0
  ? rest[packsIdx + 1]
  : path.join(worldDir, "..", "..", "systems", "dnd5e", "packs");

const ID16 = /^[A-Za-z0-9]{16}$/;
const DOC_TYPES = new Set(["Actor", "Item", "Scene", "Token", "JournalEntry", "RollTable",
  "Cards", "Playlist", "Combat", "Macro", "Folder", "User", "ChatMessage", "Combatant",
  "ActiveEffect", "TableResult", "PlaylistSound", "Card", "AmbientLight", "AmbientSound",
  "Drawing", "MeasuredTemplate", "Note", "Tile", "Wall", "Region", "Page"]);

/**
 * Classify `uuid`: {bad:false} | {bad:true, kind:"sibling", refId} for `.id`/`.Type.id`
 * | {bad:true, kind:"embedded", parentType, parentId, refType, refId}
 * | {bad:true, kind:"unresolvable"}.
 */
function badUuid(uuid) {
  if (typeof uuid !== "string" || !uuid) return { bad: false };
  if (uuid.startsWith("Compendium.")) return { bad: false };
  if (uuid.startsWith(".")) {
    const segs = uuid.split(".").filter(Boolean);
    if (!segs.length) return { bad: false };
    if (segs.length === 1) return { bad: true, kind: "sibling", refId: segs[0] };
    if (segs.length === 2 && DOC_TYPES.has(segs[0])) {
      return { bad: true, kind: "sibling", refType: segs[0], refId: segs[1] };
    }
    return { bad: true, kind: "unresolvable" };
  }
  const segs = uuid.split(".");
  if (segs.length >= 4 && segs.length % 2 === 0) {
    const pairs = [];
    for (let i = 0; i < segs.length; i += 2) pairs.push([segs[i], segs[i + 1]]);
    if (pairs.every(([t, id]) => DOC_TYPES.has(t) && ID16.test(id))) {
      const [refType, refId] = pairs.at(-1);
      const [parentType, parentId] = pairs.at(-2);
      return { bad: true, kind: "embedded", parentType, parentId, refType, refId };
    }
  }
  return { bad: false };
}

const systemOf = doc => doc.system ?? doc.data ?? {};
const compendiumSourceOf = ref =>
  ref?._stats?.compendiumSource ?? ref?.flags?.core?.sourceId ?? null;

const openDb = dir => new ClassicLevel(dir, { keyEncoding: "utf8", valueEncoding: "json" });

// ---------- world lookup maps ----------
const dataDir = path.join(worldDir, "data");

async function loadCollection(name) {
  const map = new Map();
  const db = openDb(path.join(dataDir, name));
  try {
    for await (const [key, doc] of db.iterator()) {
      // `!actors!<id>` -> "<id>"; `!actors.items!<aid>.<iid>` -> "<aid>.<iid>"
      map.set(key.slice(key.lastIndexOf("!") + 1), doc);
    }
  } finally { await db.close(); }
  return map;
}

const worldItems = fs.existsSync(path.join(dataDir, "items"))
  ? await loadCollection("items") : new Map();
const worldActors = fs.existsSync(path.join(dataDir, "actors"))
  ? await loadCollection("actors") : new Map();
console.log(`lookup maps: ${worldActors.size} actor-side records, ${worldItems.size} items`);

// ---------- dnd5e pack index ----------
/**
 * `itemByUuid` : "Compendium.dnd5e.<pack>.Item.<id>" -> { identifier, name }
 * `scoped`     : "class|sub|race:<slug>" -> Map<identifier, uuid>
 *                built from the official grant pools of class/subclass/species
 *                items so repaired pools match what the system itself writes
 * `byIdentifier`: identifier -> [{ uuid, id, folderName }]
 */
const itemByUuid = new Map();
const scoped = new Map();
const byIdentifier = new Map();
const PACK_INDEX_ORDER = ["classes24", "classfeatures", "origins24", "feats24",
  "races", "monsterfeatures24", "items", "equipment24"];

const CLASS_CODES = { barbarian: "brb", bard: "brd", cleric: "clc", druid: "drd",
  fighter: "ftr", monk: "mnk", paladin: "pdn", ranger: "rgr", rogue: "rge",
  sorcerer: "scr", warlock: "wlk", wizard: "wzd" };

function identifierize(text) {
  return decodeURIComponent(text).toLowerCase()
    .replace(/['\u2018\u2019`"]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

// Two passes per pack: index every item first, then build scope pools — pool
// entries can reference items scanned later (or in a later pack).
async function loadPackIndex() {
  for (const pack of PACK_INDEX_ORDER) {
    const dir = path.join(packsDir, pack);
    if (!fs.existsSync(path.join(dir, "CURRENT"))) continue;
    const db = openDb(dir);
    const folders = new Map();
    const docs = [];
    try {
      for await (const [key, doc] of db.iterator()) {
        if (key.startsWith("!folders!")) folders.set(doc._id, doc.name ?? "");
        else if (key.startsWith("!items!")) docs.push(doc);
      }
    } finally { await db.close(); }
    for (const doc of docs) {
      const uuid = `Compendium.dnd5e.${pack}.Item.${doc._id}`;
      const identifier = systemOf(doc).identifier ?? null;
      itemByUuid.set(uuid, { identifier, name: doc.name ?? "" });
      if (identifier) {
        const list = byIdentifier.get(identifier) ?? [];
        list.push({ uuid, id: doc._id, folderName: folders.get(doc.folder) ?? "", pack });
        byIdentifier.set(identifier, list);
      }
    }
  }
  // Pools are resolved only after every pack item is indexed.
  for (const pack of PACK_INDEX_ORDER) {
    const dir = path.join(packsDir, pack);
    if (!fs.existsSync(path.join(dir, "CURRENT"))) continue;
    const db = openDb(dir);
    const docs = [];
    try {
      for await (const [key, doc] of db.iterator()) if (key.startsWith("!items!")) docs.push(doc);
    } finally { await db.close(); }
    for (const doc of docs) {
      const scopeKind = doc.type === "class" ? "class"
        : doc.type === "subclass" ? "sub"
        : doc.type === "species" ? "race" : null;
      const identifier = systemOf(doc).identifier ?? null;
      const scopeSlug = identifierize(identifier ?? doc.name ?? "");
      if (!scopeKind || !scopeSlug) continue;
      const pool = scoped.get(`${scopeKind}:${scopeSlug}`) ?? new Map();
      for (const adv of Object.values(systemOf(doc).advancement ?? {})) {
        if (adv?.type !== "ItemGrant") continue;
        for (const e of adv.configuration?.items ?? []) {
          const target = itemByUuid.get(e?.uuid);
          if (target?.identifier) pool.set(target.identifier, e.uuid);
        }
      }
      scoped.set(`${scopeKind}:${scopeSlug}`, pool);
    }
  }
}

await loadPackIndex();
console.log(`pack index: ${itemByUuid.size} items, ${scoped.size} grant scopes`);

// ---------- Plutonium hash parsing ----------
/**
 * `classFeature:<slug>_<class>_<src>_<lvl>_<src>`
 * `subclassFeature:<slug>_<class>_<src>_<subclass>_<src>_<lvl>_<src>`
 * `raceFeature:<slug>_<race>_<src>_<src>`
 * `feats.html:<slug>_<src>` / `optionalfeatures.html:<slug>_<src>`
 */
function parsePlutonium(flags) {
  const page = flags?.plutonium?.page;
  const hash = flags?.plutonium?.hash;
  if (!page || !hash) return null;
  const seg = hash.split("_");
  const out = { page, slug: identifierize(seg[0]) };
  if (page === "classFeature") out.className = decodeURIComponent(seg[1] ?? "").toLowerCase();
  else if (page === "subclassFeature") {
    out.className = decodeURIComponent(seg[1] ?? "").toLowerCase();
    out.subName = decodeURIComponent(seg[3] ?? "").toLowerCase();
  } else if (page === "raceFeature") {
    out.raceName = decodeURIComponent(seg[1] ?? "").toLowerCase();
  }
  return out.slug ? out : null;
}

function englishTail(name) {
  const text = String(name ?? "");
  const afterColon = text.includes(":") ? text.slice(text.lastIndexOf(":") + 1) : text;
  const stripped = afterColon.replace(/[\uac00-\ud7a3\u3130-\u318f\u1100-\u11ff]/g, " ")
    .replace(/\s+/g, " ").trim();
  return stripped || text.trim();
}

const HANGUL = /[\uac00-\ud7a3\u3130-\u318f\u1100-\u11ff]/;

/** Stock imports carry English descriptions; Hangul text means localized/custom. */
function hasLocalizedDescription(sibling) {
  const desc = systemOf(sibling).description ?? {};
  return HANGUL.test(desc.value ?? "") || HANGUL.test(desc.short ?? "")
    || HANGUL.test(desc.chat ?? "");
}

/**
 * Resolve a sibling embedded item to a compendium uuid, or null to drop.
 * A candidate is accepted only when the sibling still carries the official
 * name and an unlocalized description — a renamed or Korean-described item is
 * a user customization (e.g. a renamed ability) and must not be silently
 * aliased to the official compendium version.
 */
function compendiumMatch(sibling) {
  if (!sibling) return null;
  if (hasLocalizedDescription(sibling)) return null;
  const nameKey = englishTail(sibling.name).toLowerCase();
  const official = uuid => {
    const name = itemByUuid.get(uuid)?.name;
    return name && name.toLowerCase() === nameKey ? uuid : null;
  };
  const plut = parsePlutonium(sibling.flags);
  if (plut) {
    const id = plut.slug;
    if (plut.subName) {
      const u = official(scoped.get(`sub:${identifierize(plut.subName)}`)?.get(id));
      if (u) return u;
    }
    if (plut.className) {
      const u = official(scoped.get(`class:${identifierize(plut.className)}`)?.get(id));
      if (u) return u;
    }
    if (plut.raceName) {
      const u = official(scoped.get(`race:${identifierize(plut.raceName)}`)?.get(id));
      if (u) return u;
    }
    // Global fallback: unique identifier, optionally narrowed by class hint.
    let candidates = byIdentifier.get(id) ?? [];
    if (plut.className && candidates.length > 1) {
      const code = CLASS_CODES[plut.className];
      const narrowed = candidates.filter(c =>
        (code && c.id.startsWith(`phb${code}`)) ||
        c.folderName.toLowerCase().includes(plut.className));
      if (narrowed.length) candidates = narrowed;
    }
    const uuids = [...new Set(candidates.map(c => c.uuid))];
    if (uuids.length === 1) return official(uuids[0]);
    return null;
  }
  // Name fallback for siblings without Plutonium data.
  const src = compendiumSourceOf(sibling);
  if (src) return src;
  const nameId = identifierize(englishTail(sibling.name));
  const candidates = byIdentifier.get(nameId) ?? [];
  const uuids = [...new Set(candidates.map(c => c.uuid))];
  return uuids.length === 1 ? uuids[0] : null;
}

/**
 * Resolve a bad uuid to a replacement, or null to drop.
 * `recordKey` is the LevelDB key of the record carrying the advancement —
 * `!actors.items!<aid>.<iid>` tells us which actor's item collection a `.id`
 * shorthand belongs to.
 */
function resolveUuid(verdict, recordKey) {
  // Actor context for `.id` shorthand: `!actors.items!<aid>.<iid>` records and
  // `!actors!<aid>` records (whose `items` array copies are also scanned) both
  // resolve siblings inside actor <aid>'s embedded item collection.
  const actorId = recordKey.startsWith("!actors.items!")
    ? recordKey.slice("!actors.items!".length, recordKey.lastIndexOf("."))
    : recordKey.startsWith("!actors!")
      ? recordKey.slice("!actors!".length)
      : null;

  if (verdict.kind === "sibling") {
    if (verdict.refType && verdict.refType !== "Item") return null;
    if (actorId) {
      // `.id` on an embedded item -> sibling record on the same actor.
      return compendiumMatch(worldActors.get(`${actorId}.${verdict.refId}`));
    }
    // `.id` on a standalone world item -> another record in items collection.
    const sibling = worldItems.get(verdict.refId);
    if (sibling) return `Item.${verdict.refId}`;
    return null;
  }
  if (verdict.kind === "embedded" && verdict.refType === "Item") {
    if (verdict.parentType === "Actor") {
      return compendiumMatch(worldActors.get(`${verdict.parentId}.${verdict.refId}`));
    }
    return null;
  }
  return null;
}

// ---------- scan + collect repairs ----------
const collections = fs.readdirSync(dataDir, { withFileTypes: true })
  .filter(d => d.isDirectory() && fs.existsSync(path.join(dataDir, d.name, "CURRENT")))
  .map(d => d.name);
console.log(`collections: ${collections.join(", ")}`);

const results = { docs: 0, rewritten: 0, dropped: 0 };
const repairs = []; // { name, dbPath, pending:[{key,doc}] }

for (const name of collections) {
  const dbPath = path.join(dataDir, name);
  const db = openDb(dbPath);
  const pending = [];
  try {
    for await (const [key, doc] of db.iterator()) {
      results.docs++;
      let touched = false;
      // Top-level item records AND embedded item records (`!actors.items!`) can
      // both carry advancements; parent actor copies inside `doc.items` are
      // checked too in case a collection denormalizes them.
      const carriers = [doc, ...(doc.items ?? [])];
      for (const item of carriers) {
        const advs = systemOf(item).advancement;
        if (!advs) continue;
        for (const adv of Object.values(advs)) {
          const items = adv?.configuration?.items;
          if (!Array.isArray(items)) continue;
          for (const e of items) {
            const verdict = badUuid(e?.uuid);
            if (!verdict.bad) continue;
            const replacement = verdict.kind === "unresolvable"
              ? null : resolveUuid(verdict, key);
            if (replacement) {
              console.log(`  FIX   [${name}] ${doc.name ?? key} / ${item.name}: ${e.uuid} -> ${replacement}`);
              e.uuid = replacement;
              results.rewritten++;
            } else {
              console.log(`  DROP  [${name}] ${doc.name ?? key} / ${item.name}: ${e.uuid}`);
              e.__drop = true;
              results.dropped++;
            }
            touched = true;
          }
          adv.configuration.items = items.filter(e => !e.__drop);
          for (const e of adv.configuration.items) delete e.__drop;
        }
      }
      if (touched) pending.push({ key, doc });
    }
  } finally { await db.close(); }
  repairs.push({ name, dbPath, pending });
  console.log(`[${name}] ${pending.length} record(s) to update`);
}

console.log(`\nscan: ${results.docs} docs — ${results.rewritten} uuid(s) rewritten, ${results.dropped} dropped`);

if (mode === "--repair") {
  const touched = repairs.filter(r => r.pending.length);
  if (!touched.length) { console.log("nothing to repair"); process.exit(0); }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupRoot = path.join(worldDir, `repair-backup-${stamp}`);
  for (const { name, dbPath, pending } of touched) {
    const dst = path.join(backupRoot, name);
    fs.mkdirSync(dst, { recursive: true });
    for (const f of fs.readdirSync(dbPath)) fs.copyFileSync(path.join(dbPath, f), path.join(dst, f));
    console.log(`backup: ${dbPath} -> ${dst}`);
    const db = openDb(dbPath);
    try {
      for (const { key, doc } of pending) await db.put(key, doc);
    } finally { await db.close(); }
    console.log(`[${name}] repaired ${pending.length} record(s)`);
  }
}
