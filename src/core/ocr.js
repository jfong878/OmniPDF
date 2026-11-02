'use strict';

const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');
const { sanitizeWinAnsi } = require('./util');

let workerPromise = null;
let workerLang = null;
let cacheDir = null;

function setCacheDir(dir) {
  cacheDir = dir;
}

async function getWorker(lang) {
  if (workerPromise && workerLang === lang) return workerPromise;
  const { createWorker } = require('tesseract.js');
  workerLang = lang;
  const options = { logger: () => {} };
  if (cacheDir) options.cachePath = cacheDir;
  workerPromise = createWorker(lang, 1, options);
  workerPromise.catch(() => {
    workerPromise = null;
    workerLang = null;
  });
  return workerPromise;
}

/** Walk the nested block -> paragraph -> line -> word tree tesseract returns. */
function walkBlocks(node, out) {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const child of node) walkBlocks(child, out);
    return;
  }
  if (node.bbox && typeof node.text === 'string') {
    if (node.text.trim()) out.push(node);
    return;
  }
  for (const key of ['blocks', 'paragraphs', 'lines', 'words']) {
    if (node[key]) walkBlocks(node[key], out);
  }
}

/**
 * Parse tesseract's TSV channel. Level 5 rows are words:
 * level, page, block, par, line, word, left, top, width, height, conf, text
 */
function wordsFromTsv(tsv) {
  const out = [];
  for (const line of String(tsv || '').split('\n')) {
    const cols = line.split('\t');
    if (cols.length < 12 || cols[0] !== '5') continue;
    const text = cols[11].trim();
    if (!text) continue;
    const left = Number(cols[6]) || 0;
    const top = Number(cols[7]) || 0;
    const width = Number(cols[8]) || 0;
    const height = Number(cols[9]) || 0;
    out.push({ text, bbox: { x0: left, y0: top, x1: left + width, y1: top + height } });
  }
  return out;
}

function flattenWords(data) {
  if (!data) return [];
  if (Array.isArray(data.words) && data.words.length) {
    return data.words.filter((w) => w && w.bbox && w.text);
  }
  const collected = [];
  walkBlocks(data.blocks, collected);
  if (collected.length) return collected;
  return wordsFromTsv(data.tsv);
}

async function ocrPng(pngBuffer, lang = 'eng') {
  const worker = await getWorker(lang);
  let result;
  try {
    // Word geometry is not part of the default payload in tesseract 7.
    result = await worker.recognize(pngBuffer, {}, { text: true, blocks: true, tsv: true });
  } catch {
    result = await worker.recognize(pngBuffer);
  }
  const data = result.data || {};
  return {
    text: data.text || '',
    words: flattenWords(data),
    confidence: typeof data.confidence === 'number' ? data.confidence : 0,
  };
}

/**
 * Replace listed pages with a raster plus an invisible, positioned text layer
 * so the document becomes selectable and searchable without changing content.
 *
 * @param {Buffer|Uint8Array} pdfBytes
 * @param {Array<{index:number, pngBase64:string, dispWidth:number,
 *                dispHeight:number, pxPerPt:number, lang?:string}>} pages
 */
async function buildSearchable(pdfBytes, pages) {
  const doc = await PDFDocument.load(Buffer.from(pdfBytes), { updateMetadata: false });
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const results = [];

  for (const spec of pages) {
    const png = Buffer.from(spec.pngBase64, 'base64');
    const { text, words, confidence } = await ocrPng(png, spec.lang || 'eng');
    results.push({
      index: spec.index,
      confidence: Math.round(confidence),
      wordCount: words.length,
      text,
    });

    const image = await doc.embedPng(png);
    const dispW = spec.dispWidth;
    const dispH = spec.dispHeight;
    const newPage = doc.insertPage(spec.index, [dispW, dispH]);
    doc.removePage(spec.index + 1);

    newPage.drawImage(image, { x: 0, y: 0, width: dispW, height: dispH });

    const pxPerPt = spec.pxPerPt || 1;
    for (const word of words) {
      const label = sanitizeWinAnsi(word.text).trim();
      if (!label) continue;
      const height = (word.bbox.y1 - word.bbox.y0) / pxPerPt;
      const size = Math.max(4, Math.min(28, height * 0.92));
      newPage.drawText(label, {
        x: Math.max(0, word.bbox.x0 / pxPerPt),
        y: Math.max(0, dispH - word.bbox.y1 / pxPerPt),
        size,
        font,
        color: rgb(0, 0, 0),
        opacity: 0,
      });
    }
  }

  return { bytes: Buffer.from(await doc.save()), results };
}

async function dispose() {
  if (!workerPromise) return;
  try {
    const worker = await workerPromise;
    await worker.terminate();
  } catch {
    /* ignore */
  }
  workerPromise = null;
  workerLang = null;
}

module.exports = { setCacheDir, ocrPng, buildSearchable, dispose, flattenWords };
