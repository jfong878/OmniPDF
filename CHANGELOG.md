# Changelog

All notable changes to OmniPDF are recorded here. Releases follow Semantic
Versioning.

## [1.1.0] - 2026-11-05

### Added

- Movable signature placement: choose Sign, click a page, drag the dashed box,
  then confirm or cancel.
- Per-tab document history with toolbar back/forward arrows. Snapshots cover
  form edits, annotations, rotation/deletion, OCR, signing and saves.
- Printing from the current document state (Ctrl+P), with pending edits
  flattened and pages rendered for the system print dialog.
- Ten-item recent-files list on the start screen and under File > Open Recent.
- Fit page and actual-size zoom controls, plus Ctrl+2 and Ctrl+1 shortcuts.
- Find-result stepping with toolbar arrows, F3/Shift+F3, and Escape to clear.
- Page navigation shortcuts: Ctrl+G, PageUp/PageDown, Ctrl+Home/End.
- Document properties dialog (Ctrl+D) with metadata, page size and file size.

### Fixed

- Late change events from detached form widgets could overwrite restored state
  and truncate the redo branch; detached inputs are now ignored.

### Verified

- `npm run selftest` covers core editing, signing, OCR and recent-file storage.
- `npm run smoke` verifies find navigation, metadata, recent-list rendering and
  print-page preparation (3 fixture pages rendered at 1275px wide).
- A live-renderer CDP pass verifies fit page, fit width, actual size and zoom-in,
  find next/previous and F3, Escape clearing, and keyboard page navigation.

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
