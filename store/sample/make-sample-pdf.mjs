// Builds the fictional Northwind Community Picnic flyer used by the Chrome Web
// Store viewer and search screenshots. All names, dates and contact details are
// invented. Run with:
//
//   node store/sample/make-sample-pdf.mjs
//
// The capture script imports this module so a screenshot run always starts
// from the same document.

import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const SAMPLE_PDF_PATH = path.join(HERE, 'northwind-picnic-flyer.pdf');
export const SAMPLE_PDF_NAME = 'Northwind Picnic Flyer.pdf';

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;
const MARGIN = 54;

const hex = (value) => {
  const clean = value.replace('#', '');
  return rgb(
    parseInt(clean.slice(0, 2), 16) / 255,
    parseInt(clean.slice(2, 4), 16) / 255,
    parseInt(clean.slice(4, 6), 16) / 255
  );
};

const GREEN = hex('#2E6B4C');
const DARK_GREEN = hex('#174D35');
const NAVY = hex('#1A2942');
const SLATE = hex('#5D6878');
const BODY = hex('#333A44');
const RULE = hex('#DDE2E8');

function drawTrackedText(page, text, { x, y, size, font, color, gap }) {
  let cursor = x;
  for (const char of text) {
    page.drawText(char, { x: cursor, y, size, font, color });
    cursor += font.widthOfTextAtSize(char, size) + gap;
  }
}

function drawOrganization(page, font) {
  page.drawRectangle({
    x: 0,
    y: PAGE_HEIGHT - 13,
    width: PAGE_WIDTH,
    height: 13,
    color: GREEN,
  });

  page.drawRectangle({ x: MARGIN, y: 741, width: 18, height: 18, color: DARK_GREEN });
  page.drawText('N', {
    x: MARGIN + 5.4,
    y: 745,
    size: 11,
    font,
    color: rgb(1, 1, 1),
  });
  drawTrackedText(page, 'NORTHWIND NEIGHBORHOOD ASSOCIATION', {
    x: MARGIN + 28,
    y: 746,
    size: 6.5,
    font,
    color: DARK_GREEN,
    gap: 1.35,
  });
}

async function buildSamplePdfBytes() {
  const doc = await PDFDocument.create();
  doc.setTitle('Northwind Community Picnic');
  doc.setAuthor('Northwind Neighborhood Association');
  doc.setSubject('Fictional sample document for OmniPDF store screenshots');
  doc.setCreator('OmniPDF sample generator');
  doc.setProducer('OmniPDF');
  doc.setCreationDate(new Date('2026-06-01T00:00:00Z'));
  doc.setModificationDate(new Date('2026-06-01T00:00:00Z'));

  const regular = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);

  const page1 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawOrganization(page1, bold);

  page1.drawText('Northwind', { x: MARGIN, y: 674, size: 40, font: bold, color: NAVY });
  page1.drawText('Community Picnic', { x: MARGIN, y: 623, size: 40, font: bold, color: GREEN });

  page1.drawText('Saturday, June 13  \u00b7  11:00 AM \u2013 3:00 PM', {
    x: MARGIN,
    y: 582,
    size: 11,
    font: bold,
    color: NAVY,
  });
  page1.drawText('Willow Bend Park  \u00b7  Pavilion 2', {
    x: MARGIN,
    y: 562,
    size: 11,
    font: regular,
    color: SLATE,
  });

  page1.drawRectangle({ x: MARGIN, y: 538, width: 504, height: 0.8, color: RULE });

  page1.drawText('Bring a blanket, a dish to share, and a friend. Drinks, tableware,', {
    x: MARGIN,
    y: 507,
    size: 11.5,
    font: regular,
    color: BODY,
  });
  page1.drawText('and lawn games are provided. Rain or shine \u2014 the pavilion is covered.', {
    x: MARGIN,
    y: 492.5,
    size: 11.5,
    font: regular,
    color: BODY,
  });

  page1.drawRectangle({ x: MARGIN, y: 435, width: 2.5, height: 13, color: GREEN });
  page1.drawText('12:00 PM', { x: 67, y: 435, size: 12, font: bold, color: GREEN });
  page1.drawText('Potluck lunch', { x: 151, y: 435, size: 12, font: regular, color: NAVY });
  page1.drawText('1:00 PM', { x: 67, y: 405, size: 12, font: bold, color: GREEN });
  page1.drawText('Field games and relay races', {
    x: 151,
    y: 405,
    size: 12,
    font: regular,
    color: NAVY,
  });
  page1.drawText('2:30 PM', { x: 67, y: 375, size: 12, font: bold, color: GREEN });
  page1.drawText('Dessert table and closing thanks', {
    x: 151,
    y: 375,
    size: 12,
    font: regular,
    color: NAVY,
  });

  const page2 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawOrganization(page2, bold);
  page2.drawText('Picnic Day Schedule', {
    x: MARGIN,
    y: 690,
    size: 27,
    font: bold,
    color: GREEN,
  });
  page2.drawText('All events take place at Willow Bend Park, Pavilion 2.', {
    x: MARGIN,
    y: 654,
    size: 12,
    font: regular,
    color: BODY,
  });

  const schedule = [
    ['11:00 AM', 'Welcome and name badges'],
    ['12:00 PM', 'Potluck lunch'],
    ['1:00 PM', 'Field games and relay races'],
    ['2:30 PM', 'Dessert table and closing thanks'],
  ];
  let rowY = 606;
  for (const [time, label] of schedule) {
    page2.drawText(time, { x: MARGIN, y: rowY, size: 12, font: bold, color: GREEN });
    page2.drawText(label, { x: 140, y: rowY, size: 12, font: regular, color: NAVY });
    rowY -= 34;
  }

  page2.drawText('Bring a blanket or lawn chair. Tables and water are provided.', {
    x: MARGIN,
    y: rowY - 24,
    size: 12,
    font: regular,
    color: BODY,
  });

  const page3 = doc.addPage([PAGE_WIDTH, PAGE_HEIGHT]);
  drawOrganization(page3, bold);
  page3.drawText('Picnic Setup Crew', { x: MARGIN, y: 690, size: 27, font: bold, color: GREEN });
  page3.drawText('Setup volunteers arrive at 9:30 AM; cleanup crew stays until 4:00 PM.', {
    x: MARGIN,
    y: 654,
    size: 12,
    font: regular,
    color: BODY,
  });
  page3.drawText('Sign in at the welcome table when you arrive, and collect a vest.', {
    x: MARGIN,
    y: 634,
    size: 12,
    font: regular,
    color: BODY,
  });
  page3.drawText('Questions? Email outreach@example.org or call the community line.', {
    x: MARGIN,
    y: 590,
    size: 12,
    font: regular,
    color: BODY,
  });
  page3.drawText('Thank you for helping make the afternoon easy for every neighbor.', {
    x: MARGIN,
    y: 552,
    size: 12,
    font: regular,
    color: BODY,
  });

  return doc.save();
}

export async function writeSamplePdf() {
  await mkdir(HERE, { recursive: true });
  const bytes = await buildSamplePdfBytes();
  await writeFile(SAMPLE_PDF_PATH, bytes);
  return SAMPLE_PDF_PATH;
}

const invokedDirectly =
  process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));
if (invokedDirectly) {
  const output = await writeSamplePdf();
  process.stdout.write(`wrote ${path.relative(process.cwd(), output)}\n`);
}
