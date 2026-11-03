'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MAX_BYTES = 5 * 1024 * 1024;
const MAX_COUNT = 24;
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function dirFor(userDir) {
  return path.join(userDir, 'signatures');
}

function metaPath(userDir) {
  return path.join(dirFor(userDir), 'signatures.json');
}

function readMeta(userDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(metaPath(userDir), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item) => item && typeof item.id === 'string' && typeof item.file === 'string'
    );
  } catch {
    return [];
  }
}

function writeMeta(userDir, items) {
  fs.mkdirSync(dirFor(userDir), { recursive: true });
  fs.writeFileSync(metaPath(userDir), JSON.stringify(items, null, 2), { mode: 0o600 });
}

function cleanName(value, fallback = 'Signature') {
  const name = String(value || '')
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
  return name || fallback;
}

function readPng(dataUrl) {
  if (typeof dataUrl !== 'string') throw new Error('No signature image supplied');
  const match = /^data:image\/png;base64,([A-Za-z0-9+/=\s]+)$/.exec(dataUrl);
  if (!match) throw new Error('Signature must be a PNG image');

  const buffer = Buffer.from(match[1].replace(/\s+/g, ''), 'base64');
  if (buffer.length < 33 || buffer.length > MAX_BYTES) {
    throw new Error('Signature image is empty or too large');
  }
  if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) {
    throw new Error('Signature image is not a valid PNG');
  }

  const width = buffer.readUInt32BE(16);
  const height = buffer.readUInt32BE(20);
  if (!width || !height || width > 4096 || height > 4096) {
    throw new Error('Signature image dimensions are invalid');
  }
  return buffer;
}

function dataUrlOf(buffer) {
  return `data:image/png;base64,${buffer.toString('base64')}`;
}

function list(userDir) {
  const out = [];
  for (const item of readMeta(userDir)) {
    try {
      const buffer = fs.readFileSync(path.join(dirFor(userDir), path.basename(item.file)));
      if (!buffer.subarray(0, 8).equals(PNG_MAGIC)) continue;
      out.push({
        id: item.id,
        name: cleanName(item.name),
        createdAt: item.createdAt || null,
        dataUrl: dataUrlOf(buffer),
      });
    } catch {
      /* skip missing or unreadable files */
    }
  }
  return out;
}

function save(userDir, payload) {
  const buffer = readPng(payload && payload.dataUrl);
  const items = readMeta(userDir);
  if (items.length >= MAX_COUNT) {
    throw new Error(`Signature library is full (${MAX_COUNT}). Delete one first.`);
  }

  const id = `sig-${Date.now()}-${crypto.randomBytes(4).toString('hex')}`;
  const file = `${id}.png`;
  const name = cleanName(payload.name);
  const entry = { id, name, file, createdAt: new Date().toISOString() };

  fs.mkdirSync(dirFor(userDir), { recursive: true });
  fs.writeFileSync(path.join(dirFor(userDir), file), buffer, { mode: 0o600 });
  items.push(entry);
  writeMeta(userDir, items);

  return { ...entry, dataUrl: dataUrlOf(buffer) };
}

function remove(userDir, id) {
  if (typeof id !== 'string' || !/^[A-Za-z0-9_-]{1,80}$/.test(id)) {
    throw new Error('Invalid signature id');
  }

  const items = readMeta(userDir);
  const entry = items.find((item) => item.id === id);
  if (!entry) return list(userDir);

  try {
    fs.unlinkSync(path.join(dirFor(userDir), path.basename(entry.file)));
  } catch {
    /* the metadata entry is still removed */
  }
  writeMeta(userDir, items.filter((item) => item.id !== id));
  return list(userDir);
}

module.exports = { list, save, remove, MAX_BYTES, MAX_COUNT };
