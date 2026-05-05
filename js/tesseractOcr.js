/**
 * Browser OCR via Tesseract.js (WASM). Loads vendored worker/core/lang data from same origin.
 *
 * Static import keeps `createWorker` resolution consistent across browsers; dynamic import()
 * has historically varied default/nested-default shapes for CJS-interop bundles.
 */

import tesseractModule from "../vendor/tesseract.js/dist/tesseract.esm.min.js";

const WORKER_SCRIPT_URL = new URL(
  "../vendor/tesseract.js/dist/worker.min.js",
  import.meta.url,
).href;
const CORE_PATH = new URL("../vendor/tesseract.js-core/", import.meta.url).href;
const LANG_PATH = new URL("../vendor/tessdata/", import.meta.url).href;

/**
 * tesseract.esm.min.js wraps CJS; dynamic import() shape varies by browser
 * ({ default: api } vs nested default). Walk until we find createWorker.
 * @param {unknown} mod
 * @returns {{ createWorker: (...args: unknown[]) => Promise<unknown> }}
 */
function getTesseractApi(mod) {
  let cur = mod;
  for (let depth = 0; depth < 5 && cur && typeof cur === "object"; depth++) {
    const cw =
      /** @type {{ createWorker?: unknown }} */ (cur).createWorker;
    if (typeof cw === "function") {
      return /** @type {{ createWorker: (...args: unknown[]) => Promise<unknown> }} */ (
        cur
      );
    }
    const next = /** @type {{ default?: unknown }} */ (cur).default;
    if (next === cur) break;
    cur = next;
  }
  return null;
}

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
  const api =
    getTesseractApi(tesseractModule) ??
    getTesseractApi({ default: tesseractModule });
  const createWorker = api?.createWorker;
  if (typeof createWorker !== "function") {
    const hint =
      tesseractModule && typeof tesseractModule === "object"
        ? ` keys=${Object.keys(/** @type {object} */ (tesseractModule)).join(",")}`
        : "";
    throw new Error(`Tesseract.js createWorker not found after import.${hint}`);
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
