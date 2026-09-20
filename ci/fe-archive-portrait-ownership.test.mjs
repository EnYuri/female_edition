// Tripwire: the export-portrait ownership marker has ONE spelling in the archive
// family, and the one unavoidable copy agrees with it.
//
// `feUpgradePortraitsForExport` marks a portrait `data-fe-export-portrait="1"` and
// owns its `src` until its undo runs. Three archive passes and one live pass must
// honour that, and they used to spell the check four different ways across four
// files (`!dataset.feExportPortrait`, `dataset.feExportPortrait`, `!== "1"` twice).
// Equivalent only because "1" is the sole value ever written. docs/chat.md defends
// this invariant with three separate MUST-keep sections — which is the symptom of
// it having no single owner in code.
//
// It now lives in `feIsExportOwnedImage` (fe-archive-output.js). The exception is
// fe-chat-portrait-image.js, which has zero imports by deliberate design, so its
// `cpMayWriteScreenPortraitSource` stays a local copy — pinned here instead.

import test from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";

const SCRIPTS = new URL("../scripts/", import.meta.url);
const read = (f) => readFileSync(new URL(f, SCRIPTS), "utf8");

const MARKER = "feExportPortrait";
const FAMILY = readdirSync(SCRIPTS)
  .filter((f) => f === "fe-chat-archive.js" || /^fe-archive-.*\.js$/.test(f));

test("feIsExportOwnedImage is the archive family's only marker reader", () => {
  const offenders = [];
  for (const file of FAMILY) {
    const src = read(file);
    src.split(/\r?\n/).forEach((line, i) => {
      if (!line.includes(MARKER)) return;
      if (line.trim().startsWith("//") || line.trim().startsWith("*")) return;
      // The owner itself, plus the writer/undo in fe-archive-snapshot.js, are the
      // only places allowed to touch the attribute directly.
      const isOwner = file === "fe-archive-output.js" && line.includes("img?.dataset?.");
      const isWriter = /dataset\.feExportPortrait\s*=/.test(line) || /delete .*dataset\.feExportPortrait/.test(line);
      if (isOwner || isWriter) return;
      offenders.push(`${file}:${i + 1}  ${line.trim()}`);
    });
  }
  assert.deepEqual(offenders, [], "read the marker through feIsExportOwnedImage instead");
});

test("every pass that skips export-owned images honours the marker", () => {
  // Identify the honourers by the FUNCTION that must skip, not by the file it
  // currently lives in — this suite already survived one refactor that moved
  // feUpgradePortraitsForExport between modules.
  const owners = ["feDownscaleImagesForPrint", "feRestoreOriginalPortraitSources", "feUpgradePortraitsForExport"];
  const missing = [];
  for (const fn of owners) {
    const file = FAMILY.find((f) => new RegExp(`^export\\s+(?:async\\s+)?function\\s+${fn}\\b`, "m").test(read(f)));
    assert.ok(file, `${fn} no longer exists anywhere in the archive family`);
    if (!read(file).includes("feIsExportOwnedImage")) missing.push(`${fn} (${file})`);
  }
  assert.deepEqual(missing, [], "these passes no longer honour the export-portrait marker");
});

test("the live resampler's private copy agrees with the shared predicate", () => {
  const live = read("fe-chat-portrait-image.js");

  // The design constraint that forces the copy to exist. If this ever becomes false,
  // delete the copy and import feIsExportOwnedImage instead.
  const imports = live.split(/\r?\n/).filter((l) => /^import\b/.test(l));
  assert.deepEqual(imports, [], "fe-chat-portrait-image.js gained imports — drop its private copy");

  const fn = live.slice(live.indexOf("function cpMayWriteScreenPortraitSource("));
  const body = fn.slice(0, fn.indexOf("\n}"));
  // Same attribute, same sole accepted value, opposite polarity ("may write" === "not owned").
  assert.match(body, /dataset\?\.feExportPortrait !== "1"/);

  const owner = read("fe-archive-output.js");
  const ownerFn = owner.slice(owner.indexOf("export function feIsExportOwnedImage("));
  assert.match(ownerFn.slice(0, ownerFn.indexOf("\n}")), /dataset\?\.feExportPortrait === "1"/);
});
