import assert from "node:assert/strict";
import test from "node:test";
import { applyPageColor, PAGE_TINTS } from "../js/pageColor.mjs";

/**
 * @param {number[]} pixels RGBA tuples
 */
function imageFrom(pixels) {
  const data = new Uint8ClampedArray(pixels.length * 4);
  pixels.forEach((px, index) => {
    data.set(px, index * 4);
  });
  return { data };
}

/**
 * @param {Uint8ClampedArray} data
 * @param {number} index
 */
function pixel(data, index) {
  const i = index * 4;
  return [data[i], data[i + 1], data[i + 2], data[i + 3]];
}

test("invert flips opaque colors and leaves transparent pixels", () => {
  const image = imageFrom([
    [10, 20, 30, 255],
    [255, 255, 255, 255],
    [0, 0, 0, 255],
    [40, 50, 60, 0],
  ]);
  applyPageColor(image, "invert");
  assert.deepEqual(pixel(image.data, 0), [245, 235, 225, 255]);
  assert.deepEqual(pixel(image.data, 1), [0, 0, 0, 255]);
  assert.deepEqual(pixel(image.data, 2), [255, 255, 255, 255]);
  assert.deepEqual(pixel(image.data, 3), [40, 50, 60, 0]);
});

test("named colors map white paper to the tint and keep black ink", () => {
  for (const mode of ["yellow", "red", "blue", "green"]) {
    const image = imageFrom([
      [255, 255, 255, 255],
      [0, 0, 0, 255],
    ]);
    applyPageColor(image, mode);
    const tint = PAGE_TINTS[mode];
    assert.deepEqual(pixel(image.data, 0), [...tint, 255]);
    assert.deepEqual(pixel(image.data, 1), [0, 0, 0, 255]);
  }
});

test("unknown and original modes leave pixels unchanged", () => {
  const original = [12, 34, 56, 255];
  for (const mode of ["none", "purple", ""]) {
    const image = imageFrom([original]);
    applyPageColor(image, mode);
    assert.deepEqual(pixel(image.data, 0), original);
  }
});
