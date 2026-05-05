export default {
  "ui": {
    "languageLabel": "Language"
  },
  "document": {
    "title": "Low Vision PDF — Reflow PDFs for low-vision reading",
    "skipLink": "Skip to main content"
  },
  "welcomeDialog": {
    "heading": "Welcome to Low Vision PDF",
    "description": "This tool helps you prepare a document that is easier to read with low vision. You upload a PDF in your browser (nothing is sent to a server). The app can show you the embedded text so you know it is the right file, then you choose how each page is split into larger segments. When you are done, you can print the result or download a new PDF made from those pages for printing at home.",
    "bullet1": "Upload your PDF and check the first-page preview.",
    "bullet2": "Optional: extract text to verify the document.",
    "bullet3": "Set splitting, direction, rotation, and margin options.",
    "bullet4": "Generate the reflowed view, then download or use Print.",
    "getStarted": "Get started"
  },
  "header": {
    "h1": "Low Vision PDF",
    "howItWorks": "How it works",
    "debug": "Debug",
    "themeToggle": {
      "toDark": "Switch to dark high-contrast theme",
      "toLight": "Switch to light high-contrast theme",
      "labelWhenLight": "Dark mode",
      "labelWhenDark": "Light mode"
    },
    "support": "Support",
    "buyMeACoffee": "Buy me a coffee",
    "tagline": "Reflow PDF pages into large, split segments for low-vision reading. All processing stays in your browser."
  },
  "step1": {
    "heading": "Step 1: Upload",
    "description": "Select a single PDF. Nothing is uploaded to a server.",
    "selectLabel": "Select PDF",
    "originalPreview": "Original — first page preview",
    "previewAriaLabel": "Preview of the first page of the selected PDF"
  },
  "step2": {
    "heading": "Step 2: Verify (text extraction)",
    "description": "Embedded text is read with the same PDF engine used for rendering. No text leaves your device. Use this after upload to confirm you have the correct document before you adjust layout options.",
    "extractButton": "Extract text for verification",
    "extractedTextHeading": "Extracted document text",
    "textareaAriaLabel": "Plain text extracted from the PDF for verification",
    "placeholder": "Text will appear here after extraction."
  },
  "step3": {
    "heading": "Step 3: Configuration",
    "legendSegments": "Number of splitting segments",
    "segmentsOptions": {
      "two": "2 segments",
      "three": "3 segments",
      "four": "4 segments"
    },
    "legendMode": "Splitting Mode",
    "modeOptions": {
      "auto": "Automatic splitting",
      "manual": "Manual cropping"
    },
    "alertNote": "Note:",
    "alertManual": "Manual cropping requires drawing regions on the screen and requires sight. If you are using a screen reader, please use Automatic splitting.",
    "defineRegionsButton": "Define crop regions",
    "noRegionsDefined": "Open “Define crop regions” and draw one or more boxes on each page as needed.",
    "legendDirection": "Splitting direction",
    "directionOptions": {
      "horizontal": "Horizontal (top to bottom)",
      "vertical": "Vertical (left to right)"
    },
    "legendRotation": "Rotate output segments",
    "rotationOptions": {
      "none": "No rotation (0°)",
      "right": "Rotate right (90° clockwise)",
      "left": "Rotate left (90° counter-clockwise)",
      "down": "Rotate down (180°)"
    },
    "trimMarginsHeading": "Detect and trim blank margins",
    "trimMarginsDesc": "Crops each page to the bounding box of visible ink before splitting.",
    "undoAriaLabel": "Undo margin trimming and regenerate output using full pages",
    "undoButton": "Undo margin trim"
  },
  "step4": {
    "heading": "Step 4: Process, view, and download",
    "description": "Workers render and split the PDF off the main thread. Large files may take a moment.",
    "generateButton": "Generate reflowed view",
    "downloadButton": "Download reflowed PDF",
    "saveDesc": "Saves one PDF page per segment image, sized to match each image, for printing or sharing. Your browser’s Print dialog is still available if you prefer.",
    "outputAriaLabel": "Reflowed split segments"
  },
  "footer": {
    "description": "Low Vision PDF — client-side only. After generating the reflowed view, use Download reflowed PDF or your browser’s print dialog to print or save as PDF.",
    "license": "MIT License — Addison Graham, Creator"
  },
  "debugPanel": {
    "heading": "Debug Log",
    "clear": "Clear",
    "close": "Close"
  },
  "cropModal": {
    "heading": "Define Crop Regions",
    "instructionBasic": "Choose a page, then click and drag on the image to draw boxes. You can add any number of regions per page. Repeat for each page.",
    "pageLabel": "Page",
    "pageAriaLabel": "Which PDF page to define crops for",
    "pageOption": "Page {p} of {total}",
    "clearAll": "Clear All",
    "cancel": "Cancel",
    "save": "Save Regions"
  },
  "dynamicCopy": {
    "cropStatus": {
      "manual": {
        "noneYet": "No crop regions yet. Open “Define crop regions”, pick each page, and draw one or more boxes ({total} pages total).",
        "needMorePages": "Crop regions still missing for page(s): {pages}{more}. ({done} of {total} pages have at least one region.)",
        "morePages": " (+{count} more)",
        "allPagesReady": "Every page has at least one crop region ({total} pages). Ready to generate."
      }
    },
    "cropInstructionsDetailed": "Select a page above, then click and drag to draw boxes on that page only. You can add any number of regions per page. Switch pages and repeat until every page is covered ({total} pages).",
    "status": {
      "loadFirst": "Load a PDF first.",
      "loadingCropPreview": "Loading preview for cropping…",
      "ready": "Ready.",
      "cropPreviewFailed": "Failed to load crop preview.",
      "selectPdfFirst": "Select a PDF first.",
      "manualCropMissingPage": "Manual cropping: page {p} of {total} has no crop regions. Define at least one region for every page.",
      "processing": "Processing…",
      "renderingPage": "Rendering page {p} of {total}…",
      "splittingPage": "Splitting page {p} of {total}…",
      "done": "Done. {pageCount} page(s) reflowed into {n} segment image(s). Use “Download reflowed PDF” when you are ready.",
      "error": "Error: {message}",
      "extractingText": "Extracting text…",
      "extractionFinished": "Text extraction finished.",
      "extractionFailed": "Text extraction failed.",
      "buildingPdf": "Building PDF…",
      "downloadStarted": "Reflowed PDF download started.",
      "buildPdfFailed": "Could not build PDF: {message}",
      "generateFirst": "Generate the reflowed view first.",
      "noFileSelected": "No file selected.",
      "choosePdf": "Please choose a PDF file.",
      "loadingPdf": "Loading PDF…",
      "pdfLoaded": "Loaded {pageCount} page(s). Review the preview, optionally extract text to verify, then configure and generate the reflowed view.",
      "pageCountError": "Could not read page count.",
      "loadPdfFailed": "Could not load PDF: {message}",
      "readyToSelect": "Ready. Select a PDF to begin."
    },
    "extractedText": {
      "loadFirst": "Load a PDF before extracting text.",
      "noTextFound": "No embedded text was found. This may be a scanned PDF; only OCR could read pixels, which is not enabled in this build.",
      "failed": "Extraction failed: {message}"
    },
    "outputSegments": {
      "label": "Page {p}: Part {partNumber}",
      "imageAlt": "{label} — reflowed segment"
    },
    "download": {
      "filenamePattern": "{basename}-reflowed.pdf"
    },
    "email": {
      "supportSubjectUrlEncoded": "Graham%20Visual%20Acuity%20Tester%20Support"
    },
    "workerErrors": {
      "renderFailed": "Render failed.",
      "splitFailed": "Split failed.",
      "noPdfLoaded": "No PDF loaded.",
      "no2dContext": "Could not get 2D context.",
      "noTrimmedContext": "Could not get trimmed context.",
      "encodeImage": "Could not encode image.",
      "noCanvasContext": "Could not create canvas context.",
      "readSegmentImage": "Could not read a segment image",
      "unknownWorkerMessage": "Unknown worker message.",
      "workerMessageReadFailed": "Failed to read worker response."
    }
  }
};
