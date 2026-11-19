# Chrome Web Store release folder

## Build the upload ZIP

```bash
npm run chrome:package
```

This rebuilds the PDF.js runtime, validates the required runtime files, and
writes:

```text
dist/chrome/OmniPDF-Chrome-0.1.0.zip
dist/chrome/OmniPDF-Chrome-0.1.0.zip.sha256
```

Upload the ZIP itself to the Chrome Web Store Developer Dashboard. The ZIP has
`manifest.json` at its root and contains only runtime files.

## Store assets

- `store/icon-128.png` — 128×128 store icon, 96×96 artwork with 16px
  transparent padding.
- `store/screenshots/01-viewer.png` — 1280×800 viewer screenshot using the
  fictional Northwind Community Picnic sample document.
- `store/screenshots/02-search.png` — 1280×800 search screenshot using the
  same fictional sample document.
- `store/screenshots/03-gmail.png` — 1280×800 Gmail attachment screenshot
  with the injected **Open in OmniPDF** button.
- `store/screenshots/gmail-source.html` — sanitized source layout for
  `03-gmail.png`. Regenerate at 1280×800 with headless Chrome; all message
  content and attachment labels in it are placeholders.
- `store/promo/small-tile-440x280.png` — small promotional tile.
- `store/promo/promo.html` — source for regenerating the small tile.

## Dashboard fields

Use `store/listing.md` for the name, summary, description, category, privacy
answers, permission justifications, and reviewer instructions.

Before submitting:

1. Push `PRIVACY.md` to the public repository and confirm the privacy-policy URL
   in `store/listing.md` resolves.
2. Create or sign in to the Chrome Web Store Developer Dashboard and complete
   the developer registration/trader declarations.
3. Upload the generated ZIP.
4. Fill in the Store listing and Privacy practices tabs using `store/listing.md`.
5. Test the uploaded package in a clean Chrome profile.
6. Re-test the live Gmail path in that clean profile. The content script was
   re-checked against signed-in Gmail on 2026-11-17 (button injection, real
   attachment fetch, PDF validation, and transfer handoff); repeat the full
   packaged-extension test before submitting.
7. Submit for review only after the clean-profile Gmail test passes.

## Not done automatically

- No Chrome Web Store account, payment, declaration, upload, or publication is
  performed by this repository.
- All screenshots use fictional sample content: the Northwind Community Picnic
  document and a sanitized Gmail mockup with placeholder message content and
  attachment labels. No real inbox, document, or personal content is included.
- The current extension version is `0.1.0`; bump `manifest.json` and rebuild for
  every Store upload.
