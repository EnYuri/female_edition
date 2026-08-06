import { test } from "node:test";
import assert from "node:assert/strict";

import {
  cpEffectiveExportTarget,
  cpComputeSourceCrop,
  cpComputeDrawRect,
} from "../scripts/fe-chat-portrait-image.js";

// ---------------------------------------------------------------------------
// cpEffectiveExportTarget
//
// Guards the export path against asking for more pixels than the source has.
// The regression this exists for: `cover` crops to the SHORT side, so the guard
// inside cpResampleToDataURL (`max(nw, nh) <= target`) lets a tall-but-narrow
// source through and then UPSCALES it — a blurrier, larger file than the original.
// ---------------------------------------------------------------------------

test("cpEffectiveExportTarget: cover is bounded by the SHORT side", () => {
  // 200x600 asked for 256: the square crop can only supply 200.
  assert.equal(cpEffectiveExportTarget(200, 600, "cover", 256), 200);
  // Wide is the same case transposed.
  assert.equal(cpEffectiveExportTarget(600, 200, "cover", 256), 200);
});

test("cpEffectiveExportTarget: contain is bounded by the LONG side", () => {
  // contain draws the whole image, so the long side is what has to reach target.
  assert.equal(cpEffectiveExportTarget(200, 600, "contain", 256), 256);
  assert.equal(cpEffectiveExportTarget(200, 220, "contain", 256), 220);
});

test("cpEffectiveExportTarget: never exceeds the requested target", () => {
  assert.equal(cpEffectiveExportTarget(3328, 3677, "cover", 256), 256);
  assert.equal(cpEffectiveExportTarget(3328, 3677, "contain", 256), 256);
  assert.equal(cpEffectiveExportTarget(832, 1216, "cover", 768), 768);
});

test("cpEffectiveExportTarget: never upscales — result <= what the fit can supply", () => {
  for (const [w, h] of [[64, 64], [100, 300], [300, 100], [255, 4000], [1, 1]]) {
    for (const fit of ["cover", "contain"]) {
      const supplied = fit === "contain" ? Math.max(w, h) : Math.min(w, h);
      const eff = cpEffectiveExportTarget(w, h, fit, 256);
      assert.ok(eff <= supplied, `${fit} ${w}x${h}: ${eff} > ${supplied}`);
      assert.ok(eff <= 256, `${fit} ${w}x${h}: exceeded target`);
    }
  }
});

test("cpEffectiveExportTarget: a square source at the target resolves to the target", () => {
  // Equal, not greater — cpResampleToDataURL then returns null and cpBuildExportPortrait
  // reports `keepOriginal`, so the caller PINS the original file. Leaving it unpinned is
  // what capped these portraits at 64-96px while large art was upgraded to 256px.
  assert.equal(cpEffectiveExportTarget(256, 256, "cover", 256), 256);
});

// The `keepOriginal` branch is only safe because a size bail implies a SMALL source:
// it is what lets the caller pin the original file (and skip the avatar downscaler)
// without pushing a full-resolution image into the print doc or the embed budget.
// `cpResampleToDataURL` bails when `max(nw, nh) <= effective`, so assert that this can
// only happen for sources whose long side is already within the requested target.
test("a size bail implies max(srcW, srcH) <= targetPx — the pin-the-original guarantee", () => {
  const TARGET = 256;
  const cases = [
    [64, 64], [256, 256], [200, 220], [257, 257], [200, 600], [600, 200],
    [255, 4000], [832, 1216], [3328, 3677], [768, 768],
  ];
  for (const [w, h] of cases) {
    for (const fit of ["cover", "contain"]) {
      const eff = cpEffectiveExportTarget(w, h, fit, TARGET);
      const bails = Math.max(w, h) <= eff; // cpResampleToDataURL's "nothing to do" test
      if (bails) {
        assert.ok(
          Math.max(w, h) <= TARGET,
          `${fit} ${w}x${h}: bailed with a source larger than the target`
        );
      }
    }
  }
});

test("cpEffectiveExportTarget: unusable input returns 0, never a default", () => {
  assert.equal(cpEffectiveExportTarget(0, 600, "cover", 256), 0);
  assert.equal(cpEffectiveExportTarget(600, 0, "cover", 256), 0);
  assert.equal(cpEffectiveExportTarget(NaN, 600, "cover", 256), 0);
  assert.equal(cpEffectiveExportTarget(undefined, undefined, "cover", 256), 0);
  assert.equal(cpEffectiveExportTarget(-10, 600, "cover", 256), 0);
  assert.equal(cpEffectiveExportTarget(600, 600, "cover", 0), 0);
});

test("cpEffectiveExportTarget: fractional dimensions floor, target rounds", () => {
  assert.equal(cpEffectiveExportTarget(200.9, 600, "cover", 256), 200);
  assert.equal(cpEffectiveExportTarget(4000, 4000, "cover", 255.6), 256);
});

// ---------------------------------------------------------------------------
// cpComputeSourceCrop
// ---------------------------------------------------------------------------

test("cpComputeSourceCrop: cover crops to a square on the short side", () => {
  const c = cpComputeSourceCrop({ srcW: 832, srcH: 1216, fit: "cover" });
  assert.equal(c.sw, 832);
  assert.equal(c.sh, 832);
  assert.equal(c.sx, 0);
  // Not anchorTop -> vertically centered.
  assert.equal(c.sy, (1216 - 832) / 2);
});

test("cpComputeSourceCrop: anchorTop keeps the head (sy = 0)", () => {
  // This is the CHAT portrait case: a tall full-body image must not lose the face.
  const c = cpComputeSourceCrop({ srcW: 832, srcH: 1216, fit: "cover", anchorTop: true });
  assert.equal(c.sy, 0);
  assert.equal(c.sh, 832);
});

test("cpComputeSourceCrop: anchorTop is irrelevant for a wide source", () => {
  // Short side is the height, so the full height is used either way.
  const a = cpComputeSourceCrop({ srcW: 1600, srcH: 400, fit: "cover", anchorTop: true });
  const b = cpComputeSourceCrop({ srcW: 1600, srcH: 400, fit: "cover", anchorTop: false });
  assert.deepEqual(a, b);
  assert.equal(a.sh, 400);
  assert.equal(a.sx, (1600 - 400) / 2);
});

test("cpComputeSourceCrop: contain uses the whole image, ignoring anchorTop", () => {
  const c = cpComputeSourceCrop({ srcW: 832, srcH: 1216, fit: "contain", anchorTop: true });
  assert.deepEqual(c, { sx: 0, sy: 0, sw: 832, sh: 1216 });
});

test("cpComputeSourceCrop: degenerate dimensions clamp to 1 instead of producing NaN", () => {
  const c = cpComputeSourceCrop({ srcW: 0, srcH: NaN, fit: "cover" });
  assert.equal(c.sw, 1);
  assert.equal(c.sh, 1);
  assert.ok(Number.isFinite(c.sx) && Number.isFinite(c.sy));
});

// ---------------------------------------------------------------------------
// cpComputeDrawRect
// ---------------------------------------------------------------------------

test("cpComputeDrawRect: cover fills the box and overflows on one axis only", () => {
  const r = cpComputeDrawRect({ srcW: 200, srcH: 400, dstSize: 100, fit: "cover" });
  assert.equal(r.dw, 100);   // short side exactly fills
  assert.equal(r.dh, 200);   // long side overflows
  assert.equal(r.dx, 0);
  assert.equal(r.dy, -50);   // centered overflow
});

test("cpComputeDrawRect: contain fits inside the box and is LEFT-aligned", () => {
  // Left alignment is a deliberate product decision (empty space on the right only),
  // not centering — do not "fix" this to (s - dw) / 2.
  const r = cpComputeDrawRect({ srcW: 200, srcH: 400, dstSize: 100, fit: "contain" });
  assert.equal(r.dh, 100);
  assert.equal(r.dw, 50);
  assert.equal(r.dx, 0);
  assert.equal(r.dy, 0);
});

test("cpComputeDrawRect: a square source is an exact fit in both modes", () => {
  // The Chromium filtering cliff only bites when cover overflows the box; a square
  // source in a square box does not, which is why the export path pre-crops to square.
  for (const fit of ["cover", "contain"]) {
    const r = cpComputeDrawRect({ srcW: 512, srcH: 512, dstSize: 64, fit });
    assert.deepEqual(r, { dx: 0, dy: 0, dw: 64, dh: 64 });
  }
});
