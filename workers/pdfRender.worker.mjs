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
      createElement: () => ({ style: {} }),
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
 * Renders one page to an ImageBitmap, optionally trimming blank margins.
 * @param {number} pageIndex 1-based
 * @param {number} maxLongEdge
 * @param {boolean} trimMargins
 */
async function renderPageToBitmap(pageIndex, maxLongEdge, trimMargins) {
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
  const ctx = canvas.getContext("2d", { alpha: false });
  if (!ctx) throw new Error("Could not get 2D context");

  await page.render({
    canvasContext: ctx,
    viewport,
  }).promise;

  if (trimMargins) {
    const { width, height } = canvas;
    const imageData = ctx.getImageData(0, 0, width, height);
    const box = contentBoundingBox(imageData);
    if (box && box.w > 0 && box.h > 0) {
      const trimmed = new OffscreenCanvas(box.w, box.h);
      const tctx = trimmed.getContext("2d", { alpha: false });
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
      const loadingTask = pdfjsLib.getDocument({
        data: buffer,
        cMapUrl: `${PDFJS_VENDOR_ROOT}cmaps/`,
        cMapPacked: true,
        standardFontDataUrl: `${PDFJS_VENDOR_ROOT}standard_fonts/`,
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
      const { pageIndex, maxLongEdge, trimMargins } = msg.payload;
      const bitmap = await renderPageToBitmap(
        pageIndex,
        maxLongEdge,
        !!trimMargins,
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
