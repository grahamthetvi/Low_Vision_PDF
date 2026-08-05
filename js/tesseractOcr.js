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
 * @param {number[]} pageIndices 1-based pages to OCR (already sampled/capped by caller)
 * @param {number} documentPageCount Total pages in the PDF (for status copy)
 * @param {string} locale
 * @param {(statusKey: string, vars?: Record<string, string | number>) => void} onStatus
 */
export async function runTesseractOnPdfPages(
  renderPageBitmap,
  pageIndices,
  documentPageCount,
  locale,
  onStatus,
) {
  const pages = Array.isArray(pageIndices)
    ? pageIndices.map((n) => Math.floor(Number(n))).filter((p) => p >= 1)
    : [];
  if (pages.length === 0) return "";

  onStatus("dynamicCopy.status.ocrLoadingEngine");
  const { createWorker } = await import(/* webpackIgnore: true */ TESSERACT_MODULE_URL);
  const lang = tessLang(locale);

  const worker = await createWorker(lang, 1, {
    workerPath: WORKER_SCRIPT_URL,
    corePath: CORE_PATH,
    langPath: LANG_PATH,
    logger: () => {},
  });

  const parts = [];
  const sampleCount = pages.length;
  const total = documentPageCount || sampleCount;
  try {
    for (let i = 0; i < pages.length; i++) {
      const p = pages[i];
      onStatus("dynamicCopy.status.ocrPage", {
        p,
        i: i + 1,
        sampleCount,
        total,
      });
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
