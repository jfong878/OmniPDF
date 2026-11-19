'use strict';

const DIAGNOSTICS_KEY = 'diagnostics';

const STAGE_LABELS = {
  fetch: 'Fetch failed',
  http: 'HTTP error',
  size: 'Size limit',
  content: 'Not a PDF',
  storage: 'Local storage failed',
  transfer: 'Transfer failed',
  handoff: 'Gmail handoff failed',
  inject: 'Script injection failed',
  load: 'Viewer load failed',
  start: 'Viewer start failed',
};

const panel = document.getElementById('diagnostics');
const list = document.getElementById('diagnostics-list');
const empty = document.getElementById('diagnostics-empty');
const count = document.getElementById('diagnostics-count');
const copyButton = document.getElementById('diagnostics-copy');
const clearButton = document.getElementById('diagnostics-clear');

let diagnostics = [];
let copyTimer = null;

function timestamp(value) {
  const ms = Number(value);
  return Number.isFinite(ms) && ms > 0 && ms <= 8.64e15 ? ms : Date.now();
}

function formatTime(value) {
  const date = new Date(timestamp(value));
  try {
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return '';
  }
}

function formatBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

function sourceLabel(source) {
  if (source === 'gmail') return 'Gmail';
  if (source === 'viewer') return 'Viewer';
  return 'Extension';
}

function renderDiagnostics() {
  list.textContent = '';
  const hasEntries = diagnostics.length > 0;
  count.textContent = String(diagnostics.length);
  count.hidden = !hasEntries;
  empty.hidden = hasEntries;
  list.hidden = !hasEntries;
  copyButton.disabled = !hasEntries;
  clearButton.disabled = !hasEntries;

  for (const entry of diagnostics) {
    const item = document.createElement('li');

    const head = document.createElement('div');
    head.className = 'diagnostics-head';
    const label = document.createElement('strong');
    label.textContent = STAGE_LABELS[entry.stage] || entry.stage || 'Failure';
    const time = document.createElement('time');
    time.dateTime = new Date(timestamp(entry.at)).toISOString();
    time.textContent = formatTime(entry.at);
    head.append(label, time);

    const message = document.createElement('p');
    message.className = 'diagnostics-message';
    message.textContent = entry.message || 'Unknown error';

    const meta = document.createElement('p');
    meta.className = 'diagnostics-meta';
    meta.textContent = [
      sourceLabel(entry.source),
      entry.name || '',
      formatBytes(entry.bytes),
      Number.isFinite(entry.status) && entry.status > 0 ? `HTTP ${entry.status}` : '',
      Number.isFinite(entry.durationMs) ? `${Math.round(entry.durationMs)} ms` : '',
    ]
      .filter(Boolean)
      .join(' · ');

    item.append(head, message);
    if (meta.textContent) item.append(meta);
    if (entry.url) {
      const url = document.createElement('code');
      url.className = 'diagnostics-url';
      url.textContent = entry.url;
      item.append(url);
    }
    list.append(item);
  }
}

function diagnosticsText() {
  const header = [
    `OmniPDF ${chrome.runtime.getManifest?.().version || ''} Gmail diagnostics`.trim(),
    `Browser: ${navigator.userAgent}`,
    `Recorded failures: ${diagnostics.length}`,
  ].join('\n');
  const entries = diagnostics.map((entry) => {
    const lines = [
      `${new Date(timestamp(entry.at)).toISOString()} [${sourceLabel(entry.source)}] ${
        STAGE_LABELS[entry.stage] || entry.stage || 'Failure'
      }: ${entry.message || 'Unknown error'}`,
    ];
    if (entry.name) lines.push(`  file: ${entry.name}`);
    if (entry.url) lines.push(`  url: ${entry.url}`);
    if (Number.isFinite(entry.status) && entry.status > 0) lines.push(`  http: ${entry.status}`);
    if (Number.isFinite(entry.bytes)) lines.push(`  bytes: ${entry.bytes}`);
    if (Number.isFinite(entry.durationMs)) lines.push(`  elapsed: ${entry.durationMs} ms`);
    return lines.join('\n');
  });
  return [header, ...entries].join('\n\n');
}

async function loadDiagnostics() {
  try {
    const stored = await chrome.storage.local.get(DIAGNOSTICS_KEY);
    diagnostics = Array.isArray(stored[DIAGNOSTICS_KEY])
      ? stored[DIAGNOSTICS_KEY].filter((entry) => entry && typeof entry === 'object')
      : [];
  } catch {
    diagnostics = [];
  }
  renderDiagnostics();
  if (diagnostics.length) panel.open = true;
}

document.getElementById('open-viewer').addEventListener('click', () => {
  chrome.runtime.sendMessage({ type: 'open-viewer' });
  window.close();
});

document.getElementById('open-gmail').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://mail.google.com/' });
  window.close();
});

copyButton.addEventListener('click', async () => {
  if (!diagnostics.length) return;
  clearTimeout(copyTimer);
  try {
    await navigator.clipboard.writeText(diagnosticsText());
    copyButton.textContent = 'Copied';
  } catch {
    copyButton.textContent = 'Copy failed';
  }
  copyTimer = setTimeout(() => {
    copyButton.textContent = 'Copy details';
  }, 1600);
});

clearButton.addEventListener('click', async () => {
  try {
    await chrome.storage.local.remove(DIAGNOSTICS_KEY);
  } catch {
    // The list still clears for this popup session.
  }
  diagnostics = [];
  renderDiagnostics();
});

loadDiagnostics();
