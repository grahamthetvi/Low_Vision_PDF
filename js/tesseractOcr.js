/**
 * Browser OCR via Tesseract.js (WASM). Loads vendored worker/core/lang data from same origin.
 */

const TESSERACT_MODULE_URL = new URL(
  "../vendor/tesseract.js/dist/tesseract.esm.min.js",
  import.meta.url,
).href;
const WORKER_SCRIPT_URL = new URL(
  "../vendor/tesseract.js/dist/worker.min.js",
  import.meta.url,
).href;
const CORE_PATH = new URL("../vendor/tesseract.js-core/", import.meta.url).href;
const LANG_PATH = new URL("../vendor/tessdata/", import.meta.url).href;

/**
 * @param {string} locale App locale (`ar` uses Arabic traineddata).
 */
function tessLang(locale) {
  return locale === "ar" ? "ara" : "eng";
}

/**
 * @param {(pageIndex: number) => Promise<ImageBitmap>} renderPageBitmap 1-based page index
 * @param {number} pageCount
 * @param {string} locale
 * @param {(statusKey: string, vars?: Record<string, string | number>) => void} onStatus
 */
export async function runTesseractOnPdfPages(
  renderPageBitmap,
  pageCount,
  locale,
  onStatus,
) {
  onStatus("dynamicCopy.status.ocrLoadingEngine");
  const mod = await import(/* webpackIgnore: true */ TESSERACT_MODULE_URL);
  const createWorker = mod.default?.createWorker;
  if (typeof createWorker !== "function") {
    throw new Error("Tesseract.js default export is missing createWorker");
  }
  const lang = tessLang(locale);

  const worker = await createWorker(lang, 1, {
    workerPath: WORKER_SCRIPT_URL,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    logger: () => {},
  });

  const parts = [];
  try {
    for (let p = 1; p <= pageCount; p++) {
      onStatus("dynamicCopy.status.ocrPage", { p, total: pageCount });
      let bitmap;
      try {
        bitmap = await renderPageBitmap(p);
        const {
          data: { text },
        } = await worker.recognize(bitmap);
        parts.push(`--- Page ${p} ---\n${text ?? ""}\n`);
      } finally {
        if (bitmap instanceof ImageBitmap) bitmap.close();
      }
    }
  } finally {
    await worker.terminate();
  }

  return parts.join("\n");
}
