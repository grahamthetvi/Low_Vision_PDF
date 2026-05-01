/**
 * Off-main-thread splitting and rotation of page bitmaps.
 * No network I/O; receives ImageBitmap from the main thread.
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
 * @param {ImageBitmap} source
 * @param {{ mode?: 'auto' | 'manual'; segments?: number; direction?: 'horizontal' | 'vertical'; rotation: number; cropRegions?: {x:number, y:number, w:number, h:number}[] }} opts
 * @returns {ImageBitmap[]}
 */
function splitBitmap(source, opts) {
  const { mode = 'auto', segments = 2, direction = 'horizontal', rotation = 0, cropRegions = [] } = opts;
  const w = source.width;
  const h = source.height;
  const parts = [];

  if (mode === 'manual') {
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
    const base = Math.floor(h / segments);
    for (let i = 0; i < segments; i++) {
      const sy = i * base;
      const sh = i === segments - 1 ? h - sy : base;
      const strip = new OffscreenCanvas(w, sh);
      strip.getContext("2d").drawImage(source, 0, sy, w, sh, 0, 0, w, sh);
      let bmp = strip.transferToImageBitmap();
      bmp = rotateImageBitmap(bmp, rotation);
      parts.push(bmp);
    }
  } else {
    const base = Math.floor(w / segments);
    for (let i = 0; i < segments; i++) {
      const sx = i * base;
      const sw = i === segments - 1 ? w - sx : base;
      const strip = new OffscreenCanvas(sw, h);
      strip.getContext("2d").drawImage(source, sx, 0, sw, h, 0, 0, sw, h);
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
      const { imageBitmap, mode, segments, direction, rotation, cropRegions } = payload;
      const bitmaps = splitBitmap(imageBitmap, {
        mode,
        segments,
        direction,
        rotation,
        cropRegions,
      });
      imageBitmap.close();
      self.postMessage(
        { requestId, type: "splitResult", payload: { bitmaps } },
        bitmaps,
      );
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
