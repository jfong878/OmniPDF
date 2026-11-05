'use strict';

const fs = require('node:fs');
const path = require('node:path');

const MAX_RECENT = 10;

function storePath(userDir) {
  return path.join(userDir, 'recent.json');
}

function isPdf(filePath) {
  return typeof filePath === 'string' && path.extname(filePath).toLowerCase() === '.pdf';
}

function load(userDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(storePath(userDir), 'utf8'));
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isPdf).slice(0, MAX_RECENT);
  } catch {
    return [];
  }
}

function save(userDir, entries) {
  fs.mkdirSync(userDir, { recursive: true });
  const target = storePath(userDir);
  const temp = `${target}.tmp`;
  fs.writeFileSync(temp, JSON.stringify(entries.slice(0, MAX_RECENT), null, 2));
  fs.renameSync(temp, target);
}

function add(userDir, filePath) {
  if (!isPdf(filePath)) return load(userDir);
  const resolved = path.resolve(filePath);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return load(userDir);

  const key = resolved.toLowerCase();
  const next = [resolved, ...load(userDir).filter((entry) => entry.toLowerCase() !== key)];
  save(userDir, next);
  return next.slice(0, MAX_RECENT);
}

function remove(userDir, filePath) {
  if (!filePath) return load(userDir);
  const key = path.resolve(filePath).toLowerCase();
  const next = load(userDir).filter((entry) => entry.toLowerCase() !== key);
  save(userDir, next);
  return next;
}

function clear(userDir) {
  save(userDir, []);
  return [];
}

/** Existing PDFs only, newest first, with display metadata. */
function list(userDir) {
  const entries = load(userDir);
  const existing = [];
  let pruned = false;
  for (const entry of entries) {
    try {
      if (fs.existsSync(entry) && fs.statSync(entry).isFile()) existing.push(entry);
      else pruned = true;
    } catch {
      pruned = true;
    }
  }
  if (pruned) {
    try {
      save(userDir, existing);
    } catch {
      /* keep the menu usable even if the cache cannot be rewritten */
    }
  }
  return existing.map((filePath) => ({
    path: filePath,
    name: path.basename(filePath),
    folder: path.dirname(filePath),
  }));
}

module.exports = { MAX_RECENT, load, add, remove, clear, list };