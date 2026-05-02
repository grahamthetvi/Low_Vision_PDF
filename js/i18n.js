/**
 * Client-side i18n: loads locale modules via dynamic import (works with file://
 * and HTTP; fetch() on JSON often fails on file origins).
 */

const LOCALE_STORAGE_KEY = "lv-pdf-locale";
const DEFAULT_LOCALE = "en";

/** @type {Record<string, object>} */
const bundleCache = {};

/** @type {string} */
let currentLocale = DEFAULT_LOCALE;
/** @type {object} */
let messages = {};

const LOCALE_IMPORTS = {
  en: () => import("../locales/en.mjs"),
  ar: () => import("../locales/ar.mjs"),
};

const RTL_LOCALES = new Set(["ar"]);

/**
 * @param {string} path dot path e.g. "header.h1"
 * @param {object} obj
 */
function getByPath(path, obj) {
  const parts = path.split(".");
  let cur = obj;
  for (const p of parts) {
    if (cur == null || typeof cur !== "object") return undefined;
    cur = cur[p];
  }
  return cur;
}

/**
 * @param {string} template
 * @param {Record<string, string | number>} vars
 */
function interpolate(template, vars) {
  let out = template;
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`{${k}}`).join(String(v));
  }
  return out;
}

/**
 * @param {string} path
 * @param {Record<string, string | number>} [vars]
 */
export function t(path, vars) {
  let s = getByPath(path, messages);
  if (typeof s !== "string") {
    s = getByPath(path, bundleCache[DEFAULT_LOCALE] || {});
  }
  if (typeof s !== "string") {
    return path;
  }
  return vars ? interpolate(s, vars) : s;
}

export function getLocale() {
  return currentLocale;
}

export function isRtl() {
  return RTL_LOCALES.has(currentLocale);
}

/**
 * @param {string} locale
 */
export async function setLocale(locale) {
  const next = locale === "ar" ? "ar" : "en";
  if (!bundleCache[next]) {
    const loader = LOCALE_IMPORTS[next];
    if (!loader) return;
    const mod = await loader();
    bundleCache[next] = mod.default;
  }
  currentLocale = next;
  messages = bundleCache[next];
  try {
    localStorage.setItem(LOCALE_STORAGE_KEY, next);
  } catch {
    /* ignore */
  }
  applyDocumentLocale();
  applyDomTranslations();
  document.dispatchEvent(new CustomEvent("lv-pdf-localechange", { detail: { locale: next } }));
}

function applyDocumentLocale() {
  const html = document.documentElement;
  html.lang = currentLocale === "ar" ? "ar" : "en";
  html.dir = isRtl() ? "rtl" : "ltr";
}

/**
 * Reads initial locale from storage or Accept-Language / navigator.
 */
export function resolveInitialLocale() {
  try {
    const stored = localStorage.getItem(LOCALE_STORAGE_KEY);
    if (stored === "ar" || stored === "en") return stored;
  } catch {
    /* ignore */
  }
  const nav = (typeof navigator !== "undefined" && navigator.language) || "";
  if (nav.toLowerCase().startsWith("ar")) return "ar";
  return DEFAULT_LOCALE;
}

/**
 * data-i18n="path" — sets textContent
 * data-i18n-placeholder / data-i18n-aria-label — set those attributes from path
 */
export function applyDomTranslations() {
  document.title = t("document.title");

  document.querySelectorAll("[data-i18n]").forEach((el) => {
    const path = el.getAttribute("data-i18n");
    if (!path) return;
    el.textContent = t(path);
  });

  document.querySelectorAll("[data-i18n-placeholder]").forEach((el) => {
    const path = el.getAttribute("data-i18n-placeholder");
    if (path) el.setAttribute("placeholder", t(path));
  });
  document.querySelectorAll("[data-i18n-aria-label]").forEach((el) => {
    const path = el.getAttribute("data-i18n-aria-label");
    if (path) el.setAttribute("aria-label", t(path));
  });

  const support = document.getElementById("support-link");
  if (support) {
    const subj = t("dynamicCopy.email.supportSubjectUrlEncoded");
    support.href = `mailto:grahamthetvi@icloud.com?subject=${subj}`;
  }
}

/**
 * Map known English worker error substrings to translation keys.
 * @param {string} message
 */
export function translateWorkerErrorMessage(message) {
  const m = message.trim();
  const map = [
    ["Render failed: missing bitmap", "dynamicCopy.workerErrors.renderFailed"],
    ["Render failed", "dynamicCopy.workerErrors.renderFailed"],
    ["Split failed", "dynamicCopy.workerErrors.splitFailed"],
    ["No PDF loaded", "dynamicCopy.workerErrors.noPdfLoaded"],
    ["Could not get 2D context", "dynamicCopy.workerErrors.no2dContext"],
    ["Could not get trimmed context", "dynamicCopy.workerErrors.noTrimmedContext"],
    ["Could not encode image", "dynamicCopy.workerErrors.encodeImage"],
    ["Could not create canvas context", "dynamicCopy.workerErrors.noCanvasContext"],
    ["Could not read a segment image", "dynamicCopy.workerErrors.readSegmentImage"],
  ];
  for (const [prefix, key] of map) {
    if (m === prefix || m.startsWith(prefix + ":") || m.startsWith(prefix + " ")) {
      return t(key);
    }
  }
  if (m.startsWith("Unknown message type:")) return t("dynamicCopy.workerErrors.unknownWorkerMessage");
  if (m.startsWith("Failed to read worker message data:")) return t("dynamicCopy.workerErrors.workerMessageReadFailed");
  return message;
}
