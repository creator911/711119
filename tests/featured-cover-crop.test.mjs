import assert from "node:assert/strict";
import test from "node:test";
import { getCoverCropGeometry, moveCoverPositionByDrag } from "../app/lib/featured-cover-crop.ts";

const baseInput = {
  targetRatio: 16 / 10,
  horizontal: 50,
  vertical: 50,
  viewportWidth: 800,
  viewportHeight: 500,
  deltaX: 0,
  deltaY: 0,
};

test("cover crop geometry preserves the 16:10 source ratio", () => {
  const geometry = getCoverCropGeometry(2400, 1200, 16 / 10, 1.5);
  assert.ok(geometry);
  assert.equal(geometry.sourceWidth / geometry.sourceHeight, 16 / 10);
  assert.ok(geometry.maxSourceX > 0);
  assert.ok(geometry.maxSourceY > 0);
});

test("dragging a landscape cover moves the image and clamps horizontal edges", () => {
  const right = moveCoverPositionByDrag({ ...baseInput, imageWidth: 2000, imageHeight: 1000, zoom: 1, deltaX: 100 });
  const left = moveCoverPositionByDrag({ ...baseInput, imageWidth: 2000, imageHeight: 1000, zoom: 1, deltaX: -100 });
  assert.deepEqual(right, { horizontal: 0, vertical: 50 });
  assert.deepEqual(left, { horizontal: 100, vertical: 50 });
});

test("an unavailable crop axis stays fixed while the available axis moves", () => {
  const position = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1000, imageHeight: 1000, zoom: 1, deltaX: 180, deltaY: 100 });
  assert.deepEqual(position, { horizontal: 50, vertical: 16.67 });
});

test("zoomed covers move on both axes without exposing empty space", () => {
  const position = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1600, imageHeight: 1000, zoom: 2, deltaX: 100, deltaY: -50 });
  const clamped = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1600, imageHeight: 1000, zoom: 2, deltaX: -5000, deltaY: 5000 });
  assert.deepEqual(position, { horizontal: 37.5, vertical: 60 });
  assert.deepEqual(clamped, { horizontal: 100, vertical: 0 });
});

test("clicking without movement and responsive preview scaling preserve position", () => {
  const click = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1600, imageHeight: 1000, zoom: 2 });
  const widePreview = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1600, imageHeight: 1000, zoom: 2, deltaX: 100 });
  const narrowPreview = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1600, imageHeight: 1000, zoom: 2, viewportWidth: 400, viewportHeight: 250, deltaX: 50 });
  assert.deepEqual(click, { horizontal: 50, vertical: 50 });
  assert.deepEqual(narrowPreview, widePreview);
});

test("an exact 16:10 image cannot move before it is zoomed", () => {
  const position = moveCoverPositionByDrag({ ...baseInput, imageWidth: 1600, imageHeight: 1000, zoom: 1, deltaX: 200, deltaY: -200 });
  assert.deepEqual(position, { horizontal: 50, vertical: 50 });
});
