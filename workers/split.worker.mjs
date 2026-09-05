/**
 * Off-main-thread splitting and rotation of page bitmaps.
 * No network I/O; receives ImageBitmap from the main thread.
 *
 * Optional "Smart Crop" for automatic mode: analyzes ink projection to find
 * content bands and snaps split lines to avoid bisecting blocks.
 */

/**
 * @param {ImageBitmap} src
 * @param {number} degrees 0, 90, 180, or 270
 * @returns {ImageBitmap}
 */
function rotateImageBitmap(src, degrees) {
  const d = ((degrees % 360) + 360) % 360;
  if (d === 0) {
    const c = new OffscreenCanvas(src.width, src.height);
    c.getContext("2d").drawImage(src, 0, 0);
    return c.transferToImageBitmap();
  }

  const w = src.width;
  const h = src.height;
  const outW = d === 90 || d === 270 ? h : w;
  const outH = d === 90 || d === 270 ? w : h;
  const canvas = new OffscreenCanvas(outW, outH);
  const ctx = canvas.getContext("2d");
  ctx.translate(outW / 2, outH / 2);
  ctx.rotate((d * Math.PI) / 180);
  ctx.drawImage(src, -w / 2, -h / 2);
  return canvas.transferToImageBitmap();
}

/**
 * @param {Uint8ClampedArray} data
 * @param {number} idx
 * @param {number} threshold
 */
function isInkPixel(data, idx, threshold) {
  const a = data[idx + 3];
  if (a < 12) return false;
  const r = data[idx];
  const g = data[idx + 1];
  const b = data[idx + 2];
  return !(r >= threshold && g >= threshold && b >= threshold);
}

/**
 * @param {ImageData} imageData
 * @param {number} threshold
 * @returns {boolean[]}
 */
function rowInkMask(imageData, threshold) {
  const { data, width, height } = imageData;
  const mask = new Array(height);
  const minCount = Math.max(2, Math.floor(width * 0.0008));
  for (let y = 0; y < height; y++) {
    let count = 0;
    const row = y * width * 4;
    for (let x = 0; x < width; x++) {
      if (isInkPixel(data, row + x * 4, threshold)) count++;
      if (count >= minCount) break;
    }
    mask[y] = count >= minCount;
  }
  return mask;
}

/**
 * @param {ImageData} imageData
 * @param {number} threshold
 * @returns {boolean[]}
 */
function colInkMask(imageData, threshold) {
  const { data, width, height } = imageData;
  const mask = new Array(width);
  const minCount = Math.max(2, Math.floor(height * 0.0008));
  for (let x = 0; x < width; x++) {
    let count = 0;
    for (let y = 0; y < height; y++) {
      const i = (y * width + x) * 4;
      if (isInkPixel(data, i, threshold)) count++;
      if (count >= minCount) break;
    }
    mask[x] = count >= minCount;
  }
  return mask;
}

/**
 * Merge consecutive true runs; join runs separated by gaps <= maxGap.
 * @param {boolean[]} mask
 * @param {number} maxGap
 * @returns {{ start: number; end: number }[]}
 */
function maskToBands(mask, maxGap) {
  const bands = [];
  let i = 0;
  const n = mask.length;
  while (i < n) {
    while (i < n && !mask[i]) i++;
    if (i >= n) break;
    let start = i;
    let end = i;
    i++;
    while (i < n) {
      if (mask[i]) {
        end = i;
        i++;
        continue;
      }
      let gap = 0;
      let j = i;
      while (j < n && !mask[j]) {
        gap++;
        j++;
      }
      if (gap <= maxGap && j < n && mask[j]) {
        i = j;
        continue;
      }
      break;
    }
    bands.push({ start, end });
  }
  return bands;
}

/**
 * Split at row y: upper is [0, y), lower is [y, height).
 * Band [top, end] (inclusive) is bisected when top < y <= end.
 * @param {number} y0
 * @param {{ start: number; end: number }[]} bands
 * @returns {number}
 */
function snapHorizontalLine(y0, bands) {
  let y = y0;
  for (let iter = 0; iter < bands.length + 2; iter++) {
    let changed = false;
    for (const b of bands) {
      const top = b.start;
      const end = b.end;
      if (top < y && y <= end) {
        const above = top;
        const below = end + 1;
        const da = Math.abs(y0 - above);
        const db = Math.abs(y0 - below);
        y = da <= db ? above : below;
        changed = true;
      }
    }
    if (!changed) break;
  }
  return y;
}

/**
 * @param {number} x0
 * @param {{ start: number; end: number }[]} bands
 */
function snapVerticalLine(x0, bands) {
  return snapHorizontalLine(x0, bands);
}

/**
 * @param {number} h
 * @param {number} segments
 * @param {number} minSeg
 * @param {{ start: number; end: number }[]} bands
 * @returns {number[]}
 */
function smartHorizontalCuts(h, segments, minSeg, bands) {
  /** @type {number[]} */
  const cuts = [0];
  for (let i = 1; i < segments; i++) {
    const ideal = Math.floor((i * h) / segments);
    const prev = cuts[i - 1];
    const minY = Math.min(h - minSeg, prev + minSeg);
    const maxY = h - minSeg;
    let y = Math.max(minY, Math.min(maxY, ideal));
    y = snapHorizontalLine(y, bands);
    if (y < minY) y = minY;
    if (y > maxY) y = maxY;
    if (y <= prev) y = Math.min(maxY, prev + minSeg);
    cuts.push(y);
  }
  cuts.push(h);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < cuts.length - 1; i++) {
      const minY = cuts[i - 1] + minSeg;
      const maxY = cuts[i + 1] - minSeg;
      if (minY > maxY) continue;
      let y = Math.max(minY, Math.min(maxY, cuts[i]));
      y = snapHorizontalLine(y, bands);
      if (y < minY) y = minY;
      if (y > maxY) y = maxY;
      cuts[i] = y;
    }
  }
  return cuts;
}

/**
 * @param {number} w
 * @param {number} segments
 * @param {number} minSeg
 * @param {{ start: number; end: number }[]} bands
 */
function smartVerticalCuts(w, segments, minSeg, bands) {
  /** @type {number[]} */
  const cuts = [0];
  for (let i = 1; i < segments; i++) {
    const ideal = Math.floor((i * w) / segments);
    const prev = cuts[i - 1];
    const minX = Math.min(w - minSeg, prev + minSeg);
    const maxX = w - minSeg;
    let x = Math.max(minX, Math.min(maxX, ideal));
    x = snapVerticalLine(x, bands);
    if (x < minX) x = minX;
    if (x > maxX) x = maxX;
    if (x <= prev) x = Math.min(maxX, prev + minSeg);
    cuts.push(x);
  }
  cuts.push(w);
  for (let pass = 0; pass < 3; pass++) {
    for (let i = 1; i < cuts.length - 1; i++) {
      const minX = cuts[i - 1] + minSeg;
      const maxX = cuts[i + 1] - minSeg;
      if (minX > maxX) continue;
      let x = Math.max(minX, Math.min(maxX, cuts[i]));
      x = snapVerticalLine(x, bands);
      if (x < minX) x = minX;
      if (x > maxX) x = maxX;
      cuts[i] = x;
    }
  }
  return cuts;
}

/**
 * Detect when auto splits would leave a tiny sliver segment, which often means
 * a full-page graphic (e.g. vertical rule) confused ink-based snapping.
 * @param {number[]} cuts pixel positions including 0 and totalSize
 * @param {number} totalSize
 * @param {number} segments
 */
function analyzeAmbiguousCuts(cuts, totalSize, segments) {
  const idealSegSize = totalSize / segments;
  const sliverThreshold = Math.max(24, totalSize * 0.06);
  /** @type {{ segmentIndex: number; segmentSize: number; reason: string }[]} */
  const reasons = [];

  for (let i = 0; i < segments; i++) {
    const segSize = cuts[i + 1] - cuts[i];
    if (segSize < sliverThreshold) {
      reasons.push({
        segmentIndex: i,
        segmentSize: segSize,
        reason: "tiny_segment",
      });
    }
  }

  for (let i = 1; i < cuts.length - 1; i++) {
    const ideal = Math.floor((i * totalSize) / segments);
    const actual = cuts[i];
    const prevCut = cuts[i - 1];
    const nextCut = cuts[i + 1];
    const minAdjacent = Math.min(actual - prevCut, nextCut - actual);
    if (
      minAdjacent < sliverThreshold &&
      Math.abs(actual - ideal) > totalSize * 0.03
    ) {
      const segIdx = minAdjacent === actual - prevCut ? i - 1 : i;
      if (!reasons.some((r) => r.segmentIndex === segIdx)) {
        reasons.push({
          segmentIndex: segIdx,
          segmentSize: minAdjacent,
          reason: "edge_sliver",
        });
      }
    }
  }

  return {
    needsReview: reasons.length > 0,
    reasons,
    sliverThreshold,
    idealSegSize,
  };
}

/**
 * @param {ImageBitmap} source
 * @param {'horizontal' | 'vertical'} direction
 * @param {number} segments
 * @param {boolean} smartCrop
 */
function computeAutoCuts(source, direction, segments, smartCrop) {
  const w = source.width;
  const h = source.height;

  if (direction === "horizontal") {
    const minSeg = Math.max(
      1,
      Math.min(Math.max(24, Math.floor(h / 200)), Math.floor(h / (segments + 1)) - 1),
    );
    /** @type {number[]} */
    let cutYs;
    if (smartCrop && segments > 1) {
      const canvas = new OffscreenCanvas(w, h);
      const ctx = canvas.getContext("2d");
      ctx.drawImage(source, 0, 0);
      const imageData = ctx.getImageData(0, 0, w, h);
      const mask = rowInkMask(imageData, 245);
      const maxGap = Math.max(2, Math.min(8, Math.floor(h / 120)));
      const bands = maskToBands(mask, maxGap);
      cutYs = smartHorizontalCuts(h, segments, minSeg, bands);
    } else {
      cutYs = [];
      const base = Math.floor(h / segments);
      for (let i = 0; i <= segments; i++) {
        if (i === 0) cutYs.push(0);
        else if (i === segments) cutYs.push(h);
        else cutYs.push(i * base);
      }
    }
    const ambiguity = smartCrop && segments > 1
      ? analyzeAmbiguousCuts(cutYs, h, segments)
      : { needsReview: false, reasons: [], sliverThreshold: 0, idealSegSize: h / segments };
    return { cuts: cutYs, minSeg, ambiguity, axisSize: h };
  }

  const minSeg = Math.max(
    1,
    Math.min(Math.max(24, Math.floor(w / 200)), Math.floor(w / (segments + 1)) - 1),
  );
  /** @type {number[]} */
  let cutXs;
  if (smartCrop && segments > 1) {
    const canvas = new OffscreenCanvas(w, h);
    const ctx = canvas.getContext("2d");
    ctx.drawImage(source, 0, 0);
    const imageData = ctx.getImageData(0, 0, w, h);
    const mask = colInkMask(imageData, 245);
    const maxGap = Math.max(2, Math.min(8, Math.floor(w / 120)));
    const bands = maskToBands(mask, maxGap);
    cutXs = smartVerticalCuts(w, segments, minSeg, bands);
  } else {
    cutXs = [];
    const base = Math.floor(w / segments);
    for (let i = 0; i <= segments; i++) {
      if (i === 0) cutXs.push(0);
      else if (i === segments) cutXs.push(w);
      else cutXs.push(i * base);
    }
  }
  const ambiguity = smartCrop && segments > 1
    ? analyzeAmbiguousCuts(cutXs, w, segments)
    : { needsReview: false, reasons: [], sliverThreshold: 0, idealSegSize: w / segments };
  return { cuts: cutXs, minSeg, ambiguity, axisSize: w };
}

/**
 * @param {ImageBitmap} source
 * @param {{ mode?: 'auto' | 'manual'; segments?: number; direction?: 'horizontal' | 'vertical'; rotation: number; cropRegions?: {x:number, y:number, w:number, h:number}[]; smartCrop?: boolean; customCuts?: number[] }} opts
 * @returns {ImageBitmap[]}
 */
function splitBitmap(source, opts) {
  const {
    mode = "auto",
    segments = 2,
    direction = "horizontal",
    rotation = 0,
    cropRegions = [],
    smartCrop = false,
    customCuts = null,
  } = opts;
  const w = source.width;
  const h = source.height;
  const parts = [];

  if (mode === "manual") {
    for (const region of cropRegions) {
      const sx = Math.max(0, Math.floor(region.x * w));
      const sy = Math.max(0, Math.floor(region.y * h));
      const sw = Math.min(w - sx, Math.floor(region.w * w));
      const sh = Math.min(h - sy, Math.floor(region.h * h));

      if (sw > 0 && sh > 0) {
        const strip = new OffscreenCanvas(sw, sh);
        strip.getContext("2d").drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
        let bmp = strip.transferToImageBitmap();
        bmp = rotateImageBitmap(bmp, rotation);
        parts.push(bmp);
      }
    }
  } else if (direction === "horizontal") {
    /** @type {number[]} */
    let cutYs;
    if (Array.isArray(customCuts) && customCuts.length === segments + 1) {
      cutYs = customCuts.map((c) => Math.round(c));
    } else {
      const computed = computeAutoCuts(source, "horizontal", segments, smartCrop);
      cutYs = computed.cuts;
    }
    for (let i = 0; i < segments; i++) {
      const sy = cutYs[i];
      const shPart = cutYs[i + 1] - sy;
      const strip = new OffscreenCanvas(w, shPart);
      strip.getContext("2d").drawImage(source, 0, sy, w, shPart, 0, 0, w, shPart);
      let bmp = strip.transferToImageBitmap();
      bmp = rotateImageBitmap(bmp, rotation);
      parts.push(bmp);
    }
  } else {
    /** @type {number[]} */
    let cutXs;
    if (Array.isArray(customCuts) && customCuts.length === segments + 1) {
      cutXs = customCuts.map((c) => Math.round(c));
    } else {
      const computed = computeAutoCuts(source, "vertical", segments, smartCrop);
      cutXs = computed.cuts;
    }
    for (let i = 0; i < segments; i++) {
      const sx = cutXs[i];
      const swPart = cutXs[i + 1] - sx;
      const strip = new OffscreenCanvas(swPart, h);
      strip.getContext("2d").drawImage(source, sx, 0, swPart, h, 0, 0, swPart, h);
      let bmp = strip.transferToImageBitmap();
      bmp = rotateImageBitmap(bmp, rotation);
      parts.push(bmp);
    }
  }

  return parts;
}

self.onmessage = (event) => {
  const msg = event.data;
  if (!msg || typeof msg.requestId !== "string") return;

  const { requestId, type, payload } = msg;

  try {
    if (type === "split") {
      const { imageBitmap, mode, segments, direction, rotation, cropRegions, smartCrop, customCuts } =
        payload;
      const bitmaps = splitBitmap(imageBitmap, {
        mode,
        segments,
        direction,
        rotation,
        cropRegions,
        smartCrop: !!smartCrop,
        customCuts: customCuts ?? null,
      });
      imageBitmap.close();
      self.postMessage(
        { requestId, type: "splitResult", payload: { bitmaps } },
        bitmaps,
      );
    } else if (type === "analyzeAutoSplit") {
      const { imageBitmap, segments, direction, smartCrop } = payload;
      const computed = computeAutoCuts(
        imageBitmap,
        direction === "vertical" ? "vertical" : "horizontal",
        segments,
        !!smartCrop,
      );
      self.postMessage({
        requestId,
        type: "analyzeAutoSplitResult",
        payload: {
          cuts: computed.cuts,
          minSeg: computed.minSeg,
          ambiguity: computed.ambiguity,
          axisSize: computed.axisSize,
        },
      });
    } else {
      self.postMessage({
        requestId,
        error: `Unknown message type: ${type}`,
      });
    }
  } catch (err) {
    self.postMessage({
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
