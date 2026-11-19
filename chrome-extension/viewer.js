import * as pdfjsLib from './vendor/build/pdf.mjs?v=2026-11-05-2';

pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
  './vendor/build/pdf.worker.mjs?v=2026-11-05-2',
  import.meta.url
).href;

const CMAP_URL = new URL('./vendor/cmaps/', import.meta.url).href;
const STANDARD_FONTS = new URL('./vendor/standard_fonts/', import.meta.url).href;
const WASM_URL = new URL('./vendor/wasm/', import.meta.url).href;
const ICC_URL = new URL('./vendor/iccs/', import.meta.url).href;

const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const DEFAULT_SCALE = 1.15;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_CANVAS_SIDE = 8192;
const PRINT_DPI = 150;
const MAX_FILE_BYTES = 200 * 1024 * 1024;
const MAX_PRINT_PIXELS = 12_000_000;
const EAGER_RENDER_LIMIT = 4;

const IDS = [
  'btn-open', 'btn-download', 'btn-print', 'btn-prev', 'page-input', 'page-total', 'btn-next',
  'btn-zoom-out', 'zoom-label', 'btn-zoom-in', 'btn-fit', 'btn-fit-page', 'btn-actual',
  'search', 'search-count', 'btn-find-prev', 'btn-find-next',
  'viewer', 'pages', 'empty-state', 'empty-title', 'empty-copy', 'empty-open', 'empty-gmail',
  'empty-source', 'status-file', 'status-msg', 'file-input', 'print-root', 'build-label',
];

const el = {};
for (const id of IDS) el[id] = document.getElementById(id);
const emptyHint = el['empty-state'].querySelector('.hint');

let doc = null;
let loadToken = 0;
let pinch = null;
let wheelZoom = null;
let scaleRenderTimer = null;
let searchTimer = null;
let scrollFrame = 0;
let suppressClickUntil = 0;
let printUrls = [];
let printBusy = false;

const clamp = (value, min, max) => Math.min(max, Math.max(min, value));
const hasDoc = () => Boolean(doc && doc.pdf);

function setMsg(message) {
  el['status-msg'].textContent = message || '';
}

function reportDiagnostic(stage, message, details = {}) {
  try {
    if (!globalThis.chrome?.runtime?.sendMessage) return;
    const pending = chrome.runtime.sendMessage({
      type: 'omnipdf-diagnostic',
      entry: {
        stage,
        message: String(message || 'Unknown error'),
        name: details.name || '',
        url: details.url || '',
        bytes: details.bytes,
        durationMs: details.durationMs,
      },
    });
    if (typeof pending?.catch === 'function') pending.catch(() => {});
  } catch {
    // Diagnostics must not interfere with opening the document.
  }
}

function updateTitle() {
  document.title = doc ? `${doc.name} — OmniPDF` : 'OmniPDF for Chrome';
}

function syncChrome() {
  const ready = hasDoc();
  for (const id of [
    'btn-download', 'btn-print', 'btn-prev', 'btn-next', 'page-input',
    'btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-fit-page', 'btn-actual',
    'search', 'btn-find-prev', 'btn-find-next',
  ]) {
    el[id].disabled = !ready;
  }
  el['page-total'].textContent = ready ? `/ ${doc.pageOrder.length}` : '/ 0';
  el['page-input'].max = String(Math.max(1, ready ? doc.pageOrder.length : 1));
  el['page-input'].value = ready ? String(doc.current + 1) : '1';
  const shownScale = wheelZoom && ready ? wheelZoom.target : doc?.scale;
  el['zoom-label'].textContent = ready ? `${Math.round(shownScale * 100)}%` : '100%';
  el['status-file'].textContent = ready ? doc.name : 'No document';
  el['btn-find-prev'].disabled = !ready || !doc.searchHits.length;
  el['btn-find-next'].disabled = !ready || !doc.searchHits.length;
  document.body.classList.toggle('has-document', ready);
  updateTitle();
}

function showEmpty(title, copy, hint, sourceUrl) {
  document.body.classList.remove('has-document');
  el['empty-title'].textContent = title;
  el['empty-copy'].textContent = copy;
  emptyHint.textContent = hint;
  el['empty-source'].hidden = !sourceUrl;
  if (sourceUrl) el['empty-source'].href = sourceUrl;
  setMsg('Ready');
}

function looksLikePdf(bytes) {
  if (!bytes || bytes.length < 5) return false;
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(1024, bytes.length)));
  return head.includes('%PDF-');
}

function filenameFromDisposition(header) {
  if (!header) return '';
  const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
  if (extended) {
    try {
      return decodeURIComponent(extended[1].trim());
    } catch {
      return extended[1].trim();
    }
  }
  const plain = /filename="?([^";]+)"?/i.exec(header);
  return plain ? plain[1].trim() : '';
}

function cleanName(name) {
  const value = String(name || 'document.pdf').replace(/[\\/:*?"<>|]/g, '_').trim();
  if (!value) return 'document.pdf';
  return /\.pdf$/i.test(value) ? value : `${value}.pdf`;
}

function base64ToBytes(encoded) {
  const binary = atob(String(encoded || ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function pdfLoadOptions(bytes) {
  return {
    data: bytes,
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS,
    wasmUrl: WASM_URL,
    iccUrl: ICC_URL,
    isEvalSupported: false,
    useSystemFonts: true,
  };
}

async function getViewport(pdf, idx, scale) {
  const page = await pdf.getPage(idx + 1);
  return page.getViewport({ scale, rotation: page.rotate });
}

async function openFile(file) {
  if (!file) return;
  if (file.size > MAX_FILE_BYTES) {
    setMsg('This PDF is too large for the Chrome viewer');
    return;
  }
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    await openBytes(bytes, cleanName(file.name));
  } catch (error) {
    const message = String(error.message || error);
    if (doc) setMsg(`Could not open PDF: ${message}`);
    else {
      showEmpty(
        'Could not open PDF',
        message,
        'Choose another PDF, or drop it anywhere in this window.'
      );
    }
  }
}

function availablePageWidth() {
  // 20px page padding on each side plus the scrollbar gutter.
  return Math.max(0, el.viewer.clientWidth - 48);
}

async function openBytes(bytes, name, sourceUrl = '') {
  if (!looksLikePdf(bytes)) throw new Error('That file is not a PDF');
  const token = ++loadToken;
  cancelWheel();
  setMsg('Loading…');

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument(pdfLoadOptions(bytes)).promise;
  } catch (error) {
    throw new Error(`PDF.js could not read this document: ${error.message || error}`);
  }

  if (token !== loadToken) {
    pdf.destroy().catch(() => {});
    return;
  }

  if (doc?.pdf) {
    try {
      await doc.pdf.destroy();
    } catch {
      /* ignore a stale document */
    }
  }
  if (doc?.io) doc.io.disconnect();

  const firstPage = await pdf.getPage(1);
  const firstViewport = firstPage.getViewport({ scale: 1 });
  const fitScale = availablePageWidth() / Math.max(1, firstViewport.width);
  const scale = clamp(fitScale || DEFAULT_SCALE, MIN_SCALE, MAX_SCALE);

  doc = {
    bytes,
    name: cleanName(name),
    sourceUrl,
    pdf,
    pageEls: new Map(),
    pageOrder: Array.from({ length: pdf.numPages }, (_, i) => i),
    scale,
    current: 0,
    searchHits: [],
    searchActive: 0,
    searchQuery: '',
    searchToken: 0,
    scaleSeq: 0,
    io: null,
  };

  el.viewer.scrollTop = 0;
  el.viewer.scrollLeft = 0;
  el.search.value = '';
  el['search-count'].textContent = '';
  el.pages.style.transform = '';
  el.pages.style.transformOrigin = '';
  document.body.classList.add('has-document');
  syncChrome();
  setMsg('Building pages…');

  await buildPages(token);
  if (!doc || token !== loadToken) return;

  // Short printouts should be readable page-to-page without waiting for the
  // IntersectionObserver to catch up as the user scrolls.
  const eagerCount = Math.min(doc.pageOrder.length, EAGER_RENDER_LIMIT);
  for (let idx = 0; idx < eagerCount; idx += 1) renderPage(idx).catch(() => {});
  updateCurrentPage();
  setMsg(`${doc.pageOrder.length} page${doc.pageOrder.length === 1 ? '' : 's'} · pinch to zoom`);
  syncChrome();
}

async function buildPages(token) {
  el.pages.innerHTML = '';
  if (!doc) return;
  doc.pageEls.clear();
  if (doc.io) doc.io.disconnect();

  doc.io = new IntersectionObserver(
    (entries) => {
      if (!doc) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = Number(entry.target.dataset.idx);
        if (doc.pageEls.has(idx)) renderPage(idx).catch(() => {});
      }
    },
    { root: el.viewer, rootMargin: '700px 0px' }
  );

  for (let idx = 0; idx < doc.pageOrder.length; idx += 1) {
    const pdf = doc.pdf;
    if (!pdf) return;
    const vp = await getViewport(pdf, idx, doc.scale);
    if (!doc || token !== loadToken) return;

    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.idx = String(idx);
    div.style.width = `${Math.floor(vp.width)}px`;
    div.style.height = `${Math.floor(vp.height)}px`;
    div.innerHTML =
      '<canvas class="page-canvas"></canvas><div class="text-layer"></div><div class="search-layer"></div><div class="page-error" role="status" hidden></div>';

    el.pages.appendChild(div);
    const entry = {
      index: idx,
      div,
      vp,
      baseW: vp.width / doc.scale,
      baseH: vp.height / doc.scale,
      rendered: '',
      errorKey: '',
      renderSeq: 0,
      textItems: null,
      chain: Promise.resolve(),
    };
    doc.pageEls.set(idx, entry);
    doc.io.observe(div);
  }

  syncChrome();
}

/* ----------------------------------------------------------------- render */

function renderPage(idx) {
  if (!doc) return Promise.resolve();
  const entry = doc.pageEls.get(idx);
  if (!entry) return Promise.resolve();
  entry.chain = entry.chain
    .then(() => doRenderPage(idx))
    .catch(() => {});
  return entry.chain;
}

function blankCanvas(canvas) {
  if (!canvas) return;
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) return;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, 1, 1);
}

function showPageError(entry, pageNumber, error) {
  const box = entry && entry.div.querySelector('.page-error');
  if (!box) return;
  const title = document.createElement('strong');
  title.textContent = `Page ${pageNumber} could not be rendered`;
  const detail = document.createElement('span');
  const message = String((error && error.message) || error || '')
    .replace(/\s+/g, ' ')
    .slice(0, 180);
  detail.textContent =
    `The rest of the document is still available. Try Fit width, a lower zoom, or reopen the file.` +
    (message ? ` (${message})` : '');
  box.replaceChildren(title, detail);
  box.hidden = false;
}

function clearPageError(entry) {
  const box = entry && entry.div.querySelector('.page-error');
  if (!box) return;
  box.hidden = true;
  box.replaceChildren();
}

function swapPageCanvas(target, source) {
  target.width = source.width;
  target.height = source.height;
  const context = target.getContext('2d', { alpha: false });
  if (!context) throw new Error('Canvas is unavailable');
  context.drawImage(source, 0, 0);
}

async function paintPage(page, canvas, viewport, entry, current) {
  // Paint into a detached canvas so the visible page keeps its previous
  // bitmap for the whole render. Resizing the visible canvas up front cleared
  // it, which made the delayed high-resolution rerender flash white.
  const offscreen = document.createElement('canvas');
  offscreen.width = Math.max(1, Math.floor(viewport.width));
  offscreen.height = Math.max(1, Math.floor(viewport.height));
  try {
    const context = offscreen.getContext('2d', { alpha: false });
    if (!context) throw new Error('Canvas is unavailable');
    context.fillStyle = '#ffffff';
    context.fillRect(0, 0, offscreen.width, offscreen.height);
    const task = page.render({ canvasContext: context, canvas: offscreen, viewport });
    entry.renderTask = task;
    try {
      await task.promise;
    } finally {
      entry.renderTask = null;
    }
    // A cancelled render can still settle after the cancel. Never blit a
    // stale scale over the newest bitmap.
    if (!current()) return false;
    // Resize and blit in the same task so the old bitmap is replaced without
    // an intermediate white frame.
    swapPageCanvas(canvas, offscreen);
    return true;
  } finally {
    // Release the canvas on failure too, not only after a successful blit.
    offscreen.width = 1;
    offscreen.height = 1;
  }
}

async function doRenderPage(idx) {
  if (!doc) return;
  const activeDoc = doc;
  const entry = activeDoc.pageEls.get(idx);
  if (!entry) return;

  let page;
  try {
    page = await activeDoc.pdf.getPage(idx + 1);
  } catch (error) {
    if (doc === activeDoc) {
      entry.rendered = 'error';
      showPageError(entry, idx + 1, error);
    }
    return;
  }
  if (doc !== activeDoc) return;
  const vp = page.getViewport({ scale: activeDoc.scale, rotation: page.rotate });
  const key = `${activeDoc.scale.toFixed(4)}|${vp.rotation}`;

  if (entry.rendered === key) {
    entry.vp = vp;
    // Keep the error card for a scale that already failed. IntersectionObserver
    // re-renders the page when it scrolls into view, and clearing here made the
    // explanation disappear exactly when the reader reached the broken page.
    if (entry.errorKey !== key) clearPageError(entry);
    return;
  }

  entry.renderSeq += 1;
  const seq = entry.renderSeq;
  const scaled = page.getViewport({ scale: activeDoc.scale * DPR, rotation: page.rotate });
  const pixelBudget = Math.min(
    1,
    Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, scaled.width * scaled.height))
  );
  const sideBudget = Math.min(1, MAX_CANVAS_SIDE / Math.max(1, scaled.width, scaled.height));
  const budget = Math.min(pixelBudget, sideBudget);
  const canvas = entry.div.querySelector('.page-canvas');

  const current = () => doc === activeDoc && seq === entry.renderSeq;
  let failure = null;
  for (const factor of [1, 0.7, 0.5]) {
    if (!current()) return;
    const renderViewport = page.getViewport({
      scale: activeDoc.scale * DPR * budget * factor,
      rotation: page.rotate,
    });
    try {
      // A cancelled render must stop the retry ladder; trying the same stale
      // scale again at a lower resolution would race the newest render.
      if (!(await paintPage(page, canvas, renderViewport, entry, current))) return;
      failure = null;
      break;
    } catch (error) {
      if (!current()) return;
      failure = error;
    }
  }

  if (failure) {
    entry.rendered = key;
    entry.errorKey = key;
    entry.vp = vp;
    showPageError(entry, idx + 1, failure);
    setMsg(`Page ${idx + 1} could not be rendered`);
    return;
  }

  entry.div.style.width = `${Math.floor(vp.width)}px`;
  entry.div.style.height = `${Math.floor(vp.height)}px`;
  entry.rendered = key;
  entry.errorKey = '';
  entry.vp = vp;
  clearPageError(entry);

  await buildTextLayer(entry, page, vp, activeDoc, seq);
  if (doc === activeDoc) paintSearch(entry);
}

function multiply(m1, m2) {
  return [
    m1[0] * m2[0] + m1[2] * m2[1],
    m1[1] * m2[0] + m1[3] * m2[1],
    m1[0] * m2[2] + m1[2] * m2[3],
    m1[1] * m2[2] + m1[3] * m2[3],
    m1[0] * m2[4] + m1[2] * m2[5] + m1[4],
    m1[1] * m2[4] + m1[3] * m2[5] + m1[5],
  ];
}

async function buildTextLayer(entry, page, vp, activeDoc, seq) {
  let content;
  try {
    content = await page.getTextContent();
  } catch {
    return;
  }
  // A zoom or page rebuild can land while the text is loading; never write
  // old-scale spans into a page that is no longer the live one.
  if (doc !== activeDoc || seq !== entry.renderSeq || !entry.div.isConnected) return;

  entry.textItems = content.items.filter((item) => item.str && item.str.trim());
  const layer = entry.div.querySelector('.text-layer');
  layer.innerHTML = '';
  const spans = [];

  for (const item of content.items) {
    if (!item.str) continue;
    const tx = multiply(vp.transform, item.transform);
    const height = Math.hypot(tx[2], tx[3]);
    if (!(height > 0)) continue;

    const span = document.createElement('span');
    span.textContent = item.str;
    span.style.left = `${tx[4]}px`;
    span.style.top = `${tx[5] - height}px`;
    span.style.fontSize = `${height}px`;
    const angle = Math.atan2(tx[1], tx[0]);
    if (Math.abs(angle) > 0.01) span.style.transform = `rotate(${angle}rad)`;
    layer.appendChild(span);
    spans.push({ span, item, angle });
  }

  // The glyph widths are not always represented by the inherited font; scale
  // the transparent text so selection and search hit boxes match the canvas.
  for (const { span, item, angle } of spans) {
    if (Math.abs(angle) > 0.01) continue;
    const measured = span.getBoundingClientRect().width;
    const target = item.width * vp.scale;
    if (measured > 1 && target > 1) {
      const sx = target / measured;
      if (sx > 0.15 && sx < 8 && Math.abs(sx - 1) > 0.02) {
        span.style.transform = `scaleX(${sx})`;
      }
    }
  }
}

/* ----------------------------------------------------------------- search */

async function getTextItems(idx) {
  if (!doc) return [];
  const entry = doc.pageEls.get(idx);
  if (!entry) return [];
  if (entry.textItems) return entry.textItems;

  const page = await doc.pdf.getPage(idx + 1);
  const content = await page.getTextContent();
  entry.textItems = content.items.filter((item) => item.str && item.str.trim());
  return entry.textItems;
}

function paintSearch(entry) {
  if (!doc || !entry.vp) return;
  const layer = entry.div.querySelector('.search-layer');
  layer.innerHTML = '';
  if (!doc.searchHits.length) return;
  const vp = entry.vp;

  for (const hit of doc.searchHits.filter((item) => item.page === entry.index)) {
    const tx = multiply(vp.transform, hit.item.transform);
    const height = Math.hypot(tx[2], tx[3]) || 10;
    const marker = document.createElement('div');
    marker.className = doc.searchHits[doc.searchActive] === hit ? 'search-hit is-active' : 'search-hit';
    marker.style.left = `${tx[4]}px`;
    marker.style.top = `${tx[5] - height}px`;
    marker.style.width = `${hit.item.width * vp.scale}px`;
    marker.style.height = `${height * 1.18}px`;
    layer.appendChild(marker);
  }
}

function paintAllSearch() {
  if (!doc) return;
  for (const idx of doc.pageOrder) {
    const entry = doc.pageEls.get(idx);
    if (entry) paintSearch(entry);
  }
}

async function runSearch(query) {
  if (!doc) return;
  const activeDoc = doc;
  const token = (activeDoc.searchToken += 1);
  activeDoc.searchQuery = String(query || '');
  activeDoc.searchHits = [];
  activeDoc.searchActive = 0;
  const needle = activeDoc.searchQuery.trim().toLowerCase();

  if (!needle) {
    el['search-count'].textContent = '';
    el['btn-find-prev'].disabled = true;
    el['btn-find-next'].disabled = true;
    paintAllSearch();
    return;
  }

  for (const idx of activeDoc.pageOrder) {
    const items = await getTextItems(idx);
    if (doc !== activeDoc || token !== activeDoc.searchToken) return;
    for (const item of items) {
      if (item.str.toLowerCase().includes(needle)) {
        activeDoc.searchHits.push({ page: idx, item });
      }
    }
  }

  if (doc !== activeDoc) return;
  el['btn-find-prev'].disabled = !activeDoc.searchHits.length;
  el['btn-find-next'].disabled = !activeDoc.searchHits.length;
  if (!activeDoc.searchHits.length) {
    el['search-count'].textContent = '0';
    paintAllSearch();
    setMsg('No matches');
    return;
  }

  el['search-count'].textContent = `1/${activeDoc.searchHits.length}`;
  gotoHit(0);
  setMsg(`${activeDoc.searchHits.length} match${activeDoc.searchHits.length === 1 ? '' : 'es'}`);
}

function gotoHit(index) {
  if (!doc || !doc.searchHits.length) return;
  doc.searchActive = (index + doc.searchHits.length) % doc.searchHits.length;
  const hit = doc.searchHits[doc.searchActive];
  scrollToPage(hit.page);
  paintAllSearch();
  el['search-count'].textContent = `${doc.searchActive + 1}/${doc.searchHits.length}`;
}

function stepFind(delta) {
  if (!doc) return;
  if (!doc.searchHits.length) {
    if (doc.searchQuery.trim()) runSearch(doc.searchQuery).catch(() => {});
    else focusSearch();
    return;
  }
  gotoHit(doc.searchActive + delta);
}

function focusSearch() {
  if (!doc) {
    setMsg('Open a PDF to search');
    return;
  }
  el.search.focus();
  el.search.select();
}

function clearSearch() {
  if (!doc) return;
  clearTimeout(searchTimer);
  el.search.value = '';
  runSearch('').catch(() => {});
}

/* ------------------------------------------------------------- navigation */

function scrollToPage(pos) {
  if (!doc) return;
  const safe = clamp(Number(pos) || 0, 0, Math.max(0, doc.pageOrder.length - 1));
  doc.current = safe;
  el['page-input'].value = String(safe + 1);
  const entry = doc.pageEls.get(doc.pageOrder[safe]);
  if (entry) {
    entry.div.scrollIntoView({ block: 'start', inline: 'nearest', behavior: 'auto' });
  }
}

function updateCurrentPage() {
  if (!doc) return;
  const top = el.viewer.getBoundingClientRect().top;
  let best = 0;
  let bestDistance = Infinity;
  for (let pos = 0; pos < doc.pageOrder.length; pos += 1) {
    const entry = doc.pageEls.get(doc.pageOrder[pos]);
    if (!entry) continue;
    const box = entry.div.getBoundingClientRect();
    const distance = Math.abs(box.top - top - 12);
    if (box.bottom > top && distance < bestDistance) {
      bestDistance = distance;
      best = pos;
    }
  }
  doc.current = best;
  el['page-input'].value = String(best + 1);
}

function isVisible(node) {
  const box = node.getBoundingClientRect();
  const view = el.viewer.getBoundingClientRect();
  return box.bottom > view.top - 300 && box.top < view.bottom + 300;
}

function captureAnchor(pageIndex, clientX, clientY) {
  if (!doc) return null;
  const view = el.viewer.getBoundingClientRect();
  const x = clientX ?? view.left + el.viewer.clientWidth / 2;
  const y = clientY ?? view.top + el.viewer.clientHeight / 2;
  const index = pageIndex ?? doc.current;
  const entry =
    doc.pageEls.get(index) ||
    doc.pageEls.get(doc.pageOrder[clamp(index, 0, doc.pageOrder.length - 1)]) ||
    doc.pageEls.get(doc.pageOrder[0]);
  if (!entry) return null;
  const box = entry.div.getBoundingClientRect();
  return {
    page: entry.index,
    relX: clamp((x - box.left) / Math.max(1, box.width), 0, 1),
    relY: clamp((y - box.top) / Math.max(1, box.height), 0, 1),
    clientX: x,
    clientY: y,
  };
}

async function setScale(next, anchor) {
  cancelWheel();
  if (!doc) return;
  const target = clamp(next, MIN_SCALE, MAX_SCALE);
  if (Math.abs(target - doc.scale) < 0.0001) return;

  const activeDoc = doc;
  const seq = ++activeDoc.scaleSeq;
  activeDoc.scale = target;
  syncChrome();

  for (const idx of activeDoc.pageOrder) {
    const entry = activeDoc.pageEls.get(idx);
    if (!entry) continue;
    const width = Math.max(1, Math.round(entry.baseW * target));
    const height = Math.max(1, Math.round(entry.baseH * target));
    entry.rendered = '';
    entry.renderSeq += 1;
    entry.vp = null;
    if (entry.renderTask) {
      try {
        entry.renderTask.cancel();
      } catch {
        /* render already settled */
      }
      entry.renderTask = null;
    }
    // Leave `entry.chain` alone: it serialises renders for this page. The
    // cancel above rejects the in-flight render promptly, and `paintPage`
    // re-checks `renderSeq` before it blits, so the queued render for this
    // scale can never overlap or be overwritten by the cancelled one.
    entry.div.style.width = `${width}px`;
    entry.div.style.height = `${height}px`;
    const canvas = entry.div.querySelector('.page-canvas');
    if (canvas) {
      // Keep a visible page's bitmap while the replacement render is in
      // flight; offscreen pages release theirs so zooming a long book does not
      // accumulate full-resolution canvases.
      if (!isVisible(entry.div)) {
        if (canvas.width > 1) blankCanvas(canvas);
      } else if (canvas.width <= 1) {
        blankCanvas(canvas);
      }
    }
    clearPageError(entry);
    const textLayer = entry.div.querySelector('.text-layer');
    if (textLayer) textLayer.innerHTML = '';
    const searchLayer = entry.div.querySelector('.search-layer');
    if (searchLayer) searchLayer.innerHTML = '';
  }

  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (doc !== activeDoc || seq !== activeDoc.scaleSeq) return;

  if (anchor) {
    const entry = activeDoc.pageEls.get(anchor.page);
    if (entry) {
      const box = entry.div.getBoundingClientRect();
      const currentX = box.left + anchor.relX * box.width;
      const currentY = box.top + anchor.relY * box.height;
      el.viewer.scrollLeft += currentX - anchor.clientX;
      el.viewer.scrollTop += currentY - anchor.clientY;
    }
  }

  // Resize the page boxes immediately, but defer the expensive bitmap
  // refreshes until the zoom gesture has settled. The previous bitmap is
  // stretched in the meantime, which keeps zooming responsive.
  clearTimeout(scaleRenderTimer);
  scaleRenderTimer = setTimeout(() => {
    scaleRenderTimer = null;
    if (doc !== activeDoc) return;
    for (const idx of activeDoc.pageOrder) {
      const entry = activeDoc.pageEls.get(idx);
      if (entry && isVisible(entry.div)) renderPage(idx).catch(() => {});
    }
    updateCurrentPage();
  }, 160);
  updateCurrentPage();
}

function resetWheelPreview() {
  el.pages.style.transform = '';
  el.pages.style.transformOrigin = '';
  el.pages.classList.remove('is-live-zoom');
}

function cancelWheel() {
  if (!wheelZoom) return false;
  const current = wheelZoom;
  wheelZoom = null;
  clearTimeout(current.timer);
  if (current.frame) cancelAnimationFrame(current.frame);
  resetWheelPreview();
  if (doc) el['zoom-label'].textContent = `${Math.round(doc.scale * 100)}%`;
  return true;
}

function commitWheelZoom() {
  if (!wheelZoom) return;
  const current = wheelZoom;
  wheelZoom = null;
  clearTimeout(current.timer);
  if (current.frame) cancelAnimationFrame(current.frame);
  resetWheelPreview();
  if (!doc) return;

  const target = clamp(current.target, MIN_SCALE, MAX_SCALE);
  if (Math.abs(target - doc.scale) < 0.0001) {
    el['zoom-label'].textContent = `${Math.round(doc.scale * 100)}%`;
    return;
  }
  setScale(target, current.anchor).catch(() => {});
}

async function fitWidth() {
  if (!doc) return;
  cancelWheel();
  const vp = await getViewport(doc.pdf, doc.pageOrder[doc.current], 1);
  await setScale(availablePageWidth() / Math.max(1, vp.width), captureAnchor());
}

async function fitPage() {
  if (!doc) return;
  cancelWheel();
  const vp = await getViewport(doc.pdf, doc.pageOrder[doc.current], 1);
  const availableW = availablePageWidth();
  const availableH = Math.max(0, el.viewer.clientHeight - 40);
  await setScale(
    Math.min(availableW / Math.max(1, vp.width), availableH / Math.max(1, vp.height)),
    captureAnchor()
  );
}

async function actualSize() {
  if (!doc) return;
  cancelWheel();
  await setScale(1, captureAnchor());
}

function zoomBy(factor) {
  if (!doc) return;
  cancelWheel();
  setScale(doc.scale * factor, captureAnchor()).catch(() => {});
}

// Trackpad and Ctrl/Cmd-wheel zoom previews with a compositor transform, like
// the touch pinch. Resizing every page box on each wheel tick made trackpad
// zooming choppy in Chrome, so the real layout change waits until wheel idle.
function onWheel(ev) {
  if (!doc || !(ev.ctrlKey || ev.metaKey) || pinch) return;
  const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
  if (!delta) return;
  ev.preventDefault();

  if (!wheelZoom) {
    cancelWheel();
    const pagesBox = el.pages.getBoundingClientRect();
    const anchor = captureAnchor(undefined, ev.clientX, ev.clientY);
    wheelZoom = {
      startScale: doc.scale,
      target: doc.scale,
      anchor,
      timer: 0,
      frame: 0,
    };
    el.pages.style.transformOrigin = `${ev.clientX - pagesBox.left}px ${ev.clientY - pagesBox.top}px`;
    el.pages.style.transform = 'scale(1)';
    el.pages.classList.add('is-live-zoom');
  }

  const current = wheelZoom;
  current.target = clamp(
    current.target * Math.exp(-delta * 0.0015),
    MIN_SCALE,
    MAX_SCALE
  );
  el['zoom-label'].textContent = `${Math.round(current.target * 100)}%`;

  if (!current.frame) {
    current.frame = requestAnimationFrame(() => {
      if (!wheelZoom) return;
      wheelZoom.frame = 0;
      el.pages.style.transform = `scale(${wheelZoom.target / wheelZoom.startScale})`;
    });
  }

  clearTimeout(current.timer);
  current.timer = setTimeout(commitWheelZoom, 140);
}

/* --------------------------------------------------------------- pinch zoom */

function touchDistance(touches) {
  return Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY);
}

function touchMidpoint(touches) {
  return {
    x: (touches[0].clientX + touches[1].clientX) / 2,
    y: (touches[0].clientY + touches[1].clientY) / 2,
  };
}

function findTouch(touches, identifier) {
  for (const touch of touches) {
    if (touch.identifier === identifier) return touch;
  }
  return null;
}

function startPinch(ev) {
  if (!doc || pinch || ev.touches.length !== 2) return;
  const touches = [ev.touches[0], ev.touches[1]];
  const distance = touchDistance(touches);
  if (distance < 16) return;

  const midpoint = touchMidpoint(touches);
  const node = document.elementFromPoint(midpoint.x, midpoint.y);
  const pageNode = node && node.closest('.page');
  if (!pageNode) return;

  const pageIndex = Number(pageNode.dataset.idx);
  const pageEntry = doc.pageEls.get(pageIndex);
  if (!pageEntry) return;
  const pageBox = pageEntry.div.getBoundingClientRect();
  const pagesBox = el.pages.getBoundingClientRect();
  if (pageBox.width < 1 || pageBox.height < 1) return;

  ev.preventDefault();
  ev.stopPropagation();
  cancelWheel();
  pinch = {
    touchA: touches[0].identifier,
    touchB: touches[1].identifier,
    startScale: doc.scale,
    startDistance: distance,
    startMidpoint: midpoint,
    pagesLeft: pagesBox.left,
    pagesTop: pagesBox.top,
    contentX: midpoint.x - pagesBox.left,
    contentY: midpoint.y - pagesBox.top,
    page: pageIndex,
    relX: clamp((midpoint.x - pageBox.left) / pageBox.width, 0, 1),
    relY: clamp((midpoint.y - pageBox.top) / pageBox.height, 0, 1),
    targetScale: doc.scale,
    finalMidpoint: midpoint,
    pending: null,
    frame: 0,
  };

  el.pages.style.transformOrigin = '0 0';
  el.pages.classList.add('is-live-zoom');
  document.body.classList.add('is-pinching');
}

function renderPinchFrame() {
  if (!pinch || !doc) return;
  pinch.frame = 0;
  const point = pinch.pending || {
    midpoint: pinch.finalMidpoint,
    distance: pinch.startDistance,
  };
  const target = clamp(
    pinch.startScale * (point.distance / Math.max(1, pinch.startDistance)),
    MIN_SCALE,
    MAX_SCALE
  );
  const ratio = target / pinch.startScale;
  const tx = point.midpoint.x - pinch.pagesLeft - pinch.contentX * ratio;
  const ty = point.midpoint.y - pinch.pagesTop - pinch.contentY * ratio;
  pinch.targetScale = target;
  pinch.finalMidpoint = point.midpoint;
  el.pages.style.transform = `translate3d(${tx}px, ${ty}px, 0) scale(${ratio})`;
  el['zoom-label'].textContent = `${Math.round(target * 100)}%`;
}

function movePinch(ev) {
  if (!pinch || ev.touches.length < 2) return;
  const a = findTouch(ev.touches, pinch.touchA);
  const b = findTouch(ev.touches, pinch.touchB);
  if (!a || !b) return;
  ev.preventDefault();
  const touches = [a, b];
  pinch.pending = {
    midpoint: touchMidpoint(touches),
    distance: touchDistance(touches),
  };
  if (!pinch.frame) pinch.frame = requestAnimationFrame(renderPinchFrame);
}

function finishPinch(cancelled = false) {
  if (!pinch) return;
  const gesture = pinch;
  pinch = null;
  if (gesture.frame) cancelAnimationFrame(gesture.frame);
  if (gesture.pending) {
    gesture.targetScale = clamp(
      gesture.startScale * (gesture.pending.distance / Math.max(1, gesture.startDistance)),
      MIN_SCALE,
      MAX_SCALE
    );
    gesture.finalMidpoint = gesture.pending.midpoint;
  }

  el.pages.style.transform = '';
  el.pages.style.transformOrigin = '';
  el.pages.classList.remove('is-live-zoom');
  document.body.classList.remove('is-pinching');

  if (cancelled || !doc) {
    el['zoom-label'].textContent = `${Math.round((doc?.scale || gesture.startScale) * 100)}%`;
    return;
  }

  suppressClickUntil = performance.now() + 450;
  const target = gesture.targetScale;
  const finalMidpoint = gesture.finalMidpoint;

  if (Math.abs(target - doc.scale) < 0.0001) {
    const entry = doc.pageEls.get(gesture.page);
    if (entry) {
      const box = entry.div.getBoundingClientRect();
      const currentX = box.left + gesture.relX * box.width;
      const currentY = box.top + gesture.relY * box.height;
      el.viewer.scrollLeft += currentX - finalMidpoint.x;
      el.viewer.scrollTop += currentY - finalMidpoint.y;
    }
    el['zoom-label'].textContent = `${Math.round(doc.scale * 100)}%`;
    return;
  }

  setScale(target, {
    page: gesture.page,
    relX: gesture.relX,
    relY: gesture.relY,
    clientX: finalMidpoint.x,
    clientY: finalMidpoint.y,
  }).catch(() => {});
}

function onTouchStart(ev) {
  if (ev.touches.length !== 2) return;
  startPinch(ev);
}

function onTouchMove(ev) {
  if (!pinch) return;
  movePinch(ev);
}

function onTouchEnd(ev) {
  if (!pinch) return;
  if (ev.touches.length >= 2) return;
  ev.preventDefault();
  finishPinch(false);
}

function onTouchCancel() {
  if (pinch) finishPinch(true);
}

/* --------------------------------------------------------------- printing */

function cleanupPrint() {
  el['print-root'].innerHTML = '';
  for (const url of printUrls) URL.revokeObjectURL(url);
  printUrls = [];
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('Could not build the print preview'));
    image.src = url;
  });
}

function canvasBlob(canvas) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('Could not encode a print page'));
    }, 'image/png');
  });
}

async function printDocument() {
  if (!doc || printBusy) return;
  printBusy = true;
  const activeDoc = doc;
  el['btn-print'].disabled = true;
  setMsg('Preparing print pages…');
  cleanupPrint();

  try {
    for (let idx = 0; idx < activeDoc.pageOrder.length; idx += 1) {
      const page = await activeDoc.pdf.getPage(idx + 1);
      const base = page.getViewport({ scale: PRINT_DPI / 72, rotation: page.rotate });
      const budget = Math.min(
        1,
        Math.sqrt(MAX_PRINT_PIXELS / Math.max(1, base.width * base.height))
      );
      const vp =
        budget < 1
          ? page.getViewport({ scale: (PRINT_DPI / 72) * budget, rotation: page.rotate })
          : base;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const context = canvas.getContext('2d', { alpha: false });
      context.fillStyle = '#ffffff';
      context.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: context, canvas, viewport: vp }).promise;

      const blob = await canvasBlob(canvas);
      const url = URL.createObjectURL(blob);
      printUrls.push(url);
      const image = await loadImage(url);
      const holder = document.createElement('div');
      holder.className = 'print-page';
      holder.appendChild(image);
      el['print-root'].appendChild(holder);
      if (idx % 4 === 3) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
    }

    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    setMsg('Opening print dialog…');
    window.print();
  } catch (error) {
    setMsg(`Could not print: ${error.message || error}`);
  } finally {
    printBusy = false;
    if (doc) el['btn-print'].disabled = false;
    cleanupPrint();
    if (doc) setMsg('Ready');
  }
}

/* ------------------------------------------------------------------ print */

function downloadPdf() {
  if (!doc) return;
  const url = URL.createObjectURL(new Blob([doc.bytes], { type: 'application/pdf' }));
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = doc.name;
  anchor.style.display = 'none';
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
  setMsg('Downloaded');
}

/* ------------------------------------------------------------- input setup */

function isEditingTarget(target) {
  return Boolean(
    target instanceof HTMLElement &&
      (target.matches('input, textarea, select') || target.isContentEditable)
  );
}

async function loadFromTransfer(transferId, fallbackName) {
  if (!globalThis.chrome?.storage?.local) {
    throw new Error('Open this link from the installed OmniPDF Chrome extension');
  }
  const key = `pending:${transferId}`;
  const stored = await chrome.storage.local.get(key);
  const payload = stored[key];
  if (payload) await chrome.storage.local.remove(key);
  if (!payload?.data) {
    throw new Error('The Gmail attachment expired. Open it from Gmail again.');
  }
  const bytes = base64ToBytes(payload.data);
  await openBytes(bytes, cleanName(payload.name || fallbackName), payload.sourceUrl || '');
}

async function loadFromUrl(url, fallbackName) {
  const response = await fetch(url, {
    credentials: 'include',
    cache: 'no-store',
    redirect: 'follow',
  });
  if (!response.ok) throw new Error(`The PDF server returned HTTP ${response.status}`);
  const blob = await response.blob();
  if (blob.size > MAX_FILE_BYTES) throw new Error('This PDF is too large for the Chrome viewer');
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (!looksLikePdf(bytes)) {
    throw new Error('That link did not return a PDF. Download the attachment and drop it here.');
  }
  const name =
    fallbackName || filenameFromDisposition(response.headers.get('content-disposition')) || 'document.pdf';
  await openBytes(bytes, cleanName(name), url);
}

function bindUi() {
  el['btn-open'].addEventListener('click', () => el['file-input'].click());
  el['empty-open'].addEventListener('click', () => el['file-input'].click());
  el['empty-gmail'].addEventListener('click', () => {
    window.open('https://mail.google.com/', '_blank', 'noopener');
  });
  el['file-input'].addEventListener('change', () => {
    const file = el['file-input'].files?.[0];
    el['file-input'].value = '';
    if (file) openFile(file);
  });

  el['btn-download'].addEventListener('click', downloadPdf);
  el['btn-print'].addEventListener('click', () => {
    printDocument().catch(() => {});
  });
  el['btn-prev'].addEventListener('click', () => scrollToPage(doc ? doc.current - 1 : 0));
  el['btn-next'].addEventListener('click', () => scrollToPage(doc ? doc.current + 1 : 0));
  el['page-input'].addEventListener('change', () => {
    if (!doc) return;
    const value = Number(el['page-input'].value);
    scrollToPage((Number.isFinite(value) ? value : 1) - 1);
  });
  el['btn-zoom-out'].addEventListener('click', () => zoomBy(1 / 1.2));
  el['btn-zoom-in'].addEventListener('click', () => zoomBy(1.2));
  el['btn-fit'].addEventListener('click', () => fitWidth().catch(() => {}));
  el['btn-fit-page'].addEventListener('click', () => fitPage().catch(() => {}));
  el['btn-actual'].addEventListener('click', () => actualSize().catch(() => {}));

  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(el.search.value).catch(() => {}), 180);
  });
  el['btn-find-prev'].addEventListener('click', () => stepFind(-1));
  el['btn-find-next'].addEventListener('click', () => stepFind(1));

  el.viewer.addEventListener(
    'scroll',
    () => {
      if (scrollFrame) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = 0;
        updateCurrentPage();
      });
    },
    { passive: true }
  );
  el.viewer.addEventListener('wheel', onWheel, { passive: false });
  el.viewer.addEventListener('touchstart', onTouchStart, { passive: false });
  el.viewer.addEventListener('touchmove', onTouchMove, { passive: false });
  el.viewer.addEventListener('touchend', onTouchEnd, { passive: false });
  el.viewer.addEventListener('touchcancel', onTouchCancel, { passive: true });
  el.viewer.addEventListener(
    'click',
    (event) => {
      if (performance.now() < suppressClickUntil) {
        event.preventDefault();
        event.stopPropagation();
        suppressClickUntil = 0;
      }
    },
    true
  );

  document.addEventListener('dragover', (event) => {
    if (Array.from(event.dataTransfer?.types || []).includes('Files')) {
      event.preventDefault();
    }
  });
  document.addEventListener('drop', (event) => {
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    event.preventDefault();
    if (file.type !== 'application/pdf' && !/\.pdf$/i.test(file.name)) {
      setMsg('Only PDF files can be opened');
      return;
    }
    openFile(file);
  });

  window.addEventListener('afterprint', cleanupPrint);
  document.addEventListener('keydown', (event) => {
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    if (mod && key.toLowerCase() === 'o') {
      event.preventDefault();
      el['file-input'].click();
    } else if (mod && key.toLowerCase() === 'f') {
      event.preventDefault();
      focusSearch();
    } else if (mod && key.toLowerCase() === 's') {
      event.preventDefault();
      downloadPdf();
    } else if (mod && key.toLowerCase() === 'p') {
      event.preventDefault();
      if (doc) printDocument().catch(() => {});
    } else if (mod && (key === '=' || key === '+')) {
      event.preventDefault();
      zoomBy(1.2);
    } else if (mod && key === '-') {
      event.preventDefault();
      zoomBy(1 / 1.2);
    } else if (mod && key === '0') {
      event.preventDefault();
      if (doc) fitWidth().catch(() => {});
    } else if (mod && key === '1') {
      event.preventDefault();
      if (doc) actualSize().catch(() => {});
    } else if (mod && key === '2') {
      event.preventDefault();
      if (doc) fitPage().catch(() => {});
    } else if (mod && key.toLowerCase() === 'g') {
      event.preventDefault();
      if (doc) {
        el['page-input'].focus();
        el['page-input'].select();
      }
    } else if (key === 'F3') {
      event.preventDefault();
      stepFind(event.shiftKey ? -1 : 1);
    } else if (key === 'PageDown' && !isEditingTarget(event.target) && doc) {
      event.preventDefault();
      scrollToPage(doc.current + 1);
    } else if (key === 'PageUp' && !isEditingTarget(event.target) && doc) {
      event.preventDefault();
      scrollToPage(doc.current - 1);
    } else if (key === 'Home' && mod && doc) {
      event.preventDefault();
      scrollToPage(0);
    } else if (key === 'End' && mod && doc) {
      event.preventDefault();
      scrollToPage(doc.pageOrder.length - 1);
    } else if (key === 'Escape' && document.activeElement === el.search) {
      event.preventDefault();
      clearSearch();
    }
  });
}

/* ------------------------------------------------- text-layer smoke test */

// Focused smoke hook used by `npm run smoke`. It holds one page's text request
// open while the page list is rebuilt, then lets the stale request resolve and
// checks that the rebuilt page's layer and text item cache were left alone.
window.__smokeTextLayer = async (base64) => {
  try {
    await openBytes(base64ToBytes(base64), 'fixture.pdf');
    const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const staleEntry = doc.pageEls.get(0);
    for (let i = 0; i < 100 && !staleEntry.textItems; i += 1) await settle(50);

    const page = await doc.pdf.getPage(1);
    const realGetTextContent = page.getTextContent.bind(page);
    let releaseStale;
    const staleGate = new Promise((resolve) => {
      releaseStale = resolve;
    });
    let textRequests = 0;
    page.getTextContent = async () => {
      textRequests += 1;
      if (textRequests === 1) {
        await staleGate;
        return {
          items: [
            {
              str: 'STALE TEXT LAYER',
              transform: [1, 0, 0, 1, 8, 18],
              width: 60,
              height: 10,
              dir: 'ltr',
              fontName: 'g_d0_f1',
            },
          ],
        };
      }
      return realGetTextContent();
    };

    staleEntry.rendered = '';
    const staleRender = renderPage(0);
    for (let i = 0; i < 400 && textRequests === 0; i += 1) await settle(10);
    const textRequestPending = textRequests > 0;

    // Rebuild the page list while the stale text request is still pending, and
    // let the new page render its own layer before the old request resolves.
    loadToken += 1;
    await buildPages(loadToken);
    const liveEntry = doc.pageEls.get(0);
    await renderPage(0);
    for (
      let i = 0;
      i < 100 &&
      (!liveEntry.textItems || !liveEntry.div.querySelector('.text-layer').children.length);
      i += 1
    ) {
      await settle(50);
    }
    const liveLayer = liveEntry.div.querySelector('.text-layer');
    const liveHtml = liveLayer.innerHTML;
    const liveItems = liveEntry.textItems;

    releaseStale();
    await staleRender;
    await settle(100);

    const layerIntact = liveLayer.innerHTML === liveHtml;
    const cacheIntact = liveEntry.textItems === liveItems;
    const liveLeak =
      liveLayer.textContent.includes('STALE TEXT LAYER') ||
      (liveItems || []).some((item) => String(item.str).includes('STALE'));
    const staleLeak = staleEntry.div.textContent.includes('STALE TEXT LAYER');

    return {
      ok:
        textRequestPending &&
        Boolean(liveItems) &&
        liveItems.length > 0 &&
        !staleEntry.div.isConnected &&
        layerIntact &&
        cacheIntact &&
        !liveLeak &&
        !staleLeak,
      textRequestPending,
      staleEntryDetached: !staleEntry.div.isConnected,
      liveItems: liveItems ? liveItems.length : 0,
      liveSpans: liveLayer.children.length,
      layerIntact,
      cacheIntact,
      staleLeak: liveLeak || staleLeak,
    };
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error) };
  }
};

async function boot() {
  bindUi();
  syncChrome();
  const params = new URLSearchParams(location.search);
  const transfer = params.get('transfer');
  const source = params.get('src');
  const name = params.get('name') || '';

  if (transfer) {
    try {
      await loadFromTransfer(transfer, name);
    } catch (error) {
      const message = String(error.message || error);
      reportDiagnostic('transfer', message, { name });
      showEmpty(
        'Could not open attachment',
        message,
        'Open the attachment from Gmail again, or download it and drop it here.'
      );
    }
    return;
  }

  if (source) {
    setMsg('Loading attachment…');
    try {
      await loadFromUrl(source, name);
    } catch (error) {
      const message = String(error.message || error);
      reportDiagnostic('load', message, { name, url: source });
      showEmpty(
        'Could not open attachment',
        message,
        'Download the PDF from Gmail and drop it here if the attachment link cannot be fetched directly.',
        source
      );
    }
    return;
  }

  showEmpty(
    'Open a PDF',
    'Drop a PDF anywhere in this window, or choose one below.',
    'Pinch with two fingers to zoom. Gmail attachments can be opened without downloading first.'
  );
}

boot().catch((error) => {
  const message = String(error.message || error);
  reportDiagnostic('start', message);
  showEmpty('Could not start viewer', message, 'Reload this tab and try again.');
});
