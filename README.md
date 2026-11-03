# OmniPDF

A local Windows PDF workspace: view, annotate, fill forms, sign, and OCR.
Open several documents at once — each PDF gets its own tab.

Built on [pdf.js](https://mozilla.github.io/pdf.js/) for rendering and
[pdf-lib](https://pdf-lib.js.org/) for document edits, wrapped in Electron.
Nothing leaves the machine.

## Requirements

- Windows 10/11 (electron-builder produces a per-user NSIS installer)
- Node.js 22+ and npm
- No Acrobat, Ghostscript, or other PDF tooling required

## Quick start

```bash
npm ci
npm start
```

## Verify

```bash
npm run selftest   # core checks: forms, annotations, rotation, delete, extract, signing, signatures, OCR
npm run smoke      # Electron: renders a page, extracts text, builds widgets, switches tabs
```

`selftest` runs against `assets/fixture.pdf` and is pure Node — no display needed.
`smoke` exits non-zero if the renderer fails to load or produce text.

## Auto-updates

Installed builds check a generic HTTPS feed shortly after launch and every six
hours, then download updates in the background. The update installs when you
quit, or immediately from the banner's "Restart now". The toolbar's persistent
"Updates" button shows the current state; once a build is downloaded it becomes
"Restart to update", even if the banner was dismissed. Nothing is discarded
silently: quitting with unsaved documents asks first, and "Restart now"
confirms which documents would be lost.

The feed URL lives in `build.publish[0].url` in `package.json` and points at
this repository's GitHub Releases feed. For local testing, or to point an
installed build at a different host, set `OMNIPDF_UPDATE_URL` before launch.

A release is the contents of `dist/`: `OmniPDF-Setup-<version>.exe`, its
`.blockmap`, and `latest.yml`. Bump `version`, commit the change, and push a
matching `v<version>` tag. The workflow in `.github/workflows/release.yml`
builds the unsigned installer and publishes all three files to the repository's
latest GitHub release, so installed copies can pick them up. Update activity is
logged to `updates.log` in the app data directory (Help > Open Update Log).

Only app releases should become the repository's latest release. Publish
documentation-only tags as drafts or prereleases; GitHub's `latest/download`
path otherwise resolves to a release without updater assets.

Serve the feed from a host that supports HTTP range requests (S3, R2, nginx);
without them electron-updater falls back to a full installer download.

Builds are **unsigned by default**, so SmartScreen warns on first install and
updates cannot be cryptographically attributed. For signed releases set
`CSC_LINK` and `CSC_KEY_PASSWORD` for electron-builder (or configure Azure
Trusted Signing), then add the certificate's publisher name as
`win.publisherName` so electron-updater verifies the downloaded installer
before running it.

## Build, package and install

```bash
node scripts/png-to-ico.mjs     # only if you changed the icon drawing
npm run dist                    # electron-builder: dist/OmniPDF-Setup-<version>.exe
```

`npm run dist` produces a per-user NSIS installer (no UAC) in `dist/`, plus
`latest.yml` and `.blockmap` files used by updates. It creates Start Menu /
desktop shortcuts and registers an `Open with` handler for `.pdf`. It does
**not** change your default handler — Windows `UserChoice` is user-controlled,
so set that through Explorer if wanted. `scripts/install.ps1` remains as a
developer shortcut that copies `dist/win-unpacked` into place.

### Regenerating assets

The files in `assets/` are generated but committed, so a fresh clone builds and
tests without extra steps. To rebuild them:

```bash
powershell -ExecutionPolicy Bypass -File scripts/make-icon.ps1  # 512px master + all sizes
node scripts/png-to-ico.mjs                                     # pack the multi-size .ico
node scripts/make-fixture.mjs                                   # test PDF
```

`assets/ocr-sample.png` is the OCR fixture; without it the OCR checks are
skipped rather than failed.

## Layout

```
main.js               Electron main: app:// protocol, window, menu, IPC
preload.js            contextBridge surface (no Node in the renderer)
src/main/updater.js   update feed, background download, install-on-quit
src/main/signatures.js saved drawn/imported signature images
src/core/edit.js      form filling, annotation flattening, rotate/delete, extract
src/core/sign.js      local signing identity + PKCS#7 signing
src/core/ocr.js       tesseract worker + searchable-PDF construction
src/core/util.js      WinAnsi sanitising, colour parsing
renderer/app.js       viewer, annotations, widgets, search, dialogs
renderer/index.html   markup
renderer/styles.css   theme
scripts/              install, icon, fixture, selftest, one-off removal helper
```

`src/core/*` deliberately contains no Electron imports, which is why the test
suite can exercise it in plain Node.

## How it works

**Tabs.** Each open document is a tab with its own pdf.js document, page order,
rotations, annotations and form values. Switching tabs tears down the page DOM
and rebuilds it from that tab's state, so only the active tab holds live
elements. Opening the same path twice focuses the existing tab instead of
duplicating it; closing a dirty tab asks before discarding. Ctrl+T / Ctrl+O open
a file in a new tab, Ctrl+W closes one, Ctrl+Tab and Ctrl+Shift+Tab cycle.

**Serving.** The renderer is served over a custom `app://bundle` scheme rather
than `file://`, so ES modules and module workers load normally. `/vendor/*` maps
to `node_modules/pdfjs-dist`. Chromium's code caches are cleared on launch —
otherwise a previously compiled renderer module can shadow edits on disk, which
produces confusing "my fix did nothing" behaviour.

**Coordinates.** Annotations are stored in PDF user space, not screen space, so
they survive zoom and page rotation. Screen mapping is done with the viewport's
affine transform directly; pdf.js v6 removed the `PageViewport` conversion
helpers this originally used.

**Save pipeline.** Order matters: fill forms → draw annotations → apply
rotations → delete pages (descending, so earlier indices stay valid). Annotations
are flattened into page content, so they are no longer editable after a save.
A signed PDF is written byte-for-byte; making further edits asks before saving a
modified copy without the prior signature.

**Signing.** A self-signed RSA-2048 identity is created on first use at
`%APPDATA%\OmniPDF\signer.p12`. The signature is a detached PKCS#7 over the
document byte range (placeholder via `@signpdf/placeholder-pdf-lib`, applied by
`@signpdf/signpdf`). The visible signature can be drawn with a mouse, pen, or
touch, or imported as PNG/JPEG. Saved signatures live under
`%APPDATA%\OmniPDF\signatures` and are embedded as an appearance; they do not
change the signing identity.

**OCR.** Pages are rasterised at 200 DPI, recognised by tesseract, then replaced
with the image plus an invisible, word-positioned text layer.

## Known limitations

- **Annotations flatten on save.** They become page content and cannot be edited
  or removed afterwards.
- **Signatures are tamper-evident, not identity-verified.** There is no
  third-party CA, so verifiers report the signer as unknown unless they
  explicitly trust the generated certificate. A drawn or imported signature is
  only a visible appearance; importing a `.p12` identity is still unsupported.
- **OCR rasterises.** Correct for scans; wrong for vector documents.
- **No page reordering.** Deletion, rotation and extraction only. pdf-lib's
  page-tree mutation silently corrupted ordering, so the feature was removed
  rather than shipped broken.
- **No XFA.** Deprecated in PDF 2.0 and proprietary; AcroForm only.
- **No printing, no text editing, no PDF/A validation.**
- **Windows only**, due to the packaging and install scripts.
- **Auto-updates are unsigned until a certificate is configured.** SmartScreen
  warns on first install; set `CSC_LINK` before distributing.

## Notes for future sessions

- `scripts/force-remove-xchange.ps1` and `scripts/finish-remove-xchange.ps1`
  are one-off tools written to remove PDF-XChange Editor on this machine after
  its MSI cache went missing (installer error 1612). They are not part of the
  app; keep or delete as you like.
- If the taskbar shows a stale icon after a rebuild, Windows is serving
  `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`. Stop Explorer,
  delete those files, and restart it.
