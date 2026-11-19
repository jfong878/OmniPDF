# OmniPDF for Chrome Privacy Policy

Last updated: November 12, 2026

OmniPDF for Chrome is a local PDF viewer. It opens PDFs selected from your
computer and PDF attachments from Gmail in a Chrome tab. The extension is
separate from the OmniPDF Windows application.

## Data the extension handles

When you use the Gmail integration, the extension handles:

- The Gmail attachment link and filename that you choose.
- The PDF bytes returned by Gmail for that attachment.
- The page content needed to display the PDF in the viewer.

When you open a local PDF, it handles only the file you choose and the page
content needed to display it.

## How the data is used

The extension uses this data only to display the PDF you selected and to support
the viewer's navigation, search, zoom, print, and download features.

For Gmail attachments, the PDF bytes are encoded temporarily into
`chrome.storage.local` under a `pending:` key. The viewer removes that key when
it starts. Pending transfers older than ten minutes are cleaned up when the
extension starts. The extension does not send the PDF or its contents to a
server.

The extension requests the Gmail attachment from `mail.google.com` using the
browser's existing signed-in Gmail session. It does not read, copy, or store
Gmail cookies, passwords, or authentication tokens.

## Collection, sharing, and retention

OmniPDF for Chrome does not collect, transmit, sell, rent, or share user data.
It has no analytics, telemetry, advertising, or crash-reporting service. No
person reads your PDFs or Gmail content through this extension.

Data stays on your device and is retained only for the temporary handoff
described above. You can remove all extension data at any time by removing the
extension from Chrome.

## Permissions

- **`contextMenus`** provides the right-click fallback for opening a Gmail PDF
  attachment.
- **`scripting`** injects the Gmail attachment button into a Gmail tab that was
  already open when the extension was installed.
- **`storage`** holds the temporary attachment handoff between the Gmail tab
  and the viewer.
- **`unlimitedStorage`** allows that handoff to hold a PDF larger than Chrome's
  normal extension-storage quota, up to the extension's 48 MB attachment limit.
- **`https://mail.google.com/*`** lets the extension find PDF attachment links
  and fetch the selected attachment using the existing Gmail session.

The extension does not request access to other websites.

## Remote code

The extension does not load or execute remote code. PDF.js and its WebAssembly,
CMap, font, and ICC assets are bundled with the extension. The
`wasm-unsafe-eval` source policy is used only for PDF.js rendering.

## Limited Use

The use of information received from Google APIs will adhere to the Chrome Web
Store User Data Policy, including the Limited Use requirements.

## Changes

If this policy changes, the updated policy will be published at this URL with a
new last-updated date.

## Contact

Questions about this policy can be raised at
https://github.com/jfong878/OmniPDF/issues.
