/**
 * PDF.js runs in this dedicated worker for parsing, text extraction, and
 * rasterization. Engine and auxiliary font data are loaded from `vendor/pdfjs/`
 * (same origin). No document bytes are sent to any remote server.
 */

/** Vendored pdf.js 4.10.38 — same-origin, no CDN required for the engine. */
const PDF_MODULE_URL = new URL("../vendor/pdfjs/pdf.min.mjs", import.meta.url)
  .href;
const PDF_WORKER_URL = new URL(
  "../vendor/pdfjs/pdf.worker.min.mjs",
  import.meta.url,
).href;

/** Same directory as pdf.min.mjs — CMaps and standard fonts for correct text shaping (avoids “tofu” hex boxes). */
const PDFJS_VENDOR_ROOT = new URL("../vendor/pdfjs/", import.meta.url).href;

/** @type {any} */
let pdfjsLib = null;
/** @type {any} */
let pdfDocument = null;

async function ensurePdfJs() {
  if (pdfjsLib) return;

  if (typeof document === "undefined") {
    globalThis.document = {
      /**
       * PDF.js may call `createElement("canvas")` for font metrics, etc. A plain
       * object stub has no getContext, which throws on some tag-heavy (e.g. PDF/UA) files.
       */
      createElement(tag) {
        if (String(tag).toLowerCase() === "canvas") {
          return new OffscreenCanvas(0, 0);
        }
        return { style: {} };
      },
      documentElement: { style: {} },
      head: { appendChild: () => {} },
      body: { appendChild: () => {} },
      getElementsByTagName: () => []
    };
  }
  if (typeof window === "undefined") {
    globalThis.window = globalThis;
  }

  pdfjsLib = await import(/* webpackIgnore: true */ PDF_MODULE_URL);
  pdfjsLib.GlobalWorkerOptions.workerSrc = PDF_WORKER_URL;
}

/**
 * @param {ImageData} imageData
 * @param {number} threshold Treat RGB above this as background
 * @returns {{ x: number; y: number; w: number; h: number } | null}
 */
function contentBoundingBox(imageData, threshold = 248) {
  const { data, width, height } = imageData;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3];
      if (a < 12) continue;
      if (r >= threshold && g >= threshold && b >= threshold) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }

  if (maxX < minX || maxY < minY) return null;

  const pad = 2;
  const x = Math.max(0, minX - pad);
  const y = Math.max(0, minY - pad);
  const w = Math.min(width, maxX + pad + 1) - x;
  const h = Math.min(height, maxY + pad + 1) - y;
  if (w < 4 || h < 4) return null;
  return { x, y, w, h };
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
 * Rotate image counter-clockwise by `angleDeg` (positive = CCW), expand canvas, white background.
 * Uses 2D canvas for resampling (faster than per-pixel JS on large bitmaps).
 * @param {ImageData} src
 * @param {number} angleDeg
 * @returns {ImageData}
 */
function rotateImageDataViaCanvas(src, angleDeg) {
  const { width: w, height: h } = src;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.abs(Math.cos(rad));
  const sin = Math.abs(Math.sin(rad));
  const nw = Math.ceil(w * cos + h * sin);
  const nh = Math.ceil(w * sin + h * cos);

  const srcCanvas = new OffscreenCanvas(w, h);
  const sctx = srcCanvas.getContext("2d");
  if (!sctx) return src;
  sctx.putImageData(src, 0, 0);

  const outCanvas = new OffscreenCanvas(nw, nh);
  const ctx = outCanvas.getContext("2d");
  if (!ctx) return src;
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, nw, nh);
  ctx.translate(nw / 2, nh / 2);
  ctx.rotate(-rad);
  ctx.drawImage(srcCanvas, -w / 2, -h / 2);

  return ctx.getImageData(0, 0, nw, nh);
}

/**
 * Build grayscale Uint8Array from ImageData (luminance).
 * @param {ImageData} im
 */
function toGrayscale(im) {
  const { data, width, height } = im;
  const g = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    g[j] = Math.round(luminance(data[i], data[i + 1], data[i + 2]));
  }
  return g;
}

/**
 * Horizontal shear (shift each row) on grayscale, sample with clamp.
 * @param {Uint8Array} src
 * @param {number} w
 * @param {number} h
 * @param {number} shearTan tan(angle) positive shifts rows right with y
 */
function shearHorizontalGray(src, w, h, shearTan) {
  const out = new Uint8Array(w * h);
  const cy = (h - 1) / 2;
  for (let y = 0; y < h; y++) {
    const shift = shearTan * (y - cy);
    for (let x = 0; x < w; x++) {
      const xs = x - shift;
      const x0 = Math.floor(xs);
      const x1 = x0 + 1;
      const f = xs - x0;
      const v0 = x0 >= 0 && x0 < w ? src[y * w + x0] : 255;
      const v1 = x1 >= 0 && x1 < w ? src[y * w + x1] : 255;
      out[y * w + x] = Math.round(v0 * (1 - f) + v1 * f);
    }
  }
  return out;
}

/**
 * Otsu threshold for 8-bit grayscale.
 * @param {Uint8Array} gray
 * @param {number} w
 * @param {number} h
 */
function otsuThresholdU8(gray, w, h) {
  const hist = new Uint32Array(256);
  const n = w * h;
  for (let i = 0; i < n; i++) hist[gray[i]]++;
  let sum = 0;
  for (let t = 0; t < 256; t++) sum += t * hist[t];
  let sumB = 0;
  let wB = 0;
  let maxVar = 0;
  let threshold = 127;
  for (let t = 0; t < 256; t++) {
    wB += hist[t];
    if (wB === 0) continue;
    const wF = n - wB;
    if (wF === 0) break;
    sumB += t * hist[t];
    const mB = sumB / wB;
    const mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between >= maxVar) {
      maxVar = between;
      threshold = t;
    }
  }
  return threshold;
}

/**
 * Variance of row sums (higher when text lines align with rows).
 * @param {Uint8Array} gray
 * @param {number} w
 * @param {number} h
 */
function projectionRowVariance(gray, w, h) {
  const sums = new Float64Array(h);
  for (let y = 0; y < h; y++) {
    let s = 0;
    const o = y * w;
    for (let x = 0; x < w; x++) s += 255 - gray[o + x];
    sums[y] = s;
  }
  let mean = 0;
  for (let y = 0; y < h; y++) mean += sums[y];
  mean /= h;
  let v = 0;
  for (let y = 0; y < h; y++) {
    const d = sums[y] - mean;
    v += d * d;
  }
  return v / h;
}

/**
 * Estimate skew angle (degrees, CCW) using shear search on a downscaled copy.
 * Positive angle means content appears rotated CCW; we rotate by -angle to straighten.
 * @param {ImageData} imageData
 * @returns {number} correction to apply (rotate bitmap by this many degrees CCW)
 */
function estimateDeskewAngle(imageData) {
  const { width: W, height: H } = imageData;
  const maxSide = 320;
  const scale = Math.min(1, maxSide / Math.max(W, H));
  const w = Math.max(32, Math.round(W * scale));
  const h = Math.max(32, Math.round(H * scale));
  const small = new OffscreenCanvas(w, h);
  const sctx = small.getContext("2d");
  if (!sctx) return 0;
  const full = new OffscreenCanvas(W, H);
  const fctx = full.getContext("2d");
  if (!fctx) return 0;
  fctx.putImageData(imageData, 0, 0);
  sctx.drawImage(full, 0, 0, W, H, 0, 0, w, h);
  const sim = sctx.getImageData(0, 0, w, h);
  let gray = toGrayscale(sim);
  const otsuThreshold = otsuThresholdU8(gray, w, h);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = gray[i] < otsuThreshold ? 0 : 255;
  }

  const baseVar = projectionRowVariance(gray, w, h);
  if (baseVar < 1e-6) return 0;

  let bestAngle = 0;
  let bestScore = baseVar;
  const step = 0.25;
  const limit = 6;
  for (let a = -limit; a <= limit + 1e-6; a += step) {
    const rad = (a * Math.PI) / 180;
    const tan = Math.tan(rad);
    const sheared = shearHorizontalGray(gray, w, h, tan);
    const v = projectionRowVariance(sheared, w, h);
    const penalty = 1 + 0.0008 * a * a;
    const score = v / penalty;
    if (score > bestScore) {
      bestScore = score;
      bestAngle = a;
    }
  }

  if (bestScore / baseVar < 1.04) return 0;
  return -bestAngle;
}

/**
 * Stretch contrast using luminance percentiles; preserves hue via per-pixel scale.
 * @param {ImageData} imageData
 */
function applyAutoContrast(imageData) {
  const { data, width, height } = imageData;
  const n = width * height;
  const lum = new Float64Array(n);
  let k = 0;
  for (let i = 0; i < data.length; i += 4) {
    const a = data[i + 3];
    if (a < 12) {
      lum[k++] = -1;
      continue;
    }
    lum[k++] = luminance(data[i], data[i + 1], data[i + 2]);
  }
  const valid = [];
  for (let i = 0; i < n; i++) {
    if (lum[i] < 0) continue;
    if (lum[i] < 252) valid.push(lum[i]);
  }
  if (valid.length < Math.min(500, n * 0.05)) {
    valid.length = 0;
    for (let i = 0; i < n; i++) {
      if (lum[i] >= 0) valid.push(lum[i]);
    }
  }
  if (valid.length < 50) return;
  valid.sort((a, b) => a - b);
  const pLo = valid[Math.floor(valid.length * 0.03)];
  const pHi = valid[Math.ceil(valid.length * 0.97) - 1];
  if (pHi - pLo < 18) return;
  const range = pHi - pLo;
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    const L = lum[j];
    if (L < 0) continue;
    const L2 = ((L - pLo) / range) * 255;
    const f = L > 1 ? L2 / L : 1;
    data[i] = Math.min(255, Math.max(0, Math.round(data[i] * f)));
    data[i + 1] = Math.min(255, Math.max(0, Math.round(data[i + 1] * f)));
    data[i + 2] = Math.min(255, Math.max(0, Math.round(data[i + 2] * f)));
  }
}

/**
 * Renders one page to an ImageBitmap, optionally trimming blank margins.
 * @param {number} pageIndex 1-based
 * @param {number} maxLongEdge
 * @param {boolean} trimMargins
 * @param {boolean} autoContrast
 * @param {boolean} autoDeskew
 */
async function renderPageToBitmap(
  pageIndex,
  maxLongEdge,
  trimMargins,
  autoContrast,
  autoDeskew,
) {
  if (!pdfDocument) throw new Error("No PDF loaded");

  const page = await pdfDocument.getPage(pageIndex);
  const baseViewport = page.getViewport({ scale: 1 });
  const longEdge = Math.max(baseViewport.width, baseViewport.height);
  const scale = maxLongEdge / longEdge;
  const viewport = page.getViewport({ scale });

  const canvas = new OffscreenCanvas(
    Math.ceil(viewport.width),
    Math.ceil(viewport.height),
  );
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("Could not get 2D context");

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  const { width, height } = canvas;
  let imageData = ctx.getImageData(0, 0, width, height);

  if (autoDeskew) {
    const angle = estimateDeskewAngle(imageData);
    if (Math.abs(angle) >= 0.2) {
      imageData = rotateImageDataViaCanvas(imageData, angle);
      canvas.width = imageData.width;
      canvas.height = imageData.height;
      const ctx2 = canvas.getContext("2d");
      if (!ctx2) throw new Error("Could not get 2D context");
      ctx2.putImageData(imageData, 0, 0);
    }
  }

  if (autoContrast) {
    const w = canvas.width;
    const h = canvas.height;
    const id = ctx.getImageData(0, 0, w, h);
    applyAutoContrast(id);
    ctx.putImageData(id, 0, 0);
  }

  if (trimMargins) {
    const w = canvas.width;
    const h = canvas.height;
    const imageData2 = ctx.getImageData(0, 0, w, h);
    const box = contentBoundingBox(imageData2);
    if (box && box.w > 0 && box.h > 0) {
      const trimmed = new OffscreenCanvas(box.w, box.h);
      const tctx = trimmed.getContext("2d");
      if (!tctx) throw new Error("Could not get trimmed context");
      tctx.drawImage(canvas, box.x, box.y, box.w, box.h, 0, 0, box.w, box.h);
      return trimmed.transferToImageBitmap();
    }
  }

  return canvas.transferToImageBitmap();
}

async function extractAllText() {
  if (!pdfDocument) throw new Error("No PDF loaded");
  const numPages = pdfDocument.numPages;
  const chunks = [];
  let hasText = false;

  for (let p = 1; p <= numPages; p++) {
    const page = await pdfDocument.getPage(p);
    const textContent = await page.getTextContent();
    const pageText = textContent.items
      .filter((item) => "str" in item && item.str)
      .map((item) => item.str)
      .join(" ");
    
    if (pageText.trim()) hasText = true;
    chunks.push(`--- Page ${p} ---\n${pageText}\n`);
  }

  return hasText ? chunks.join("\n") : "";
}

self.onmessage = async (event) => {
  const msg = event.data;
  if (!msg || typeof msg.requestId !== "string") return;

  const { requestId, type } = msg;

  try {
    await ensurePdfJs();

    if (type === "load") {
      const buffer = msg.buffer;
      if (pdfDocument) {
        try {
          if (typeof pdfDocument.destroy === "function") {
            await pdfDocument.destroy();
          }
        } catch {
          /* ignore */
        }
        pdfDocument = null;
      }
      // `disableFontFace: true` draws glyph outlines in the canvas instead of relying on
      // @font-face in a worker, which often fails and shows "tofu" boxes. Output is then
      // image-like (as if scanned); embedded text is still available via getTextContent().
      const loadingTask = pdfjsLib.getDocument({
        data: buffer,
        cMapUrl: `${PDFJS_VENDOR_ROOT}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_VENDOR_ROOT}standard_fonts/`,
        disableFontFace: true,
      });
      pdfDocument = await loadingTask.promise;
      self.postMessage({
        requestId,
        type: "loaded",
        payload: { pageCount: pdfDocument.numPages },
      });
      return;
    }

    if (type === "renderPage") {
      const {
        pageIndex,
        maxLongEdge,
        trimMargins,
        autoContrast = false,
        autoDeskew = false,
      } = msg.payload;
      const bitmap = await renderPageToBitmap(
        pageIndex,
        maxLongEdge,
        !!trimMargins,
        !!autoContrast,
        !!autoDeskew,
      );
      self.postMessage(
        {
          requestId,
          type: "renderPageResult",
          payload: { pageIndex, bitmap },
        },
        [bitmap],
      );
      return;
    }

    if (type === "extractText") {
      const text = await extractAllText();
      self.postMessage({
        requestId,
        type: "extractTextResult",
        payload: { text },
      });
      return;
    }

    self.postMessage({
      requestId,
      error: `Unknown message type: ${type}`,
    });
  } catch (err) {
    self.postMessage({
      requestId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
};
