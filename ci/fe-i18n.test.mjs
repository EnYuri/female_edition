import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { feLocalize, feFormat, feLocalizeHTML, feFormatHTML } from "../scripts/fe-i18n.js";
import { FE_SETTING_DEFINITIONS, CHOICES, FE_DEFAULTS } from "../scripts/fe-settings-data.js";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("module.json", root), "utf8"));

// female_edition's OWN translations only. The manifest also registers the Korean and
// English strings of the vendored Tidy 5e Classic fork (tidy-classic/public/lang/), which
// are third-party `TIDY5E.*` keys redistributed as-is — they are not ours to consolidate,
// rename or lint, and they must stay registered so the fork keeps its strings even if
// tidy5e-sheet 14 is uninstalled.
const feLanguageEntries = manifest.languages.filter(
  entry => entry.lang === "ko" && !entry.path.startsWith("tidy-classic/"));
const translations = Object.assign({}, ...feLanguageEntries
  .map(entry => JSON.parse(readFileSync(new URL(entry.path, root), "utf8"))));

test("a single korean language file holds every translation without duplicate keys", () => {
  const entries = feLanguageEntries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].path, "lang/ko.json");
  const source = readFileSync(new URL(entries[0].path, root), "utf8");
  const seen = new Set();
  for (const match of source.matchAll(/^\t"([^"]+)":/gm)) {
    assert.equal(seen.has(match[1]), false, `Duplicate translation: ${match[1]}`);
    seen.add(match[1]);
  }
  assert.equal(seen.size, Object.keys(translations).length);
  for (const value of Object.values(translations)) assert.equal(typeof value, "string");
});

test("UI translation keys used by scripts, templates and settings exist", () => {
  for (const directory of ["scripts", "templates"]) {
    for (const file of readdirSync(new URL(`${directory}/`, root))) {
      if (!/\.(js|hbs|html)$/.test(file)) continue;
      const source = readFileSync(new URL(`${directory}/${file}`, root), "utf8");
      for (const match of source.matchAll(/"((?:FE\.|FEAPH\.|FECT\.|FESP\.|FETP\.)[\w.]+)"/g)) {
        const key = match[1];
        assert.ok(typeof translations[key] === "string" || Object.keys(translations).some(candidate => candidate.startsWith(`${key}.`)),
          `${file}: ${key}`);
      }
    }
  }
  for (const [key, definition] of Object.entries(FE_SETTING_DEFINITIONS)) {
    assert.equal(/[가-힣]/.test(definition.name ?? ""), false, key);
    assert.equal(/[가-힣]/.test(definition.hint ?? ""), false, key);
  }
  for (const choices of Object.values(CHOICES)) {
    for (const label of Object.values(choices)) {
      assert.equal(/[가-힣]/.test(label), false, label);
    }
  }
  // Translation keys describe labels; persisted choice values remain unchanged.
  assert.equal(FE_DEFAULTS.ceMergeMode, "standard");
  assert.equal(FE_DEFAULTS.ceExportPrintImageMode, "downscaleLite");
});

test("localization resolves lazily and escapes translated HTML text and parameters", () => {
  const previousGame = globalThis.game;
  try {
    delete globalThis.game;
    assert.equal(feLocalize("FE.Common.Save"), "FE.Common.Save");
    globalThis.game = {
      i18n: {
        localize: key => translations[key] ?? key,
        format: (key, data) => (translations[key] ?? key).replace(/\{(\w+)\}/g, (_, name) => data[name]),
      },
    };
    assert.equal(feLocalize("FE.Common.Save"), "저장");
    assert.equal(feFormat("FE.ChatArchive.MessageCount", { count: 42 }), "메시지 42개");
    assert.equal(feFormatHTML("FE.ChatArchive.MessageCount", { count: '<img src="x">&\'' }),
      "메시지 &lt;img src=&quot;x&quot;&gt;&amp;&#39;개");
    globalThis.game.i18n.localize = () => '<b title="x">&\'</b>';
    assert.equal(feLocalizeHTML("example"), "&lt;b title=&quot;x&quot;&gt;&amp;&#39;&lt;/b&gt;");
  } finally {
    if (previousGame === undefined) delete globalThis.game;
    else globalThis.game = previousGame;
  }
});

test("settings selectOptions explicitly localizes labels without changing option values", () => {
  const source = readFileSync(new URL("templates/fe-settings-menu.hbs", root), "utf8");
  const options = [...source.matchAll(/{{selectOptions choices\.[^}]+}}/g)];
  assert.ok(options.length > 0);
  assert.ok(options.every(match => match[0].includes("localize=true")));
  for (const [key, value] of Object.entries(translations)) {
    assert.equal(/<(?:input|select|button)\b/i.test(value), false, `${key} contains form structure`);
  }
});
