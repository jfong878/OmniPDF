# Changelog

All notable changes to OmniPDF are recorded here. Releases follow Semantic
Versioning.

## [1.0.7] - 2026-11-04

### Fixed

- Restored click-to-place signing on blank page areas. The PDF form layer was
  covering the full page and swallowing pointer input before it reached the
  signature/annotation overlay.
- Form fields remain clickable independently of the page overlay.

### Verified

- Drawn signatures: mouse drawing reached the Sign dialog and embedded a
  signature in the PDF.
- Imported signatures: PNG import populated the pad, saved the signature to
  the local library, and embedded it in the PDF.
- `npm run selftest`, `npm run smoke`, and form-field pointer checks pass.

## [1.0.6] - 2026-11-03

### Fixed

- JPEG-2000 and JBIG2 image-only scans render correctly with bundled PDF.js
  WASM decoders and ICC-profile support.
- Zoom buttons are incremental; Ctrl/Cmd-wheel and touchpad pinch work, with
  bounded canvases to avoid high-zoom crashes.

### Added

- Reusable drawn and imported signatures, with signed PDFs preserved
  byte-for-byte and their PKCS#7 signature intact.
