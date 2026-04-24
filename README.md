# Low Vision PDF

**PDF Accessibility Reflo-er** — a static web app that reflows standard PDF pages into large, split images for low-vision reading. PDF parsing, rendering, splitting, and text extraction run entirely in the browser using Web Workers. Document bytes are not sent to any server; the PDF.js engine is vendored under [`vendor/pdfjs/`](vendor/pdfjs/) so the app works offline after the page is cached.

## Run locally

Because module workers are used, open the app through a local web server (not `file://`):

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080` in a modern browser.

## GitHub Pages

In the repository **Settings → Pages**, set **Source** to **GitHub Actions**. Pushes to `main` or `master` run `.github/workflows/deploy-pages.yml`, which publishes `index.html`, `css/`, `js/`, `workers/`, and `vendor/` plus the `CNAME` file for **lowvisionpdf.com**. Point that domain’s DNS to GitHub Pages as documented by GitHub, then add the custom hostname under Pages settings. If the site is served from a subpath, relative URLs in this project still resolve correctly.

## Updating vendored PDF.js

The render worker imports `vendor/pdfjs/pdf.min.mjs` and `pdf.worker.min.mjs` (version **4.10.38**) and passes `cMapUrl` / `standardFontDataUrl` into `getDocument` so PDF.js can load **cmaps** and **standard_fonts** from `vendor/pdfjs/`. Those folders ship beside the `.mjs` files so CID-keyed fonts and the standard 14 PDF fonts draw as real text instead of hex “tofu” boxes. To upgrade, run `npm install pdfjs-dist@<version>` and copy the `.mjs` worker bundle you use plus the `cmaps/` and `standard_fonts/` directories from that release into `vendor/pdfjs/`, then update this README line.

## Reflowed PDF download

The main thread dynamically imports [pdf-lib](https://pdf-lib.js.org/) from `vendor/pdf-lib/pdf-lib.esm.min.js` (version **1.17.1**) to assemble segment PNGs into a multi-page PDF. To upgrade, run `npm install pdf-lib@<version>` and copy `node_modules/pdf-lib/dist/pdf-lib.esm.min.js` into `vendor/pdf-lib/`, then update this README line.

## Print

Use the browser’s Print dialog on the reflowed view; users can print to paper or “Save as PDF” from there.
