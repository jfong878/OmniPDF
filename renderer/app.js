import * as pdfjsLib from '/vendor/build/pdf.mjs';

pdfjsLib.GlobalWorkerOptions.workerSrc = '/vendor/build/pdf.worker.mjs';

const CMAP_URL = '/vendor/cmaps/';
const STANDARD_FONTS = '/vendor/standard_fonts/';
const WASM_URL = '/vendor/wasm/';
const ICC_URL = '/vendor/iccs/';
const MIN_SCALE = 0.25;
const MAX_SCALE = 5;
const DEFAULT_SCALE = 1.15;
const DPR = Math.min(window.devicePixelRatio || 1, 2);
const MAX_CANVAS_PIXELS = 8_000_000;
const MAX_PRINT_PIXELS = 12_000_000;
const PRINT_DPI = 150;
const HISTORY_LIMIT = 40;
const BUILD_TAG = 'build-9';

const IDS = [
  'btn-open', 'btn-save', 'btn-saveas', 'btn-print', 'btn-undo', 'btn-redo', 'btn-prev', 'btn-next',
  'page-input', 'page-total',
  'btn-zoom-out', 'btn-zoom-in', 'btn-fit', 'btn-fit-page', 'btn-actual', 'zoom-label',
  'pages', 'viewer', 'thumbs', 'search', 'search-count', 'btn-find-prev', 'btn-find-next',
  'status-file', 'status-msg', 'btn-rotate', 'btn-delete-page', 'btn-extract',
  'btn-ocr', 'btn-sign', 'dlg-sign', 'sign-name', 'sign-reason', 'sign-location',
  'sign-pad', 'sign-pad-hint', 'sign-clear', 'sign-import', 'sign-file', 'sign-save',
  'sign-status', 'sign-saved-list', 'sign-place-bar', 'sign-place-confirm', 'sign-place-cancel',
  'dlg-ocr',
  'ocr-scope', 'ocr-lang', 'dlg-text', 'text-value', 'dlg-cert', 'cert-body',
  'dlg-props', 'props-body', 'props-path', 'props-reveal',
  'tabs', 'btn-new-tab', 'dlg-confirm', 'confirm-text', 'dlg-signedit',
  'update-banner', 'update-text', 'update-action', 'update-dismiss', 'btn-update',
  'dlg-update', 'update-confirm-text', 'recent-files', 'recent-list', 'recent-clear',
  'print-root',
];

const el = {};
for (const id of IDS) el[id] = document.getElementById(id);

/* ------------------------------------------------------------------- tabs */

// One tab per open document. Only the active tab owns elements in the shared
// viewer/sidebar; switching tears the page DOM down and rebuilds it from that
// tab's own state so render callbacks always work against live elements.
let tabs = [];
let state = null; // active tab, or null when no document is open
let tool = 'select';
let tabSeq = 0;
let allowUnload = false;
let scaleTimer = null;
let printBusy = false;
let printUrls = [];

const SIGN_PAD_W = 700;
const SIGN_PAD_H = 200;
const SIGNATURE_MAX_BYTES = 5 * 1024 * 1024;
const sigPad = {
  ctx: null,
  dpr: 1,
  drawing: false,
  selectedId: null,
  saved: [],
};

function createTab() {
  tabSeq += 1;
  return {
    id: `tab-${tabSeq}`,
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
    searchQuery: '',
    searchToken: 0,
    searchTimer: null,
    scale: DEFAULT_SCALE,
    layoutScale: DEFAULT_SCALE,
    current: 0,
    dirty: false,
    nextId: 1,
    signMode: false,
    signPlacement: null,
    history: { entries: [], index: -1, busy: false },
    drag: null,
    io: null,
    scrollTop: 0,
    closed: false,
    ui: null,
  };
}

const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const hasDoc = (s) => Boolean(s && s.pdf);

function pdfLoadOptions(bytes) {
  return {
    data: bytes.slice(),
    cMapUrl: CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: STANDARD_FONTS,
    wasmUrl: WASM_URL,
    iccUrl: ICC_URL,
    isEvalSupported: false,
    useSystemFonts: true,
  };
}

function setMsg(message) {
  el['status-msg'].textContent = message || '';
}

function setMsgFor(s, message) {
  if (s === state) setMsg(message);
}

function updateTitle() {
  if (!state) {
    document.title = 'OmniPDF';
    el['status-file'].textContent = 'No document';
    return;
  }
  const name = state.fileName || 'Untitled';
  document.title = `${state.dirty ? '• ' : ''}${name} — OmniPDF`;
  el['status-file'].textContent = state.filePath || (hasDoc(state) ? name : 'No document');
}

function setDirty(s, value) {
  s.dirty = value;
  updateTabLabel(s);
  if (s === state) updateTitle();
}

/* --------------------------------------------------------------- history */

// A snapshot holds the document state, but not copies of the PDF bytes: byte
// arrays are immutable here and snapshots reuse the same reference. Signed and
// OCR states therefore restore the exact bytes from that point in history.
function snapshotTab(s) {
  return {
    bytes: s.bytes,
    pageOrder: s.pageOrder.slice(),
    originalCount: s.originalCount,
    rotations: { ...s.rotations },
    annotations: structuredClone(s.annotations),
    formValues: { ...s.formValues },
    nextId: s.nextId,
    current: s.current,
    dirty: s.dirty,
  };
}

function historyStateMatches(a, b) {
  return (
    a.bytes === b.bytes &&
    a.originalCount === b.originalCount &&
    a.nextId === b.nextId &&
    JSON.stringify({
      pageOrder: a.pageOrder,
      rotations: a.rotations,
      annotations: a.annotations,
      formValues: a.formValues,
    }) ===
      JSON.stringify({
        pageOrder: b.pageOrder,
        rotations: b.rotations,
        annotations: b.annotations,
        formValues: b.formValues,
      })
  );
}

function updateHistoryButtons(s) {
  const undo = el['btn-undo'];
  const redo = el['btn-redo'];
  if (!undo || !redo) return;
  const h = s && s.history;
  const idle = Boolean(s && s === state && h && !h.busy);
  const canUndo = Boolean(idle && h.index > 0);
  const canRedo = Boolean(idle && h.index >= 0 && h.index < h.entries.length - 1);
  undo.disabled = !canUndo;
  redo.disabled = !canRedo;
  undo.title = canUndo
    ? `Back — undo ${h.entries[h.index].label || 'edit'}`
    : 'Back — no earlier PDF state';
  redo.title = canRedo
    ? `Forward — redo ${h.entries[h.index + 1].label || 'edit'}`
    : 'Forward — no later PDF state';
}

function resetHistory(s) {
  if (!s) return;
  s.history = hasDoc(s)
    ? { entries: [snapshotTab(s)], index: 0, busy: false }
    : { entries: [], index: -1, busy: false };
  updateHistoryButtons(s);
}

function syncHistoryCurrent(s) {
  const h = s && s.history;
  if (!h || !hasDoc(s)) {
    resetHistory(s);
    return;
  }
  if (h.index < 0 || !h.entries[h.index]) {
    resetHistory(s);
    return;
  }
  const snap = snapshotTab(s);
  const previous = h.entries[h.index];
  snap.label = previous.label || 'Edit';
  snap.coalesceKey = previous.coalesceKey || null;
  snap.time = Date.now();
  h.entries[h.index] = snap;
  updateHistoryButtons(s);
}

function pushHistory(s, options = {}) {
  const h = s && s.history;
  if (!h || !hasDoc(s) || s.closed || h.busy) return;

  const snap = snapshotTab(s);
  snap.label = options.label || 'Edit';
  snap.coalesceKey = options.coalesceKey || null;
  snap.time = Date.now();

  const current = h.index >= 0 ? h.entries[h.index] : null;
  if (current && historyStateMatches(current, snap)) {
    current.dirty = snap.dirty;
    current.current = snap.current;
    updateHistoryButtons(s);
    return;
  }

  // A new edit after going back invalidates the forward branch.
  if (h.index < h.entries.length - 1) h.entries.splice(h.index + 1);

  const last = h.index >= 0 ? h.entries[h.index] : null;
  if (
    options.coalesceKey &&
    last &&
    last.coalesceKey === options.coalesceKey &&
    snap.time - last.time < 900
  ) {
    snap.label = options.label || last.label || 'Edit';
    h.entries[h.index] = snap;
  } else {
    h.entries.push(snap);
    h.index = h.entries.length - 1;
    if (h.entries.length > HISTORY_LIMIT) {
      h.entries.splice(0, h.entries.length - HISTORY_LIMIT);
      h.index = h.entries.length - 1;
    }
  }
  updateHistoryButtons(s);
}

function updateTabLabel(tab) {
  if (!tab || !tab.ui) return;
  tab.ui.label.textContent = tab.fileName || 'Untitled';
  tab.ui.dot.hidden = !tab.dirty;
  tab.ui.root.title = tab.filePath || tab.fileName || 'Untitled';
  tab.ui.root.classList.toggle('is-active', tab === state);
}

function makeTabUi(tab) {
  const root = document.createElement('div');
  root.className = 'tab';
  root.setAttribute('role', 'tab');
  root.tabIndex = 0;

  const label = document.createElement('span');
  label.className = 'tab-label';

  const dot = document.createElement('span');
  dot.className = 'tab-dot';
  dot.textContent = '\u2022';
  dot.hidden = true;

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'tab-close';
  close.textContent = '\u00d7';
  close.title = 'Close tab (Ctrl+W)';

  root.append(label, dot, close);
  root.addEventListener('mousedown', (ev) => {
    if (ev.button === 1) {
      ev.preventDefault();
      closeTab(tab);
    } else if (ev.button === 0) {
      activateTab(tab);
    }
  });
  root.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' || ev.key === ' ') {
      ev.preventDefault();
      activateTab(tab);
    }
  });
  close.addEventListener('mousedown', (ev) => ev.stopPropagation());
  close.addEventListener('click', (ev) => {
    ev.stopPropagation();
    closeTab(tab);
  });

  el.tabs.appendChild(root);
  tab.ui = { root, label, dot, close };
  updateTabLabel(tab);
}

function newTab() {
  const tab = createTab();
  tabs.push(tab);
  makeTabUi(tab);
  activateTab(tab);
  return tab;
}

function activateTab(tab) {
  if (!tab || tab.closed) return Promise.resolve();
  if (tab === state) {
    syncChrome(tab);
    return Promise.resolve();
  }

  const prev = state;
  if (prev) {
    prev.scrollTop = el.viewer.scrollTop;
    if (prev.io) {
      prev.io.disconnect();
      prev.io = null;
    }
    if (prev.signPlacement) clearSignPlacement(prev);
    prev.pageEls.clear();
    prev.thumbEls.clear();
    prev.drag = null;
    prev.signMode = false;
  }
  document.body.classList.remove('sign-mode');
  el['btn-sign'].classList.remove('is-active');

  state = tab;
  for (const t of tabs) {
    if (t.ui) t.ui.root.classList.toggle('is-active', t === tab);
  }

  el.pages.innerHTML = '';
  el.thumbs.innerHTML = '';
  el.viewer.scrollTop = 0;
  syncChrome(tab);
  syncSignPlacementBar(tab);

  if (tab.pdf) {
    return buildPages(tab)
      .then(() => {
        if (state !== tab) return;
        el.viewer.scrollTop = tab.scrollTop || 0;
        updateCurrentPage(tab);
        const count = tab.pageOrder.length;
        setMsg(`${count} page${count === 1 ? '' : 's'}`);
      })
      .catch(() => {});
  }
  setMsg('');
  return Promise.resolve();
}

function confirmDiscard(name) {
  el['confirm-text'].textContent =
    `Close “${name || 'Untitled'}” without saving? Changes that were not saved will be lost.`;
  return openDialog(el['dlg-confirm']);
}

async function closeTab(tab) {
  const target = tab || state;
  if (!target || target.closed) return;

  if (target.dirty) {
    const ok = await confirmDiscard(target.fileName);
    if (!ok) return;
  }

  const pos = tabs.indexOf(target);
  if (pos < 0) return;
  const wasActive = target === state;

  target.closed = true;
  if (target.signPlacement) clearSignPlacement(target);
  tabs.splice(pos, 1);
  if (target.ui) {
    target.ui.root.remove();
    target.ui = null;
  }
  if (target.io) {
    target.io.disconnect();
    target.io = null;
  }
  try {
    if (target.pdf) await target.pdf.destroy();
  } catch {
    /* ignore */
  }

  if (!wasActive) return;

  state = null;
  target.pageEls.clear();
  target.thumbEls.clear();
  el.pages.innerHTML = '';
  el.thumbs.innerHTML = '';
  document.body.classList.remove('sign-mode');
  el['btn-sign'].classList.remove('is-active');

  const next = tabs[Math.min(pos, tabs.length - 1)] || null;
  if (next) {
    activateTab(next);
  } else {
    syncChrome(null);
    setMsg('');
    refreshRecentFiles();
  }
}

function cycleTabs(delta) {
  if (tabs.length < 2) return;
  const pos = tabs.indexOf(state);
  if (pos < 0) return;
  activateTab(tabs[(pos + delta + tabs.length) % tabs.length]);
}

function syncChrome(s) {
  document.body.classList.toggle('has-document', hasDoc(s));
  if (!s) {
    el['page-total'].textContent = '/ 0';
    el['page-input'].max = '1';
    el['page-input'].value = '1';
    el['zoom-label'].textContent = '100%';
    el['search-count'].textContent = '';
    el.search.value = '';
    syncFindButtons(null);
    updateHistoryButtons(null);
    updateTitle();
    return;
  }
  el['page-total'].textContent = `/ ${s.pageOrder.length}`;
  el['page-input'].max = String(Math.max(1, s.pageOrder.length));
  el['page-input'].value = String(Math.min(s.current + 1, Math.max(1, s.pageOrder.length)));
  el['zoom-label'].textContent = `${Math.round(s.scale * 100)}%`;
  el['search-count'].textContent = s.searchQuery
    ? s.searchHits.length
      ? `${Math.min(s.searchActive + 1, s.searchHits.length)}/${s.searchHits.length}`
      : '0'
    : '';
  el.search.value = s.searchQuery || '';
  syncFindButtons(s);
  updateHistoryButtons(s);
  updateTitle();
}

/* -------------------------------------------------------------- viewports */

async function getViewport(s, idx, scale = s.scale) {
  const page = await s.pdf.getPage(idx + 1);
  const rotation = (((page.rotate + (s.rotations[idx] || 0)) % 360) + 360) % 360;
  return page.getViewport({ scale, rotation });
}

/* ------------------------------------------------------------ open/reload */

async function openBytes(s, bytes, name, filePath, options = {}) {
  if (!s || s.closed) return;
  const { history = 'reset', dirty = false, build = true } = options;
  setMsgFor(s, 'Loading…');

  const doc = await pdfjsLib.getDocument(pdfLoadOptions(bytes)).promise;

  if (s.closed) {
    try {
      await doc.destroy();
    } catch {
      /* ignore */
    }
    return;
  }

  if (s.pdf) {
    try {
      await s.pdf.destroy();
    } catch {
      /* ignore */
    }
  }

  s.pdf = doc;
  s.bytes = bytes;
  s.fileName = name;
  s.filePath = filePath || null;
  s.pageOrder = Array.from({ length: doc.numPages }, (_, i) => i);
  s.originalCount = doc.numPages;
  s.rotations = {};
  s.annotations = [];
  s.formValues = {};
  s.searchHits = [];
  s.searchActive = 0;
  s.searchQuery = '';
  s.searchToken += 1;
  s.current = 0;
  s.nextId = 1;
  s.signMode = false;
  s.signPlacement = null;
  s.drag = null;
  s.scrollTop = 0;
  s.pageEls.clear();
  s.thumbEls.clear();
  s.textItems.clear();
  updateTabLabel(s);

  if (s === state) {
    document.body.classList.remove('sign-mode', 'placing-signature');
    el['btn-sign'].classList.remove('is-active');
    el['sign-place-bar'].hidden = true;
    syncChrome(s);
    if (build) {
      await buildPages(s);
      if (s === state) {
        setMsg(`${doc.numPages} page${doc.numPages === 1 ? '' : 's'}`);
      }
    }
  }
  setDirty(s, dirty);
  updateTitle();
  if (history === 'reset') resetHistory(s);
  else if (history === 'sync') syncHistoryCurrent(s);
}

async function restoreHistory(s, targetIndex) {
  const h = s && s.history;
  const snap = h && h.entries[targetIndex];
  if (!s || s.closed || !h || h.busy || !snap) return false;

  h.busy = true;
  updateHistoryButtons(s);
  try {
    s.signMode = false;
    clearSignPlacement(s);

    // Only signed, OCR'd, saved or otherwise rewritten documents need a new
    // pdf.js parse. Ordinary edits share the original byte array reference.
    if (s.bytes !== snap.bytes) {
      await openBytes(s, snap.bytes, s.fileName, s.filePath, {
        history: 'none',
        dirty: snap.dirty,
        build: false,
      });
      if (s.closed) return false;
    }

    s.pageOrder = snap.pageOrder.slice();
    s.originalCount = snap.originalCount;
    s.rotations = { ...snap.rotations };
    s.annotations = structuredClone(snap.annotations);
    s.formValues = { ...snap.formValues };
    s.nextId = snap.nextId;
    s.current = clamp(Number(snap.current) || 0, 0, Math.max(0, s.pageOrder.length - 1));
    s.drag = null;
    s.searchHits = [];
    s.searchActive = 0;
    s.searchQuery = '';
    s.searchToken += 1;
    setDirty(s, snap.dirty);
    h.index = targetIndex;

    await buildPages(s);
    if (s.closed) return false;
    if (s === state) {
      syncChrome(s);
      scrollToPage(s, s.current);
    }
    return true;
  } finally {
    h.busy = false;
    updateHistoryButtons(s);
  }
}

async function undoDocument(s) {
  const h = s && s.history;
  if (!s || s !== state || !h || h.busy || h.index <= 0) return;
  const entry = h.entries[h.index];
  try {
    if (await restoreHistory(s, h.index - 1)) {
      setMsg(`Back: undid ${entry.label || 'edit'}`);
    }
  } catch (err) {
    setMsg(`Could not undo: ${err.message || err}`);
  }
}

async function redoDocument(s) {
  const h = s && s.history;
  if (!s || s !== state || !h || h.busy || h.index >= h.entries.length - 1) return;
  const entry = h.entries[h.index + 1];
  try {
    if (await restoreHistory(s, h.index + 1)) {
      setMsg(`Forward: redid ${entry.label || 'edit'}`);
    }
  } catch (err) {
    setMsg(`Could not redo: ${err.message || err}`);
  }
}

async function buildPages(s) {
  if (s !== state) return;
  el.pages.innerHTML = '';
  el.thumbs.innerHTML = '';
  s.pageEls.clear();
  s.thumbEls.clear();
  if (s.io) s.io.disconnect();
  s.io = new IntersectionObserver(
    (entries) => {
      if (s !== state) return;
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const idx = Number(entry.target.dataset.idx);
        if (!s.pageEls.has(idx)) continue;
        renderPage(s, idx).catch(() => {});
      }
    },
    { root: el.viewer, rootMargin: '700px 0px' }
  );

  for (let pos = 0; pos < s.pageOrder.length; pos += 1) {
    const idx = s.pageOrder[pos];
    const vp = await getViewport(s, idx);
    if (s !== state) return;

    const div = document.createElement('div');
    div.className = 'page';
    div.dataset.idx = String(idx);
    div.style.width = `${Math.floor(vp.width)}px`;
    div.style.height = `${Math.floor(vp.height)}px`;
    div.innerHTML =
      '<canvas class="page-canvas"></canvas><div class="text-layer"></div>' +
      '<div class="search-layer"></div><canvas class="anno-layer"></canvas><div class="form-layer"></div>' +
      '<div class="sign-layer"></div>';

    const overlay = div.querySelector('.anno-layer');
    overlay.addEventListener('pointerdown', (ev) => onOverlayDown(s, ev, idx));

    el.pages.appendChild(div);
    s.pageEls.set(idx, {
      div,
      vp,
      baseW: vp.width / s.scale,
      baseH: vp.height / s.scale,
      rendered: '',
      renderSeq: 0,
      widgets: [],
    });
    s.io.observe(div);

    const thumb = document.createElement('div');
    thumb.className = 'thumb';
    thumb.innerHTML = `<canvas></canvas><span class="thumb-label">${pos + 1}</span>`;
    thumb.addEventListener('click', () => scrollToPage(s, pos));
    el.thumbs.appendChild(thumb);
    s.thumbEls.set(idx, thumb);
  }

  s.layoutScale = s.scale;

  // Thumbnails render after the first pages so opening feels immediate.
  window.setTimeout(() => {
    if (s === state) renderThumbs(s).catch(() => {});
  }, 60);
}

async function renderThumbs(s) {
  for (const idx of s.pageOrder) {
    if (s !== state || s.closed) return;
    const thumb = s.thumbEls.get(idx);
    if (!thumb || thumb.dataset.done === '1') continue;
    try {
      const page = await s.pdf.getPage(idx + 1);
      const base = page.getViewport({ scale: 1 });
      const rotation = (((page.rotate + (s.rotations[idx] || 0)) % 360) + 360) % 360;
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
function renderPage(s, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry || !s.pdf) return Promise.resolve();
  entry.chain = (entry.chain || Promise.resolve())
    .then(() => doRenderPage(s, idx))
    .catch(() => {});
  return entry.chain;
}

async function doRenderPage(s, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry || !s.pdf || s !== state) return;

  const page = await s.pdf.getPage(idx + 1);
  const rotation = (((page.rotate + (s.rotations[idx] || 0)) % 360) + 360) % 360;
  const vp = page.getViewport({ scale: s.scale, rotation });
  const key = `${s.scale}|${rotation}`;

  // A blank `rendered` marks the page stale; the key check skips redundant work.
  if (entry.rendered === key) {
    await layoutPage(s, idx);
    return;
  }

  entry.renderSeq += 1;
  const seq = entry.renderSeq;

  const canvas = entry.div.querySelector('.page-canvas');
  const scaled = page.getViewport({ scale: s.scale * DPR, rotation });
  const pixelBudget = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, scaled.width * scaled.height)));
  const renderViewport = pixelBudget < 1
    ? page.getViewport({ scale: s.scale * DPR * pixelBudget, rotation })
    : scaled;
  canvas.width = Math.max(1, Math.floor(renderViewport.width));
  canvas.height = Math.max(1, Math.floor(renderViewport.height));

  const ctx = canvas.getContext('2d', { alpha: false });
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  try {
    await page.render({ canvasContext: ctx, canvas, viewport: renderViewport }).promise;
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

  await buildTextLayer(s, idx, page, vp);
  await buildWidgets(s, idx, page, vp);
  await layoutPage(s, idx);
}

async function buildTextLayer(s, idx, page, vp) {
  const entry = s.pageEls.get(idx);
  if (!entry) return;

  let content;
  try {
    content = await page.getTextContent();
  } catch {
    return;
  }

  s.textItems.set(idx, content.items.filter((i) => i.str && i.str.trim()));

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

async function buildWidgets(s, idx, page, vp) {
  const entry = s.pageEls.get(idx);
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
    // Values typed before a tab switch live in the tab state, not the PDF, so
    // rebuilding the form layer has to put them back on top of the defaults.
    if (Object.prototype.hasOwnProperty.call(s.formValues, name)) {
      const stored = s.formValues[name];
      if (input.type === 'checkbox') input.checked = stored === 'true';
      else if (input.type === 'radio') input.checked = input.value === stored;
      else if (input.tagName !== 'BUTTON') input.value = stored;
    }

    const commit = () => {
      // Undo/redo rebuilds the page and detaches old widgets. A late change
      // event from one of those inputs must not overwrite the restored state or
      // truncate the redo branch.
      if (!input.isConnected) return;
      if (input.type === 'checkbox') s.formValues[name] = input.checked ? 'true' : 'false';
      else if (input.type === 'radio') {
        if (input.checked) s.formValues[name] = input.value;
      } else s.formValues[name] = input.value;
      setDirty(s, true);
      pushHistory(s, {
        label: 'Edit form field',
        coalesceKey: input.type === 'text' || input.tagName === 'TEXTAREA' ? `field:${name}` : null,
      });
    };
    input.addEventListener('input', commit);
    input.addEventListener('change', commit);
    if (fieldType === 'Sig') {
      input.addEventListener('click', () => beginSign(s));
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

async function layoutPage(s, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry) return;

  if (!entry.vp) entry.vp = await getViewport(s, idx);
  const vp = entry.vp;
  const width = parseFloat(entry.div.style.width) || vp.width;
  const height = parseFloat(entry.div.style.height) || vp.height;

  const overlay = entry.div.querySelector('.anno-layer');
  const overlayScale = Math.min(DPR, Math.sqrt(MAX_CANVAS_PIXELS / Math.max(1, width * height)));
  entry.overlayScale = overlayScale;
  overlay.width = Math.max(1, Math.floor(width * overlayScale));
  overlay.height = Math.max(1, Math.floor(height * overlayScale));
  overlay.style.width = `${width}px`;
  overlay.style.height = `${height}px`;
  overlay.classList.toggle('is-active', tool !== 'select' || s.signMode);

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

  paintAnnotations(s, idx);
  paintSearch(s, idx);
  renderSignPlacement(s, idx);
}

function paintAnnotations(s, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry) return;
  const canvas = entry.div.querySelector('.anno-layer');
  const ctx = canvas.getContext('2d');
  const width = parseFloat(entry.div.style.width) || 0;
  const height = parseFloat(entry.div.style.height) || 0;
  const overlayScale = entry.overlayScale || DPR;
  ctx.setTransform(overlayScale, 0, 0, overlayScale, 0, 0);
  ctx.clearRect(0, 0, width, height);
  const vp = entry.vp;
  if (!vp) return;

  const items = s.annotations.filter((a) => a.page === idx);
  if (s.drag && s.drag.page === idx) items.push(s.drag.preview);

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

function paintSearch(s, idx) {
  if (s !== state) return;
  const entry = s.pageEls.get(idx);
  if (!entry || !entry.vp) return;
  const layer = entry.div.querySelector('.search-layer');
  layer.innerHTML = '';
  if (!s.searchHits.length) return;
  const vp = entry.vp;
  for (const hit of s.searchHits.filter((h) => h.page === idx)) {
    const tx = multiply(vp.transform, hit.item.transform);
    const height = Math.hypot(tx[2], tx[3]) || 10;
    const div = document.createElement('div');
    const active = s.searchHits[s.searchActive] === hit;
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

function pointerToUser(s, ev, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry || !entry.vp) return null;
  const [px, py] = localPoint(ev, entry.div);
  const [ux, uy] = toUser(entry.vp, px, py);
  return { px, py, ux, uy, vp: entry.vp };
}

function onOverlayDown(s, ev, idx) {
  if (!hasDoc(s) || s !== state || ev.button !== 0) return;
  const point = pointerToUser(s, ev, idx);
  if (!point) return;

  if (s.signMode) {
    placeSignature(s, ev, idx).catch((err) => setMsg(String(err.message || err)));
    return;
  }
  if (tool === 'select') return;

  ev.preventDefault();
  ev.target.setPointerCapture(ev.pointerId);

  if (tool === 'erase') {
    eraseAt(s, idx, point.px, point.py);
    return;
  }

  if (tool === 'ink') {
    s.drag = {
      page: idx,
      points: [[point.ux, point.uy]],
      preview: { page: idx, type: 'ink', color: '#e0453e', width: 2, points: [[point.ux, point.uy]] },
    };
  } else {
    s.drag = {
      page: idx,
      start: [point.ux, point.uy],
      preview: {
        page: idx,
        type: tool === 'box' ? 'box' : 'highlight',
        color: tool === 'box' ? '#4d8dff' : '#ffd400',
        width: 1.5,
        opacity: 0.35,
        rect: { x: point.ux, y: point.uy, w: 0, h: 0 },
      },
    };
  }

  const move = (e) => onOverlayMove(s, e, idx);
  const up = (e) => {
    ev.target.removeEventListener('pointermove', move);
    ev.target.removeEventListener('pointerup', up);
    onOverlayUp(s, e, idx);
  };
  ev.target.addEventListener('pointermove', move);
  ev.target.addEventListener('pointerup', up);
}

function onOverlayMove(s, ev, idx) {
  if (!s.drag) return;
  const point = pointerToUser(s, ev, idx);
  if (!point) return;

  if (s.drag.preview.type === 'ink') {
    s.drag.preview.points.push([point.ux, point.uy]);
  } else {
    const [sx, sy] = s.drag.start;
    s.drag.preview.rect = {
      x: Math.min(sx, point.ux),
      y: Math.min(sy, point.uy),
      w: Math.abs(point.ux - sx),
      h: Math.abs(point.uy - sy),
    };
  }
  paintAnnotations(s, idx);
}

async function onOverlayUp(s, ev, idx) {
  const drag = s.drag;
  s.drag = null;
  if (!drag) return;

  if (drag.preview.type === 'ink') {
    if (drag.preview.points.length > 2) {
      addAnnotation(s, { ...drag.preview, id: s.nextId++, page: idx });
    }
    paintAnnotations(s, idx);
    return;
  }

  const rect = drag.preview.rect;
  if (rect.w < 3 || rect.h < 3) {
    setMsg('Drag a larger area');
    paintAnnotations(s, idx);
    return;
  }

  if (tool === 'text') {
    const text = await askText('');
    if (text) {
      addAnnotation(s, {
        id: s.nextId++,
        page: idx,
        type: 'text',
        color: '#ffd400',
        rect,
        text,
        fontSize: 12,
      });
    }
  } else {
    addAnnotation(s, {
      id: s.nextId++,
      page: idx,
      type: drag.preview.type,
      color: drag.preview.color,
      opacity: drag.preview.opacity,
      width: drag.preview.width,
      rect,
    });
  }
  paintAnnotations(s, idx);
}

function addAnnotation(s, ann) {
  s.annotations.push(ann);
  setDirty(s, true);
  pushHistory(s, { label: 'Add annotation' });
}

function eraseAt(s, idx, px, py) {
  const entry = s.pageEls.get(idx);
  if (!entry || !entry.vp) return;
  const vp = entry.vp;
  const candidates = s.annotations.filter((a) => a.page === idx);
  for (let i = candidates.length - 1; i >= 0; i -= 1) {
    const ann = candidates[i];
    if (ann.type === 'ink') {
      const hit = (ann.points || []).some(([x, y]) => {
        const p = toViewport(vp, x, y);
        return Math.hypot(p[0] - px, p[1] - py) < 9;
      });
      if (hit) {
        removeAnnotation(s, ann.id);
        return;
      }
      continue;
    }
    const r = viewportRect(vp, ann.rect);
    if (px >= r.x - 3 && px <= r.x + r.w + 3 && py >= r.y - 3 && py <= r.y + r.h + 3) {
      removeAnnotation(s, ann.id);
      return;
    }
  }
  setMsg('Nothing to erase there');
}

function removeAnnotation(s, id) {
  s.annotations = s.annotations.filter((a) => a.id !== id);
  setDirty(s, true);
  pushHistory(s, { label: 'Erase annotation' });
  for (const idx of s.pageOrder) paintAnnotations(s, idx);
}

/* ---------------------------------------------------------------- dialogs */

function openDialog(dialog) {
  return new Promise((resolve) => {
    const form = dialog.querySelector('form');
    let settled = false;

    const finish = (value) => {
      if (settled) return;
      settled = true;
      dialog.removeEventListener('close', onClose);
      dialog.removeEventListener('cancel', onCancel);
      if (form) form.removeEventListener('submit', onSubmit);
      resolve(value);
    };
    const onClose = () => finish(dialog.returnValue === 'ok');
    const onCancel = () => finish(false);
    const onSubmit = (event) => {
      // Electron's dialog implementation does not deliver close events here,
      // so settle from the form submission and let the default close finish.
      const value = event.submitter ? event.submitter.value : 'cancel';
      setTimeout(() => finish(value === 'ok'), 0);
    };

    dialog.addEventListener('close', onClose);
    dialog.addEventListener('cancel', onCancel);
    if (form) form.addEventListener('submit', onSubmit);
    dialog.returnValue = 'cancel';
    dialog.showModal();
  });
}

async function askText(initial) {
  el['text-value'].value = initial || '';
  const ok = await openDialog(el['dlg-text']);
  return ok ? el['text-value'].value.trim() : '';
}

function setSignStatus(message) {
  el['sign-status'].textContent = message || '';
}

function clearSignaturePad(clearSelection = true) {
  const canvas = el['sign-pad'];
  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.restore();
  sigPad.drawing = false;
  if (clearSelection) {
    sigPad.selectedId = null;
  }
  el['sign-pad-hint'].hidden = false;
}

function setupSignaturePad() {
  const canvas = el['sign-pad'];
  const ctx = canvas.getContext('2d');
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = SIGN_PAD_W * dpr;
  canvas.height = SIGN_PAD_H * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = '#10151f';
  ctx.lineWidth = 2.4;
  sigPad.ctx = ctx;
  sigPad.dpr = dpr;

  const pointFor = (ev) => {
    const rect = canvas.getBoundingClientRect();
    return {
      x: clamp((ev.clientX - rect.left) * (SIGN_PAD_W / rect.width), 0, SIGN_PAD_W),
      y: clamp((ev.clientY - rect.top) * (SIGN_PAD_H / rect.height), 0, SIGN_PAD_H),
    };
  };

  canvas.addEventListener('pointerdown', (ev) => {
    if (!ev.isPrimary || (ev.pointerType === 'mouse' && ev.button !== 0)) return;
    ev.preventDefault();
    try {
      canvas.setPointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
    sigPad.drawing = true;
    sigPad.selectedId = null;
    el['sign-pad-hint'].hidden = true;
    setSignStatus('');
    renderSavedSignatures();
    const p = pointFor(ev);
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(p.x + 0.01, p.y);
    ctx.stroke();
  });

  canvas.addEventListener('pointermove', (ev) => {
    if (!sigPad.drawing) return;
    ev.preventDefault();
    const coalesced = typeof ev.getCoalescedEvents === 'function' ? ev.getCoalescedEvents() : [];
    const events = coalesced.length ? coalesced : [ev];
    for (const item of events) {
      const p = pointFor(item);
      ctx.lineTo(p.x, p.y);
    }
    ctx.stroke();
  });

  const endStroke = (ev) => {
    if (!sigPad.drawing) return;
    sigPad.drawing = false;
    try {
      canvas.releasePointerCapture(ev.pointerId);
    } catch {
      /* ignore */
    }
  };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);

  el['sign-clear'].addEventListener('click', () => {
    clearSignaturePad();
    setSignStatus('');
    renderSavedSignatures();
  });

  el['sign-import'].addEventListener('click', () => el['sign-file'].click());

  el['sign-save'].addEventListener('click', () => {
    saveCurrentSignature(el['sign-name'].value.trim() || 'Signature');
  });

  el['sign-file'].addEventListener('change', async () => {
    const file = el['sign-file'].files && el['sign-file'].files[0];
    el['sign-file'].value = '';
    if (!file) return;
    if (file.size > SIGNATURE_MAX_BYTES) {
      setSignStatus('Signature image must be under 5 MB');
      return;
    }
    if (!/^image\/(png|jpeg)$/i.test(file.type) && !/\.(png|jpe?g)$/i.test(file.name)) {
      setSignStatus('Choose a PNG or JPEG signature image');
      return;
    }
    try {
      const dataUrl = await readFileAsDataUrl(file);
      await loadImageToPad(dataUrl);
      if (!signatureDataUrl()) {
        setSignStatus('That image appears blank');
        return;
      }
      const name = file.name.replace(/\.[^.]+$/, '').trim().slice(0, 60) || 'Imported signature';
      const saved = await saveCurrentSignature(name);
      if (saved) setSignStatus(`Imported and saved “${saved.name}”`);
    } catch (err) {
      setSignStatus(String(err.message || err));
    }
  });
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(new Error('Could not read the signature image'));
    reader.readAsDataURL(file);
  });
}

function loadImageToPad(dataUrl) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      if (!image.width || !image.height) {
        reject(new Error('Signature image is empty'));
        return;
      }
      clearSignaturePad(false);
      const boxW = SIGN_PAD_W - 32;
      const boxH = SIGN_PAD_H - 24;
      const scale = Math.min(boxW / image.width, boxH / image.height);
      const w = image.width * scale;
      const h = image.height * scale;
      sigPad.ctx.drawImage(image, (SIGN_PAD_W - w) / 2, (SIGN_PAD_H - h) / 2, w, h);
      el['sign-pad-hint'].hidden = true;
      resolve();
    };
    image.onerror = () => reject(new Error('Could not read the signature image'));
    image.src = dataUrl;
  });
}

function signatureDataUrl() {
  const canvas = el['sign-pad'];
  const ctx = sigPad.ctx || canvas.getContext('2d');
  const width = canvas.width;
  const height = canvas.height;
  const pixels = ctx.getImageData(0, 0, width, height).data;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const i = (y * width + x) * 4;
      if (pixels[i + 3] < 16) continue;
      if (pixels[i] > 248 && pixels[i + 1] > 248 && pixels[i + 2] > 248) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < minX) return null;

  const margin = Math.round(12 * sigPad.dpr);
  const sx = Math.max(0, minX - margin);
  const sy = Math.max(0, minY - margin);
  const sw = Math.min(width - sx, maxX - minX + 1 + margin * 2);
  const sh = Math.min(height - sy, maxY - minY + 1 + margin * 2);
  const out = document.createElement('canvas');
  out.width = sw;
  out.height = sh;
  out.getContext('2d').drawImage(canvas, sx, sy, sw, sh, 0, 0, sw, sh);
  return out.toDataURL('image/png');
}

function signatureBase64() {
  const dataUrl = signatureDataUrl();
  return dataUrl ? dataUrl.split(',')[1] : '';
}

function renderSavedSignatures() {
  const list = el['sign-saved-list'];
  list.innerHTML = '';
  if (!sigPad.saved.length) {
    const empty = document.createElement('span');
    empty.className = 'sig-saved-empty';
    empty.textContent = 'No saved signatures yet';
    list.appendChild(empty);
    return;
  }

  for (const saved of sigPad.saved) {
    const wrap = document.createElement('div');
    wrap.className = 'sig-saved-wrap';

    const button = document.createElement('button');
    button.type = 'button';
    button.className = `sig-saved-item${saved.id === sigPad.selectedId ? ' is-selected' : ''}`;
    button.title = saved.name;
    button.setAttribute('aria-label', `Use saved signature ${saved.name}`);

    const image = document.createElement('img');
    image.src = saved.dataUrl;
    image.alt = '';
    button.appendChild(image);
    button.addEventListener('click', () => {
      useSavedSignature(saved);
    });

    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'sig-saved-delete';
    remove.textContent = '×';
    remove.title = `Delete ${saved.name}`;
    remove.setAttribute('aria-label', `Delete saved signature ${saved.name}`);
    remove.addEventListener('click', (ev) => {
      ev.stopPropagation();
      deleteSavedSignature(saved);
    });

    wrap.append(button, remove);
    list.appendChild(wrap);
  }
}

async function refreshSavedSignatures() {
  try {
    const items = await window.omnipdf.listSignatures();
    sigPad.saved = Array.isArray(items) ? items : [];
  } catch (err) {
    sigPad.saved = [];
    setSignStatus(String(err.message || err));
  }
  if (sigPad.selectedId && !sigPad.saved.some((saved) => saved.id === sigPad.selectedId)) {
    sigPad.selectedId = null;
  }
  renderSavedSignatures();
}

async function useSavedSignature(saved) {
  try {
    await loadImageToPad(saved.dataUrl);
    sigPad.selectedId = saved.id;
    renderSavedSignatures();
    setSignStatus(`Using “${saved.name}”`);
  } catch (err) {
    setSignStatus(String(err.message || err));
  }
}

async function saveCurrentSignature(name) {
  setSignStatus('Saving…');
  try {
    const dataUrl = signatureDataUrl();
    if (!dataUrl) {
      setSignStatus('Draw or import a signature first');
      return null;
    }
    const saved = await window.omnipdf.saveSignature({ name, dataUrl });
    sigPad.selectedId = saved.id;
    await refreshSavedSignatures();
    setSignStatus(`Saved “${saved.name}”`);
    return saved;
  } catch (err) {
    setSignStatus(String(err.message || err));
    return null;
  }
}

async function deleteSavedSignature(saved) {
  try {
    await window.omnipdf.deleteSignature(saved.id);
    if (sigPad.selectedId === saved.id) {
      sigPad.selectedId = null;
    }
    await refreshSavedSignatures();
    setSignStatus(`Deleted “${saved.name}”`);
  } catch (err) {
    setSignStatus(String(err.message || err));
  }
}

async function prepareSignDialog() {
  clearSignaturePad();
  el['sign-name'].value = el['sign-name'].value || 'OmniPDF User';
  setSignStatus('');
  await refreshSavedSignatures();
}

/* ---------------------------------------------------------------- signing */

function syncSignPlacementBar(s) {
  if (s !== state) return;
  const visible = Boolean(s && hasDoc(s) && s.signPlacement);
  el['sign-place-bar'].hidden = !visible;
  document.body.classList.toggle('placing-signature', visible);
}

function clearSignPlacement(s) {
  if (!s) return;
  s.signPlacement = null;
  for (const idx of s.pageOrder) {
    const layer = s.pageEls.get(idx)?.div.querySelector('.sign-layer');
    if (layer) layer.replaceChildren();
  }
  if (s === state) {
    el['sign-place-bar'].hidden = true;
    document.body.classList.remove('placing-signature');
    el['btn-sign'].classList.remove('is-active');
  }
}

function cancelSignPlacement(s) {
  if (!s) return;
  clearSignPlacement(s);
  s.signMode = false;
  if (s === state) {
    document.body.classList.remove('sign-mode');
    el['btn-sign'].classList.remove('is-active');
    for (const idx of s.pageOrder) layoutPage(s, idx);
    setMsg('');
  }
}

function renderSignPlacement(s, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry) return;
  const layer = entry.div.querySelector('.sign-layer');
  if (!layer) return;
  const placement = s.signPlacement;
  if (!placement || placement.page !== idx || !entry.vp) {
    layer.replaceChildren();
    return;
  }

  let target = layer.querySelector('.sign-target');
  if (!target) {
    target = document.createElement('div');
    target.className = 'sign-target';
    target.setAttribute('role', 'group');
    target.setAttribute('aria-label', 'Signature placement. Drag to move.');
    target.innerHTML =
      '<span class="sign-target-label">Signature</span>' +
      '<span class="sign-target-hint">Drag to move</span>';
    target.addEventListener('pointerdown', (ev) => onSignTargetDown(s, ev, idx));
    layer.appendChild(target);
  }

  const r = viewportRect(entry.vp, placement.rect);
  target.style.left = `${r.x}px`;
  target.style.top = `${r.y}px`;
  target.style.width = `${r.w}px`;
  target.style.height = `${r.h}px`;
}

function onSignTargetDown(s, ev, idx) {
  const placement = s.signPlacement;
  const entry = s.pageEls.get(idx);
  if (!placement || placement.page !== idx || !entry || !entry.vp || ev.button !== 0) return;
  const start = pointerToUser(s, ev, idx);
  if (!start) return;

  ev.preventDefault();
  ev.stopPropagation();
  const target = ev.currentTarget;
  const startRect = { ...placement.rect };
  const pageW = entry.vp.width / entry.vp.scale;
  const pageH = entry.vp.height / entry.vp.scale;
  target.classList.add('is-dragging');

  const move = (event) => {
    if (s.signPlacement !== placement) return;
    const point = pointerToUser(s, event, idx);
    if (!point) return;
    placement.rect.x = clamp(
      startRect.x + point.ux - start.ux,
      4,
      Math.max(4, pageW - placement.rect.w - 4)
    );
    placement.rect.y = clamp(
      startRect.y + point.uy - start.uy,
      4,
      Math.max(4, pageH - placement.rect.h - 4)
    );
    renderSignPlacement(s, idx);
  };

  const finish = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', finish);
    window.removeEventListener('pointercancel', finish);
    target.classList.remove('is-dragging');
    if (s === state && s.signPlacement === placement) {
      setMsg('Position set — choose Sign document to finish');
    }
  };

  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', finish);
  window.addEventListener('pointercancel', finish);
}

async function beginSign(s) {
  if (!hasDoc(s) || s !== state) return;
  clearSignPlacement(s);
  await flushEdits(s);
  if (s !== state || s.closed) return;
  s.signMode = true;
  el['btn-sign'].classList.add('is-active');
  document.body.classList.add('sign-mode');
  for (const idx of s.pageOrder) layoutPage(s, idx);
  setMsg('Click where the signature block should go');
}

async function placeSignature(s, ev, idx) {
  const entry = s.pageEls.get(idx);
  if (!entry || !entry.vp) return;
  const point = pointerToUser(s, ev, idx);
  if (!point) return;
  const base = await getViewport(s, idx, 1);
  if (s !== state || s.closed) return;

  const w = Math.min(250, base.width * 0.64);
  const h = Math.min(86, base.height * 0.22);
  const x = clamp(point.ux, 4, Math.max(4, base.width - w - 4));
  const y = clamp(point.uy - h, 4, Math.max(4, base.height - h - 4));

  s.signMode = false;
  s.signPlacement = { page: idx, rect: { x, y, w, h } };
  document.body.classList.remove('sign-mode');
  el['btn-sign'].classList.add('is-active');
  for (const i of s.pageOrder) layoutPage(s, i);
  syncSignPlacementBar(s);
  setMsg('Drag the signature box to move it, then choose Sign document');
}

function startOrConfirmSign(s) {
  if (!hasDoc(s) || s !== state) return;
  if (s.signPlacement) {
    confirmSignature(s).catch((err) => setMsgFor(s, `Signing failed: ${err.message || err}`));
    return;
  }
  beginSign(s).catch((err) => setMsgFor(s, String(err.message || err)));
}

async function confirmSignature(s) {
  const placement = s.signPlacement;
  if (!hasDoc(s) || s !== state || !placement) return;
  const { page: idx, rect } = placement;

  el['sign-place-bar'].hidden = true;
  el['sign-name'].value = el['sign-name'].value || 'OmniPDF User';
  await prepareSignDialog();
  const ok = await openDialog(el['dlg-sign']);
  if (!ok) {
    if (s.closed) return;
    syncSignPlacementBar(s);
    setMsgFor(s, 'Signing cancelled — drag the box to adjust it, or sign when ready');
    return;
  }

  setMsgFor(s, 'Signing…');
  try {
    const result = await window.omnipdf.sign({
      bytes: s.bytes,
      pageIndex: idx,
      rect: { x: rect.x, y: rect.y, w: rect.w, h: rect.h },
      name: el['sign-name'].value.trim() || 'OmniPDF User',
      reason: el['sign-reason'].value.trim(),
      location: el['sign-location'].value.trim(),
      signatureImage: signatureBase64() || undefined,
      formValues: {},
      annotations: [],
      pageOps: { rotations: {} },
    });

    if (s.closed) return;
    await openBytes(s, result.bytes, s.fileName, s.filePath, { history: 'none', dirty: true });
    setDirty(s, true);
    pushHistory(s, { label: 'Sign document' });
    setMsgFor(s, 'Signed — save to write the signature to disk');
  } catch (err) {
    setMsgFor(s, `Signing failed: ${err.message || err}`);
    if (s.signPlacement) syncSignPlacementBar(s);
  }
}

/* ------------------------------------------------------------------- edit */

function editPayload(s) {
  const kept = new Set(s.pageOrder);
  const deletes = [];
  for (let i = 0; i < s.originalCount; i += 1) {
    if (!kept.has(i)) deletes.push(i);
  }
  return {
    bytes: s.bytes,
    formValues: s.formValues,
    annotations: s.annotations,
    pageOps: { rotations: s.rotations, deletes },
  };
}

async function buildEditedBytes(s) {
  const result = await window.omnipdf.edit(editPayload(s));
  if (result.errors && result.errors.length) {
    setMsg(`Completed with warnings: ${result.errors.slice(0, 2).join('; ')}`);
  }
  return result.bytes;
}

/** Bake pending edits into memory so index-based actions (OCR, sign) stay valid. */
async function flushEdits(s) {
  if (!hasDoc(s) || s.closed) return;
  if (
    !s.annotations.length &&
    !Object.keys(s.formValues).length &&
    !Object.keys(s.rotations).length &&
    s.pageOrder.length === s.originalCount
  ) {
    return;
  }
  const bytes = await buildEditedBytes(s);
  if (s.closed) return;
  await openBytes(s, bytes, s.fileName, s.filePath, { history: 'none', dirty: true });
  if (!s.closed) syncHistoryCurrent(s);
}

function pdfHasSignature(bytes) {
  try {
    return new TextDecoder('latin1').decode(bytes).includes('/ByteRange');
  } catch {
    return false;
  }
}

function hasPendingEdits(s) {
  return Boolean(
    s.annotations.length ||
      Object.keys(s.formValues).length ||
      Object.keys(s.rotations).length ||
      s.pageOrder.length !== s.originalCount
  );
}

async function save(s, asNew) {
  if (!hasDoc(s) || s.closed) return;
  const signed = pdfHasSignature(s.bytes);
  const pending = hasPendingEdits(s);

  if (signed && pending) {
    const ok = await openDialog(el['dlg-signedit']);
    if (!ok) {
      setMsgFor(s, 'Save cancelled');
      return;
    }
  }

  setMsgFor(s, 'Saving…');
  // A signed PDF must be written byte-for-byte. Running it through the edit
  // pipeline would rewrite the document and strip its signature dictionary.
  const bytes = signed && !pending ? s.bytes : await buildEditedBytes(s);

  let target = s.filePath;
  if (asNew || !target) {
    const out = await window.omnipdf.saveAs({
      bytes,
      suggestedName: s.fileName || 'document.pdf',
    });
    if (!out) {
      setMsgFor(s, 'Save cancelled');
      return;
    }
    target = out.path;
    s.fileName = out.name;
    s.filePath = out.path;
  } else {
    await window.omnipdf.save({ path: target, bytes });
  }

  if (s.closed) return;
  await openBytes(s, bytes, s.fileName, target, { history: 'none', dirty: false });
  setDirty(s, false);
  syncHistoryCurrent(s);
  refreshRecentFiles();
  setMsgFor(s, signed && pending ? 'Saved a modified copy; the previous signature was removed' : 'Saved');
}

async function extractCurrent(s) {
  if (!hasDoc(s) || s !== state) return;
  const bytes = await buildEditedBytes(s);
  const pageIndex = s.current;
  const out = await window.omnipdf.extract({ bytes, indices: [pageIndex] });
  if (!out) return;
  const saved = await window.omnipdf.saveAs({
    bytes: out.bytes,
    suggestedName: `page-${pageIndex + 1}.pdf`,
  });
  if (saved) setMsg(`Extracted to ${saved.name}`);
}

/* -------------------------------------------------------------------- OCR */

async function rasterize(s, idx, scale, lang) {
  const page = await s.pdf.getPage(idx + 1);
  const rotation = (((page.rotate + (s.rotations[idx] || 0)) % 360) + 360) % 360;
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

async function runOcr(s) {
  if (!hasDoc(s) || s !== state) return;
  const ok = await openDialog(el['dlg-ocr']);
  if (!ok || s !== state) return;

  const scope = el['ocr-scope'].value;
  const lang = el['ocr-lang'].value;

  await flushEdits(s);
  if (s !== state || s.closed) return;

  const targets = scope === 'current' ? [s.pageOrder[s.current]] : s.pageOrder.slice();
  const pages = [];
  for (const idx of targets) {
    setMsg(`Rasterising page ${pages.length + 1} of ${targets.length}…`);
    pages.push(await rasterize(s, idx, 200 / 72, lang));
  }

  setMsg(`Running OCR on ${pages.length} page${pages.length === 1 ? '' : 's'} — this may take a while…`);
  try {
    const result = await window.omnipdf.ocr({
      bytes: s.bytes,
      pages,
      formValues: {},
      annotations: [],
      pageOps: { rotations: {} },
    });
    if (s.closed) return;
    await openBytes(s, result.bytes, s.fileName, s.filePath, { history: 'none', dirty: true });
    setDirty(s, true);
    pushHistory(s, { label: 'Run OCR' });
    const words = result.results.reduce((sum, r) => sum + r.wordCount, 0);
    const conf = result.results.length
      ? Math.round(result.results.reduce((sum, r) => sum + r.confidence, 0) / result.results.length)
      : 0;
    setMsgFor(s, `OCR complete: ${words} words, mean confidence ${conf}% — save to keep the text layer`);
  } catch (err) {
    setMsgFor(s, `OCR failed: ${err.message || err}`);
  }
}

/* ----------------------------------------------------------------- search */

async function getTextItems(s, idx) {
  if (s.textItems.has(idx)) return s.textItems.get(idx);
  const page = await s.pdf.getPage(idx + 1);
  const content = await page.getTextContent();
  const items = content.items.filter((i) => i.str && i.str.trim());
  s.textItems.set(idx, items);
  return items;
}

async function runSearch(s, query) {
  if (!s || s.closed) return;
  const token = (s.searchToken += 1);
  s.searchHits = [];
  s.searchActive = 0;
  s.searchQuery = String(query || '');

  const needle = s.searchQuery.trim().toLowerCase();
  if (!needle || !hasDoc(s)) {
    if (s === state) {
      el['search-count'].textContent = '';
      syncFindButtons(s);
      for (const idx of s.pageOrder) paintSearch(s, idx);
    }
    return;
  }

  for (const idx of s.pageOrder) {
    const items = await getTextItems(s, idx);
    if (s.closed || token !== s.searchToken) return;
    for (const item of items) {
      if (item.str.toLowerCase().includes(needle)) s.searchHits.push({ page: idx, item });
    }
  }

  if (s !== state) return;
  el['search-count'].textContent = String(s.searchHits.length);
  syncFindButtons(s);
  for (const idx of s.pageOrder) paintSearch(s, idx);
  if (s.searchHits.length) gotoHit(s, 0);
  else {
    setMsg('No matches');
    syncFindButtons(s);
  }
}

function syncFindButtons(s) {
  const found = Boolean(s && s.searchHits.length);
  el['btn-find-prev'].disabled = !found;
  el['btn-find-next'].disabled = !found;
}

function focusSearch() {
  if (!hasDoc(state)) {
    setMsg('Open a PDF to search');
    return;
  }
  el.search.focus();
  el.search.select();
}

function clearSearch(s) {
  if (!hasDoc(s)) return;
  window.clearTimeout(s.searchTimer);
  el.search.value = '';
  s.searchQuery = '';
  runSearch(s, '').catch(() => {});
}

function isEditingTarget(target) {
  return Boolean(
    target instanceof HTMLElement &&
      (target.matches('input, textarea, select') || target.isContentEditable)
  );
}

function stepFind(delta) {
  const s = state;
  if (!hasDoc(s)) return;
  if (!s.searchHits.length) {
    if (!s.searchQuery.trim()) {
      focusSearch();
      return;
    }
    runSearch(s, s.searchQuery)
      .then(() => {
        if (delta < 0 && s === state && s.searchHits.length) {
          gotoHit(s, s.searchHits.length - 1);
        }
      })
      .catch(() => {});
    return;
  }
  gotoHit(s, s.searchActive + delta);
}

function gotoHit(s, i) {
  if (!s || s !== state || !s.searchHits.length) return;
  s.searchActive = (i + s.searchHits.length) % s.searchHits.length;
  const hit = s.searchHits[s.searchActive];
  const pos = s.pageOrder.indexOf(hit.page);
  if (pos >= 0) scrollToPage(s, pos);
  for (const idx of s.pageOrder) paintSearch(s, idx);
  el['search-count'].textContent = `${s.searchActive + 1}/${s.searchHits.length}`;
  syncFindButtons(s);
}

/* ------------------------------------------------------------- navigation */

function scrollToPage(s, pos) {
  if (s !== state || !hasDoc(s)) return;
  const safe = clamp(Number(pos) || 0, 0, Math.max(0, s.pageOrder.length - 1));
  s.current = safe;
  el['page-input'].value = String(safe + 1);
  for (const [idx, thumb] of s.thumbEls) {
    thumb.classList.toggle('is-current', s.pageOrder[safe] === idx);
  }
  const target = el.pages.children[safe];
  if (target) target.scrollIntoView({ block: 'start', behavior: 'auto' });
}

function focusPageInput() {
  if (!hasDoc(state)) {
    setMsg('Open a PDF first');
    return;
  }
  el['page-input'].focus();
  el['page-input'].select();
}

function updateCurrentPage(s) {
  if (!s || s !== state || !hasDoc(s)) return;
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
  s.current = best;
  el['page-input'].value = String(best + 1);
  for (const [idx, thumb] of s.thumbEls) {
    thumb.classList.toggle('is-current', s.pageOrder[best] === idx);
  }
}

async function applyScale(s) {
  if (!hasDoc(s) || s !== state || !s.pageEls.size) return;
  const oldScale = s.layoutScale || s.scale;
  const nextScale = s.scale;
  if (Math.abs(nextScale - oldScale) < 0.0001) return;

  const anchorPos = s.current;
  const anchorEl = el.pages.children[anchorPos] || null;
  const anchorOffset = anchorEl ? el.viewer.scrollTop - anchorEl.offsetTop : 0;

  // Resize the existing page boxes instead of rebuilding all 460 pages. The
  // visible pages are rerendered at the new scale; offscreen pages render when
  // they next intersect the viewport.
  for (const idx of s.pageOrder) {
    const entry = s.pageEls.get(idx);
    if (!entry) continue;
    const baseW = entry.baseW || (entry.vp ? entry.vp.width / oldScale : 0);
    const baseH = entry.baseH || (entry.vp ? entry.vp.height / oldScale : 0);
    const width = Math.max(1, Math.floor(baseW * nextScale));
    const height = Math.max(1, Math.floor(baseH * nextScale));
    entry.rendered = '';
    entry.vp = null;
    entry.renderSeq += 1;
    entry.div.style.width = `${width}px`;
    entry.div.style.height = `${height}px`;
    const canvas = entry.div.querySelector('.page-canvas');
    if (canvas) {
      canvas.width = 1;
      canvas.height = 1;
    }
    const textLayer = entry.div.querySelector('.text-layer');
    if (textLayer) textLayer.innerHTML = '';
    const searchLayer = entry.div.querySelector('.search-layer');
    if (searchLayer) searchLayer.innerHTML = '';
  }

  s.layoutScale = nextScale;
  await new Promise((resolve) => requestAnimationFrame(resolve));
  if (s !== state) return;
  if (anchorEl) {
    el.viewer.scrollTop = Math.max(0, anchorEl.offsetTop + anchorOffset * (nextScale / oldScale));
  }
  for (const idx of s.pageOrder) {
    const entry = s.pageEls.get(idx);
    if (entry && isVisible(entry.div)) renderPage(s, idx).catch(() => {});
  }
  updateCurrentPage(s);
}

async function setScale(s, next) {
  if (!hasDoc(s) || s !== state) return;
  const target = clamp(next, MIN_SCALE, MAX_SCALE);
  if (Math.abs(target - s.scale) < 0.0001) return;
  s.scale = target;
  syncChrome(s);
  await applyScale(s);
}

function scheduleScale(s, next) {
  if (!hasDoc(s) || s !== state) return;
  const target = clamp(next, MIN_SCALE, MAX_SCALE);
  if (Math.abs(target - s.scale) < 0.0001) return;
  s.scale = target;
  syncChrome(s);
  window.clearTimeout(scaleTimer);
  scaleTimer = window.setTimeout(() => {
    scaleTimer = null;
    if (s === state) applyScale(s).catch(() => {});
  }, 50);
}

function onZoomWheel(ev) {
  if (!hasDoc(state) || !(ev.ctrlKey || ev.metaKey)) return;
  const delta = Math.abs(ev.deltaY) >= Math.abs(ev.deltaX) ? ev.deltaY : ev.deltaX;
  if (!delta) return;
  ev.preventDefault();
  scheduleScale(state, state.scale * Math.exp(-delta * 0.0015));
}

function isVisible(node) {
  const box = node.getBoundingClientRect();
  const view = el.viewer.getBoundingClientRect();
  return box.bottom > view.top - 300 && box.top < view.bottom + 300;
}

async function fitWidth(s) {
  if (!hasDoc(s) || s !== state) return;
  const vp = await getViewport(s, s.pageOrder[s.current], 1);
  const available = el.viewer.clientWidth - 56;
  await setScale(s, available / Math.max(vp.width, 1));
}

async function fitPage(s) {
  if (!hasDoc(s) || s !== state) return;
  const vp = await getViewport(s, s.pageOrder[s.current], 1);
  const availableW = Math.max(120, el.viewer.clientWidth - 56);
  const availableH = Math.max(120, el.viewer.clientHeight - 40);
  await setScale(s, Math.min(availableW / Math.max(vp.width, 1), availableH / Math.max(vp.height, 1)));
}

async function actualSize(s) {
  if (!hasDoc(s) || s !== state) return;
  await setScale(s, 1);
}

/* --------------------------------------------------------------- commands */

function setTool(next) {
  tool = next;
  for (const button of document.querySelectorAll('#tool-group .tool')) {
    button.classList.toggle('is-active', button.dataset.tool === next);
  }
  if (hasDoc(state)) {
    for (const idx of state.pageOrder) layoutPage(state, idx);
  }
  setMsg(next === 'select' ? '' : `${next} tool — drag on a page`);
}

async function rotateCurrent(s) {
  if (!hasDoc(s) || s !== state) return;
  const idx = s.pageOrder[s.current];
  s.rotations[idx] = ((s.rotations[idx] || 0) + 90) % 360;
  const entry = s.pageEls.get(idx);
  if (entry) entry.rendered = '';
  const thumb = s.thumbEls.get(idx);
  if (thumb) thumb.dataset.done = '0';
  const vp = await getViewport(s, idx);
  if (s !== state) return;
  if (entry) {
    entry.baseW = vp.width / s.scale;
    entry.baseH = vp.height / s.scale;
    entry.div.style.width = `${Math.floor(vp.width)}px`;
    entry.div.style.height = `${Math.floor(vp.height)}px`;
    entry.vp = vp;
    await renderPage(s, idx);
  }
  setDirty(s, true);
  pushHistory(s, { label: 'Rotate page' });
  setMsg('Page rotated — save to apply');
}

async function deleteCurrent(s) {
  if (!hasDoc(s) || s !== state) return;
  if (s.pageOrder.length <= 1) {
    setMsg('Cannot delete the only page');
    return;
  }
  const pos = s.current;
  const idx = s.pageOrder[pos];
  const entry = s.pageEls.get(idx);
  if (entry && s.io) s.io.unobserve(entry.div);
  s.pageOrder.splice(pos, 1);
  s.pageEls.delete(idx);
  const thumb = s.thumbEls.get(idx);
  if (thumb) thumb.remove();
  s.thumbEls.delete(idx);
  await buildPages(s);
  if (s !== state) return;
  s.current = Math.min(pos, s.pageOrder.length - 1);
  el['page-total'].textContent = `/ ${s.pageOrder.length}`;
  el['page-input'].max = String(s.pageOrder.length);
  scrollToPage(s, s.current);
  setDirty(s, true);
  pushHistory(s, { label: 'Delete page' });
  setMsg('Page deleted — save to apply');
}

/* -------------------------------------------------------------------- open */

function existingTabFor(filePath) {
  if (!filePath) return null;
  const key = filePath.toLowerCase();
  return tabs.find((t) => t.filePath && t.filePath.toLowerCase() === key) || null;
}

async function openInNewTab(doc) {
  const existing = existingTabFor(doc.path);
  if (existing) {
    activateTab(existing);
    setMsg('Already open');
    refreshRecentFiles();
    return existing;
  }
  const tab = newTab();
  await openBytes(tab, doc.bytes, doc.name, doc.path);
  if (doc.path) refreshRecentFiles();
  return tab;
}

async function openPathInNewTab(filePath) {
  if (!filePath) return;
  try {
    const doc = await window.omnipdf.openPath(filePath);
    if (doc) await openInNewTab(doc);
    else refreshRecentFiles();
  } catch (err) {
    setMsg(`Could not open recent file: ${err.message || err}`);
    refreshRecentFiles();
  }
}

async function openFile() {
  const doc = await window.omnipdf.openFile();
  if (!doc) return;
  await openInNewTab(doc);
}

async function openDropped(file) {
  const path = window.omnipdf.pathForFile(file);
  if (path) {
    const doc = await window.omnipdf.openPath(path);
    if (doc) {
      await openInNewTab(doc);
      return;
    }
  }
  const buffer = new Uint8Array(await file.arrayBuffer());
  await openInNewTab({ path: null, name: file.name, bytes: buffer });
}

function renderRecentFiles(items) {
  const list = el['recent-list'];
  list.replaceChildren();
  const valid = Array.isArray(items) ? items : [];
  el['recent-files'].hidden = !valid.length;
  for (const item of valid) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'recent-item';
    button.title = item.path;

    const name = document.createElement('span');
    name.className = 'recent-name';
    name.textContent = item.name;
    const folder = document.createElement('span');
    folder.className = 'recent-folder';
    folder.textContent = item.folder;
    button.append(name, folder);
    button.addEventListener('click', () => openPathInNewTab(item.path));
    list.appendChild(button);
  }
}

async function refreshRecentFiles() {
  try {
    renderRecentFiles(await window.omnipdf.listRecent());
  } catch {
    renderRecentFiles([]);
  }
}

/* --------------------------------------------------------------- properties */

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPdfDate(value) {
  if (!value) return '—';
  const m = /^D:(\d{4})(\d{2})(\d{2})(\d{2})?(\d{2})?(\d{2})?/.exec(String(value));
  if (!m) return String(value);
  const date = new Date(
    Number(m[1]),
    Number(m[2]) - 1,
    Number(m[3]),
    Number(m[4] || 0),
    Number(m[5] || 0),
    Number(m[6] || 0)
  );
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString();
}

async function collectDocumentProperties(s) {
  if (!hasDoc(s)) return null;
  let info = {};
  try {
    const meta = await s.pdf.getMetadata();
    info = (meta && meta.info) || {};
  } catch {
    info = {};
  }

  let pageSize = '—';
  try {
    const idx = s.pageOrder[s.current] ?? s.pageOrder[0];
    const page = await s.pdf.getPage(idx + 1);
    const rotation = (((page.rotate + (s.rotations[idx] || 0)) % 360) + 360) % 360;
    const vp = page.getViewport({ scale: 1, rotation });
    pageSize = `${Math.round(vp.width)} × ${Math.round(vp.height)} pt`;
  } catch {
    /* keep the placeholder */
  }

  return {
    fileName: s.fileName || 'Untitled',
    title: info.Title || '',
    author: info.Author || '',
    subject: info.Subject || '',
    keywords: info.Keywords || '',
    creator: info.Creator || '',
    producer: info.Producer || '',
    created: formatPdfDate(info.CreationDate),
    modified: formatPdfDate(info.ModDate),
    version: info.PDFFormatVersion || '—',
    pages: s.pageOrder.length,
    pageSize,
    fileSize: formatBytes(s.bytes ? s.bytes.length : 0),
    path: s.filePath || '',
  };
}

async function showProperties() {
  const s = state;
  if (!hasDoc(s)) {
    setMsg('Open a PDF to view its properties');
    return;
  }
  let props;
  try {
    props = await collectDocumentProperties(s);
  } catch (err) {
    setMsg(`Could not read document properties: ${err.message || err}`);
    return;
  }
  if (!props || s.closed) return;

  const rows = [
    ['File name', props.fileName],
    ['Title', props.title || '—'],
    ['Author', props.author || '—'],
    ['Subject', props.subject || '—'],
    ['Keywords', props.keywords || '—'],
    ['Creator', props.creator || '—'],
    ['Producer', props.producer || '—'],
    ['Created', props.created],
    ['Modified', props.modified],
    ['PDF version', props.version],
    ['Pages', String(props.pages)],
    ['Current page size', props.pageSize],
    ['File size', props.fileSize],
  ];
  el['props-body'].replaceChildren();
  for (const [label, value] of rows) {
    const dt = document.createElement('dt');
    dt.textContent = label;
    const dd = document.createElement('dd');
    dd.textContent = value || '—';
    el['props-body'].append(dt, dd);
  }
  el['props-path'].textContent = props.path || 'This PDF has not been saved yet.';
  el['props-reveal'].disabled = !props.path;
  el['props-reveal'].dataset.path = props.path;
  await openDialog(el['dlg-props']);
}

/* ------------------------------------------------------------------ print */

function clearPrintImages() {
  for (const url of printUrls) URL.revokeObjectURL(url);
  printUrls = [];
  el['print-root'].replaceChildren();
}

async function preparePrintImages(s) {
  if (!hasDoc(s)) return 0;
  clearPrintImages();
  const bytes = hasPendingEdits(s) ? await buildEditedBytes(s) : s.bytes;
  const doc = await pdfjsLib.getDocument(pdfLoadOptions(bytes)).promise;
  const count = doc.numPages;
  try {
    for (let pageNumber = 1; pageNumber <= count; pageNumber += 1) {
      if (s.closed) return 0;
      setMsgFor(s, `Preparing page ${pageNumber} of ${count} for print…`);
      const page = await doc.getPage(pageNumber);
      const base = page.getViewport({ scale: 1 });
      const scale = Math.min(
        PRINT_DPI / 72,
        Math.sqrt(MAX_PRINT_PIXELS / Math.max(1, base.width * base.height))
      );
      const vp = page.getViewport({ scale });
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.floor(vp.width));
      canvas.height = Math.max(1, Math.floor(vp.height));
      const ctx = canvas.getContext('2d', { alpha: false });
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      await page.render({ canvasContext: ctx, canvas, viewport: vp }).promise;

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
      if (!blob) throw new Error(`Could not prepare page ${pageNumber}`);
      const url = URL.createObjectURL(blob);
      printUrls.push(url);

      const image = new Image();
      image.alt = `Page ${pageNumber}`;
      image.src = url;
      await image.decode();
      const wrapper = document.createElement('div');
      wrapper.className = 'print-page';
      wrapper.appendChild(image);
      el['print-root'].appendChild(wrapper);
    }
  } finally {
    try {
      await doc.destroy();
    } catch {
      /* ignore */
    }
  }
  return count;
}

async function printCurrent(s) {
  if (printBusy) return;
  if (!hasDoc(s) || s !== state) {
    setMsg('Open a PDF to print');
    return;
  }

  printBusy = true;
  el['btn-print'].disabled = true;
  try {
    const count = await preparePrintImages(s);
    if (!count || s.closed) return;
    setMsgFor(s, `Opening the print dialog for ${count} page${count === 1 ? '' : 's'}…`);
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    const result = await window.omnipdf.printDocument();
    if (s.closed) return;
    if (result && result.success) {
      setMsgFor(s, `Print job sent — ${count} page${count === 1 ? '' : 's'}`);
    } else if (result && result.failureReason && !/cancel/i.test(result.failureReason)) {
      setMsgFor(s, `Printing failed: ${result.failureReason}`);
    } else {
      setMsgFor(s, 'Print cancelled');
    }
  } catch (err) {
    setMsgFor(s, `Printing failed: ${err.message || err}`);
  } finally {
    clearPrintImages();
    printBusy = false;
    el['btn-print'].disabled = false;
  }
}

/* ---------------------------------------------------------------- updates */

let updateStatus = null;

function updateUpdateButton(status) {
  const button = el['btn-update'];
  if (!button) return;
  const state = status && status.state;
  button.classList.toggle('has-update', state === 'downloaded');
  button.classList.toggle('is-busy', state === 'checking' || state === 'downloading');

  if (state === 'downloaded') {
    button.textContent = 'Restart to update';
    button.title = 'An update is ready; restart to install it';
  } else if (state === 'downloading') {
    button.textContent = `Downloading… ${status.percent ?? 0}%`;
    button.title = 'An update is downloading in the background';
  } else if (state === 'checking') {
    button.textContent = 'Checking…';
    button.title = 'Checking for updates';
  } else {
    button.textContent = 'Updates';
    button.title = 'Check for updates';
  }
}

function hideUpdateBannerSoon(message) {
  window.setTimeout(() => {
    if (el['update-text'].textContent === message && el['update-action'].hidden) {
      el['update-banner'].hidden = true;
    }
  }, 4000);
}

function showUpdateBanner(message, actionLabel, actionKind) {
  el['update-text'].textContent = message;
  el['update-action'].hidden = !actionLabel;
  el['update-action'].textContent = actionLabel || '';
  el['update-action'].dataset.kind = actionKind || '';
  el['update-banner'].hidden = false;
}

function renderUpdate(status) {
  if (!status || !status.state) return;
  updateStatus = status;
  updateUpdateButton(status);
  const interactive = status.interactive === true;

  switch (status.state) {
    case 'checking':
      if (interactive) showUpdateBanner('Checking for updates…');
      break;
    case 'downloading': {
      const percent = status.percent ?? 0;
      const label = status.version ? `OmniPDF ${status.version}` : 'an update';
      showUpdateBanner(`Downloading ${label}… ${percent}%`);
      break;
    }
    case 'downloaded':
      showUpdateBanner(
        `OmniPDF ${status.version || ''} is ready. It installs when you quit.`,
        'Restart now',
        'install'
      );
      break;
    case 'none': {
      if (!interactive) break;
      const message = `OmniPDF ${status.version || ''} is up to date.`;
      showUpdateBanner(message);
      hideUpdateBannerSoon(message);
      break;
    }
    case 'error': {
      if (!interactive) break;
      const message = `Update failed: ${status.message || 'unknown error'}`;
      showUpdateBanner(message);
      hideUpdateBannerSoon(message);
      break;
    }
    case 'unsupported':
    case 'unconfigured': {
      const message = status.message || 'Updates are not configured.';
      showUpdateBanner(message);
      hideUpdateBannerSoon(message);
      break;
    }
    default:
      break;
  }
}

async function restartForUpdate() {
  const dirty = tabs.filter((tab) => tab.dirty).map((tab) => tab.fileName || 'Untitled');
  if (dirty.length) {
    el['update-confirm-text'].textContent =
      `These documents have unsaved changes: ${dirty.join(', ')}. ` +
      'Restarting now discards them and installs the update.';
    const ok = await openDialog(el['dlg-update']);
    if (!ok) return;
  }

  allowUnload = true;
  const result = await window.omnipdf.installUpdate();
  if (!result || !result.installing) {
    allowUnload = false;
    renderUpdate(result);
  }
}

function bindUpdates() {
  window.omnipdf.onUpdate(renderUpdate);
  window.omnipdf
    .updateState()
    .then((status) => {
      updateStatus = status || null;
      if (status && status.state && status.state !== 'idle') renderUpdate(status);
      else updateUpdateButton(status);
    })
    .catch(() => {});

  el['btn-update'].addEventListener('click', async () => {
    const state = updateStatus && updateStatus.state;
    if (state === 'downloaded') {
      restartForUpdate();
      return;
    }
    if (state === 'checking' || state === 'downloading') {
      renderUpdate(updateStatus);
      return;
    }
    try {
      const status = await window.omnipdf.checkForUpdates();
      if (status) renderUpdate(status);
    } catch (err) {
      showUpdateBanner(`Update check failed: ${err.message || err}`);
    }
  });

  el['update-action'].addEventListener('click', () => {
    if (el['update-action'].dataset.kind === 'install') restartForUpdate();
  });
  el['update-dismiss'].addEventListener('click', () => {
    el['update-banner'].hidden = true;
  });
}

/* -------------------------------------------------------------------- init */

function bind() {
  setupSignaturePad();

  window.addEventListener('beforeunload', (ev) => {
    if (allowUnload) return;
    if (tabs.some((tab) => tab.dirty)) {
      ev.preventDefault();
      ev.returnValue = '';
    }
  });

  el['btn-open'].addEventListener('click', () => openFile());
  el['btn-new-tab'].addEventListener('click', () => openFile());
  el['btn-save'].addEventListener('click', () => save(state, false));
  el['btn-saveas'].addEventListener('click', () => save(state, true));
  el['btn-print'].addEventListener('click', () => printCurrent(state));
  el['recent-clear'].addEventListener('click', async () => {
    try {
      await window.omnipdf.clearRecent();
    } finally {
      refreshRecentFiles();
    }
  });
  el['props-reveal'].addEventListener('click', () => {
    const filePath = el['props-reveal'].dataset.path;
    if (filePath) window.omnipdf.reveal(filePath);
  });
  el['btn-undo'].addEventListener('click', () => undoDocument(state));
  el['btn-redo'].addEventListener('click', () => redoDocument(state));
  el['btn-ocr'].addEventListener('click', () => runOcr(state));
  el['btn-sign'].addEventListener('click', () => startOrConfirmSign(state));
  el['sign-place-confirm'].addEventListener('click', () => {
    if (state) confirmSignature(state).catch((err) => setMsg(`Signing failed: ${err.message || err}`));
  });
  el['sign-place-cancel'].addEventListener('click', () => {
    if (state) cancelSignPlacement(state);
  });
  el['btn-rotate'].addEventListener('click', () => rotateCurrent(state));
  el['btn-delete-page'].addEventListener('click', () => deleteCurrent(state));
  el['btn-extract'].addEventListener('click', () => extractCurrent(state));

  el['btn-prev'].addEventListener('click', () => {
    if (state) scrollToPage(state, Math.max(0, state.current - 1));
  });
  el['btn-next'].addEventListener('click', () => {
    if (state) scrollToPage(state, Math.min(state.pageOrder.length - 1, state.current + 1));
  });
  el['page-input'].addEventListener('change', () => {
    const s = state;
    if (!s) return;
    const value = clamp(Number(el['page-input'].value) || 1, 1, s.pageOrder.length || 1);
    scrollToPage(s, value - 1);
  });

  el['btn-zoom-in'].addEventListener('click', () => {
    if (state) setScale(state, state.scale * 1.2);
  });
  el['btn-zoom-out'].addEventListener('click', () => {
    if (state) setScale(state, state.scale / 1.2);
  });
  el['btn-fit'].addEventListener('click', () => {
    if (state) fitWidth(state);
  });
  el['btn-fit-page'].addEventListener('click', () => {
    if (state) fitPage(state);
  });
  el['btn-actual'].addEventListener('click', () => {
    if (state) actualSize(state);
  });
  el['btn-find-prev'].addEventListener('click', () => stepFind(-1));
  el['btn-find-next'].addEventListener('click', () => stepFind(1));

  for (const button of document.querySelectorAll('#tool-group .tool')) {
    button.addEventListener('click', () => setTool(button.dataset.tool));
  }

  el.search.addEventListener('input', () => {
    const s = state;
    if (!s) return;
    s.searchQuery = el.search.value;
    window.clearTimeout(s.searchTimer);
    s.searchTimer = window.setTimeout(() => {
      if (s === state) runSearch(s, el.search.value);
    }, 220);
  });
  el.search.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter' && state) {
      ev.preventDefault();
      gotoHit(state, state.searchActive + (ev.shiftKey ? -1 : 1));
    } else if (ev.key === 'Escape' && state) {
      ev.preventDefault();
      clearSearch(state);
      el.search.blur();
    }
  });

  let scrollTimer = null;
  el.viewer.addEventListener('scroll', () => {
    window.clearTimeout(scrollTimer);
    scrollTimer = window.setTimeout(() => updateCurrentPage(state), 90);
  });
  el.viewer.addEventListener('wheel', onZoomWheel, { passive: false });

  document.addEventListener('keydown', (ev) => {
    if (ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === 's') {
      ev.preventDefault();
      save(state, ev.shiftKey);
      return;
    }
    if (ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === 'f') {
      ev.preventDefault();
      focusSearch();
      return;
    }
    if (ev.ctrlKey && !ev.altKey && ev.key.toLowerCase() === 'g') {
      ev.preventDefault();
      focusPageInput();
      return;
    }
    if (ev.ctrlKey && !ev.altKey && ev.key === 'Tab') {
      ev.preventDefault();
      cycleTabs(ev.shiftKey ? -1 : 1);
      return;
    }
    if (ev.key === 'F3') {
      ev.preventDefault();
      stepFind(ev.shiftKey ? -1 : 1);
      return;
    }
    if (!isEditingTarget(ev.target) && !ev.ctrlKey && !ev.altKey && !ev.metaKey) {
      if (ev.key === 'PageDown' || ev.key === 'PageUp') {
        if (!hasDoc(state)) return;
        ev.preventDefault();
        scrollToPage(state, state.current + (ev.key === 'PageDown' ? 1 : -1));
        return;
      }
    }
    if (!isEditingTarget(ev.target) && ev.ctrlKey && !ev.altKey && (ev.key === 'Home' || ev.key === 'End')) {
      if (!hasDoc(state)) return;
      ev.preventDefault();
      scrollToPage(state, ev.key === 'Home' ? 0 : state.pageOrder.length - 1);
      return;
    }
    if (ev.key === 'Escape') {
      if (document.activeElement === el.search) {
        ev.preventDefault();
        clearSearch(state);
        el.search.blur();
        return;
      }
      if (state && state.signPlacement) {
        cancelSignPlacement(state);
        return;
      }
      if (state && state.signMode) {
        state.signMode = false;
        document.body.classList.remove('sign-mode');
        el['btn-sign'].classList.remove('is-active');
        for (const idx of state.pageOrder) layoutPage(state, idx);
        setMsg('');
      }
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
    const files = Array.from(ev.dataTransfer?.files || []).filter(
      (file) => /\.pdf$/i.test(file.name) || file.type === 'application/pdf'
    );
    if (!files.length) {
      setMsg('Only PDF files can be opened');
      return;
    }
    (async () => {
      for (const file of files) {
        try {
          await openDropped(file);
        } catch (err) {
          setMsg(String(err.message || err));
        }
      }
    })();
  });

  window.omnipdf.onMenu((payload) => {
    const action = typeof payload === 'string' ? payload : payload && payload.action;
    const filePath = payload && typeof payload === 'object' ? payload.path : '';
    if (action === 'open' || action === 'newTab') openFile();
    else if (action === 'openRecent') openPathInNewTab(filePath);
    else if (action === 'recentCleared') refreshRecentFiles();
    else if (action === 'closeTab') closeTab(state);
    else if (action === 'nextTab') cycleTabs(1);
    else if (action === 'prevTab') cycleTabs(-1);
    else if (action === 'save') save(state, false);
    else if (action === 'saveAs') save(state, true);
    else if (action === 'print') printCurrent(state);
    else if (action === 'properties') showProperties();
    else if (action === 'extract') extractCurrent(state);
    else if (action === 'ocr') runOcr(state);
    else if (action === 'sign') startOrConfirmSign(state);
    else if (action === 'rotate') rotateCurrent(state);
    else if (action === 'zoomIn') {
      if (state) setScale(state, state.scale * 1.2);
    } else if (action === 'zoomOut') {
      if (state) setScale(state, state.scale / 1.2);
    } else if (action === 'fit') {
      if (state) fitWidth(state);
    } else if (action === 'fitPage') {
      if (state) fitPage(state);
    } else if (action === 'actualSize') {
      if (state) actualSize(state);
    } else if (action === 'gotoPage') focusPageInput();
    else if (action === 'focusSearch') focusSearch();
    else if (action === 'cert') showCert();
  });

  // Windows hands us the file on the command line (Open with / double-click).
  window.omnipdf.onOpenPaths(async (paths) => {
    for (const filePath of paths) {
      try {
        const doc = await window.omnipdf.openPath(filePath);
        if (doc) await openInNewTab(doc);
      } catch (err) {
        setMsg(String(err.message || err));
      }
    }
  });

  refreshRecentFiles();
  bindUpdates();
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

    const first = newTab();
    await openBytes(first, bytes, 'fixture.pdf', null);
    const idx = first.pageOrder[0];
    await renderPage(first, idx);
    const items = await getTextItems(first, idx);
    const entry = first.pageEls.get(idx);
    const page0 = await first.pdf.getPage(1);
    const anns = await page0.getAnnotations({ intent: 'display' });

    // Ease-of-use paths: metadata, find navigation, and print preparation.
    const props = await collectDocumentProperties(first);
    await runSearch(first, 'fixture');
    const findHits = first.searchHits.length;
    const findOnPage = first.searchHits[0] ? first.searchHits[0].page : -1;
    el['btn-find-next'].click();
    const findAfterNext = first.searchActive;
    await runSearch(first, '');

    const printPages = await preparePrintImages(first);
    const printRendered = el['print-root'].querySelectorAll('.print-page img').length;
    const printImageWidth = printRendered
      ? el['print-root'].querySelector('.print-page img').naturalWidth
      : 0;
    clearPrintImages();
    renderRecentFiles([
      { name: 'recent-smoke.pdf', folder: 'C:\\Temp', path: 'C:\\Temp\\recent-smoke.pdf' },
    ]);
    const recentRendered =
      !el['recent-files'].hidden && el['recent-list'].querySelectorAll('.recent-item').length === 1;
    renderRecentFiles([]);
    const featuresCheck =
      Boolean(props) &&
      props.pages === first.pageOrder.length &&
      props.fileSize !== '—' &&
      findHits === 3 &&
      findOnPage === 0 &&
      findAfterNext === 1 &&
      printPages === first.pageOrder.length &&
      printRendered === printPages &&
      printImageWidth > 0 &&
      recentRendered;

    // A second document must not disturb the first, and switching back has to
    // rebuild the first tab's pages from that tab's own state.
    const second = newTab();
    await openBytes(second, bytes, 'fixture-second.pdf', null);
    const twoTabsOpen = tabs.length;
    const secondLabel = second.ui ? second.ui.label.textContent : '';

    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const press = (key, shift) =>
      document.dispatchEvent(
        new KeyboardEvent('keydown', {
          key,
          ctrlKey: true,
          shiftKey: Boolean(shift),
          bubbles: true,
        })
      );

    // Keyboard path: Ctrl+Tab cycles tabs, Ctrl+W closes only the active one.
    press('Tab');
    await wait(250);
    const cycledToFirst = state === first;
    for (let i = 0; i < 40 && first.pageEls.size < first.pageOrder.length; i += 1) await wait(100);
    const restoredPages = first.pageEls.size;

    press('Tab');
    await wait(250);
    const cycledToSecond = state === second;

    await closeTab(second);
    await wait(700);
    const tabsAfterClose = tabs.length;
    const stillFirst = state === first;
    const title = document.title;

    const tabCheck =
      twoTabsOpen === 2 &&
      secondLabel === 'fixture-second.pdf' &&
      cycledToFirst &&
      restoredPages === first.pageOrder.length &&
      cycledToSecond &&
      tabsAfterClose === 1 &&
      stillFirst;

    return {
      build: BUILD_TAG,
      ok: items.length > 0 && tabCheck && featuresCheck,
      pages: first.pdf.numPages,
      textItems: items.length,
      sample: items.map((i) => i.str).join(' ').slice(0, 100),
      widgets: entry ? entry.widgets.length : 0,
      widgetError: entry ? entry.widgetError || null : 'no entry',
      widgetDiag: entry ? entry.widgetDiag : null,
      annotations: anns.map((a) => a.subtype + ':' + (a.fieldName || '-')).slice(0, 6),
      canvasWidth: entry ? entry.div.querySelector('.page-canvas').width : 0,
      features: {
        propsPages: props ? props.pages : 0,
        propsSize: props ? props.fileSize : '',
        findHits,
        findOnPage,
        findAfterNext,
        printPages,
        printRendered,
        printImageWidth,
        recentRendered,
        featuresCheck,
      },
      tabs: {
        twoTabsOpen,
        secondLabel,
        cycledToFirst,
        restoredPages,
        cycledToSecond,
        tabsAfterClose,
        stillFirst,
        title,
        tabCheck,
      },
    };
  } catch (error) {
    return { ok: false, error: String((error && error.stack) || error) };
  }
};

bind();
syncChrome(null);
