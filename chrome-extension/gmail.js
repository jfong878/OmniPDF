'use strict';

if (!globalThis.__omnipdfGmailLoaded) {
  globalThis.__omnipdfGmailLoaded = true;

  const MAX_BYTES = 48 * 1024 * 1024;
  const BUTTON_CLASS = 'omnipdf-gmail-open';
  const TOAST_ID = 'omnipdf-gmail-toast';
  const ATTACHMENT_SCOPE_SELECTOR =
    '[role="listitem"], .aQH, .aZo, .aVW, .aSH, .aYB, .aZk';
  const SCOPE_LIMIT = 2;
  let scanTimer = null;

  function toast(message) {
    let node = document.getElementById(TOAST_ID);
    if (!node) {
      node = document.createElement('div');
      node.id = TOAST_ID;
      node.setAttribute('role', 'status');
      document.documentElement.appendChild(node);
    }
    node.textContent = message;
    node.classList.add('is-visible');
    clearTimeout(toast.timer);
    toast.timer = setTimeout(() => node.classList.remove('is-visible'), 5200);
  }

  function reportDiagnostic(stage, message, details = {}) {
    try {
      const pending = chrome.runtime.sendMessage({
        type: 'omnipdf-diagnostic',
        entry: {
          stage,
          message: String(message || 'Unknown error'),
          name: details.name || '',
          url: details.url || '',
          status: details.status,
          bytes: details.bytes,
          durationMs: details.durationMs,
        },
      });
      if (typeof pending?.catch === 'function') pending.catch(() => {});
    } catch {
      // Diagnostics are best effort; never let logging hide the real failure.
    }
  }

  function safeDecode(value) {
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }

  function filenameFromDisposition(header) {
    if (!header) return '';
    const extended = /filename\*=UTF-8''([^;]+)/i.exec(header);
    if (extended) return safeDecode(extended[1].trim());
    const plain = /filename="?([^";]+)"?/i.exec(header);
    return plain ? plain[1].trim() : '';
  }

  function pdfNameInText(value) {
    let text = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .trim()
      .replace(/^Preview attachment\s*(?=.+\.pdf$)/i, '');
    if (!text) return '';
    const glued = /^(.*?\.pdf)(?:Preview|Download)\b/i.exec(text);
    if (glued) text = glued[1];
    text = text
      .replace(/\s*\((?:[^()]{0,80})\)\s*$/, '')
      .replace(
        /\s+(?:\d+(?:[.,]\d+)?\s*(?:B|KB|MB|GB|TB|pages?|pgs?)|Download|Preview|Save to Drive|Add to Drive|Scan with Google)\b.*$/i,
        ''
      )
      .trim();
    if (!text || text.length > 240) return '';
    return /\.pdf$/i.test(text) ? text : '';
  }

  function cleanPdfName(value) {
    const text = String(value || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+/g, ' ')
      .replace(/\s*\n\s*/g, '\n')
      .trim();
    if (!text) return '';
    for (const line of text.split('\n')) {
      const name = pdfNameInText(line);
      if (name) return name;
    }
    return '';
  }

  function nameFromUrl(value) {
    const text = String(value || '');
    if (!text) return '';
    let parsed = null;
    try {
      parsed = new URL(text);
    } catch {
      return '';
    }
    for (const key of ['name', 'filename', 'fileName', 'attname', 'fn']) {
      const name = cleanPdfName(parsed.searchParams.get(key) || '');
      if (name) return name;
    }
    return '';
  }

  function looksLikeAttachmentUrl(value) {
    let parsed = null;
    try {
      parsed = new URL(String(value || ''));
    } catch {
      return false;
    }
    if (parsed.hostname !== 'mail.google.com') return false;
    if (parsed.searchParams.get('view') === 'att') return true;
    if (parsed.searchParams.get('disp') === 'safe') return true;
    return parsed.searchParams.has('attid') || parsed.searchParams.has('permmsgid');
  }

  function attachmentScopes(anchor) {
    const scopes = [];
    let node = anchor.closest(ATTACHMENT_SCOPE_SELECTOR);
    while (node && scopes.length < SCOPE_LIMIT) {
      scopes.push(node);
      node = node.parentElement?.closest(ATTACHMENT_SCOPE_SELECTOR) || null;
    }
    return scopes;
  }

  function insideOmniPdfButton(node) {
    return typeof node.closest === 'function' && Boolean(node.closest(`.${BUTTON_CLASS}`));
  }

  function nameInScope(scope) {
    if (!scope) return '';
    for (const node of scope.querySelectorAll('[title], [aria-label], [data-tooltip], .aV3')) {
      if (insideOmniPdfButton(node)) continue;
      const name = cleanPdfName(
        [
          node.getAttribute('title'),
          node.getAttribute('aria-label'),
          node.getAttribute('data-tooltip'),
          node.textContent,
        ]
          .filter(Boolean)
          .join('\n')
      );
      if (name) return name;
    }
    const labelled = cleanPdfName(scope.getAttribute('title') || scope.getAttribute('aria-label') || '');
    if (labelled) return labelled;
    return cleanPdfName(scope.textContent || '');
  }

  function hasPdfToken(value) {
    return /application\/pdf|(?:^|[^a-z0-9])pdf(?:$|[^a-z0-9])/i.test(safeDecode(String(value || '')));
  }

  function scopeHasPdfHint(anchor, scope, href) {
    if (hasPdfToken(href)) return true;
    const root = scope || anchor;
    if (hasPdfToken(root.getAttribute?.('title')) || hasPdfToken(root.getAttribute?.('aria-label'))) {
      return true;
    }
    if (scope && /\.pdf(?=$|[^a-z0-9])/i.test(scope.textContent || '')) return true;

    for (const node of root.querySelectorAll('img, [title], [aria-label], [data-tooltip]')) {
      if (insideOmniPdfButton(node)) continue;
      if (
        hasPdfToken(node.getAttribute('src')) ||
        hasPdfToken(node.getAttribute('alt')) ||
        hasPdfToken(node.getAttribute('title')) ||
        hasPdfToken(node.getAttribute('aria-label')) ||
        hasPdfToken(node.getAttribute('data-tooltip'))
      ) {
        return true;
      }
    }

    for (const node of root.querySelectorAll('span, div')) {
      if (node.childElementCount || insideOmniPdfButton(node)) continue;
      if (/^(?:pdf|adobe pdf)$/i.test(String(node.textContent || '').trim())) return true;
    }
    return false;
  }

  function fallbackAttachmentName(anchor) {
    const label = String(
      anchor.getAttribute('aria-label') || anchor.getAttribute('title') || anchor.textContent || ''
    )
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return /^preview attachment$/i.test(label) ? '' : label.slice(0, 180);
  }

  function attachmentInfo(anchor) {
    const href = anchor.href || '';
    const linkName = cleanPdfName(
      [
        anchor.getAttribute('download'),
        anchor.getAttribute('title'),
        anchor.getAttribute('aria-label'),
        anchor.getAttribute('data-tooltip'),
        anchor.textContent,
      ]
        .filter(Boolean)
        .join('\n')
    );
    const attachmentLink = looksLikeAttachmentUrl(href);
    let name = linkName || nameFromUrl(href);
    const scopes = /\.pdf$/i.test(name) ? [] : attachmentScopes(anchor);

    if (!/\.pdf$/i.test(name)) {
      for (const scope of scopes) {
        const found = nameInScope(scope);
        if (found) {
          name = found;
          break;
        }
      }
    }

    const isPdf =
      /\.pdf$/i.test(name) ||
      (attachmentLink &&
        (scopes.length
          ? scopes.some((scope) => scopeHasPdfHint(anchor, scope, href))
          : scopeHasPdfHint(anchor, null, href)));

    return {
      isPdf,
      name: name || fallbackAttachmentName(anchor),
    };
  }

  function pdfAttachment(anchor) {
    if (!(anchor.href || '').startsWith('https://mail.google.com/')) return null;
    const info = attachmentInfo(anchor);
    return info.isPdf ? info : null;
  }

  function attachmentName(anchor) {
    return attachmentInfo(anchor).name;
  }

  function readBlobAsBase64(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = String(reader.result || '');
        const comma = result.indexOf(',');
        if (comma < 0) reject(new Error('Could not encode the attachment'));
        else resolve(result.slice(comma + 1));
      };
      reader.onerror = () => reject(new Error('Could not read the attachment'));
      reader.readAsDataURL(blob);
    });
  }

  async function fetchAttachment(url, fallbackName, button) {
    const previous = button ? button.textContent : '';
    const startedAt = Date.now();
    let stage = 'fetch';
    let status = 0;
    let bytes = 0;
    if (button) {
      button.disabled = true;
      button.textContent = 'Opening…';
    }
    try {
      const response = await fetch(url, {
        credentials: 'include',
        cache: 'no-store',
        redirect: 'follow',
      });
      status = response.status;
      stage = 'http';
      if (!response.ok) throw new Error(`Gmail returned HTTP ${response.status}`);

      const length = Number(response.headers.get('content-length') || 0);
      stage = 'size';
      if (length > MAX_BYTES) throw new Error('This PDF is over the 48 MB Chrome-viewer limit');

      const blob = await response.blob();
      bytes = blob.size;
      if (!blob.size) throw new Error('The attachment was empty');
      if (blob.size > MAX_BYTES) throw new Error('This PDF is over the 48 MB Chrome-viewer limit');

      stage = 'content';
      const header = await blob.slice(0, 1024).arrayBuffer();
      const head = new TextDecoder('latin1').decode(new Uint8Array(header));
      if (!head.includes('%PDF-')) {
        throw new Error('That link did not return a PDF. Download the attachment and drop it into the viewer.');
      }

      stage = 'storage';
      const data = await readBlobAsBase64(blob);
      const name =
        filenameFromDisposition(response.headers.get('content-disposition')) ||
        fallbackName ||
        'Gmail attachment.pdf';
      const transferId = crypto.randomUUID();
      const key = `pending:${transferId}`;
      await chrome.storage.local.set({
        [key]: {
          data,
          name,
          sourceUrl: url,
          createdAt: Date.now(),
        },
      });

      stage = 'transfer';
      try {
        const result = await chrome.runtime.sendMessage({
          type: 'open-transfer',
          transferId,
          name,
        });
        if (!result?.ok) throw new Error(result?.error || 'Could not open the viewer');
      } catch (error) {
        await chrome.storage.local.remove(key);
        throw error;
      }
    } catch (error) {
      const message = String(error.message || error);
      reportDiagnostic(stage, message, {
        name: fallbackName,
        url,
        status,
        bytes,
        durationMs: Date.now() - startedAt,
      });
      toast(`OmniPDF: ${message} Open the OmniPDF toolbar icon for diagnostics.`);
    } finally {
      if (button) {
        button.disabled = false;
        button.textContent = previous || 'Open in OmniPDF';
      }
    }
  }

  function makeButton(anchor, name) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = BUTTON_CLASS;
    button.textContent = 'Open in OmniPDF';
    button.title = `Open ${name || 'this PDF'} in OmniPDF`;
    button.addEventListener('click', (event) => {
      event.preventDefault();
      event.stopPropagation();
      fetchAttachment(anchor.href, name, button);
    });
    anchor.insertAdjacentElement('afterend', button);
    anchor.dataset.omnipdfBound = '1';
  }

  function scan() {
    for (const anchor of document.querySelectorAll('a[href]')) {
      if (anchor.dataset.omnipdfBound === '1') continue;
      const info = pdfAttachment(anchor);
      if (!info) continue;
      makeButton(anchor, info.name);
    }
  }

  function scheduleScan() {
    clearTimeout(scanTimer);
    scanTimer = setTimeout(scan, 250);
  }

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === 'omnipdf-ping') {
      sendResponse({ ok: true });
      return false;
    }
    if (message?.type === 'omnipdf-fetch-attachment' && message.url) {
      const anchor = [...document.querySelectorAll('a[href]')].find(
        (candidate) => candidate.href === message.url || candidate.getAttribute('href') === message.url
      );
      fetchAttachment(message.url, anchor ? attachmentName(anchor) : '', null);
      sendResponse({ ok: true });
      return false;
    }
    return false;
  });

  new MutationObserver(scheduleScan).observe(document.documentElement, {
    childList: true,
    subtree: true,
  });
  scheduleScan();
}
