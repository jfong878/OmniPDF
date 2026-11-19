'use strict';

const MENU_ID = 'omnipdf-open-link';
const TRANSFER_TTL_MS = 10 * 60 * 1000;
const DIAGNOSTICS_KEY = 'diagnostics';
const DIAGNOSTICS_LIMIT = 25;

function buildContextMenu() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create(
      {
        id: MENU_ID,
        title: 'Open PDF in OmniPDF',
        contexts: ['link'],
        documentUrlPatterns: ['https://mail.google.com/*'],
      },
      () => {
        // Chrome reports the duplicate-id error after a service-worker restart.
        void chrome.runtime.lastError;
      }
    );
  });
}

function cleanDiagnosticText(value, limit) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function redactDiagnosticUrl(value) {
  const text = cleanDiagnosticText(value, 2048);
  if (!text) return '';
  try {
    const url = new URL(text);
    // Diagnostics may only keep Gmail attachment URLs. Anything else -- another
    // scheme, host, or port -- is dropped instead of storing its origin.
    if (url.origin !== 'https://mail.google.com') return '';
    const kept = new URLSearchParams();
    for (const key of ['attid', 'view', 'disp']) {
      const param = url.searchParams.get(key);
      if (param) kept.set(key, param);
    }
    const query = kept.toString();
    return `${url.origin}${url.pathname}${query ? `?${query}` : ''}`;
  } catch {
    return '';
  }
}

let diagnosticWrites = Promise.resolve();

function recordDiagnostic(entry) {
  const record = {
    id: crypto.randomUUID(),
    at: Date.now(),
    source: ['gmail', 'viewer'].includes(entry?.source) ? entry.source : 'extension',
    stage: cleanDiagnosticText(entry?.stage, 40) || 'unknown',
    message: cleanDiagnosticText(entry?.message, 500) || 'Unknown error',
  };
  const name = cleanDiagnosticText(entry?.name, 200);
  if (name) record.name = name;
  const url = redactDiagnosticUrl(entry?.url);
  if (url) record.url = url;
  if (Number.isFinite(entry?.status) && entry.status > 0) record.status = entry.status;
  if (Number.isFinite(entry?.bytes) && entry.bytes > 0) record.bytes = entry.bytes;
  if (Number.isFinite(entry?.durationMs)) {
    record.durationMs = Math.max(0, Math.round(entry.durationMs));
  }

  diagnosticWrites = diagnosticWrites
    .then(async () => {
      const stored = await chrome.storage.local.get(DIAGNOSTICS_KEY);
      const existing = Array.isArray(stored[DIAGNOSTICS_KEY]) ? stored[DIAGNOSTICS_KEY] : [];
      await chrome.storage.local.set({
        [DIAGNOSTICS_KEY]: [record, ...existing].slice(0, DIAGNOSTICS_LIMIT),
      });
    })
    .catch(() => {});
  return diagnosticWrites;
}

async function cleanupStaleTransfers() {
  try {
    const all = await chrome.storage.local.get(null);
    const cutoff = Date.now() - TRANSFER_TTL_MS;
    const stale = Object.entries(all)
      .filter(
        ([key, value]) =>
          key.startsWith('pending:') &&
          (!value || !Number.isFinite(value.createdAt) || value.createdAt < cutoff)
      )
      .map(([key]) => key);
    if (stale.length) await chrome.storage.local.remove(stale);
  } catch {
    // The viewer removes the key it consumes; startup cleanup is best effort.
  }
}

chrome.runtime.onInstalled.addListener(() => {
  buildContextMenu();
  cleanupStaleTransfers();
});
chrome.runtime.onStartup.addListener(() => {
  buildContextMenu();
  cleanupStaleTransfers();
});

async function ensureGmailScript(tabId) {
  try {
    await chrome.tabs.sendMessage(tabId, { type: 'omnipdf-ping' });
    return;
  } catch {
    // A Gmail tab opened before the extension was installed still needs the
    // attachment button and the fetch handler injected once.
    await chrome.scripting.executeScript({ target: { tabId }, files: ['gmail.js'] });
    await chrome.scripting.insertCSS({ target: { tabId }, files: ['gmail.css'] });
  }
}

async function openViewer(transferId, name) {
  const url = new URL(chrome.runtime.getURL('viewer.html'));
  if (transferId) url.searchParams.set('transfer', transferId);
  if (name) url.searchParams.set('name', name);
  await chrome.tabs.create({ url: url.href });
}

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID || !info.linkUrl || !tab?.id) return;
  (async () => {
    try {
      await ensureGmailScript(tab.id);
      await chrome.tabs.sendMessage(tab.id, {
        type: 'omnipdf-fetch-attachment',
        url: info.linkUrl,
      });
    } catch (error) {
      console.warn('OmniPDF could not reach the Gmail attachment:', error);
      recordDiagnostic({
        source: 'extension',
        stage: 'handoff',
        message: String(error?.message || error),
        url: info.linkUrl,
      });
    }
  })();
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type === 'omnipdf-diagnostic') {
    const senderUrl = String(sender.url || '');
    const fromGmail = senderUrl.startsWith('https://mail.google.com/');
    const fromViewer = senderUrl.startsWith(chrome.runtime.getURL('viewer.html'));
    if (!fromGmail && !fromViewer) {
      sendResponse({ ok: false, error: 'Unexpected sender' });
      return false;
    }
    recordDiagnostic({ ...message.entry, source: fromGmail ? 'gmail' : 'viewer' }).then(() =>
      sendResponse({ ok: true })
    );
    return true;
  }

  if (message?.type === 'open-transfer') {
    const senderUrl = String(sender.url || '');
    if (!senderUrl.startsWith('https://mail.google.com/')) {
      sendResponse({ ok: false, error: 'Unexpected sender' });
      return false;
    }
    openViewer(message.transferId, message.name)
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  if (message?.type === 'open-viewer') {
    openViewer()
      .then(() => sendResponse({ ok: true }))
      .catch((error) => sendResponse({ ok: false, error: String(error.message || error) }));
    return true;
  }

  return false;
});
