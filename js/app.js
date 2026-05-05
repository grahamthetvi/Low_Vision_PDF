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

const PDF_WORKER_URL = new URL("../workers/pdfRender.worker.mjs", import.meta.url);
const SPLIT_WORKER_URL = new URL("../workers/split.worker.mjs", import.meta.url);
const PDF_LIB_URL = new URL("../vendor/pdf-lib/pdf-lib.esm.min.js", import.meta.url);

const WELCOME_SEEN_KEY = "lv-pdf-welcome-seen";

/** US Letter size in PDF points (1 pt = 1/72 in). Used to pad manual crops for predictable printing. */
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
/** @type {{x:number, y:number, w:number, h:number}[]} */
let cropRegions = [];
let cropDrawing = false;
let cropStart = { x: 0, y: 0 };
let currentCropPreview = null;
/** @type {ImageBitmap | null} */
let cropPreviewImageBitmap = null;

const els = {
  welcomeScreen: document.getElementById("welcome-screen"),
  welcomeContinue: document.getElementById("welcome-continue"),
  welcomeHelp: document.getElementById("welcome-help"),
  themeToggle: document.getElementById("theme-toggle"),
  pdfInput: document.getElementById("pdf-input"),
  previewBlock: document.getElementById("preview-block"),
  previewCanvas: document.getElementById("preview-canvas"),
  trimMargins: document.getElementById("trim-margins"),
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
  cropCancelBtn: document.getElementById("crop-cancel"),
  cropSaveBtn: document.getElementById("crop-save"),
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
  const segments = readSegments();
  if (cropRegions.length === 0) {
    els.cropRegionsStatus.textContent = t("dynamicCopy.cropStatus.noRegionsYet", { N: segments });
  } else if (cropRegions.length < segments) {
    els.cropRegionsStatus.textContent = t("dynamicCopy.cropStatus.someRegionsDefined", {
      M: cropRegions.length,
      N: segments,
    });
  } else {
    els.cropRegionsStatus.textContent = t("dynamicCopy.cropStatus.allRegionsDefined", { N: segments });
  }
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
    payload: {
      pageIndex: 1,
      maxLongEdge: 900,
      trimMargins: false,
    },
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

  ctx.strokeStyle = "red";
  ctx.lineWidth = 3;
  ctx.fillStyle = "rgba(255, 0, 0, 0.15)";

  for (const r of cropRegions) {
    const x = r.x * canvas.width;
    const y = r.y * canvas.height;
    const w = r.w * canvas.width;
    const h = r.h * canvas.height;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }

  if (currentCropPreview) {
    ctx.strokeStyle = "blue";
    ctx.fillStyle = "rgba(0, 0, 255, 0.2)";
    const x = currentCropPreview.x * canvas.width;
    const y = currentCropPreview.y * canvas.height;
    const w = currentCropPreview.w * canvas.width;
    const h = currentCropPreview.h * canvas.height;
    ctx.fillRect(x, y, w, h);
    ctx.strokeRect(x, y, w, h);
  }
}

async function openCropModal() {
  if (!pdfWorker || pageCount < 1) {
    setStatus(t("dynamicCopy.status.loadFirst"));
    return;
  }

  setStatus(t("dynamicCopy.status.loadingCropPreview"));
  els.openCropModalBtn.disabled = true;

  try {
    const res = await postWorkerRequest(pdfWorker, {
      type: "renderPage",
      payload: { pageIndex: 1, maxLongEdge: 1600, trimMargins: false },
    });
    const bitmap = res.payload?.bitmap;
    if (!(bitmap instanceof ImageBitmap)) throw new Error("Render failed");

    if (cropPreviewImageBitmap) cropPreviewImageBitmap.close();
    cropPreviewImageBitmap = bitmap;
    els.cropCanvas.width = bitmap.width;
    els.cropCanvas.height = bitmap.height;

    const segments = readSegments();
    els.cropModalInstructions.textContent = t("dynamicCopy.cropInstructionsDetailed", {
      N: segments,
    });

    drawCropCanvas();
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

  if (splitMode === "manual" && cropRegions.length !== segments) {
    setStatus(t("dynamicCopy.status.defineExactRegions", { N: segments }));
    return;
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
        payload: {
          pageIndex: p,
          maxLongEdge,
          trimMargins,
        },
      });

      let pageBitmap = renderRes.payload?.bitmap;
      if (!(pageBitmap instanceof ImageBitmap)) {
        throw new Error("Render failed: missing bitmap");
      }

      setStatus(t("dynamicCopy.status.splittingPage", { p, total: pageCount }));

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
            cropRegions: splitMode === "manual" ? cropRegions : [],
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

async function runTextExtraction() {
  if (!pdfWorker || pageCount < 1) {
    els.extractedText.value = t("dynamicCopy.extractedText.loadFirst");
    return;
  }

  els.extractBtn.disabled = true;
  els.processBtn.disabled = true;
  els.downloadPdfBtn.disabled = true;
  els.extractBtn.setAttribute("aria-busy", "true");
  setStatus(t("dynamicCopy.status.extractingText"));

  try {
    const res = await postWorkerRequest(pdfWorker, { type: "extractText" });
    const text = res.payload?.text ?? "";
    els.extractedText.value = text.trim()
      ? text
      : t("dynamicCopy.extractedText.noTextFound");
    setStatus(t("dynamicCopy.status.extractionFinished"));
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

      if (splitMode === "manual") {
        const box = letterBoxLayout(w, h);
        const page = pdfDoc.addPage([box.pageW, box.pageH]);
        page.drawImage(pngImage, {
          x: box.x,
          y: box.y,
          width: box.drawW,
          height: box.drawH,
        });
      } else {
        const page = pdfDoc.addPage([w, h]);
        page.drawImage(pngImage, { x: 0, y: 0, width: w, height: h });
      }
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
    pageCount = 0;
    pdfLoaded = false;
    lastPdfBaseName = "";
    els.extractedText.value = "";
    els.extractBtn.disabled = true;

    if (!file) {
      setStatus(t("dynamicCopy.status.noFileSelected"));
      return;
    }

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus(t("dynamicCopy.status.choosePdf"));
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
    void runReflow();
  });

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
      if (cropRegions.length > 0) {
        cropRegions = [];
        updateCropRegionsStatus();
      }
    });
  });

  els.openCropModalBtn.addEventListener("click", () => {
    void openCropModal();
  });

  els.cropClearBtn.addEventListener("click", () => {
    cropRegions = [];
    currentCropPreview = null;
    drawCropCanvas();
    updateCropRegionsStatus();
  });

  els.cropCancelBtn.addEventListener("click", () => {
    els.cropModal.hidden = true;
  });

  els.cropSaveBtn.addEventListener("click", () => {
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
    cropDrawing = true;
    cropStart = getCropMousePos(e);
    currentCropPreview = { x: cropStart.x, y: cropStart.y, w: 0, h: 0 };
  });

  els.cropCanvas.addEventListener("mousemove", (e) => {
    if (!cropDrawing) return;
    const pos = getCropMousePos(e);
    const x = Math.min(cropStart.x, pos.x);
    const y = Math.min(cropStart.y, pos.y);
    const w = Math.abs(pos.x - cropStart.x);
    const h = Math.abs(pos.y - cropStart.y);
    currentCropPreview = { x, y, w, h };
    drawCropCanvas();
  });

  els.cropCanvas.addEventListener("mouseup", () => {
    if (!cropDrawing) return;
    cropDrawing = false;
    if (currentCropPreview && currentCropPreview.w > 0.01 && currentCropPreview.h > 0.01) {
      const segments = readSegments();
      if (cropRegions.length < segments) {
        cropRegions.push(currentCropPreview);
      } else {
        cropRegions[cropRegions.length - 1] = currentCropPreview;
      }
    }
    currentCropPreview = null;
    drawCropCanvas();
    updateCropRegionsStatus();
  });

  els.cropCanvas.addEventListener("mouseleave", () => {
    if (!cropDrawing) return;
    cropDrawing = false;
    currentCropPreview = null;
    drawCropCanvas();
  });
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
    updateCropRegionsStatus();
    applyTheme(document.documentElement.getAttribute("data-theme") === "dark");
  });
  init();
}

void boot();