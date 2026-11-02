'use strict';

const {
  PDFDocument,
  StandardFonts,
  rgb,
  degrees,
  LineCapStyle,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} = require('pdf-lib');
const { sanitizeWinAnsi, parseColor } = require('./util');

const LOAD_OPTS = { updateMetadata: false, throwOnInvalidObject: false };

function loadPdf(bytes) {
  return PDFDocument.load(bytes, LOAD_OPTS);
}

function toRgb(c) {
  const { r, g, b } = parseColor(c);
  return rgb(r, g, b);
}

/* ------------------------------------------------------------------ forms */

function fillForm(form, values, errors) {
  for (const [name, raw] of Object.entries(values || {})) {
    let field;
    try {
      field = form.getFieldMaybe(name);
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
      continue;
    }
    if (!field) continue;
    try {
      if (field instanceof PDFTextField) {
        field.setText(sanitizeWinAnsi(raw));
      } else if (field instanceof PDFCheckBox) {
        const on = raw === true || raw === 'true' || raw === 'on' || raw === 'Yes';
        if (on) field.check();
        else field.uncheck();
      } else if (field instanceof PDFRadioGroup) {
        if (raw) field.select(String(raw));
      } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
        if (raw) field.select([String(raw)]);
      }
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
}

/* ------------------------------------------------------------ annotations */

function drawAnnotation(page, font, ann) {
  const rect = ann.rect || { x: 0, y: 0, w: 0, h: 0 };
  const colour = toRgb(ann.color || '#ffd400');
  const opacity = typeof ann.opacity === 'number' ? ann.opacity : 0.35;

  if (ann.type === 'highlight') {
    if (rect.w <= 0 || rect.h <= 0) return;
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      color: colour,
      colorOpacity: opacity,
      borderWidth: 0,
    });
    return;
  }

  if (ann.type === 'box') {
    if (rect.w <= 0 || rect.h <= 0) return;
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: rect.w,
      height: rect.h,
      borderColor: colour,
      borderWidth: ann.width || 1.5,
      borderOpacity: 1,
    });
    return;
  }

  if (ann.type === 'ink') {
    const pts = Array.isArray(ann.points) ? ann.points : [];
    for (let i = 1; i < pts.length; i += 1) {
      const [x1, y1] = pts[i - 1];
      const [x2, y2] = pts[i];
      page.drawLine({
        start: { x: x1, y: y1 },
        end: { x: x2, y: y2 },
        thickness: ann.width || 2,
        color: colour,
        lineCap: LineCapStyle.Round,
      });
    }
    return;
  }

  if (ann.type === 'text') {
    const body = sanitizeWinAnsi(ann.text || '');
    if (!body) return;
    const size = ann.fontSize || 12;
    const lineCount = body.split('\n').length;
    const boxH = Math.max(rect.h, size * 1.35 * lineCount + 6);
    page.drawRectangle({
      x: rect.x,
      y: rect.y,
      width: Math.max(rect.w, 24),
      height: boxH,
      color: rgb(1, 1, 1),
      colorOpacity: 0.92,
      borderColor: colour,
      borderWidth: 0.75,
      borderOpacity: 0.9,
    });
    page.drawText(body, {
      x: rect.x + 4,
      y: rect.y + boxH - size - 3,
      size,
      font,
      color: rgb(0.05, 0.05, 0.05),
      lineHeight: size * 1.3,
      maxWidth: Math.max(rect.w - 8, 24),
    });
  }
}

/* ---------------------------------------------------------------- page ops */

/**
 * Delete pages by original index, descending, so earlier indices stay valid
 * for the whole batch.
 */
function deletePages(doc, indices, errors) {
  const count = doc.getPageCount();
  const valid = [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < count)
    .sort((a, b) => b - a);

  if (valid.length >= count) {
    errors.push('refusing to delete every page in the document');
    return;
  }
  for (const index of valid) doc.removePage(index);
}

/* ------------------------------------------------------------------- save */

/**
 * @param {Buffer|Uint8Array} bytes
 * @param {{formValues?:object, annotations?:Array,
 *          pageOps?:{rotations?:object, deletes?:number[]}}} payload
 * @returns {Promise<{bytes:Buffer, errors:string[]}>}
 */
async function saveWithEdits(bytes, payload = {}) {
  const errors = [];
  const doc = await loadPdf(Buffer.from(bytes));
  const font = await doc.embedFont(StandardFonts.Helvetica);

  if (payload.formValues && Object.keys(payload.formValues).length) {
    const form = doc.getForm();
    fillForm(form, payload.formValues, errors);
    try {
      form.updateFieldAppearances(font);
    } catch (err) {
      errors.push(`appearances: ${err.message}`);
    }
  }

  const annotations = Array.isArray(payload.annotations) ? payload.annotations : [];
  if (annotations.length) {
    const pageCount = doc.getPageCount();
    for (const ann of annotations) {
      const idx = Number(ann.page);
      if (!Number.isInteger(idx) || idx < 0 || idx >= pageCount) continue;
      try {
        drawAnnotation(doc.getPage(idx), font, ann);
      } catch (err) {
        errors.push(`annotation: ${err.message}`);
      }
    }
  }

  const ops = payload.pageOps || {};

  for (const [key, delta] of Object.entries(ops.rotations || {})) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= doc.getPageCount()) continue;
    if (!delta) continue;
    const page = doc.getPage(idx);
    page.setRotation(degrees((((page.getRotation().angle + Number(delta)) % 360) + 360) % 360));
  }

  if (Array.isArray(ops.deletes) && ops.deletes.length) {
    deletePages(doc, ops.deletes, errors);
  }

  const out = await doc.save({ useObjectStreams: true, addDefaultPage: false });
  return { bytes: Buffer.from(out), errors };
}

/* -------------------------------------------------------- merge / extract */

async function mergePdfs(baseBytes, addBytes, position = 'end') {
  const doc = await loadPdf(Buffer.from(baseBytes));
  const other = await loadPdf(Buffer.from(addBytes));
  const copied = await doc.copyPages(other, other.getPageIndices());
  if (position === 'start') {
    copied.reverse().forEach((p, i) => doc.insertPage(i, p));
  } else {
    copied.forEach((p) => doc.addPage(p));
  }
  return { bytes: Buffer.from(await doc.save()), added: copied.length };
}

async function extractPages(bytes, indices) {
  const src = await loadPdf(Buffer.from(bytes));
  const doc = await PDFDocument.create();
  const valid = indices.filter((i) => i >= 0 && i < src.getPageCount());
  if (valid.length) {
    const copied = await doc.copyPages(src, valid);
    copied.forEach((p) => doc.addPage(p));
  }
  return Buffer.from(await doc.save());
}

module.exports = { saveWithEdits, mergePdfs, extractPages, loadPdf };
