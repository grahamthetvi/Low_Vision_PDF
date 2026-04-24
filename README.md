# Low Vision PDF

**PDF Accessibility Reflo-er** — a static web app that reflows standard PDF pages into large, split images for low-vision reading. PDF parsing, rendering, splitting, and text extraction run entirely in the browser using Web Workers. Document bytes are not sent to any server (only the PDF.js engine scripts load from a public CDN the first time).

## Run locally

Because module workers are used, open the app through a local web server (not `file://`):

```bash
python3 -m http.server 8080
```

Then visit `http://localhost:8080` in a modern browser.

## GitHub Pages

Push this repository and enable Pages from the root (or set the site to publish the branch that contains `index.html`). If the site is served from a subpath, relative URLs in this project still resolve correctly.

## Offline / air‑gapped use

The render worker loads PDF.js from jsDelivr. To work fully offline, copy `pdf.min.mjs` and `pdf.worker.min.mjs` from the same `pdfjs-dist` npm package version into a `vendor/` folder and update the URLs in `workers/pdfRender.worker.mjs`.

## Print

Use the browser’s Print dialog on the reflowed view; users can print to paper or “Save as PDF” from there.
