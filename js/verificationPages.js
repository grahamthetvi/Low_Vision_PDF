/**
 * Verification sampling for Step 2 text extraction.
 * Large PDFs are sampled so optional verify stays responsive; OCR is capped harder.
 */

/** Max pages of embedded PDF.js text to pull for verification. */
export const EMBEDDED_VERIFY_MAX_PAGES = 12;

/** Stricter page cap for Tesseract OCR (much slower than getTextContent). */
export const OCR_VERIFY_MAX_PAGES = 5;

/**
 * Build a sorted, unique 1-based page index list for verification.
 * When capping, prefers the start of the document, a middle slice, and the last page.
 *
 * @param {number} pageCount
 * @param {number} maxPages
 * @returns {number[]}
 */
export function sampleVerificationPages(pageCount, maxPages) {
  const total = Math.floor(Number(pageCount)) || 0;
  const max = Math.floor(Number(maxPages)) || 0;
  if (total < 1 || max < 1) return [];
  if (total <= max) {
    return Array.from({ length: total }, (_, i) => i + 1);
  }

  /** @type {Set<number>} */
  const set = new Set();

  const headCount = Math.min(3, max);
  for (let p = 1; p <= headCount; p++) set.add(p);
  set.add(total);

  const mid = Math.ceil(total / 2);
  if (set.size < max) set.add(mid);

  let offset = 1;
  while (set.size < max && offset < total) {
    const lo = mid - offset;
    const hi = mid + offset;
    if (lo >= 1) set.add(lo);
    if (set.size >= max) break;
    if (hi <= total) set.add(hi);
    offset += 1;
  }

  for (let p = 1; p <= total && set.size < max; p++) set.add(p);

  return [...set].sort((a, b) => a - b);
}

/**
 * Compact page list for UI: e.g. [1,2,3,12,50] → "1–3, 12, 50"
 *
 * @param {number[]} pages
 * @returns {string}
 */
export function formatPageList(pages) {
  if (!Array.isArray(pages) || pages.length === 0) return "";
  const sorted = [...new Set(pages.map((n) => Math.floor(Number(n))).filter((n) => n >= 1))].sort(
    (a, b) => a - b,
  );
  if (sorted.length === 0) return "";

  /** @type {string[]} */
  const parts = [];
  let start = sorted[0];
  let prev = sorted[0];

  for (let i = 1; i <= sorted.length; i++) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? String(start) : `${start}–${prev}`);
    start = cur;
    prev = cur;
  }

  return parts.join(", ");
}
