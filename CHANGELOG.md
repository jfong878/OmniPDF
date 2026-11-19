# Changelog

All notable changes to OmniPDF are recorded here. Releases follow Semantic
Versioning.

## [1.2.0] - 2026-11-19

### Added

- Editable zoom percentage in the desktop toolbar. Click the zoom label, type a
  value such as `150` or `150%`, and press Enter or leave the field to apply it.
  Values are clamped to 25–500%; Escape or an invalid entry restores the
  current zoom.

### Fixed

- Fit-width now gives every page in a mixed-size PDF the same displayed width.
  Each page is scaled relative to its own native width, so Letter, A4, wide
  printouts and scanned pages line up instead of changing width page by page.
- Ctrl/Cmd-wheel and touchpad pinch zoom no longer resize every page on every
  event. The viewer previews the zoom with a CSS transform and commits a single
  page resize after the gesture, in both the desktop reader and the Chrome
  extension viewer.
- The "up to date" update message now names the running app version instead of
  the feed's latest version. The feed can be older than a local build that has
  not been published yet, which made the app report a stale version.

### Verified

- `npm run smoke` opens a mixed-size fixture and a page-size variant at uniform
  widths (`1202`, `1202`, `1202`) and verifies that typing `150%` applies 1.5×
  zoom and a `150%` label.
- `npm run chrome:smoke` sends a synthetic Ctrl-wheel gesture and verifies the
  page width stays unchanged during the preview transform, then commits once
  after the gesture.
- A packaged desktop probe verified typed zoom values, the 500% clamp, and
  uniform widths across all pages.

## [1.1.1] - 2026-11-18

### Added

- Two-finger pinch-to-zoom in the desktop viewer. The gesture previews with a
  CSS transform and commits one page resize at the final scale, keeping the PDF
  point under the fingers. Single-finger scrolling, Ctrl/Cmd-wheel and touchpad
  pinch are unchanged.
- Graphics-process (GPU) exits are appended to `gpu-process.log` in the desktop
  reader's user data folder (`%APPDATA%\omnipdf\gpu-process.log` on Windows),
  one JSON line per exit with timestamp, exit code, reason and service name.
  The diagnostic only records; it never changes how pages render.
- Documents open at fit width, so Letter, A4, wide printouts and scanned books
  share the same on-screen page width instead of each opening at a fixed zoom.

### Fixed

- Two-finger pinch now works on Windows touchscreens. Chromium was exposing
  touch points but not TouchEvent handlers to the desktop reader, so the
  gesture never reached the viewer; touch events are now enabled explicitly.
- Zoom changes no longer reset a page's render queue. A cancelled render now
  finishes unwinding before the new scale starts, and a render that resolves
  after cancellation is discarded instead of painting a stale bitmap over the
  newest one, in both the desktop reader and the Chrome viewer.
- Zooming no longer flashes a white or blank page while the delayed
  high-resolution rerender is in flight. Pages now render into an offscreen
  canvas and replace the visible bitmap in one step, in both the desktop reader
  and the Chrome viewer.

### Verified

- `npm run smoke` commits two synthetic two-finger pinches in a row. The
  second lands while the first commit's rerender is still in flight and cancels
  it; only the final scale's rendered key, viewport and visible ink are checked.
- Launching the packaged 1.1.1 build with a temporary profile and terminating
  its GPU process wrote a timestamped `exitCode: -1` / `reason: crashed` entry
  to `gpu-process.log`, and the reader stayed open.

## [Unreleased]

### Added

- Chrome Web Store release packaging with `npm run chrome:package`, a compliant
  128px store icon, privacy policy, listing copy, screenshots, and promo tile.
- A **Diagnostics** panel in the Chrome extension popup that lists recent Gmail
  fetch and transfer failures with the failing stage, message, filename, HTTP
  status, byte count, elapsed time, and a redacted Gmail attachment URL; any
  other scheme or host is dropped. Entries stay
  in local extension storage, are capped at 25, and can be copied or cleared.

### Fixed

- Gmail attachment detection now handles Gmail's current attachment-card markup,
  where the anchor's accessible text concatenates "Preview attachment …" and
  the PDF filename without whitespace. The injected button now uses the clean
  filename instead of the concatenated label.
- Gmail PDF detection no longer requires the filename to appear in the link
  itself. Names are also read from the attachment card, nearby titles and
  labels, and URL parameters, and unnamed attachment links are recognised by
  PDF labels and icons.
- The Chrome viewer reserves the scrollbar gutter before fitting the first
  page, so a document that introduces a vertical scrollbar opens at the true
  fit width instead of overflowing horizontally by the scrollbar width.
- A per-page render error in the Chrome viewer now keeps its explanation
  visible when the failed page scrolls into view. The observer's redundant
  render no longer clears the card and leaves the page blank.

### Verified

- `npm run smoke` also holds a page's text-layer request open across a page
  rebuild in both the desktop reader and the Chrome viewer. The stale response
  resolves after the rebuilt page renders, and must leave that page's text
  layer and text item cache untouched.
- Live Gmail attachment test on 2026-11-17: the production `gmail.js` injected
  both **Open in OmniPDF** buttons on a signed-in message, fetched a 5.0 MB PDF
  (`%PDF-1.4`), stored the `pending:` transfer, and sent `open-transfer` to the
  viewer. The refreshed Store Gmail screenshot is a sanitized 1280×800 mockup;
  all message content and attachment labels are placeholders.
- Packaged Chrome extension on 2026-11-18 in Chrome for Testing 158: small
  (306×396) and wide (1584×612) PDFs opened at the measured fit width; a
  19-click rapid zoom to 500% produced no blank or black frames across 79
  samples; and an injected page-2 render failure showed only that page's error
  card while pages 1 and 3 rendered.
- Store asset audit on 2026-11-18: every screenshot and the promo tile uses
  fictional content only. The viewer and search screenshots were regenerated
  from the real Chrome viewer with the fictional Northwind Community Picnic
  sample document, which matches the fictional Gmail mockup.

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
