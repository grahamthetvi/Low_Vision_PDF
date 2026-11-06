/**
 * Page color modes for low-vision reading.
 * Invert flips each channel. Yellow, red, blue, and green keep dark ink
 * and map white paper onto that color.
 */

/** @typedef {"none" | "invert" | "yellow" | "red" | "blue" | "green"} PageColorMode */

/** White paper maps to these RGB triples. */
export const PAGE_TINTS = {
  yellow: [255, 235, 59],
  red: [255, 138, 128],
  blue: [130, 177, 255],
  green: [129, 199, 132],
};

const PAGE_COLOR_MODES = new Set([
  "none",
  "invert",
  "yellow",
  "red",
  "blue",
  "green",
]);

/**
 * @param {unknown} value
 * @returns {PageColorMode}
 */
export function normalizePageColor(value) {
  if (typeof value === "string" && PAGE_COLOR_MODES.has(value)) {
    return /** @type {PageColorMode} */ (value);
  }
  return "none";
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 */
function luminance(r, g, b) {
  return 0.299 * r + 0.587 * g + 0.114 * b;
}

/**
 * Recolors rasterized page pixels in place. Transparent pixels are left alone.
 * @param {{ data: Uint8ClampedArray }} imageData
 * @param {unknown} mode
 */
export function applyPageColor(imageData, mode) {
  const color = normalizePageColor(mode);
  if (color === "none") return;

  const data = imageData.data;
  if (color === "invert") {
    for (let i = 0; i < data.length; i += 4) {
      if (data[i + 3] < 12) continue;
      data[i] = 255 - data[i];
      data[i + 1] = 255 - data[i + 1];
      data[i + 2] = 255 - data[i + 2];
    }
    return;
  }

  const tint = PAGE_TINTS[color];
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 12) continue;
    const scale = luminance(data[i], data[i + 1], data[i + 2]) / 255;
    data[i] = Math.round(tint[0] * scale);
    data[i + 1] = Math.round(tint[1] * scale);
    data[i + 2] = Math.round(tint[2] * scale);
  }
}
