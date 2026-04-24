/**
 * Main-thread UI and coordination. PDF rasterization runs in pdfRender.worker;
 * splitting and rotation run in split.worker. No document data is sent remotely.
 */

const PDF_WORKER_URL = new URL("../workers/pdfRender.worker.mjs", import.meta.url);
const SPLIT_WORKER_URL = new URL("../workers/split.worker.mjs", import.meta.url);
const PDF_LIB_URL = new URL("../vendor/pdf-lib/pdf-lib.esm.min.js", import.meta.url);

const WELCOME_SEEN_KEY = "lv-pdf-welcome-seen";

let _debugOut = null;
function getDebugOut() {
  if (!_debugOut) _debugOut = document.getElementById("debug-output");
  return _debugOut;
}

function logToDebug(level, ...args) {
  const out = getDebugOut();
  if (!out) return;
  const msg = args.map(a => (typeof a === 'object' ? (a instanceof Error ? a.stack || a.message : JSON.stringify(a)) : String(a))).join(' ');
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
      const data = ev.data;
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

function hideDownloadPdf() {
  els.downloadPdfBtn.hidden = true;
  els.downloadPdfBtn.disabled = true;
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
  return `${base}-reflowed.pdf`;
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
  return Number(checked?.value || 0);
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
    dark
      ? "Switch to light high-contrast theme"
      : "Switch to dark high-contrast theme",
  );
  els.themeToggle.textContent = dark ? "Light mode" : "Dark mode";
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

async function runReflow() {
  ensureWorkers();
  clearOutputUrls();
  els.undoTrim.hidden = true;

  if (!pdfLoaded || pageCount < 1) {
    setStatus("Select a PDF first.");
    return;
  }

  const segments = readSegments();
  const direction = readDirection();
  const rotation = readRotation();
  const trimMargins = els.trimMargins.checked;

  els.processBtn.disabled = true;
  els.extractBtn.disabled = true;
  els.downloadPdfBtn.disabled = true;
  els.processBtn.setAttribute("aria-busy", "true");
  setStatus("Processing…");

  const maxLongEdge = 2800;

  try {
    for (let p = 1; p <= pageCount; p++) {
      setStatus(`Rendering page ${p} of ${pageCount}…`);

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

      setStatus(`Splitting page ${p} of ${pageCount}…`);

      const splitRes = await postWorkerRequest(
        splitWorker,
        {
          type: "split",
          payload: {
            imageBitmap: pageBitmap,
            segments,
            direction,
            rotation,
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
        const label = `Page ${p}: Part ${partNumber}`;

        const wrapper = document.createElement("div");
        wrapper.className = "output-block";

        const cap = document.createElement("p");
        cap.className = "output-label";
        cap.id = `out-label-${p}-${partNumber}`;
        cap.textContent = label;

        const img = document.createElement("img");
        img.className = "output-img";
        img.alt = `${label} — reflowed segment`;
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
      `Done. ${pageCount} page(s) reflowed into ${n} segment image(s). Use “Download reflowed PDF” when you are ready.`,
    );
  } catch (err) {
    console.error(err);
    hideDownloadPdf();
    setStatus(
      `Error: ${err instanceof Error ? err.message : String(err)}`,
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
    els.extractedText.value = "Load a PDF before extracting text.";
    return;
  }

  els.extractBtn.disabled = true;
  els.processBtn.disabled = true;
  els.downloadPdfBtn.disabled = true;
  els.extractBtn.setAttribute("aria-busy", "true");
  setStatus("Extracting text…");

  try {
    const res = await postWorkerRequest(pdfWorker, { type: "extractText" });
    const text = res.payload?.text ?? "";
    els.extractedText.value = text.trim()
      ? text
      : "No embedded text was found. This may be a scanned PDF; only OCR could read pixels, which is not enabled in this build.";
    setStatus("Text extraction finished.");
  } catch (err) {
    console.error(err);
    els.extractedText.value = `Extraction failed: ${err instanceof Error ? err.message : String(err)}`;
    setStatus("Text extraction failed.");
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
    setStatus("Generate the reflowed view first.");
    return;
  }

  els.downloadPdfBtn.disabled = true;
  els.downloadPdfBtn.setAttribute("aria-busy", "true");
  setStatus("Building PDF…");

  try {
    const { PDFDocument } = await import(PDF_LIB_URL);
    const pdfDoc = await PDFDocument.create();

    for (const img of imgs) {
      const res = await fetch(img.src);
      if (!res.ok) {
        throw new Error("Could not read a segment image");
      }
      const bytes = new Uint8Array(await res.arrayBuffer());
      const pngImage = await pdfDoc.embedPng(bytes);
      const w = pngImage.width;
      const h = pngImage.height;
      const page = pdfDoc.addPage([w, h]);
      page.drawImage(pngImage, { x: 0, y: 0, width: w, height: h });
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
    setStatus("Reflowed PDF download started.");
  } catch (err) {
    console.error(err);
    setStatus(
      `Could not build PDF: ${err instanceof Error ? err.message : String(err)}`,
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
      setStatus("No file selected.");
      return;
    }

    if (file.type !== "application/pdf" && !file.name.toLowerCase().endsWith(".pdf")) {
      setStatus("Please choose a PDF file.");
      return;
    }

    lastPdfBaseName = file.name || "document.pdf";
    setStatus("Loading PDF…");

    try {
      const buffer = await file.arrayBuffer();
      pageCount = await loadPdfIntoWorker(buffer);
      setStatus(
        pageCount > 0
          ? `Loaded ${pageCount} page(s). Review the preview, optionally extract text to verify, then configure and generate the reflowed view.`
          : "Could not read page count.",
      );
      if (pageCount > 0) {
        els.extractBtn.disabled = false;
      }
      await renderFirstPagePreview();
    } catch (err) {
      console.error(err);
      pageCount = 0;
      const errMsg = err instanceof Error ? err.message : String(err);
      setStatus(`Could not load PDF: ${errMsg}`);
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
}

function init() {
  initTheme();
  initWelcome();
  els.extractBtn.disabled = true;
  hideDownloadPdf();
  setStatus("Ready. Select a PDF to begin.");
  wireEvents();
}

init();