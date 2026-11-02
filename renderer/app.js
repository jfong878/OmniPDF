import * as pdfjsLib from '/vendor/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.mjs';

const CMAP_URL = '/vendor/cmaps/';
const STANDARD_FONTS = '/vendor/standard_fonts/';
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const BUILD_TAG = 'build-2';

const IDS = [
  'btn-open', 'btn-save', 'btn-saveas', 'btn-prev', 'btn-next', 'page-input', 'page-total',
  'btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'zoom-label', 'pages', 'viewer', 'thumbs', 'search',
  'search-count', 'status-file', 'status-msg', 'btn-rotate', 'btn-delete-page', 'btn-extract',
  'btn-ocr', 'btn-sign', 'dlg-sign', 'sign-name', 'sign-reason', 'sign-location', 'dlg-ocr',
  'ocr-scope', 'ocr-lang', 'dlg-text', 'text-value', 'dlg-cert', 'cert-body',
];

const el = {};
for (const id of IDS) el[id] = document.getElementById(id);

const state = {
  bytes: null,
  filePath: null,
  fileName: null,
  pdf: null,
  pageOrder: [],
  originalCount: 0,
  rotations: {},
  annotations: [],
  formValues: {},
  pageEls: new Map(),
  thumbEls: new Map(),
  textItems: new Map(),
  searchHits: [],
  searchActive: 0,
  scale: 1.15,
  tool: 'select',
  current: 0,
  dirty: false,
  nextId: 1,
  signMode: false,
  drag: null,
  io: null,
};

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hasDoc = () => Boolean(state.pdf);

function setMsg(message) {
  el['status-msg'].textContent = message || '';
}

function setDirty(value) {
  state.dirty = value;
  updateTitle();
}

function updateTitle() {
  const name = state.fileName || 'Untitled';
  document.title = `${state.dirty ? '• ' : ''}${name} — OmniPDF`;
  el['status-file'].textContent = state.filePath || (hasDoc() ? name : 'No document');
}

/* ------------------------------------------------------------- viewports */

async function getViewport(idx, scale = state.scale) {
  const page = await state.pdf.getPage(idx + 1);
  const rotation = (((page.rotate + (state.rotations[idx] || 0)) % 360) + 360) % 360;
  return page.getViewport({ scale, rotation });
}

/* ------------------------------------------------------------ open/reload */

async function openBytes(bytes, name, filePath) {
  setMsg('Loading…');
  const doc = await pdfjsLib.getDocument({
    data: bytes.slice(),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS,
    isEvalSupported: false,
    useSystemFonts: true,
  }).promise;

  if (state.pdf) {
    try {
      await state.pdf.destroy();
    } catch {
      /* ignore */
    }
  }

  state.pdf = doc;
  state.bytes = bytes;
  state.fileName = name;
  state.filePath = filePath || null;
  state.pageOrder = Array.from({ length: doc.numPages }, (_, i) => i);
  state.originalCount = doc.numPages;
  state.rotations = {};
  state.annotations = [];
  state.formValues = {};
  state.searchHits = [];
  state.searchActive = 0;
  state.current = 0;
  state.nextId = 1;
  state.signMode = false;
  state.pageEls.clear();
  state.thumbEls.clear();
  state.textItems.clear();

  document.body.classList.add('has-document');
  el['page-total'].textContent = `/ ${doc.numPages}`;
  el['page-input'].max = String(doc.numPages);
  el['page-input'].value = '1';
  el['search-count'].textContent = '';
  el.search.value = '';
  setDirty(false);

  await buildPages();
  updateTitle();
  setMsg(`${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
}

async function buildPages() {
  el.pages.innerHTML = '';
  el.thumbs.innerHTML = '';

  for (let pos = 0; pos < state.pageOrder.length; pos += 1) {
    const idx = state.pageOrder[pos];
    const vp = await getViewport(idx);

    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.idx = String(idx);
    div.style.width = `${Math.floor(vp.width)}px`;
    div.style.height = `${Math.floor(vp.height)}px`;
    div.innerHTML =
      '<canvas class="page-canvas"></canvas><div class="text-layer"></div>' +
      '<div class="search-layer"></div><canvas class="anno-layer"></canvas><div class="form-layer"></div>';

    const overlay = div.querySelector('.anno-layer');
    overlay.addEventListener('pointerdown', (ev) => onOverlayDown(ev, idx));

    el.pages.appendChild(div);
    state.pageEls.set(idx, { div, vp, rendered: '', renderSeq: 0, widgets: [] });
    state.io.observe(div);

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.innerHTML = `<canvas></canvas><span class="thumb-label">${pos + 1}</span>`;
    thumb.addEventListener('click', () => scrollToPage(pos));
    el.thumbs.appendChild(thumb);
    state.thumbEls.set(idx, thumb);
  }

  // Thumbnails render after the first pages so opening feels immediate.
  setTimeout(() => {
    renderThumbs().catch(() => {});
  }, 60);
}

async function renderThumbs() {
  for (const idx of state.pageOrder) {
    const thumb = state.thumbEls.get(idx);
    if (!thumb || thumb.dataset.done === '1') continue;
    try {
      const page = await state.pdf.getPage(idx + 1);
      const base = page.getViewport({ scale: 1 });
      const rotation = (((page.rotate + (state.rotations[idx] || 0)) % 360) + 360) % 360;
      const scale = 146 / Math.max(base.width, 1);
      const vp = page.getViewport({ scale, rotation });
      const canvas = thumb.querySelector('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      await page.render({ canvasContext: canvas.getContext('2d'), canvas, viewport: vp }).promise;
      thumb.dataset.done = '1';
    } catch {
      /* non-fatal */
    }
  }
}

/* ----------------------------------------------------------------- render */

// Renders are serialised per page. pdf.js cancels an in-flight render when a
// second one starts on the same canvas, which previously let a caller await a
// render that returned early without building the text/widget layers.
function renderPage(idx) {
  const entry = state.pageEls.get(idx);
  if (!entry || !state.pdf) return Promise.resolve();
  entry.chain = (entry.chain || Promise.resolve())
    .then(() => doRenderPage(idx))
    .catch(() => {});
  return entry.chain;
}

async function doRenderPage(idx) {
  const entry = state.pageEls.get(idx);
  if (!entry || !state.pdf) return;

  const page = await state.pdf.getPage(idx + 1);
  const rotation = (((page.rotate + (state.rotations[idx] || 0)) % 360) + 360) % 360;
  const vp = page.getViewport({ scale: state.scale, rotation });
  const key = `${state.scale}|${rotation}`;

  // A blank `rendered` marks the page stale; the key check skips redundant work.
  if (entry.rendered === key) {
    await layoutPage(idx);
    return;
  }

  entry.renderSeq += 1;
  const seq = entry.renderSeq;

  const canvas = entry.div.querySelector('.page-canvas');
  const scaled = page.getViewport({ scale: state.scale * DPR, rotation });
  canvas.width = Math.max(1, Math.floor(scaled.width));
  canvas.height = Math.max(1, Math.floor(scaled.height));

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    await page.render({ canvasContext: ctx, canvas, viewport: scaled }).promise;
  } catch {
    return;
  }
  // A superseded render must not skip the layer build below: the newer call
  // may have been the one that returned early.
  if (seq === entry.renderSeq) {
    entry.div.style.width = `${Math.floor(vp.width)}px`;
    entry.div.style.height = `${Math.floor(vp.height)}px`;
    entry.rendered = key;
  }
  entry.vp = vp;

  await buildTextLayer(idx, page, vp);
  await buildWidgets(idx, page, vp);
  await layoutPage(idx);
}

async function buildTextLayer(idx, page, vp) {
  const entry = state.pageEls.get(idx);
  if (!entry) return;

  let content;
  try {
    content = await page.getTextContent();
  } catch {
    return;
  }

  state.textItems.set(idx, content.items.filter((i) => i.str && i.str.trim()));

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

  // Horizontal scale correction makes selection track the glyphs.
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

async function buildWidgets(idx, page, vp) {
  const entry = state.pageEls.get(idx);
  if (!entry || entry.widgetsBuilt) return;
  const layer = entry.div.querySelector('.form-layer');
  layer.innerHTML = '';
  entry.widgets = [];

  let annotations;
  try {
    annotations = await page.getAnnotations({ intent: 'display' });
  } catch (err) {
    entry.widgetError = String((err && err.message) || err);
    return;
  }

  entry.widgetDiag = annotations.map((a) => ({
    subtype: a.subtype,
    fieldType: a.fieldType || null,
    fieldName: a.fieldName || null,
    rectLen: a.rect ? a.rect.length : 0,
  }));

  for (const ann of annotations) {
    if (ann.subtype !== 'Widget' || !ann.fieldName) continue;
    // pdf.js does not always populate fieldType; fall back to structural hints.
    const fieldType =
      ann.fieldType ||
      (ann.checkBox || ann.radioButton ? 'Btn' : Array.isArray(ann.options) ? 'Ch' : 'Tx');
    let input = null;

    if (fieldType === 'Tx') {
      input = document.createElement(ann.multiLine ? 'textarea' : 'input');
      if (!ann.multiLine) input.type = 'text';
      input.value = typeof ann.fieldValue === 'string' ? ann.fieldValue : '';
    } else if (fieldType === 'Btn' && ann.checkBox) {
      input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = Boolean(ann.fieldValue) && ann.fieldValue !== 'Off';
    } else if (fieldType === 'Btn' && ann.radioButton) {
      input = document.createElement('input');
      input.type = 'radio';
      input.name = `rg-${ann.fieldName}`;
      input.value = ann.buttonValue || 'On';
      input.checked = ann.fieldValue === input.value;
    } else if (fieldType === 'Ch') {
      input = document.createElement('select');
      const options = Array.isArray(ann.options) ? ann.options : [];
      for (const opt of options) {
        const o = document.createElement('option');
        const value = opt.exportValue ?? opt.displayValue ?? String(opt);
        o.value = value;
        o.textContent = opt.displayValue ?? value;
        input.appendChild(o);
      }
      if (typeof ann.fieldValue === 'string') input.value = ann.fieldValue;
    } else if (fieldType === 'Sig') {
      input = document.createElement('button');
      input.type = 'button';
      input.textContent = 'Sign here';
      input.className = 'form-widget';
    }

    if (!input) continue;
    input.classList.add('form-widget');
    if (ann.readOnly) {
      input.disabled = true;
      input.title = 'Read-only field';
    }

    const name = ann.fieldName;
    const commit = () => {
      if (input.type === 'checkbox') state.formValues[name] = input.checked ? 'true' : 'false';
      else if (input.type === 'radio') {
        if (input.checked) state.formValues[name] = input.value;
      } else state.formValues[name] = input.value;
      setDirty(true);
    };
    input.addEventListener('input', commit);
    input.addEventListener('change', commit);
    if (fieldType === 'Sig') {
      input.addEventListener('click', () => beginSign());
    }

    layer.appendChild(input);
    entry.widgets.push({ ann, input });
  }
  // Widgets are created once and repositioned on layout, so a concurrent or
  // repeated render cannot wipe an already-populated form layer.
  entry.widgetsBuilt = true;
}

/* ----------------------------------------------------------------- layout */

// PageViewport lost its conversion helpers in pdf.js v6, so the affine
// transform is applied directly: [a,b,c,d,e,f] maps user space to CSS pixels.
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

function toViewport(vp, x, y) {
  const m = vp.transform;
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
}

function toUser(vp, px, py) {
  const m = vp.transform;
  const det = m[0] * m[3] - m[1] * m[2] || 1;
  const dx = px - m[4];
  const dy = py - m[5];
  return [(m[3] * dx - m[2] * dy) / det, (-m[1] * dx + m[0] * dy) / det];
}

function viewportRect(vp, rect) {
  const [x1, y1] = toViewport(vp, rect.x, rect.y);
  const [x2, y2] = toViewport(vp, rect.x + rect.w, rect.y + rect.h);
  return {
    x: Math.min(x1, x2),
    y: Math.min(y1, y2),
    w: Math.abs(x2 - x1),
    h: Math.abs(y2 - y1),
  };
}

async function layoutPage(idx) {
  const entry = state.pageEls.get(idx);
  if (!entry) return;

  if (!entry.vp) entry.vp = await getViewport(idx);
  const vp = entry.vp;
  const width = parseFloat(entry.div.style.width) || vp.width;
  const height = parseFloat(entry.div.style.height) || vp.height;

  const overlay = entry.div.querySelector('.anno-layer');
  overlay.width = Math.max(1, Math.floor(width * DPR));
  overlay.height = Math.max(1, Math.floor(height * DPR));
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlay.classList.toggle('is-active', state.tool !== 'select' || state.signMode);

  for (const { ann, input } of entry.widgets) {
    if (!ann.rect || !ann.rect.length) continue;
    const r = viewportRect(vp, {
      x: ann.rect[0],
      y: ann.rect[1],
      w: ann.rect[2] - ann.rect[0],
      h: ann.rect[3] - ann.rect[1],
    });
    input.style.left = `${r.x}px`;
    input.style.top = `${r.y}px`;
    input.style.width = `${Math.max(r.w, 8)}px`;
    input.style.height = `${Math.max(r.h, 8)}px`;
  }

  paintAnnotations(idx);
  paintSearch(idx);
}

function paintAnnotations(idx) {
  const entry = state.pageEls.get(idx);
  if (!entry) return;
  const canvas = entry.div.querySelector('.anno-layer');
  const ctx = canvas.getContext('2d');
  const width = parseFloat(entry.div.style.width) || 0;
  const height = parseFloat(entry.div.style.height) || 0;
  ctx.setTransform(DPR, 0, 0, DPR, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const vp = entry.vp;
  if (!vp) return;

  const items = state.annotations.filter((a) => a.page === idx);
  if (state.drag && state.drag.page === idx) items.push(state.drag.preview);

  for (const ann of items) {
    if (ann.type === 'ink') {
      const pts = ann.points || [];
      if (pts.length < 2) continue;
      ctx.strokeStyle = ann.color || '#e0453e';
      ctx.lineWidth = ann.width || 2;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      for (let i = 0; i < pts.length; i += 1) {
        const p = toViewport(vp, pts[i][0], pts[i][1]);
        if (i === 0) ctx.moveTo(p[0], p[1]);
        else ctx.lineTo(p[0], p[1]);
      }
      ctx.stroke();
      continue;
    }

    const r = viewportRect(vp, ann.rect);
    if (ann.type === 'highlight') {
      ctx.fillStyle = hexToRgba(ann.color || '#ffd400', ann.opacity ?? 0.35);
      ctx.fillRect(r.x, r.y, r.w, r.h);
    } else if (ann.type === 'box') {
      ctx.strokeStyle = ann.color || '#4d8dff';
      ctx.lineWidth = ann.width || 1.5;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
    } else if (ann.type === 'text') {
      ctx.fillStyle = 'rgba(255,255,255,0.94)';
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.strokeStyle = ann.color || '#ffd400';
      ctx.lineWidth = 1;
      ctx.strokeRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = '#101319';
      ctx.font = `${ann.fontSize || 12}px sans-serif`;
      ctx.fillText(ann.text || '', r.x + 4, r.y + (ann.fontSize || 12) + 2);
    }
  }
}

function paintSearch(idx) {
  const entry = state.pageEls.get(idx);
  if (!entry || !entry.vp) return;
  const layer = entry.div.querySelector('.search-layer');
  layer.innerHTML = '';
  if (!state.searchHits.length) return;
  const vp = entry.vp;
  for (const hit of state.searchHits.filter((h) => h.page === idx)) {
    const tx = multiply(vp.transform, hit.item.transform);
    const height = Math.hypot(tx[2], tx[3]) || 10;
    const div = document.createElement('div');
    const active = state.searchHits[state.searchActive] === hit;
    div.className = active ? 'search-hit is-active' : 'search-hit';
    div.style.left = `${tx[4]}px`;
    div.style.top = `${tx[5] - height}px`;
    div.style.width = `${hit.item.width * vp.scale}px`;
    div.style.height = `${height * 1.18}px`;
    layer.appendChild(div);
  }
}

function hexToRgba(hex, alpha) {
  const m = /^#?([0-9a-f]{6})$/i.exec(String(hex).trim());
  if (!m) return `rgba(255,212,0,${alpha})`;
  const int = parseInt(m[1], 16);
  return `rgba(${(int >> 16) & 255},${(int >> 8) & 255},${int & 255},${alpha})`;
}

/* -------------------------------------------------------------- pointer io */

function localPoint(ev, div) {
  const box = div.querySelector('.anno-layer').getBoundingClientRect();
  return [ev.clientX - box.left, ev.clientY - box.top];
}

function pointerToUser(ev, idx) {
  const entry = state.pageEls.get(idx);
  if (!entry || !entry.vp) return null;
  const [px, py] = localPoint(ev, entry.div);
  const [ux, uy] = toUser(entry.vp, px, py);
  return { px, py, ux, uy, vp: entry.vp };
}

function onOverlayDown(ev, idx) {
  if (!hasDoc() || ev.button !== 0) return;
  const point = pointerToUser(ev, idx);
  if (!point) return;

  if (state.signMode) {
    placeSignature(ev, idx).catch((err) => setMsg(String(err.message || err)));
    return;
  }
  if (state.tool === 'select') return;

  ev.preventDefault();
  ev.target.setPointerCapture(ev.pointerId);

  if (state.tool === 'erase') {
    eraseAt(idx, point.px, point.py);
    return;
  }

  if (state.tool === 'ink') {
    state.drag = {
      page: idx,
      points: [[point.ux, point.uy]],
      preview: { page: idx, type: 'ink', color: '#e0453e', width: 2, points: [[point.ux, point.uy]] },
    };
  } else {
    state.drag = {
      page: idx,
      start: [point.ux, point.uy],
      preview: {
        page: idx,
        type: state.tool === 'box' ? 'box' : 'highlight',
        color: state.tool === 'box' ? '#4d8dff' : '#ffd400',
        width: 1.5,
        opacity: 0.35,
        rect: { x: point.ux, y: point.uy, w: 0, h: 0 },
      },
    };
  }

  const move = (e) => onOverlayMove(e, idx);
  const up = (e) => {
    ev.target.removeEventListener('pointermove', move);
    ev.target.removeEventListener('pointerup', up);
    onOverlayUp(e, idx);
  };
  ev.target.addEventListener('pointermove', move);
  ev.target.addEventListener('pointerup', up);
}

function onOverlayMove(ev, idx) {
  if (!state.drag) return;
  const point = pointerToUser(ev, idx);
  if (!point) return;

  if (state.drag.preview.type === 'ink') {
    state.drag.preview.points.push([point.ux, point.uy]);
  } else {
    const [sx, sy] = state.drag.start;
    state.drag.preview.rect = {
      x: Math.min(sx, point.ux),
      y: Math.min(sy, point.uy),
      w: Math.abs(point.ux - sx),
      h: Math.abs(point.uy - sy),
    };
  }
  paintAnnotations(idx);
}

async function onOverlayUp(ev, idx) {
  const drag = state.drag;
  state.drag = null;
  if (!drag) return;

  if (drag.preview.type === 'ink') {
    if (drag.preview.points.length > 2) {
      addAnnotation({ ...drag.preview, id: state.nextId++, page: idx });
    }
    paintAnnotations(idx);
    return;
  }

  const rect = drag.preview.rect;
  if (rect.w < 3 || rect.h < 3) {
    setMsg('Drag a larger area');
    paintAnnotations(idx);
    return;
  }

  if (state.tool === 'text') {
    const text = await askText('');
    if (text) {
      addAnnotation({
        id: state.nextId++,
        page: idx,
        type: 'text',
        color: '#ffd400',
        rect,
        text,
        fontSize: 12,
      });
    }
  } else {
    addAnnotation({
      id: state.nextId++,
      page: idx,
      type: drag.preview.type,
      color: drag.preview.color,
      opacity: drag.preview.opacity,
      width: drag.preview.width,
      rect,
    });
  }
  paintAnnotations(idx);
}

function addAnnotation(ann) {
  state.annotations.push(ann);
  setDirty(true);
}

function eraseAt(idx, px, py) {
  const entry = state.pageEls.get(idx);
  if (!entry || !entry.vp) return;
  const vp = entry.vp;
  const candidates = state.annotations.filter((a) => a.page === idx);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const ann = candidates[i];
    if (ann.type === 'ink') {
      const hit = (ann.points || []).some(([x, y]) => {
        const p = toViewport(vp, x, y);
        return Math.hypot(p[0] - px, p[1] - py) < 9;
      });
      if (hit) {
        removeAnnotation(ann.id);
        return;
      }
      continue;
    }
    const r = viewportRect(vp, ann.rect);
    if (px >= r.x - 3 && px <= r.x + r.w + 3 && py >= r.y - 3 && py <= r.y + r.h + 3) {
      removeAnnotation(ann.id);
      return;
    }
  }
  setMsg('Nothing to erase there');
}

function removeAnnotation(id) {
  state.annotations = state.annotations.filter((a) => a.id !== id);
  setDirty(true);
  for (const idx of state.pageOrder) paintAnnotations(idx);
}

/* --------------------------------------------------------------- dialogs */

function openDialog(dialog) {
  return new Promise((resolve) => {
    const onClose = () => {
      dialog.removeEventListener('close', onClose);
      resolve(dialog.returnValue === 'ok');
    };
    dialog.addEventListener('close', onClose);
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

async function askText(initial) {
  el['text-value'].value = initial || '';
  const ok = await openDialog(el['dlg-text']);
  return ok ? el['text-value'].value.trim() : '';
}

/* ---------------------------------------------------------------- signing */

async function beginSign() {
  if (!hasDoc()) return;
  await flushEdits();
  state.signMode = true;
  el['btn-sign'].classList.add('is-active');
  document.body.classList.add('sign-mode');
  for (const idx of state.pageOrder) layoutPage(idx);
  setMsg('Click where the signature block should go');
}

async function placeSignature(ev, idx) {
  const vp = state.pageEls.get(idx)?.vp;
  if (!vp) return;
  const point = pointerToUser(ev, idx);
  const base = await getViewport(idx, 1);

  const w = Math.min(230, base.width * 0.62);
  const h = Math.min(68, base.height * 0.17);
  const x = clamp(point.ux, 4, Math.max(4, base.width - w - 4));
  const y = clamp(point.uy - h, 4, Math.max(4, base.height - h - 4));

  state.signMode = false;
  document.body.classList.remove('sign-mode');
  el['btn-sign'].classList.remove('is-active');

  el['sign-name'].value = el['sign-name'].value || 'OmniPDF User';
  const ok = await openDialog(el['dlg-sign']);
  if (!ok) {
    setMsg('Signing cancelled');
    for (const i of state.pageOrder) layoutPage(i);
    return;
  }

  setMsg('Signing…');
  const result = await window.omnipdf.sign({
    bytes: state.bytes,
    pageIndex: idx,
    rect: { x, y, w, h },
    name: el['sign-name'].value.trim() || 'OmniPDF User',
    reason: el['sign-reason'].value.trim(),
    location: el['sign-location'].value.trim(),
    formValues: {},
    annotations: [],
    pageOps: { rotations: {} },
  });

  await openBytes(result.bytes, state.fileName, state.filePath);
  setDirty(true);
  setMsg('Signed — save to write the signature to disk');
}

/* ------------------------------------------------------------------- edit */

function editPayload() {
  const kept = new Set(state.pageOrder);
  const deletes = [];
  for (let i = 0; i < state.originalCount; i += 1) {
    if (!kept.has(i)) deletes.push(i);
  }
  return {
    bytes: state.bytes,
    formValues: state.formValues,
    annotations: state.annotations,
    pageOps: { rotations: state.rotations, deletes },
  };
}

async function buildEditedBytes() {
  const result = await window.omnipdf.edit(editPayload());
  if (result.errors && result.errors.length) {
    setMsg(`Completed with warnings: ${result.errors.slice(0, 2).join('; ')}`);
  }
  return result.bytes;
}

/** Bake pending edits into memory so index-based actions (OCR, sign) stay valid. */
async function flushEdits() {
  if (!hasDoc()) return;
  if (!state.annotations.length && !Object.keys(state.formValues).length &&
      !Object.keys(state.rotations).length &&
      state.pageOrder.length === state.originalCount) {
    return;
  }
  const bytes = await buildEditedBytes();
  await openBytes(bytes, state.fileName, state.filePath);
}

async function save(asNew) {
  if (!hasDoc()) return;
  setMsg('Saving…');
  const bytes = await buildEditedBytes();

  let target = state.filePath;
  if (asNew || !target) {
    const out = await window.omnipdf.saveAs({
      bytes,
      suggestedName: state.fileName || 'document.pdf',
    });
    if (!out) {
      setMsg('Save cancelled');
      return;
    }
    target = out.path;
    state.fileName = out.name;
    state.filePath = out.path;
  } else {
    await window.omnipdf.save({ path: target, bytes });
  }

  await openBytes(bytes, state.fileName, target);
  setDirty(false);
  setMsg('Saved');
}

async function extractCurrent() {
  if (!hasDoc()) return;
  const bytes = await buildEditedBytes();
  const pageIndex = state.current;
  const out = await window.omnipdf.extract({ bytes, indices: [pageIndex] });
  if (!out) return;
  const saved = await window.omnipdf.saveAs({
    bytes: out.bytes,
    suggestedName: `page-${pageIndex + 1}.pdf`,
  });
  if (saved) setMsg(`Extracted to ${saved.name}`);
}

/* -------------------------------------------------------------------- OCR */

async function rasterize(idx, scale, lang) {
  const page = await state.pdf.getPage(idx + 1);
  const rotation = (((page.rotate + (state.rotations[idx] || 0)) % 360) + 360) % 360;
  const vp = page.getViewport({ scale, rotation });
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.floor(vp.width));
  canvas.height = Math.max(1, Math.floor(vp.height));
  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;

  const base = page.getViewport({ scale: 1, rotation });
  return {
    index: idx,
    pngBase64: canvas.toDataURL('image/png').split(',')[1],
    dispWidth: base.width,
    dispHeight: base.height,
    pxPerPt: scale,
    lang,
  };
}

async function runOcr() {
  if (!hasDoc()) return;
  const ok = await openDialog(el['dlg-ocr']);
  if (!ok) return;

  const scope = el['ocr-scope'].value;
  const lang = el['ocr-lang'].value;

  await flushEdits();

  const targets = scope === 'current' ? [state.pageOrder[state.current]] : state.pageOrder.slice();
  const pages = [];
  for (const idx of targets) {
    setMsg(`Rasterising page ${pages.length + 1} of ${targets.length}…`);
    pages.push(await rasterize(idx, 200 / 72, lang));
  }

  setMsg(`Running OCR on ${pages.length} page${pages.length === 1 ? '' : 's'} — this may take a while…`);
  try {
    const result = await window.omnipdf.ocr({ bytes: state.bytes, pages, formValues: {}, annotations: [], pageOps: { rotations: {} } });
    await openBytes(result.bytes, state.fileName, state.filePath);
    setDirty(true);
    const words = result.results.reduce((sum, r) => sum + r.wordCount, 0);
    const conf = result.results.length
      ? Math.round(result.results.reduce((sum, r) => sum + r.confidence, 0) / result.results.length)
      : 0;
    setMsg(`OCR complete: ${words} words, mean confidence ${conf}% — save to keep the text layer`);
  } catch (err) {
    setMsg(`OCR failed: ${err.message || err}`);
  }
}

/* ----------------------------------------------------------------- search */

async function getTextItems(idx) {
  if (state.textItems.has(idx)) return state.textItems.get(idx);
  const page = await state.pdf.getPage(idx + 1);
  const content = await page.getTextContent();
  const items = content.items.filter((i) => i.str && i.str.trim());
  state.textItems.set(idx, items);
  return items;
}

let searchToken = 0;

async function runSearch(query) {
  const token = ++searchToken;
  state.searchHits = [];
  state.searchActive = 0;

  const needle = String(query || '').trim().toLowerCase();
  if (!needle || !hasDoc()) {
    el['search-count'].textContent = '';
    for (const idx of state.pageOrder) paintSearch(idx);
    return;
  }

  for (const idx of state.pageOrder) {
    const items = await getTextItems(idx);
    if (token !== searchToken) return;
    for (const item of items) {
      if (item.str.toLowerCase().includes(needle)) state.searchHits.push({ page: idx, item });
    }
  }

  el['search-count'].textContent = String(state.searchHits.length);
  for (const idx of state.pageOrder) paintSearch(idx);
  if (state.searchHits.length) gotoHit(0);
  else setMsg('No matches');
}

function gotoHit(i) {
  if (!state.searchHits.length) return;
  state.searchActive = (i + state.searchHits.length) % state.searchHits.length;
  const hit = state.searchHits[state.searchActive];
  const pos = state.pageOrder.indexOf(hit.page);
  if (pos >= 0) scrollToPage(pos);
  for (const idx of state.pageOrder) paintSearch(idx);
  el['search-count'].textContent = `${state.searchActive + 1}/${state.searchHits.length}`;
}

/* ------------------------------------------------------------- navigation */

function scrollToPage(pos) {
  const target = el.pages.children[pos];
  if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function updateCurrentPage() {
  if (!hasDoc()) return;
  const viewerTop = el.viewer.getBoundingClientRect().top;
  let best = 0;
  let bestDist = Infinity;
  for (let pos = 0; pos < el.pages.children.length; pos += 1) {
    const box = el.pages.children[pos].getBoundingClientRect();
    const dist = Math.abs(box.top - viewerTop - 12);
    if (box.bottom > viewerTop && dist < bestDist) {
      bestDist = dist;
      best = pos;
    }
  }
  state.current = best;
  el['page-input'].value = String(best + 1);
  for (const [idx, thumb] of state.thumbEls) {
    thumb.classList.toggle('is-current', state.pageOrder[best] === idx);
  }
}

async function setScale(next) {
  if (!hasDoc()) return;
  state.scale = clamp(next, MIN_SCALE, MAX_SCALE);
  el['zoom-label'].textContent = `${Math.round(state.scale * 100)}%`;
  for (const idx of state.pageOrder) {
    const entry = state.pageEls.get(idx);
    if (!entry) continue;
    entry.rendered = '';
    const vp = await getViewport(idx);
    entry.div.style.width = `${Math.floor(vp.width)}px`;
    entry.div.style.height = `${Math.floor(vp.height)}px`;
    entry.vp = vp;
    await layoutPage(idx);
  }
  for (const idx of state.pageOrder) {
    const entry = state.pageEls.get(idx);
    if (entry && isVisible(entry.div)) renderPage(idx).catch(() => {});
  }
}

function isVisible(node) {
  const box = node.getBoundingClientRect();
  const view = el.viewer.getBoundingClientRect();
  return box.bottom > view.top - 300 && box.top < view.bottom + 300;
}

async function fitWidth() {
  if (!hasDoc()) return;
  const vp = await getViewport(state.pageOrder[state.current], 1);
  const available = el.viewer.clientWidth - 56;
  await setScale(available / Math.max(vp.width, 1));
}

/* --------------------------------------------------------------- commands */

function setTool(tool) {
  state.tool = tool;
  for (const button of document.querySelectorAll('#tool-group .tool')) {
    button.classList.toggle('is-active', button.dataset.tool === tool);
  }
  for (const idx of state.pageOrder) layoutPage(idx);
  setMsg(tool === 'select' ? '' : `${tool} tool — drag on a page`);
}

async function rotateCurrent() {
  if (!hasDoc()) return;
  const idx = state.pageOrder[state.current];
  state.rotations[idx] = ((state.rotations[idx] || 0) + 90) % 360;
  const entry = state.pageEls.get(idx);
  if (entry) entry.rendered = '';
  const thumb = state.thumbEls.get(idx);
  if (thumb) thumb.dataset.done = '0';
  const vp = await getViewport(idx);
  if (entry) {
    entry.div.style.width = `${Math.floor(vp.width)}px`;
    entry.div.style.height = `${Math.floor(vp.height)}px`;
    entry.vp = vp;
    await renderPage(idx);
  }
  setDirty(true);
  setMsg('Page rotated — save to apply');
}

async function deleteCurrent() {
  if (!hasDoc() || state.pageOrder.length <= 1) {
    setMsg('Cannot delete the only page');
    return;
  }
  const pos = state.current;
  const idx = state.pageOrder[pos];
  const entry = state.pageEls.get(idx);
  if (entry) state.io.unobserve(entry.div);
  state.pageOrder.splice(pos, 1);
  state.pageEls.delete(idx);
  const thumb = state.thumbEls.get(idx);
  if (thumb) thumb.remove();
  state.thumbEls.delete(idx);
  el['page-total'].textContent = `/ ${state.pageOrder.length}`;
  el['page-input'].max = String(state.pageOrder.length);
  await buildPages();
  state.current = Math.min(pos, state.pageOrder.length - 1);
  scrollToPage(state.current);
  setDirty(true);
  setMsg('Page deleted — save to apply');
}

async function openFile() {
  const doc = await window.omnipdf.openFile();
  if (!doc) return;
  await openBytes(doc.bytes, doc.name, doc.path);
}

async function openDropped(file) {
  const path = window.omnipdf.pathForFile(file);
  if (path) {
    const doc = await window.omnipdf.openPath(path);
    if (doc) {
      await openBytes(doc.bytes, doc.name, doc.path);
      return;
    }
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  await openBytes(buffer, file.name, null);
}

/* ------------------------------------------------------------------- init */

function bind() {
  el['btn-open'].addEventListener('click', () => openFile());
  el['btn-save'].addEventListener('click', () => save(false));
  el['btn-saveas'].addEventListener('click', () => save(true));
  el['btn-ocr'].addEventListener('click', () => runOcr());
  el['btn-sign'].addEventListener('click', () => beginSign());
  el['btn-rotate'].addEventListener('click', () => rotateCurrent());
  el['btn-delete-page'].addEventListener('click', () => deleteCurrent());
  el['btn-extract'].addEventListener('click', () => extractCurrent());

  el['btn-prev'].addEventListener('click', () => scrollToPage(Math.max(0, state.current - 1)));
  el['btn-next'].addEventListener('click', () =>
    scrollToPage(Math.min(state.pageOrder.length - 1, state.current + 1))
  );
  el['page-input'].addEventListener('change', () => {
    const value = clamp(Number(el['page-input'].value) || 1, 1, state.pageOrder.length || 1);
    scrollToPage(value - 1);
  });

  el['btn-zoom-in'].addEventListener('click', () => setScale(state.scale * 1.2));
  el['btn-zoom-out'].addEventListener('click', () => setScale(state.scale / 1.2));
  el['btn-fit'].addEventListener('click', () => fitWidth());

  for (const button of document.querySelectorAll('#tool-group .tool')) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }

  let searchTimer = null;
  el.search.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => runSearch(el.search.value), 220);
  });
  el.search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') gotoHit(state.searchActive + (ev.shiftKey ? -1 : 1));
  });

  el.viewer.addEventListener('scroll', () => {
    window.clearTimeout(bind.scrollTimer);
    bind.scrollTimer = window.setTimeout(updateCurrentPage, 90);
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      save(ev.shiftKey);
    }
    if (ev.key === 'Escape' && state.signMode) {
      state.signMode = false;
      document.body.classList.remove('sign-mode');
      el['btn-sign'].classList.remove('is-active');
      setMsg('');
    }
  });

  window.addEventListener('dragover', (ev) => {
    ev.preventDefault();
    document.body.classList.add('is-dragging');
  });
  window.addEventListener('dragleave', () => document.body.classList.remove('is-dragging'));
  window.addEventListener('drop', (ev) => {
    ev.preventDefault();
    document.body.classList.remove('is-dragging');
    const file = ev.dataTransfer?.files?.[0];
    if (file) openDropped(file).catch((err) => setMsg(String(err.message || err)));
  });

  window.omnipdf.onMenu((action) => {
    if (action === 'open') openFile();
    else if (action === 'save') save(false);
    else if (action === 'saveAs') save(true);
    else if (action === 'extract') extractCurrent();
    else if (action === 'ocr') runOcr();
    else if (action === 'sign') beginSign();
    else if (action === 'rotate') rotateCurrent();
    else if (action === 'zoomIn') setScale(state.scale * 1.2);
    else if (action === 'zoomOut') setScale(state.scale / 1.2);
    else if (action === 'fit') fitWidth();
    else if (action === 'focusSearch') el.search.focus();
    else if (action === 'cert') showCert();
  });
}

async function showCert() {
  const info = await window.omnipdf.certInfo();
  el['cert-body'].innerHTML = '';
  const rows = [
    ['Subject', info.subject],
    ['Issued', info.issuedAt ? new Date(info.issuedAt).toLocaleString() : '—'],
    ['Valid until', info.notAfter ? new Date(info.notAfter).toLocaleDateString() : '—'],
    ['Key store', info.path],
  ];
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value || '—';
    el['cert-body'].append(dt, dd);
  }
  await openDialog(el['dlg-cert']);
}

/* Smoke test hook used by `npm run smoke`. */
window.__smoke = async (base64) => {
  try {
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    await openBytes(bytes, 'fixture.pdf', null);
    const idx = state.pageOrder[0];
    await renderPage(idx);
    const items = await getTextItems(idx);
    const entry = state.pageEls.get(idx);
    const page0 = await state.pdf.getPage(1);
    const anns = await page0.getAnnotations({ intent: 'display' });
    return {
      build: BUILD_TAG,
      ok: items.length > 0,
      pages: state.pdf.numPages,
      textItems: items.length,
      sample: items.map((i) => i.str).join(' ').slice(0, 100),
      widgets: entry ? entry.widgets.length : 0,
      widgetError: entry ? entry.widgetError || null : 'no entry',
      widgetDiag: entry ? entry.widgetDiag : null,
      annotations: anns.map((a) => a.subtype + ':' + (a.fieldName || '-')).slice(0, 6),
      canvasWidth: entry ? entry.div.querySelector('.page-canvas').width : 0,
    };
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error) };
  }
};

state.io = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const idx = Number(entry.target.dataset.idx);
      renderPage(idx).catch(() => {});
    }
  },
  { root: el.viewer, rootMargin: '700px 0px' }
);

bind();
updateTitle();
updateCurrentPage();
