import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const outDir = path.join(process.cwd(), 'assets');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'fixture.pdf');

// Distinct sizes per page make reordering / deletion verifiable without a
// text extractor.
const SIZES = [
  [612, 792],
  [595, 842],
  [500, 700],
];

const doc = await PDFDocument.create();
const font = await doc.embedFont(StandardFonts.Helvetica);
const bold = await doc.embedFont(StandardFonts.HelveticaBold);

for (let i = 0; i < SIZES.length; i += 1) {
  const [width, height] = SIZES[i];
  const page = doc.addPage([width, height]);
  page.drawText(`OmniPDF fixture page ${i + 1}`, {
    x: 60,
    y: height - 86,
    size: 22,
    font: bold,
    color: rgb(0.06, 0.1, 0.2),
  });
  page.drawText('The quick brown fox jumps over the lazy dog.', {
    x: 60,
    y: height - 128,
    size: 12,
    font,
    color: rgb(0.12, 0.12, 0.12),
  });
  page.drawText(`Section ${i + 1}: searchable marker number ${i + 1}0042`, {
    x: 60,
    y: height - 158,
    size: 12,
    font,
  });
  page.drawRectangle({
    x: 40,
    y: 60,
    width: width - 80,
    height: 2,
    color: rgb(0.75, 0.78, 0.85),
  });
}

const form = doc.getForm();
const page1 = doc.getPage(0);
const name = form.createTextField('applicant.name');
name.setText('');
name.addToPage(page1, { x: 60, y: 560, width: 300, height: 22, borderWidth: 1 });

const agree = form.createCheckBox('applicant.agree');
agree.addToPage(page1, { x: 60, y: 520, width: 16, height: 16 });

fs.writeFileSync(outPath, await doc.save());
console.log(`wrote ${outPath}`);
