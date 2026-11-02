import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PDFDocument } = require('pdf-lib');
const { saveWithEdits, extractPages } = require('../src/core/edit');
const { ensureSigner, signPdf } = require('../src/core/sign');
const { ocrPng, setCacheDir } = require('../src/core/ocr');

const root = process.cwd();
const fixture = path.join(root, 'assets', 'fixture.pdf');

let failures = 0;
const check = (label, condition, detail = '') => {
  if (condition) {
    console.log(`  PASS  ${label}`);
  } else {
    failures += 1;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
};

if (!fs.existsSync(fixture)) {
  console.error('fixture missing; run `npm run fixture` first');
  process.exit(1);
}
const source = fs.readFileSync(fixture);

console.log('\n[1] baseline');
{
  const doc = await PDFDocument.load(source);
  check('fixture has 3 pages', doc.getPageCount() === 3, String(doc.getPageCount()));
  check('fixture has applicant.name', Boolean(doc.getForm().getFieldMaybe('applicant.name')));
}

console.log('\n[2] form fill + annotations + rotation');
{
  const { bytes, errors } = await saveWithEdits(source, {
    formValues: { 'applicant.name': 'Ada Lovelace', 'applicant.agree': 'true' },
    annotations: [
      { page: 0, type: 'highlight', color: '#ffd400', opacity: 0.35, rect: { x: 60, y: 655, w: 260, h: 16 } },
      { page: 1, type: 'box', color: '#4d8dff', width: 1.5, rect: { x: 60, y: 300, w: 200, h: 90 } },
      { page: 2, type: 'text', color: '#ffd400', rect: { x: 60, y: 200, w: 260, h: 60 }, text: 'Reviewed and approved', fontSize: 12 },
    ],
    pageOps: { rotations: { 0: 90 }, order: [0, 1, 2] },
  });
  check('no edit errors', errors.length === 0, errors.join('; '));
  check('output is a valid PDF', bytes.subarray(0, 5).toString() === '%PDF-');

  const doc = await PDFDocument.load(bytes);
  check('page count preserved', doc.getPageCount() === 3, String(doc.getPageCount()));
  check('page 0 rotated to 90', doc.getPage(0).getRotation().angle === 90, String(doc.getPage(0).getRotation().angle));
  const field = doc.getForm().getFieldMaybe('applicant.name');
  check('text field value written', field && field.getText() === 'Ada Lovelace', field ? field.getText() : 'missing');
  const box = doc.getForm().getFieldMaybe('applicant.agree');
  check('checkbox checked', Boolean(box && box.isChecked()));
}

console.log('\n[3] delete');
{
  const { bytes, errors } = await saveWithEdits(source, { pageOps: { rotations: {}, deletes: [1] } });
  check('no delete errors', errors.length === 0, errors.join('; '));
  const doc = await PDFDocument.load(bytes);
  check('deleted to 2 pages', doc.getPageCount() === 2, String(doc.getPageCount()));
  const first = doc.getPage(0).getSize();
  check(
    'surviving page 0 is the original page 1 (612x792)',
    first.width === 612 && first.height === 792,
    JSON.stringify(first)
  );
  const second = doc.getPage(1).getSize();
  check(
    'surviving page 1 is the original page 3 (500x700)',
    second.width === 500 && second.height === 700,
    JSON.stringify(second)
  );
  const blocked = await saveWithEdits(source, { pageOps: { rotations: {}, deletes: [0, 1, 2] } });
  check('refuses to delete every page', blocked.errors.length > 0);
  check('kept all pages when refusing', (await PDFDocument.load(blocked.bytes)).getPageCount() === 3, 'not 3');
}

console.log('\n[4] extract');
{
  const out = await extractPages(source, [1]);
  const doc = await PDFDocument.load(out);
  check('extract produced 1 page', doc.getPageCount() === 1, String(doc.getPageCount()));
  const size = doc.getPage(0).getSize();
  check('extracted the second page (595x842)', size.width === 595 && size.height === 842, JSON.stringify(size));
}

console.log('\n[5] sign');
{
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'omnipdf-'));
  const signer = ensureSigner(dir);
  check('signer p12 created', signer.p12.length > 500, String(signer.p12.length));
  const signed = await signPdf(source, {
    pageIndex: 0,
    rect: { x: 330, y: 80, w: 210, h: 64 },
    name: 'Ada Lovelace',
    reason: 'Approved',
    location: 'London',
    signer,
  });
  const raw = signed.toString('latin1');
  check('signature dictionary present', raw.includes('/ByteRange'));
  check('subfilter set', raw.includes('/SubFilter'));
  const doc = await PDFDocument.load(signed);
  check('signed document still loads', doc.getPageCount() === 3, String(doc.getPageCount()));
  const fields = doc.getForm().getFields().map((f) => f.constructor.name);
  check('signature field added', fields.includes('PDFSignature'), fields.join(',') || 'none');
}

console.log('\n[6] OCR');
{
  const sample = path.join(root, 'assets', 'ocr-sample.png');
  if (!fs.existsSync(sample)) {
    console.log('  SKIP  no assets/ocr-sample.png');
  } else {
    setCacheDir(path.join(root, '.tessdata'));
    const result = await ocrPng(fs.readFileSync(sample), 'eng');
    check('OCR returned word boxes', result.words.length > 0, `words=${result.words.length}`);
    check('OCR recognised the caption', /Hello/i.test(result.text), JSON.stringify(result.text.slice(0, 60)));
    const w = result.words[0];
    check(
      'word boxes have geometry',
      Boolean(w && w.bbox && w.bbox.x1 > w.bbox.x0 && w.bbox.y1 > w.bbox.y0),
      JSON.stringify(w && w.bbox)
    );
  }
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
