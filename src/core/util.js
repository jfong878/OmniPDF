'use strict';

// Characters present in WinAnsiEncoding beyond Latin-1 that pdf-lib's
// StandardFonts can encode. Anything else must be replaced first.
const WINANSI_EXTRA = new Set(
  '\u20AC\u201A\u0192\u201E\u2026\u2020\u2021\u02C6\u2030\u0160\u2039\u0152\u017D' +
    '\u2018\u2019\u201C\u201D\u2022\u2013\u2014\u02DC\u2122\u0161\u203A\u0153\u017E\u0178'
);

/**
 * Coerce arbitrary text into something a StandardFonts font can encode.
 * Unencodable code points become '?' rather than throwing mid-save.
 */
function sanitizeWinAnsi(input) {
  const text = String(input == null ? '' : input);
  let out = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0);
    if (cp === 0x09 || cp === 0x0a || cp === 0x0d) out += ' ';
    else if (cp >= 0x20 && cp <= 0x7e) out += ch;
    else if (cp >= 0xa0 && cp <= 0xff) out += ch;
    else if (WINANSI_EXTRA.has(ch)) out += ch;
    else out += '?';
  }
  return out;
}

/** '#rrggbb' | '#rgb' -> {r,g,b} in 0..1, falling back to black. */
function parseColor(value, fallback = { r: 0, g: 0, b: 0 }) {
  if (typeof value !== 'string') return fallback;
  let hex = value.trim();
  if (!hex.startsWith('#')) return fallback;
  hex = hex.slice(1);
  if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
  if (hex.length !== 6 || !/^[0-9a-f]{6}$/i.test(hex)) return fallback;
  return {
    r: parseInt(hex.slice(0, 2), 16) / 255,
    g: parseInt(hex.slice(2, 4), 16) / 255,
    b: parseInt(hex.slice(4, 6), 16) / 255,
  };
}

/** Normalise {x1,y1,x2,y2} (any corner order) into {x,y,w,h} with w,h > 0. */
function normalizeRect(x1, y1, x2, y2) {
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

function round(n, places = 3) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}

module.exports = { sanitizeWinAnsi, parseColor, normalizeRect, round };
