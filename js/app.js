/**
 * Main-thread UI and coordination. PDF rasterization runs in pdfRender.worker;
 * splitting and rotation run in split.worker. No document data is sent remotely.
 */

import {
  t,
  setLocale,
  resolveInitialLocale,
  getLocale,
  translateWorkerErrorMessage,
} from "./i18n.js";
import { runTesseractOnPdfPages } from "./tesseractOcr.js";
import {
  EMBEDDED_VERIFY_MAX_PAGES,
  OCR_VERIFY_MAX_PAGES,
  sampleVerificationPages,
  formatPageList,
} from "./verificationPages.js";

const PDF_WORKER_URL = new URL("../workers/pdfRender.worker.mjs", import.meta.url);
const SPLIT_WORKER_URL = new URL("../workers/split.worker.mjs", import.meta.url);
const PDF_LIB_URL = new URL("../vendor/pdf-lib/pdf-lib.esm.min.js", import.meta.url);

const WELCOME_SEEN_KEY = "lv-pdf-welcome-seen";

/** US Letter size in PDF points (1 pt = 1/72 in). Export pages use this so printing on Letter is predictable. */
const LETTER_W_PT = 612;
const LETTER_H_PT = 792;

/**
 * @param {number} imgW
 * @param {number} imgH
 * @returns {{ pageW: number; pageH: number; scale: number; drawW: number; drawH: number; x: number; y: number }}
 */
function letterBoxLayout(imgW, imgH) {
  const sPortrait = Math.min(LETTER_W_PT / imgW, LETTER_H_PT / imgH);
  const sLandscape = Math.min(LETTER_H_PT / imgW, LETTER_W_PT / imgH);
  const useLandscape = sLandscape > sPortrait;
  const pageW = useLandscape ? LETTER_H_PT : LETTER_W_PT;
  const pageH = useLandscape ? LETTER_W_PT : LETTER_H_PT;
  const scale = Math.min(pageW / imgW, pageH / imgH);
  const drawW = imgW * scale;
  const drawH = imgH * scale;
  const x = (pageW - drawW) / 2;
  const y = (pageH - drawH) / 2;
  return { pageW, pageH, scale, drawW, drawH, x, y };
}

let _debugOut = null;
function getDebugOut() {
  if (!_debugOut) _debugOut = document.getElementById("debug-output");
  return _debugOut;
}

function logToDebug(level, ...args) {
  const out = getDebugOut();
  if (!out) return;
  const msg = args.map(a => {
    if (a instanceof Error) {
      return String(a) + (a.stack ? "\n" + a.stack : "");
    }
    return typeof a === 'object' ? JSON.stringify(a) : String(a);
  }).join(' ');
  const line = document.createElement("div");
  line.textContent = `[${level.toUpperCase()}] ${msg}`;
  line.style.color = level === 'error' ? 'red' : level === 'warn' ? 'orange' : 'inherit';
  out.appendChild(line);
  out.scrollTop = out.scrollHeight;
}

const origConsole = {
  log: console.log,
  warn: console.warn,
  error: console.error,
};

console.log = (...args) => { origConsole.log(...args); logToDebug('info', ...args); };
console.warn = (...args) => { origConsole.warn(...args); logToDebug('warn', ...args); };
console.error = (...args) => { origConsole.error(...args); logToDebug('error', ...args); };

window.addEventListener("error", (e) => {
  console.error("Global Error: " + (e.message || e.error?.message || e));
});
window.addEventListener("unhandledrejection", (e) => {
  console.error("Unhandled Promise Rejection: " + (e.reason?.message || e.reason));
});

/** @type {Worker | null} */
let pdfWorker = null;
/** @type {Worker | null} */
let splitWorker = null;

let pdfLoaded = false;
let pageCount = 0;
/** @type {string} */
let lastPdfBaseName = "";
/** @type {string[]} */
let outputObjectUrls = [];

let splitMode = "auto";
/** @type {Record<number, {x:number, y:number, w:number, h:number}[]>} */
let cropRegionsByPage = {};
/** Working copy for the page currently shown in the crop modal (1-based index). */
let cropModalPageIndex = 1;
/** @type {{x:number, y:number, w:number, h:number}[]} */
let cropRegions = [];
let cropDrawing = false;
let cropStart = { x: 0, y: 0 };
let currentCropPreview = null;
let cropSelectedIndex = -1;
/** @type {null | 'draw' | 'move' | 'resize'} */
let cropInteraction = null;
/** @type {string | null} */
let cropResizeHandle = null;
let cropDragAnchor = { x: 0, y: 0 };
/** @type {{x:number, y:number, w:number, h:number} | null} */
let cropDragStartRegion = null;
/** @type {ImageBitmap | null} */
let cropPreviewImageBitmap = null;

const CROP_MIN_SIZE = 0.01;
const CROP_HANDLE_HIT = 0.018;

/** @type {Record<number, number[]>} User-adjusted pixel cut positions per page (1-based). */
let autoSplitOverridesByPage = {};
/** @type {ImageBitmap | null} */
let splitReviewImageBitmap = null;
/** @type {number[]} */
let splitReviewCuts = [];
let splitReviewDirection = "horizontal";
let splitReviewSegments = 2;
let splitReviewMinSeg = 24;
let splitReviewPageIndex = 1;
/** @type {null | number} Index of interior cut being dragged. */
let splitReviewDraggingCut = null;
/** @type {((result: { action: 'confirm' | 'auto' | 'cancel'; cuts?: number[] }) => void) | null} */
let splitReviewResolve = null;

const els = {
  welcomeScreen: document.getElementById("welcome-screen"),
  welcomeContinue: document.getElementById("welcome-continue"),
  welcomeHelp: document.getElementById("welcome-help"),
  themeToggle: document.getElementById("theme-toggle"),
  pdfInput: document.getElementById("pdf-input"),
  previewBlock: document.getElementById("preview-block"),
  previewCanvas: document.getElementById("preview-canvas"),
  trimMargins: document.getElementById("trim-margins"),
  smartCrop: document.getElementById("smart-crop"),
  autoContrast: document.getElementById("auto-contrast"),
  autoDeskew: document.getElementById("auto-deskew"),
  undoTrim: document.getElementById("undo-trim"),
  processBtn: document.getElementById("process-btn"),
  extractBtn: document.getElementById("extract-btn"),
  downloadPdfBtn: document.getElementById("download-pdf-btn"),
  statusRegion: document.getElementById("status-region"),
  outputContainer: document.getElementById("output-container"),
  extractedText: document.getElementById("extracted-text"),
  debugToggle: document.getElementById("debug-toggle"),
  debugPanel: document.getElementById("debug-panel"),
  debugClear: document.getElementById("debug-clear"),
  debugClose: document.getElementById("debug-close"),
  splitModeRadios: document.querySelectorAll('input[name="split-mode"]'),
  manualCropWarning: document.getElementById("manual-crop-warning"),
  manualCropControls: document.getElementById("manual-crop-controls"),
  autoCropControls: document.getElementById("auto-crop-controls"),
  openCropModalBtn: document.getElementById("open-crop-modal"),
  cropRegionsStatus: document.getElementById("crop-regions-status"),
  cropModal: document.getElementById("crop-modal"),
  cropModalInstructions: document.getElementById("crop-modal-instructions"),
  cropCanvas: document.getElementById("crop-canvas"),
  cropClearBtn: document.getElementById("crop-clear"),
  cropDeleteSelectedBtn: document.getElementById("crop-delete-selected"),
  cropCancelBtn: document.getElementById("crop-cancel"),
  cropSaveBtn: document.getElementById("crop-save"),
  cropPageSelect: document.getElementById("crop-page-select"),
  splitReviewModal: document.getElementById("split-review-modal"),
  splitReviewInstructions: document.getElementById("split-review-instructions"),
  splitReviewPageLabel: document.getElementById("split-review-page-label"),
  splitReviewCanvas: document.getElementById("split-review-canvas"),
  splitReviewAcceptAutoBtn: document.getElementById("split-review-accept-auto"),
  splitReviewCancelBtn: document.getElementById("split-review-cancel"),
  splitReviewConfirmBtn: document.getElementById("split-review-confirm"),
  localeSelect: document.getElementById("locale-select"),
};

/**
 * @param {Worker} worker
 * @param {object} message
 * @param {Transferable[]} [transfer]
 */
function postWorkerRequest(worker, message, transfer) {
  return new Promise((resolve, reject) => {
    const requestId = (typeof crypto !== "undefined" && crypto.randomUUID) 
      ? crypto.randomUUID() 
      : Math.random().toString(36).slice(2) + Date.now().toString(36);

    function onMessage(ev) {
      let data;
      try {
        data = ev.data;
      } catch (err) {
        worker.removeEventListener("message", onMessage);
        worker.removeEventListener("error", onError);
        reject(new Error(`Failed to read worker message data: ${err instanceof Error ? err.message : String(err)}`));
        return;
      }
      if (!data || data.requestId !== requestId) return;
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      if (data.error) {
        reject(new Error(data.error));
      } else {
        resolve(data);
      }
    }

    function onError(err) {
      worker.removeEventListener("message", onMessage);
      worker.removeEventListener("error", onError);
      reject(err);
    }

    worker.addEventListener("message", onMessage);
    worker.addEventListener("error", onError);
    worker.postMessage({ ...message, requestId }, transfer || []);
  });
}

function ensureWorkers() {
  if (!pdfWorker) {
    pdfWorker = new Worker(PDF_WORKER_URL, { type: "module" });
  }
  if (!splitWorker) {
    splitWorker = new Worker(SPLIT_WORKER_URL, { type: "module" });
  }
}

/**
 * @param {ImageBitmap} bitmap
 * @returns {Promise<string>}
 */
function imageBitmapToObjectUrl(bitmap) {
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    bitmap.close();
    return Promise.reject(new Error("Could not create canvas context"));
  }
  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => {
        if (!blob) {
          reject(new Error("Could not encode image"));
          return;
        }
        resolve(URL.createObjectURL(blob));
      },
      "image/png",
      1,
    );
  });
}

function setStatus(text) {
  els.statusRegion.textContent = text;
}

function userErrorMessage(err) {
  const raw = err instanceof Error ? err.message : String(err);
  return translateWorkerErrorMessage(raw);
}

function hideDownloadPdf() {
  els.downloadPdfBtn.hidden = true;
  els.downloadPdfBtn.disabled = true;
}

function updateCropRegionsStatus() {
  if (splitMode !== "manual" || pageCount < 1) {
    return;
  }

  let defined = 0;
  /** @type {number[]} */
  const missing = [];
  for (let p = 1; p <= pageCount; p++) {
    const n = cropRegionsByPage[p]?.length ?? 0;
    if (n > 0) defined++;
    else missing.push(p);
  }

  if (defined === 0) {
    els.cropRegionsStatus.textContent = t("dynamicCopy.cropStatus.manual.noneYet", {
      total: pageCount,
    });
  } else if (missing.length > 0) {
    const maxShow = 12;
    const shown = missing.slice(0, maxShow);
    const more =
      missing.length > maxShow
        ? t("dynamicCopy.cropStatus.manual.morePages", {
            count: missing.length - maxShow,
          })
        : "";
    els.cropRegionsStatus.textContent = t("dynamicCopy.cropStatus.manual.needMorePages", {
      done: defined,
      total: pageCount,
      pages: shown.join(", "),
      more,
    });
  } else {
    els.cropRegionsStatus.textContent = t("dynamicCopy.cropStatus.manual.allPagesReady", {
      total: pageCount,
    });
  }
}

/**
 * Persist the in-modal crop list to storage for the given page.
 * @param {number} pageIndex 1-based
 */
function persistCropRegionsForModalPage(pageIndex) {
  cropRegionsByPage[pageIndex] = cropRegions.map((r) => ({ ...r }));
}

function syncCropPageSelectOptions() {
  const sel = els.cropPageSelect;
  if (!sel) return;
  sel.replaceChildren();
  for (let p = 1; p <= pageCount; p++) {
    const opt = document.createElement("option");
    opt.value = String(p);
    opt.textContent = t("cropModal.pageOption", { p, total: pageCount });
    sel.append(opt);
  }
}

/**
 * @param {number} pageIndex 1-based
 */
async function loadCropPreviewForPage(pageIndex) {
  const res = await postWorkerRequest(pdfWorker, {
    type: "renderPage",
    payload: buildRenderPayload(pageIndex, 2400, false),
  });
  const bitmap = res.payload?.bitmap;
  if (!(bitmap instanceof ImageBitmap)) throw new Error("Render failed");

  if (cropPreviewImageBitmap) cropPreviewImageBitmap.close();
  cropPreviewImageBitmap = bitmap;
  els.cropCanvas.width = bitmap.width;
  els.cropCanvas.height = bitmap.height;
  drawCropCanvas();
}

function clearOutputUrls() {
  for (const url of outputObjectUrls) {
    URL.revokeObjectURL(url);
  }
  outputObjectUrls = [];
  els.outputContainer.replaceChildren();
  hideDownloadPdf();
}

function reflowedDownloadFilename() {
  const base = lastPdfBaseName.replace(/\.pdf$/i, "") || "document";
  return t("dynamicCopy.download.filenamePattern", { basename: base });
}

function readSegments() {
  const checked = document.querySelector('input[name="segments"]:checked');
  return Number(checked?.value || 2);
}

function readDirection() {
  const checked = document.querySelector('input[name="direction"]:checked');
  return checked?.value === "vertical" ? "vertical" : "horizontal";
}

function readRotation() {
  const checked = document.querySelector('input[name="rotation"]:checked');
  return Number(checked?.value || 90);
}

function readSmartCrop() {
  return !!(els.smartCrop && els.smartCrop.checked);
}

function readAutoContrast() {
  return !!(els.autoContrast && els.autoContrast.checked);
}

function readAutoDeskew() {
  return !!(els.autoDeskew && els.autoDeskew.checked);
}

/**
 * @param {number} pageIndex
 * @param {number} maxLongEdge
 * @param {boolean} trimMargins
 */
function buildRenderPayload(pageIndex, maxLongEdge, trimMargins) {
  return {
    pageIndex,
    maxLongEdge,
    trimMargins,
    autoContrast: readAutoContrast(),
    autoDeskew: readAutoDeskew(),
  };
}

/** Renders a page for OCR: neutral pipeline (no trim/contrast/deskew). */
function buildOcrRenderPayload(pageIndex) {
  return {
    pageIndex,
    maxLongEdge: 1800,
    trimMargins: false,
    autoContrast: false,
    autoDeskew: false,
  };
}

function applyTheme(dark) {
  if (dark) {
    document.documentElement.setAttribute("data-theme", "dark");
  } else {
    document.documentElement.removeAttribute("data-theme");
  }
  els.themeToggle.setAttribute("aria-pressed", dark ? "true" : "false");
  els.themeToggle.setAttribute(
    "aria-label",
    dark ? t("header.themeToggle.toLight") : t("header.themeToggle.toDark"),
  );
  els.themeToggle.textContent = dark
    ? t("header.themeToggle.labelWhenDark")
    : t("header.themeToggle.labelWhenLight");
  try {
    localStorage.setItem("lv-pdf-theme", dark ? "dark" : "light");
  } catch {
    /* ignore */
  }
}

function initTheme() {
  let dark = false;
  try {
    dark = localStorage.getItem("lv-pdf-theme") === "dark";
  } catch {
    dark = false;
  }
  if (window.matchMedia("(prefers-color-scheme: dark)").matches) {
    try {
      if (!localStorage.getItem("lv-pdf-theme")) dark = true;
    } catch {
      /* ignore */
    }
  }
  applyTheme(dark);
}

/**
 * @param {ArrayBuffer} buffer
 * @returns {Promise<number>}
 */
async function loadPdfIntoWorker(buffer) {
  ensureWorkers();
  const copy = buffer.slice(0);
  const res = await postWorkerRequest(
    pdfWorker,
    { type: "load", buffer: copy },
    [copy],
  );
  pdfLoaded = true;
  return Number(res.payload?.pageCount || 0);
}

async function renderFirstPagePreview() {
  if (!pdfWorker || pageCount < 1) return;
  const res = await postWorkerRequest(pdfWorker, {
    type: "renderPage",
    payload: buildRenderPayload(1, 900, false),
  });
  const bitmap = res.payload?.bitmap;
  if (!(bitmap instanceof ImageBitmap)) return;

  const canvas = els.previewCanvas;
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.drawImage(bitmap, 0, 0);
  }
  bitmap.close();
  els.previewBlock.hidden = false;
}

function drawCropCanvas() {
  const canvas = els.cropCanvas;
  const ctx = canvas.getContext("2d");
  if (!ctx || !cropPreviewImageBitmap) return;

  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(cropPreviewImageBitmap, 0, 0, canvas.width, canvas.height);

  for (let i = 0; i < cropRegions.length; i++) {
    const r = cropRegions[i];
    const selected = i === cropSelectedIndex;
    const x = r.x * canvas.width;
    const y = r.y * canvas.height;
    const w = r.w * canvas.width;
    const h = r.h * canvas.height;

    ctx.fillStyle = selected ? "rgba(255, 200, 0, 0.2)" : "rgba(255, 0, 0, 0.15)";
    ctx.strokeStyle = selected ? "#ffaa00" : "red";
    ctx.lineWidth = selected ? 4 : 3;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);

    if (selected) {
      const handleSize = Math.max(8, CROP_HANDLE_HIT * canvas.width);
      const handles = [
        [x, y],
        [x + w / 2, y],
        [x + w, y],
        [x + w, y + h / 2],
        [x + w, y + h],
        [x + w / 2, y + h],
        [x, y + h],
        [x, y + h / 2],
      ];
      ctx.fillStyle = "#ffaa00";
      ctx.strokeStyle = "#000";
      ctx.lineWidth = 1;
      for (const [hx, hy] of handles) {
        ctx.fillRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
        ctx.strokeRect(hx - handleSize / 2, hy - handleSize / 2, handleSize, handleSize);
      }
    }
  }

  if (currentCropPreview) {
    ctx.strokeStyle = "blue";
    ctx.lineWidth = 3;
    ctx.fillStyle = "rgba(0, 0, 255, 0.2)";
    const x = currentCropPreview.x * canvas.width;
    const y = currentCropPreview.y * canvas.height;
    const w = currentCropPreview.w * canvas.width;
    const h = currentCropPreview.h * canvas.height;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  if (els.cropDeleteSelectedBtn) {
    els.cropDeleteSelectedBtn.hidden = cropSelectedIndex < 0;
  }
}

/**
 * @param {{x:number, y:number, w:number, h:number}} r
 */
function clampCropRegion(r) {
  let { x, y, w, h } = r;
  w = Math.max(CROP_MIN_SIZE, w);
  h = Math.max(CROP_MIN_SIZE, h);
  if (x < 0) {
    w += x;
    x = 0;
  }
  if (y < 0) {
    h += y;
    y = 0;
  }
  if (x + w > 1) w = 1 - x;
  if (y + h > 1) h = 1 - y;
  w = Math.max(CROP_MIN_SIZE, w);
  h = Math.max(CROP_MIN_SIZE, h);
  return { x, y, w, h };
}

/**
 * @param {{x:number, y:number}} pos normalized
 * @param {{x:number, y:number, w:number, h:number}} region
 */
function pointInCropRegion(pos, region) {
  return (
    pos.x >= region.x &&
    pos.x <= region.x + region.w &&
    pos.y >= region.y &&
    pos.y <= region.y + region.h
  );
}

/**
 * @param {{x:number, y:number}} pos normalized
 * @returns {number}
 */
function hitTestCropRegions(pos) {
  for (let i = cropRegions.length - 1; i >= 0; i--) {
    if (pointInCropRegion(pos, cropRegions[i])) return i;
  }
  return -1;
}

/**
 * @param {{x:number, y:number}} pos normalized
 * @param {{x:number, y:number, w:number, h:number}} region
 * @returns {string | null}
 */
function getCropResizeHandle(pos, region) {
  const handles = {
    nw: { x: region.x, y: region.y },
    n: { x: region.x + region.w / 2, y: region.y },
    ne: { x: region.x + region.w, y: region.y },
    e: { x: region.x + region.w, y: region.y + region.h / 2 },
    se: { x: region.x + region.w, y: region.y + region.h },
    s: { x: region.x + region.w / 2, y: region.y + region.h },
    sw: { x: region.x, y: region.y + region.h },
    w: { x: region.x, y: region.y + region.h / 2 },
  };
  for (const [name, hp] of Object.entries(handles)) {
    if (
      Math.abs(pos.x - hp.x) <= CROP_HANDLE_HIT &&
      Math.abs(pos.y - hp.y) <= CROP_HANDLE_HIT
    ) {
      return name;
    }
  }
  return null;
}

/**
 * @param {{x:number, y:number, w:number, h:number}} start
 * @param {string} handle
 * @param {{x:number, y:number}} pos
 */
function resizeCropRegionFromHandle(start, handle, pos) {
  let x = start.x;
  let y = start.y;
  let x2 = start.x + start.w;
  let y2 = start.y + start.h;

  if (handle.includes("w")) x = pos.x;
  if (handle.includes("e")) x2 = pos.x;
  if (handle.includes("n")) y = pos.y;
  if (handle.includes("s")) y2 = pos.y;

  if (x2 - x < CROP_MIN_SIZE) {
    if (handle.includes("w")) x = x2 - CROP_MIN_SIZE;
    else x2 = x + CROP_MIN_SIZE;
  }
  if (y2 - y < CROP_MIN_SIZE) {
    if (handle.includes("n")) y = y2 - CROP_MIN_SIZE;
    else y2 = y + CROP_MIN_SIZE;
  }

  return clampCropRegion({ x, y, w: x2 - x, h: y2 - y });
}

function deleteSelectedCropRegion() {
  if (cropSelectedIndex < 0 || cropSelectedIndex >= cropRegions.length) return;
  cropRegions.splice(cropSelectedIndex, 1);
  cropSelectedIndex = -1;
  persistCropRegionsForModalPage(cropModalPageIndex);
  drawCropCanvas();
  updateCropRegionsStatus();
}

function updateCropCanvasCursor(pos) {
  const canvas = els.cropCanvas;
  if (!canvas || cropInteraction) return;

  if (cropSelectedIndex >= 0 && cropSelectedIndex < cropRegions.length) {
    const handle = getCropResizeHandle(pos, cropRegions[cropSelectedIndex]);
    if (handle) {
      const cursorMap = {
        nw: "nwse-resize",
        n: "ns-resize",
        ne: "nesw-resize",
        e: "ew-resize",
        se: "nwse-resize",
        s: "ns-resize",
        sw: "nesw-resize",
        w: "ew-resize",
      };
      canvas.style.cursor = cursorMap[handle] || "crosshair";
      return;
    }
    if (pointInCropRegion(pos, cropRegions[cropSelectedIndex])) {
      canvas.style.cursor = "move";
      return;
    }
  }

  const hit = hitTestCropRegions(pos);
  canvas.style.cursor = hit >= 0 ? "move" : "crosshair";
}

function drawSplitReviewCanvas() {
  const canvas = els.splitReviewCanvas;
  const ctx = canvas?.getContext("2d");
  if (!ctx || !splitReviewImageBitmap) return;

  const bitmap = splitReviewImageBitmap;
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(bitmap, 0, 0);

  const isHorizontal = splitReviewDirection === "horizontal";
  const axisSize = isHorizontal ? canvas.height : canvas.width;

  for (let i = 1; i < splitReviewCuts.length - 1; i++) {
    const cut = splitReviewCuts[i];
    ctx.strokeStyle = "#00ccff";
    ctx.lineWidth = 4;
    ctx.setLineDash([12, 8]);
    if (isHorizontal) {
      ctx.beginPath();
      ctx.moveTo(0, cut);
      ctx.lineTo(canvas.width, cut);
      ctx.stroke();
    } else {
      ctx.beginPath();
      ctx.moveTo(cut, 0);
      ctx.lineTo(cut, canvas.height);
      ctx.stroke();
    }

    ctx.setLineDash([]);
    ctx.fillStyle = "#00ccff";
    if (isHorizontal) {
      const handleW = Math.min(40, canvas.width * 0.08);
      ctx.fillRect(canvas.width / 2 - handleW / 2, cut - 6, handleW, 12);
    } else {
      const handleH = Math.min(40, canvas.height * 0.08);
      ctx.fillRect(cut - 6, canvas.height / 2 - handleH / 2, 12, handleH);
    }
  }

  for (let i = 0; i < splitReviewSegments; i++) {
    const start = splitReviewCuts[i];
    const end = splitReviewCuts[i + 1];
    const segSize = end - start;
    const ideal = axisSize / splitReviewSegments;
    if (segSize < Math.max(24, axisSize * 0.06)) {
      ctx.fillStyle = "rgba(255, 0, 0, 0.25)";
      if (isHorizontal) {
        ctx.fillRect(0, start, canvas.width, end - start);
      } else {
        ctx.fillRect(start, 0, end - start, canvas.height);
      }
    }
  }
}

/**
 * @param {number} pageIndex
 * @param {ImageBitmap} bitmap
 * @param {number[]} cuts
 * @param {'horizontal' | 'vertical'} direction
 * @param {number} segments
 * @param {number} minSeg
 * @returns {Promise<{ action: 'confirm' | 'auto' | 'cancel'; cuts?: number[] }>}
 */
function openSplitReviewModal(pageIndex, bitmap, cuts, direction, segments, minSeg) {
  return new Promise((resolve) => {
    splitReviewResolve = resolve;
    splitReviewPageIndex = pageIndex;
    splitReviewDirection = direction;
    splitReviewSegments = segments;
    splitReviewMinSeg = minSeg;
    splitReviewCuts = cuts.slice();
    splitReviewDraggingCut = null;

    if (splitReviewImageBitmap) splitReviewImageBitmap.close();
    splitReviewImageBitmap = bitmap;

    els.splitReviewPageLabel.textContent = t("splitReviewModal.pageLabel", {
      p: pageIndex,
      total: pageCount,
    });
    els.splitReviewInstructions.textContent = t("splitReviewModal.instructionDetailed");

    drawSplitReviewCanvas();
    els.splitReviewModal.hidden = false;
  });
}

function closeSplitReviewModal(result) {
  els.splitReviewModal.hidden = true;
  splitReviewDraggingCut = null;
  if (splitReviewResolve) {
    splitReviewResolve(result);
    splitReviewResolve = null;
  }
}

/**
 * @param {MouseEvent} e
 */
function getSplitReviewMouseAxisPos(e) {
  const canvas = els.splitReviewCanvas;
  const rect = canvas.getBoundingClientRect();
  const isHorizontal = splitReviewDirection === "horizontal";
  const axisSize = isHorizontal ? canvas.height : canvas.width;
  const rel = isHorizontal
    ? (e.clientY - rect.top) / rect.height
    : (e.clientX - rect.left) / rect.width;
  return Math.max(0, Math.min(axisSize, rel * axisSize));
}

/**
 * @param {number} axisPos
 * @returns {number | null}
 */
function hitTestSplitReviewCut(axisPos) {
  const hitDist = Math.max(12, splitReviewMinSeg * 0.5);
  for (let i = 1; i < splitReviewCuts.length - 1; i++) {
    if (Math.abs(splitReviewCuts[i] - axisPos) <= hitDist) return i;
  }
  return null;
}

/**
 * @param {number} cutIndex
 * @param {number} axisPos
 */
function setSplitReviewCutPosition(cutIndex, axisPos) {
  const minSeg = splitReviewMinSeg;
  const prev = splitReviewCuts[cutIndex - 1] + minSeg;
  const next = splitReviewCuts[cutIndex + 1] - minSeg;
  splitReviewCuts[cutIndex] = Math.max(prev, Math.min(next, axisPos));
}

/**
 * @param {ImageBitmap} pageBitmap
 * @param {number} segments
 * @param {'horizontal' | 'vertical'} direction
 * @param {boolean} smartCrop
 */
async function analyzeAutoSplit(pageBitmap, segments, direction, smartCrop) {
  const res = await postWorkerRequest(splitWorker, {
    type: "analyzeAutoSplit",
    payload: {
      imageBitmap: pageBitmap,
      segments,
      direction,
      smartCrop,
    },
  });
  return res.payload;
}

async function openCropModal() {
  if (!pdfWorker || pageCount < 1) {
    setStatus(t("dynamicCopy.status.loadFirst"));
    return;
  }

  setStatus(t("dynamicCopy.status.loadingCropPreview"));
  els.openCropModalBtn.disabled = true;

  try {
    syncCropPageSelectOptions();
    cropModalPageIndex = Math.min(Math.max(1, cropModalPageIndex), pageCount);
    if (els.cropPageSelect) {
      els.cropPageSelect.value = String(cropModalPageIndex);
    }

    cropRegions = (cropRegionsByPage[cropModalPageIndex] ?? []).map((r) => ({ ...r }));

    els.cropModalInstructions.textContent = t("dynamicCopy.cropInstructionsDetailed", {
      total: pageCount,
    });
    cropSelectedIndex = -1;

    await loadCropPreviewForPage(cropModalPageIndex);

    els.cropModal.hidden = false;
    setStatus(t("dynamicCopy.status.ready"));
  } catch (err) {
    console.error(err);
    setStatus(t("dynamicCopy.status.cropPreviewFailed"));
  } finally {
    els.openCropModalBtn.disabled = false;
  }
}

async function runReflow() {
  ensureWorkers();
  clearOutputUrls();
  els.undoTrim.hidden = true;

  if (!pdfLoaded || pageCount < 1) {
    setStatus(t("dynamicCopy.status.selectPdfFirst"));
    return;
  }

  const segments = readSegments();
  const direction = readDirection();
  const rotation = readRotation();
  const trimMargins = els.trimMargins.checked && splitMode === "auto";
  const smartCrop = splitMode === "auto" && readSmartCrop();

  if (splitMode === "manual") {
    for (let p = 1; p <= pageCount; p++) {
      const regs = cropRegionsByPage[p];
      if (!regs || regs.length === 0) {
        setStatus(t("dynamicCopy.status.manualCropMissingPage", { p, total: pageCount }));
        return;
      }
    }
  }

  els.processBtn.disabled = true;
  els.extractBtn.disabled = true;
  els.downloadPdfBtn.disabled = true;
  els.processBtn.setAttribute("aria-busy", "true");
  setStatus(t("dynamicCopy.status.processing"));

  const maxLongEdge = 2800;

  try {
    for (let p = 1; p <= pageCount; p++) {
      setStatus(t("dynamicCopy.status.renderingPage", { p, total: pageCount }));

      const renderRes = await postWorkerRequest(pdfWorker, {
        type: "renderPage",
        payload: buildRenderPayload(p, maxLongEdge, trimMargins),
      });

      let pageBitmap = renderRes.payload?.bitmap;
      if (!(pageBitmap instanceof ImageBitmap)) {
        throw new Error("Render failed: missing bitmap");
      }

      setStatus(t("dynamicCopy.status.splittingPage", { p, total: pageCount }));

      /** @type {number[] | null} */
      let customCuts = autoSplitOverridesByPage[p] ?? null;

      if (
        splitMode === "auto" &&
        smartCrop &&
        segments > 1 &&
        !customCuts
      ) {
        const analysis = await analyzeAutoSplit(
          pageBitmap,
          segments,
          direction,
          smartCrop,
        );
        if (analysis?.ambiguity?.needsReview) {
          const reviewResult = await openSplitReviewModal(
            p,
            pageBitmap,
            analysis.cuts,
            direction,
            segments,
            analysis.minSeg ?? 24,
          );
          if (reviewResult.action === "cancel") {
            pageBitmap.close();
            if (splitReviewImageBitmap) {
              splitReviewImageBitmap.close();
              splitReviewImageBitmap = null;
            }
            setStatus(t("dynamicCopy.status.splitReviewCancelled"));
            return;
          }
          if (reviewResult.action === "confirm" && reviewResult.cuts) {
            customCuts = reviewResult.cuts;
            autoSplitOverridesByPage[p] = customCuts.slice();
          } else if (reviewResult.action === "auto") {
            customCuts = analysis.cuts;
          }
          if (splitReviewImageBitmap) {
            splitReviewImageBitmap.close();
            splitReviewImageBitmap = null;
          }
        }
      }

      const splitRes = await postWorkerRequest(
        splitWorker,
        {
          type: "split",
          payload: {
            imageBitmap: pageBitmap,
            mode: splitMode,
            segments,
            direction,
            rotation,
            cropRegions:
              splitMode === "manual"
                ? cropRegionsByPage[p] ?? []
                : [],
            smartCrop,
            customCuts: splitMode === "auto" ? customCuts : null,
          },
        },
        [pageBitmap],
      );

      const bitmaps = splitRes.payload?.bitmaps;
      if (!Array.isArray(bitmaps)) {
        throw new Error("Split failed");
      }

      for (let i = 0; i < bitmaps.length; i++) {
        const bmp = bitmaps[i];
        if (!(bmp instanceof ImageBitmap)) continue;
        const partNumber = i + 1;
        const label = t("dynamicCopy.outputSegments.label", { p, partNumber });

        const wrapper = document.createElement("div");
        wrapper.className = "output-block";

        const cap = document.createElement("p");
        cap.className = "output-label";
        cap.id = `out-label-${p}-${partNumber}`;
        cap.textContent = label;

        const img = document.createElement("img");
        img.className = "output-img";
        img.alt = t("dynamicCopy.outputSegments.imageAlt", { label });
        img.setAttribute("aria-labelledby", cap.id);

        const url = await imageBitmapToObjectUrl(bmp);
        outputObjectUrls.push(url);
        img.src = url;

        wrapper.append(cap, img);
        els.outputContainer.append(wrapper);
      }
    }

    els.undoTrim.hidden = !trimMargins;
    const n = els.outputContainer.querySelectorAll("img").length;
    els.downloadPdfBtn.hidden = false;
    els.downloadPdfBtn.disabled = false;
    setStatus(
      t("dynamicCopy.status.done", { pageCount, n }),
    );
  } catch (err) {
    console.error(err);
    hideDownloadPdf();
    setStatus(
      t("dynamicCopy.status.error", { message: userErrorMessage(err) }),
    );
  } finally {
    els.processBtn.disabled = false;
    els.extractBtn.disabled = false;
    els.downloadPdfBtn.disabled = els.downloadPdfBtn.hidden;
    els.processBtn.setAttribute("aria-busy", "false");
  }
}

/**
 * @param {string} body
 * @param {number[]} pages
 * @param {number} total
 * @param {boolean} sampled
 */
function presentExtractedText(body, pages, total, sampled) {
  const trimmed = (body || "").trim();
  if (!trimmed) {
    els.extractedText.value = t("dynamicCopy.extractedText.noTextFound");
    return;
  }
  if (sampled) {
    const pagesLabel = formatPageList(pages);
    const note = t("dynamicCopy.extractedText.sampleNote", {
      pages: pagesLabel,
      total,
    });
    els.extractedText.value = `${note}\n\n${trimmed}`;
  } else {
    els.extractedText.value = trimmed;
  }
}

/**
 * @param {number[]} pages
 * @param {number} total
 * @param {boolean} sampled
 */
function extractionFinishedStatus(pages, total, sampled) {
  if (sampled) {
    setStatus(
      t("dynamicCopy.status.extractionFinishedSample", {
        pages: formatPageList(pages),
        total,
      }),
    );
  } else {
    setStatus(t("dynamicCopy.status.extractionFinished"));
  }
}

async function runTextExtraction() {
  if (!pdfWorker || pageCount < 1) {
    els.extractedText.value = t("dynamicCopy.extractedText.loadFirst");
    return;
  }

  els.extractBtn.disabled = true;
  els.processBtn.disabled = true;
  els.downloadPdfBtn.disabled = true;
  els.extractBtn.setAttribute("aria-busy", "true");

  const embeddedPages = sampleVerificationPages(pageCount, EMBEDDED_VERIFY_MAX_PAGES);
  const embeddedSampled = embeddedPages.length < pageCount;
  if (embeddedSampled) {
    setStatus(
      t("dynamicCopy.status.extractingTextSample", {
        pages: formatPageList(embeddedPages),
        total: pageCount,
      }),
    );
  } else {
    setStatus(t("dynamicCopy.status.extractingText"));
  }

  try {
    const res = await postWorkerRequest(pdfWorker, {
      type: "extractText",
      payload: { pageIndices: embeddedPages },
    });
    const embeddedText = res.payload?.text ?? "";
    const hasEmbeddedText = !!res.payload?.hasEmbeddedText;
    const usedEmbeddedPages = Array.isArray(res.payload?.pageIndices)
      ? res.payload.pageIndices
      : embeddedPages;

    if (hasEmbeddedText && embeddedText.trim()) {
      presentExtractedText(
        embeddedText,
        usedEmbeddedPages,
        pageCount,
        embeddedSampled,
      );
      extractionFinishedStatus(usedEmbeddedPages, pageCount, embeddedSampled);
      return;
    }

    const ocrPages = sampleVerificationPages(pageCount, OCR_VERIFY_MAX_PAGES);
    const ocrSampled = ocrPages.length < pageCount;
    if (ocrSampled) {
      setStatus(
        t("dynamicCopy.status.ocrSampleNotice", {
          pages: formatPageList(ocrPages),
          total: pageCount,
        }),
      );
    }

    const ocrText = await runTesseractOnPdfPages(
      async (pageIndex) => {
        const renderRes = await postWorkerRequest(pdfWorker, {
          type: "renderPage",
          payload: buildOcrRenderPayload(pageIndex),
        });
        const bitmap = renderRes.payload?.bitmap;
        if (!(bitmap instanceof ImageBitmap)) {
          throw new Error("Render failed: missing bitmap");
        }
        return bitmap;
      },
      ocrPages,
      pageCount,
      getLocale(),
      (key, vars) => setStatus(t(key, vars)),
    );

    presentExtractedText(ocrText, ocrPages, pageCount, ocrSampled);
    extractionFinishedStatus(ocrPages, pageCount, ocrSampled);
  } catch (err) {
    console.error(err);
    els.extractedText.value = t("dynamicCopy.extractedText.failed", {
      message: userErrorMessage(err),
    });
    setStatus(t("dynamicCopy.status.extractionFailed"));
  } finally {
    els.extractBtn.disabled = false;
    els.processBtn.disabled = false;
    els.downloadPdfBtn.disabled = els.downloadPdfBtn.hidden;
    els.extractBtn.setAttribute("aria-busy", "false");
  }
}

async function downloadReflowedPdf() {
  const imgs = els.outputContainer.querySelectorAll("img.output-img");
  if (imgs.length === 0) {
    setStatus(t("dynamicCopy.status.generateFirst"));
    return;
  }

  els.downloadPdfBtn.disabled = true;
  els.downloadPdfBtn.setAttribute("aria-busy", "true");
  setStatus(t("dynamicCopy.status.buildingPdf"));

  try {
    const { PDFDocument } = await import(PDF_LIB_URL);
    const pdfDoc = await PDFDocument.create();

    for (const img of imgs) {
      const res = await fetch(img.src);
      if (!res.ok) {
        throw new Error(t("dynamicCopy.workerErrors.readSegmentImage"));
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pngImage = await pdfDoc.embedPng(bytes);
      const w = pngImage.width;
      const h = pngImage.height;

      const box = letterBoxLayout(w, h);
      const page = pdfDoc.addPage([box.pageW, box.pageH]);
      page.drawImage(pngImage, {
        x: box.x,
        y: box.y,
        width: box.drawW,
        height: box.drawH,
      });
    }

    const outBytes = await pdfDoc.save();
    const blob = new Blob([outBytes], { type: "application/pdf" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = reflowedDownloadFilename();
    a.rel = "noopener";
    document.body.append(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
    setStatus(t("dynamicCopy.status.downloadStarted"));
  } catch (err) {
    console.error(err);
    setStatus(
      t("dynamicCopy.status.buildPdfFailed", { message: userErrorMessage(err) }),
    );
  } finally {
    els.downloadPdfBtn.disabled = false;
    els.downloadPdfBtn.setAttribute("aria-busy", "false");
  }
}

function initWelcome() {
  function showWelcome() {
    els.welcomeScreen.removeAttribute("hidden");
    requestAnimationFrame(() => {
      els.welcomeContinue.focus();
    });
  }

  function dismissWelcome() {
    els.welcomeScreen.setAttribute("hidden", "");
    try {
      localStorage.setItem(WELCOME_SEEN_KEY, "1");
    } catch {
      /* ignore */
    }
    els.pdfInput.focus();
  }

  try {
    if (!localStorage.getItem(WELCOME_SEEN_KEY)) {
      showWelcome();
    }
  } catch {
    showWelcome();
  }

  els.welcomeContinue.addEventListener("click", dismissWelcome);
  els.welcomeHelp.addEventListener("click", () => {
    showWelcome();
  });
}

async function refreshLivePreviews() {
  if (!pdfLoaded || pageCount < 1 || !pdfWorker) return;
  try {
    await renderFirstPagePreview();
    if (!els.cropModal.hidden) {
      await loadCropPreviewForPage(cropModalPageIndex);
    }
  } catch (err) {
    console.error(err);
  }
}

function wireEvents() {
  els.themeToggle.addEventListener("click", () => {
    const isDark = document.documentElement.getAttribute("data-theme") === "dark";
    applyTheme(!isDark);
  });

  els.pdfInput.addEventListener("change", async (e) => {
    const file = e.target.files?.[0];
    clearOutputUrls();
    els.previewBlock.hidden = true;
    els.undoTrim.hidden = true;
    if (!els.cropModal.hidden) {
      els.cropModal.hidden = true;
      persistCropRegionsForModalPage(cropModalPageIndex);
    }
    if (cropPreviewImageBitmap) {
      cropPreviewImageBitmap.close();
      cropPreviewImageBitmap = null;
    }
    pageCount = 0;
    pdfLoaded = false;
    lastPdfBaseName = "";
    cropRegionsByPage = {};
    cropRegions = [];
    cropModalPageIndex = 1;
    cropSelectedIndex = -1;
    autoSplitOverridesByPage = {};
    els.extractedText.value = "";
    els.extractBtn.disabled = true;

    if (!file) {
      setStatus(t("dynamicCopy.status.noFileSelected"));
      if (splitMode === "manual") updateCropRegionsStatus();
      return;
    }

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus(t("dynamicCopy.status.choosePdf"));
      if (splitMode === "manual") updateCropRegionsStatus();
      return;
    }

    lastPdfBaseName = file.name || "document.pdf";
    setStatus(t("dynamicCopy.status.loadingPdf"));

    try {
      const buffer = await file.arrayBuffer();
      pageCount = await loadPdfIntoWorker(buffer);
      setStatus(
        pageCount > 0
          ? t("dynamicCopy.status.pdfLoaded", { pageCount })
          : t("dynamicCopy.status.pageCountError"),
      );
      if (pageCount > 0) {
        els.extractBtn.disabled = false;
      }
      if (splitMode === "manual") {
        updateCropRegionsStatus();
      }
      await renderFirstPagePreview();
    } catch (err) {
      console.error(err);
      pageCount = 0;
      const errMsg = userErrorMessage(err);
      setStatus(t("dynamicCopy.status.loadPdfFailed", { message: errMsg }));
    }
  });

  els.processBtn.addEventListener("click", () => {
    void runReflow();
  });

  els.extractBtn.addEventListener("click", () => {
    void runTextExtraction();
  });

  els.downloadPdfBtn.addEventListener("click", () => {
    void downloadReflowedPdf();
  });

  els.undoTrim.addEventListener("click", () => {
    els.trimMargins.checked = false;
    els.undoTrim.hidden = true;
    void refreshLivePreviews();
    void runReflow();
  });

  if (els.autoContrast) {
    els.autoContrast.addEventListener("change", () => {
      void refreshLivePreviews();
    });
  }
  if (els.autoDeskew) {
    els.autoDeskew.addEventListener("change", () => {
      void refreshLivePreviews();
    });
  }

  els.debugToggle.addEventListener("click", () => {
    els.debugPanel.hidden = !els.debugPanel.hidden;
  });

  els.debugClose.addEventListener("click", () => {
    els.debugPanel.hidden = true;
  });

  els.debugClear.addEventListener("click", () => {
    getDebugOut().innerHTML = "";
  });

  els.splitModeRadios.forEach((radio) => {
    radio.addEventListener("change", (e) => {
      splitMode = e.target.value;
      if (splitMode === "manual") {
        els.manualCropWarning.hidden = false;
        els.manualCropControls.hidden = false;
        els.autoCropControls.hidden = true;
        updateCropRegionsStatus();
      } else {
        els.manualCropWarning.hidden = true;
        els.manualCropControls.hidden = true;
        els.autoCropControls.hidden = false;
      }
    });
  });

  document.querySelectorAll('input[name="segments"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (splitMode === "auto") {
        autoSplitOverridesByPage = {};
        if (Object.keys(cropRegionsByPage).length > 0) {
          cropRegionsByPage = {};
          cropRegions = [];
          cropSelectedIndex = -1;
          updateCropRegionsStatus();
        }
      }
    });
  });

  document.querySelectorAll('input[name="direction"]').forEach((radio) => {
    radio.addEventListener("change", () => {
      if (splitMode === "auto") {
        autoSplitOverridesByPage = {};
      }
    });
  });

  if (els.smartCrop) {
    els.smartCrop.addEventListener("change", () => {
      autoSplitOverridesByPage = {};
    });
  }

  els.openCropModalBtn.addEventListener("click", () => {
    void openCropModal();
  });

  if (els.cropPageSelect) {
    els.cropPageSelect.addEventListener("change", () => {
      void (async () => {
        const next = Number(els.cropPageSelect.value);
        if (!Number.isFinite(next) || next < 1 || next > pageCount) return;

        persistCropRegionsForModalPage(cropModalPageIndex);
        cropModalPageIndex = next;
        cropRegions = (cropRegionsByPage[cropModalPageIndex] ?? []).map((r) => ({
          ...r,
        }));
        cropSelectedIndex = -1;

        setStatus(t("dynamicCopy.status.loadingCropPreview"));
        els.cropPageSelect.disabled = true;
        try {
          await loadCropPreviewForPage(cropModalPageIndex);
          setStatus(t("dynamicCopy.status.ready"));
        } catch (err) {
          console.error(err);
          setStatus(t("dynamicCopy.status.cropPreviewFailed"));
        } finally {
          els.cropPageSelect.disabled = false;
        }
      })();
    });
  }

  els.cropClearBtn.addEventListener("click", () => {
    cropRegions = [];
    cropSelectedIndex = -1;
    persistCropRegionsForModalPage(cropModalPageIndex);
    currentCropPreview = null;
    drawCropCanvas();
    updateCropRegionsStatus();
  });

  if (els.cropDeleteSelectedBtn) {
    els.cropDeleteSelectedBtn.addEventListener("click", () => {
      deleteSelectedCropRegion();
    });
  }

  els.cropCancelBtn.addEventListener("click", () => {
    persistCropRegionsForModalPage(cropModalPageIndex);
    els.cropModal.hidden = true;
    updateCropRegionsStatus();
  });

  els.cropSaveBtn.addEventListener("click", () => {
    persistCropRegionsForModalPage(cropModalPageIndex);
    els.cropModal.hidden = true;
    updateCropRegionsStatus();
  });

  function getCropMousePos(e) {
    const rect = els.cropCanvas.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    return { x: Math.max(0, Math.min(1, x)), y: Math.max(0, Math.min(1, y)) };
  }

  els.cropCanvas.addEventListener("mousedown", (e) => {
    const pos = getCropMousePos(e);

    if (cropSelectedIndex >= 0 && cropSelectedIndex < cropRegions.length) {
      const handle = getCropResizeHandle(pos, cropRegions[cropSelectedIndex]);
      if (handle) {
        cropInteraction = "resize";
        cropResizeHandle = handle;
        cropDragStartRegion = { ...cropRegions[cropSelectedIndex] };
        cropDragAnchor = pos;
        e.preventDefault();
        return;
      }
    }

    const hitIndex = hitTestCropRegions(pos);
    if (hitIndex >= 0) {
      cropSelectedIndex = hitIndex;
      cropInteraction = "move";
      cropDragStartRegion = { ...cropRegions[hitIndex] };
      cropDragAnchor = pos;
      drawCropCanvas();
      e.preventDefault();
      return;
    }

    cropSelectedIndex = -1;
    cropDrawing = true;
    cropInteraction = "draw";
    cropStart = pos;
    currentCropPreview = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
    drawCropCanvas();
  });

  els.cropCanvas.addEventListener("mousemove", (e) => {
    const pos = getCropMousePos(e);

    if (cropInteraction === "resize" && cropResizeHandle && cropDragStartRegion && cropSelectedIndex >= 0) {
      cropRegions[cropSelectedIndex] = resizeCropRegionFromHandle(
        cropDragStartRegion,
        cropResizeHandle,
        pos,
      );
      drawCropCanvas();
      return;
    }

    if (cropInteraction === "move" && cropDragStartRegion && cropSelectedIndex >= 0) {
      const dx = pos.x - cropDragAnchor.x;
      const dy = pos.y - cropDragAnchor.y;
      cropRegions[cropSelectedIndex] = clampCropRegion({
        x: cropDragStartRegion.x + dx,
        y: cropDragStartRegion.y + dy,
        w: cropDragStartRegion.w,
        h: cropDragStartRegion.h,
      });
      drawCropCanvas();
      return;
    }

    if (cropDrawing && cropInteraction === "draw") {
      const x = Math.min(cropStart.x, pos.x);
      const y = Math.min(cropStart.y, pos.y);
      const w = Math.abs(pos.x - cropStart.x);
      const h = Math.abs(pos.y - cropStart.y);
      currentCropPreview = { x, y, w, h };
      drawCropCanvas();
      return;
    }

    updateCropCanvasCursor(pos);
  });

  function finishCropInteraction() {
    if (cropInteraction === "draw" && cropDrawing) {
      cropDrawing = false;
      if (currentCropPreview && currentCropPreview.w > CROP_MIN_SIZE && currentCropPreview.h > CROP_MIN_SIZE) {
        cropRegions.push(currentCropPreview);
        cropSelectedIndex = cropRegions.length - 1;
        persistCropRegionsForModalPage(cropModalPageIndex);
        updateCropRegionsStatus();
      }
      currentCropPreview = null;
    } else if (cropInteraction === "move" || cropInteraction === "resize") {
      persistCropRegionsForModalPage(cropModalPageIndex);
    }
    cropInteraction = null;
    cropResizeHandle = null;
    cropDragStartRegion = null;
    drawCropCanvas();
  }

  els.cropCanvas.addEventListener("mouseup", () => {
    finishCropInteraction();
  });

  els.cropCanvas.addEventListener("mouseleave", () => {
    if (cropInteraction === "draw") {
      cropDrawing = false;
      currentCropPreview = null;
      cropInteraction = null;
      drawCropCanvas();
    }
    els.cropCanvas.style.cursor = "crosshair";
  });

  els.cropCanvas.addEventListener("dblclick", (e) => {
    const pos = getCropMousePos(e);
    const hit = hitTestCropRegions(pos);
    if (hit >= 0) {
      cropSelectedIndex = hit;
      deleteSelectedCropRegion();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (els.cropModal.hidden) return;
    if (e.key === "Delete" || e.key === "Backspace") {
      if (cropSelectedIndex >= 0) {
        e.preventDefault();
        deleteSelectedCropRegion();
      }
    }
    if (e.key === "Escape" && cropSelectedIndex >= 0) {
      cropSelectedIndex = -1;
      drawCropCanvas();
    }
  });

  if (els.splitReviewCanvas) {
    els.splitReviewCanvas.addEventListener("mousedown", (e) => {
      const axisPos = getSplitReviewMouseAxisPos(e);
      splitReviewDraggingCut = hitTestSplitReviewCut(axisPos);
      e.preventDefault();
    });

    els.splitReviewCanvas.addEventListener("mousemove", (e) => {
      if (splitReviewDraggingCut === null) return;
      const axisPos = getSplitReviewMouseAxisPos(e);
      setSplitReviewCutPosition(splitReviewDraggingCut, axisPos);
      drawSplitReviewCanvas();
    });

    els.splitReviewCanvas.addEventListener("mouseup", () => {
      splitReviewDraggingCut = null;
    });

    els.splitReviewCanvas.addEventListener("mouseleave", () => {
      splitReviewDraggingCut = null;
    });
  }

  if (els.splitReviewConfirmBtn) {
    els.splitReviewConfirmBtn.addEventListener("click", () => {
      closeSplitReviewModal({ action: "confirm", cuts: splitReviewCuts.slice() });
    });
  }

  if (els.splitReviewAcceptAutoBtn) {
    els.splitReviewAcceptAutoBtn.addEventListener("click", () => {
      closeSplitReviewModal({ action: "auto" });
    });
  }

  if (els.splitReviewCancelBtn) {
    els.splitReviewCancelBtn.addEventListener("click", () => {
      closeSplitReviewModal({ action: "cancel" });
    });
  }
}

function init() {
  initTheme();
  initWelcome();
  els.extractBtn.disabled = true;
  hideDownloadPdf();
  setStatus(t("dynamicCopy.status.readyToSelect"));
  wireEvents();
}

async function boot() {
  const initial = resolveInitialLocale();
  await setLocale(initial);
  if (els.localeSelect) {
    els.localeSelect.value = getLocale();
    els.localeSelect.addEventListener("change", () => {
      void setLocale(els.localeSelect.value).then(() => {
        updateCropRegionsStatus();
        applyTheme(document.documentElement.getAttribute("data-theme") === "dark");
        if (!pdfLoaded || pageCount < 1) {
          setStatus(t("dynamicCopy.status.readyToSelect"));
        }
      });
    });
  }
  document.addEventListener("lv-pdf-localechange", () => {
    if (els.localeSelect) els.localeSelect.value = getLocale();
    if (pageCount > 0) {
      syncCropPageSelectOptions();
      if (els.cropPageSelect) {
        els.cropPageSelect.value = String(
          Math.min(Math.max(1, cropModalPageIndex), pageCount),
        );
      }
    }
    updateCropRegionsStatus();
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark");
  });
  init();
}

void boot();