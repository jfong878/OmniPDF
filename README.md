# OmniPDF

A local Windows PDF workspace: view, annotate, fill forms, sign, and OCR.

Built on [pdf.js](https://mozilla.github.io/pdf.js/) for rendering and
[pdf-lib](https://pdf-lib.js.org/) for document edits, wrapped in Electron.
Nothing leaves the machine.

## Requirements

- Windows 10/11 (the installer scripts are PowerShell)
- Node.js 22+ and npm
- No Acrobat, Ghostscript, or other PDF tooling required

## Quick start

```bash
npm ci
npm start
```

## Verify

```bash
npm run selftest   # 24 checks: forms, annotations, rotation, delete, extract, signing, OCR
npm run smoke      # Electron: renders a page, extracts text, builds form widgets
```

`selftest` runs against `assets/fixture.pdf` and is pure Node — no display needed.
`smoke` exits non-zero if the renderer fails to load or produce text.

## Build, package and install

```bash
node scripts/png-to-ico.mjs                    # only if you changed the icon drawing
npx electron-packager . OmniPDF --platform=win32 --arch=x64 \
  --out=dist --overwrite --asar --icon=assets/icon.ico \
  --ignore='^/(dist|scripts|\.tessdata)'

powershell -ExecutionPolicy Bypass -File scripts/install.ps1
```

`install.ps1` copies the packaged app to `%LOCALAPPDATA%\Programs\OmniPDF`,
creates Start Menu / desktop / taskbar-pin shortcuts, and registers an
`Open with` handler for `.pdf`. It does **not** change your default handler —
Windows `UserChoice` is user-controlled, so set that through Explorer if wanted.

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

**Signing.** A self-signed RSA-2048 identity is created on first use at
`%APPDATA%\OmniPDF\signer.p12`. The signature is a detached PKCS#7 over the
document byte range (placeholder via `@signpdf/placeholder-pdf-lib`, applied by
`@signpdf/signpdf`).

**OCR.** Pages are rasterised at 200 DPI, recognised by tesseract, then replaced
with the image plus an invisible, word-positioned text layer.

## Known limitations

- **Annotations flatten on save.** They become page content and cannot be edited
  or removed afterwards.
- **Signatures are tamper-evident, not identity-verified.** There is no
  third-party CA, so verifiers report the signer as unknown unless they
  explicitly trust the generated certificate.
- **OCR rasterises.** Correct for scans; wrong for vector documents.
- **No page reordering.** Deletion, rotation and extraction only. pdf-lib's
  page-tree mutation silently corrupted ordering, so the feature was removed
  rather than shipped broken.
- **No XFA.** Deprecated in PDF 2.0 and proprietary; AcroForm only.
- **No printing, no text editing, no PDF/A validation.**
- **Windows only**, due to the packaging and install scripts.

## Notes for future sessions

- `scripts/force-remove-xchange.ps1` and `scripts/finish-remove-xchange.ps1`
  are one-off tools written to remove PDF-XChange Editor on this machine after
  its MSI cache went missing (installer error 1612). They are not part of the
  app; keep or delete as you like.
- If the taskbar shows a stale icon after a rebuild, Windows is serving
  `%LOCALAPPDATA%\Microsoft\Windows\Explorer\iconcache_*.db`. Stop Explorer,
  delete those files, and restart it.
