'use strict';

const fs = require('node:fs');
const path = require('node:path');
const forge = require('node-forge');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { sanitizeWinAnsi } = require('./util');

const PASSPHRASE = 'omnipdf-local-identity';

/**
 * Create (once) or load a local self-signed signing identity.
 * This is a private self-issued credential: signatures it produces are
 * cryptographically sound and tamper-evident, but carry no third-party
 * identity assurance until the certificate is trusted by the verifier.
 */
function ensureSigner(dir) {
  const p12Path = path.join(dir, 'signer.p12');
  const metaPath = path.join(dir, 'signer.json');

  if (fs.existsSync(p12Path) && fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
      return {
        p12: fs.readFileSync(p12Path),
        passphrase: meta.passphrase || PASSPHRASE,
        info: meta,
      };
    } catch {
      /* fall through and regenerate */
    }
  }

  fs.mkdirSync(dir, { recursive: true });
  const keys = forge.pki.rsa.generateKeyPair(2048);
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = `01${forge.util.bytesToHex(forge.random.getBytesSync(8))}`;
  cert.validity.notBefore = new Date();
  const notAfter = new Date();
  notAfter.setFullYear(notAfter.getFullYear() + 10);
  cert.validity.notAfter = notAfter;

  const attrs = [
    { name: 'commonName', value: 'OmniPDF Local Signer' },
    { name: 'organizationName', value: 'OmniPDF' },
  ];
  cert.setSubject(attrs);
  cert.setIssuer(attrs);
  cert.setExtensions([
    { name: 'basicConstraints', cA: false },
    { name: 'keyUsage', digitalSignature: true, nonRepudiation: true, keyEncipherment: true },
    { name: 'extKeyUsage', emailProtection: true },
    { name: 'subjectKeyIdentifier' },
  ]);
  cert.sign(keys.privateKey, forge.md.sha256.create());

  const asn1 = forge.pkcs12.toPkcs12Asn1(keys.privateKey, [cert], PASSPHRASE, {
    algorithm: '3des',
  });
  const p12 = Buffer.from(forge.asn1.toDer(asn1).getBytes(), 'binary');

  const info = {
    passphrase: PASSPHRASE,
    subject: 'CN=OmniPDF Local Signer, O=OmniPDF',
    issuedAt: new Date().toISOString(),
    notAfter: notAfter.toISOString(),
  };
  fs.writeFileSync(p12Path, p12, { mode: 0o600 });
  fs.writeFileSync(metaPath, JSON.stringify(info, null, 2), { mode: 0o600 });
  return { p12, passphrase: PASSPHRASE, info };
}

function stamp(date) {
  const pad = (n) => String(n).padStart(2, '0');
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())} UTC`
  );
}

/**
 * Draw a visible signature block, add a signature placeholder widget and
 * apply a detached PKCS#7 signature over the byte range.
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {{pageIndex:number, rect:{x:number,y:number,w:number,h:number},
 *          name:string, reason?:string, location?:string, contactInfo?:string,
 *          signer:{p12:Buffer,passphrase:string}}} opts
 */
async function signPdf(pdfBytes, opts) {
  const doc = await PDFDocument.load(Buffer.from(pdfBytes), { updateMetadata: false });
  const page = doc.getPage(opts.pageIndex);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const r = opts.rect;
  const signedAt = new Date();

  page.drawRectangle({
    x: r.x,
    y: r.y,
    width: r.w,
    height: r.h,
    color: rgb(1, 1, 1),
    colorOpacity: 0.9,
    borderColor: rgb(0.08, 0.33, 0.72),
    borderWidth: 1.1,
    borderOpacity: 1,
  });

  const lines = [
    { text: `Digitally signed by ${opts.name || 'OmniPDF User'}`, size: 9.5, font: bold },
    { text: stamp(signedAt), size: 7.5, font },
  ];
  if (opts.reason) lines.push({ text: `Reason: ${opts.reason}`, size: 7.5, font });
  if (opts.location) lines.push({ text: `Location: ${opts.location}`, size: 7.5, font });

  let cursor = r.y + r.h - 13;
  for (const line of lines) {
    if (cursor < r.y + 3) break;
    page.drawText(sanitizeWinAnsi(line.text), {
      x: r.x + 5,
      y: cursor,
      size: line.size,
      font: line.font,
      color: rgb(0.06, 0.09, 0.16),
      maxWidth: Math.max(r.w - 10, 12),
    });
    cursor -= line.size + 3.5;
  }

  const { pdflibAddPlaceholder } = require('@signpdf/placeholder-pdf-lib');
  pdflibAddPlaceholder({
    pdfDoc: doc,
    pdfPage: page,
    reason: opts.reason || 'Approved',
    contactInfo: opts.contactInfo || '',
    name: opts.name || 'OmniPDF User',
    location: opts.location || '',
    signatureLength: 30000,
    widgetRect: [r.x, r.y, r.x + r.w, r.y + r.h],
  });

  // No object streams here: the signature dictionary must be reachable as raw
  // bytes for the byte-range placeholder to be filled in.
  const withPlaceholder = Buffer.from(await doc.save({ useObjectStreams: false }));

  const { SignPdf } = require('@signpdf/signpdf');
  const signerMod = require('@signpdf/signer-p12');
  const P12Signer = signerMod.P12Signer || signerMod.default;
  const signer = new P12Signer(opts.signer.p12, { passphrase: opts.signer.passphrase });
  const signed = await new SignPdf().sign(withPlaceholder, signer);
  return Buffer.from(signed);
}

module.exports = { ensureSigner, signPdf };
