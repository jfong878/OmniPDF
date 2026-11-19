# Chrome Web Store submission copy

## Item details

**Name:** OmniPDF for Chrome

**Summary:** Open PDFs and Gmail attachments in a touch-friendly PDF viewer with search, zoom, print, and download.

**Category:** Productivity

**Language:** English (United States)

**Homepage:** https://github.com/jfong878/OmniPDF

**Support:** https://github.com/jfong878/OmniPDF/issues

**Privacy policy:** https://github.com/jfong878/OmniPDF/blob/main/PRIVACY.md

**Version:** 0.1.0

**Mature content:** No

**Distribution:** Public, all regions, free

## Detailed description

OmniPDF for Chrome gives PDFs a clean, touch-friendly reading tab.

Open a PDF from your computer, or open a PDF attachment directly from Gmail.
The viewer includes page navigation, fit-width and fit-page modes, actual-size
viewing, search with match navigation, print, and download. Two-finger pinch
zooming is built for touch screens and also works with trackpad pinch and the
toolbar zoom controls.

From Gmail, choose **Open in OmniPDF** beside a PDF attachment. If the button
does not appear, right-click the attachment link and choose **Open PDF in
OmniPDF**. The attachment is fetched with your existing Gmail session and stays
on your device.

This Chrome version is read-only. Signing, OCR, annotations, and PDF editing
remain in the separate OmniPDF Windows application. OmniPDF for Chrome does not
send PDFs to a server, does not use analytics, and does not load remote code.

## Single purpose

View PDF files, including Gmail attachments, in a touch-friendly Chrome tab.

## Permission justifications

- **contextMenus:** Adds the right-click **Open PDF in OmniPDF** fallback for a
  Gmail PDF attachment link.
- **scripting:** Injects the attachment button into Gmail tabs that were already
  open when the extension was installed.
- **storage:** Transfers the selected Gmail attachment from the content script
  to the viewer.
- **unlimitedStorage:** The temporary transfer can contain a PDF up to 48 MB,
  which is larger than Chrome's normal extension-storage quota.
- **https://mail.google.com/***: Finds PDF attachment links and fetches the
  selected attachment with the user's existing Gmail session. No other site is
  requested.

## Remote code

**No, I am not using remote code.** PDF.js and all WebAssembly, CMap, font, and
ICC assets are included in the extension package. The `wasm-unsafe-eval` source
policy is required only for local PDF.js rendering.

## Data usage

The extension handles data locally but does not collect or transmit it.

- **Website content:** Yes, locally. It reads Gmail attachment links and the
  page content needed to display the selected PDF.
- **Personal communications:** Yes, locally. The selected Gmail attachment is
  personal content and is processed only when the user opens it.
- **All other categories:** No.

Certifications:

- Data is not sold to third parties.
- Data is not transferred to third parties.
- Data is not used or transferred for purposes unrelated to the single purpose.
- Data is not used or transferred to determine creditworthiness or for lending.
- Data is not used for advertising.
- No human reads the user's data.

## Screenshots

- `store/screenshots/01-viewer.png` — **A touch-friendly PDF viewer in Chrome.**
  Page navigation, zoom controls, search, print, and download. Uses a fictional
  Northwind Community Picnic sample document.
- `store/screenshots/02-search.png` — **Find anything in the document.** Search
  highlights matches across every page in the same fictional sample document.
- `store/screenshots/03-gmail.png` — **Open PDF attachments from Gmail.** The
  injected **Open in OmniPDF** button appears beside Gmail attachment cards.
  This 1280×800 mockup uses placeholder message content and attachment labels;
  no inbox content is shown.
- `store/promo/small-tile-440x280.png` — small promotional tile.
- `store/icon-128.png` — store icon (96px artwork with 16px transparent
  padding).

## Reviewer test instructions

The extension does not require an account, a server, or test credentials.

1. Load the extension, click the OmniPDF toolbar icon, and choose **Open PDF
   viewer**.
2. Choose any local PDF. Confirm that it renders and that page navigation,
   zoom, search, print, and download are available.
3. For the Gmail path, sign in to any Gmail account and open a message with a
   PDF attachment. Refresh Gmail once after installing the extension.
4. Choose **Open in OmniPDF** beside the attachment. If the injected button is
   absent because Gmail changed its attachment markup, right-click the
   attachment link and choose **Open PDF in OmniPDF**. Both paths open the
   selected PDF in a new extension tab.

Gmail attachment links are fetched with the signed-in browser session. No
extension backend is involved.

## Known limitations

- The Chrome viewer is read-only; signing, OCR, annotation editing, and form
  saving are desktop-only.
- Gmail attachment-button detection depends on Gmail's current attachment
  markup. The right-click context menu is the fallback.
- Gmail attachments are limited to 48 MB on the transfer path.
- A Gmail attachment must be opened while signed in to Gmail.
