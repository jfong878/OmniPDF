import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(root, 'chrome-extension');
const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
const fixturePath = path.join(root, 'assets', 'fixture.pdf');
const keep = process.argv.includes('--keep');
const zipArg = process.argv.slice(2).find((arg) => arg.startsWith('--zip='));
const zipPath = path.resolve(
  root,
  zipArg ? zipArg.slice('--zip='.length) : path.join('dist', 'chrome', `OmniPDF-Chrome-${manifest.version}.zip`)
);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const check = (label, condition, detail = '') => {
  console.log(`  ${condition ? 'PASS' : 'FAIL'}  ${label}${detail ? ` — ${detail}` : ''}`);
  if (!condition) process.exitCode = 1;
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error(`${label} timed out`)), ms)),
  ]);
}

function findChrome() {
  const candidates = [];
  if (process.env.CHROME_PATH) candidates.push(process.env.CHROME_PATH);
  if (process.platform === 'win32') {
    const roots = [process.env.PROGRAMFILES, process.env['PROGRAMFILES(X86)'], process.env.LOCALAPPDATA];
    for (const base of roots.filter(Boolean)) {
      candidates.push(path.join(base, 'Google', 'Chrome', 'Application', 'chrome.exe'));
      candidates.push(path.join(base, 'Google', 'Chrome for Testing', 'Application', 'chrome.exe'));
    }
  } else if (process.platform === 'darwin') {
    candidates.push('/Applications/Google Chrome.app/Contents/MacOS/Google Chrome');
    candidates.push('/Applications/Chromium.app/Contents/MacOS/Chromium');
  } else {
    for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
      try {
        const found = execFileSync('which', [name], { encoding: 'utf8' }).trim().split(/\r?\n/)[0];
        if (found) candidates.push(found);
      } catch {
        /* try the next browser */
      }
    }
  }
  const found = candidates.find((candidate) => candidate && fs.existsSync(candidate));
  if (!found) {
    throw new Error('Chrome/Chromium not found. Set CHROME_PATH to a test-capable browser.');
  }
  return found;
}

function quotePowerShell(value) {
  return `'${String(value).replaceAll("'", "''")}'`;
}

async function extractZip(source, destination) {
  await mkdir(destination, { recursive: true });
  if (process.platform === 'win32') {
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        `Expand-Archive -LiteralPath ${quotePowerShell(source)} -DestinationPath ${quotePowerShell(destination)} -Force`,
      ],
      { stdio: 'ignore' }
    );
  } else {
    execFileSync('unzip', ['-q', source, '-d', destination], { stdio: 'ignore' });
  }
}

async function listFiles(directory, base = directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await listFiles(full, base)));
    else files.push(path.relative(base, full).split(path.sep).join('/'));
  }
  return files;
}

class PipeCdp {
  constructor(child) {
    this.child = child;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderr = '';
    this.closed = false;
    child.stderr.on('data', (chunk) => {
      this.stderr = (this.stderr + chunk.toString()).slice(-8000);
    });
    child.on('error', (error) => this.fail(error));
    child.on('exit', (code, signal) => {
      this.closed = true;
      this.fail(new Error(`Chrome exited (${code ?? signal})${this.stderr ? `: ${this.stderr.slice(-1000)}` : ''}`));
    });
    child.stdio[4].on('data', (chunk) => {
      this.buffer += chunk.toString();
      let end;
      while ((end = this.buffer.indexOf('\0')) >= 0) {
        const raw = this.buffer.slice(0, end);
        this.buffer = this.buffer.slice(end + 1);
        if (!raw) continue;
        let message;
        try {
          message = JSON.parse(raw);
        } catch {
          continue;
        }
        if (message.id && this.pending.has(message.id)) {
          const pending = this.pending.get(message.id);
          this.pending.delete(message.id);
          if (message.error) pending.reject(new Error(JSON.stringify(message.error)));
          else pending.resolve(message.result);
        }
      }
    });
  }

  fail(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  send(method, params = {}, sessionId) {
    if (this.closed) return Promise.reject(new Error('Chrome pipe is closed'));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child.stdio[3].write(
        `${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`
      );
    });
  }

  async close() {
    if (this.closed) return;
    try {
      await withTimeout(this.send('Browser.close'), 1500, 'Browser.close');
    } catch {
      /* Chrome may close the pipe before replying. */
    }
    const exited = await waitForExit(this.child, 2500);
    if (!exited) {
      this.child.kill();
      await waitForExit(this.child, 1500);
    }
  }
}

function waitForExit(child, ms) {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), ms);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

async function launchChrome(chrome, profile) {
  await mkdir(profile, { recursive: true });
  const child = spawn(
    chrome,
    [
      '--headless=new',
      '--remote-debugging-pipe',
      '--enable-unsafe-extension-debugging',
      `--user-data-dir=${profile}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--window-size=1440,1000',
      'about:blank',
    ],
    { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true }
  );
  const cdp = new PipeCdp(child);
  try {
    await withTimeout(cdp.send('Browser.getVersion'), 10000, 'Chrome DevTools pipe startup');
    return cdp;
  } catch (error) {
    await cdp.close();
    throw error;
  }
}

async function evaluate(cdp, sessionId, expression, timeout = 30000) {
  const response = await withTimeout(
    cdp.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, sessionId),
    timeout,
    'page evaluation'
  );
  if (response.exceptionDetails) {
    const description =
      response.exceptionDetails.exception?.description ||
      response.exceptionDetails.text ||
      'Evaluation failed';
    throw new Error(description);
  }
  return response.result?.value;
}

async function waitForValue(cdp, sessionId, expression, predicate, timeout = 15000) {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    try {
      const value = await evaluate(cdp, sessionId, expression, Math.min(2500, deadline - Date.now()));
      if (predicate(value)) return value;
      last = value;
    } catch (error) {
      last = error.message;
    }
    await sleep(100);
  }
  throw new Error(`Timed out waiting for page state; last=${JSON.stringify(last)}`);
}

async function openPage(cdp, url) {
  const { targetId } = await cdp.send('Target.createTarget', { url });
  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
  await cdp.send('Page.enable', {}, sessionId);
  return { targetId, sessionId };
}

const PANEL_STATE_EXPRESSION = `(() => {
  const panel = document.getElementById('diagnostics');
  return {
    ready: document.readyState,
    inner: [innerWidth, innerHeight],
    panelOpen: Boolean(panel && panel.open),
    count: document.getElementById('diagnostics-count')?.textContent || '',
    countHidden: document.getElementById('diagnostics-count')?.hidden,
    emptyHidden: document.getElementById('diagnostics-empty')?.hidden,
    listHidden: document.getElementById('diagnostics-list')?.hidden,
    copyDisabled: document.getElementById('diagnostics-copy')?.disabled,
    clearDisabled: document.getElementById('diagnostics-clear')?.disabled,
    items: [...document.querySelectorAll('#diagnostics-list li')].map((item) => ({
      label: item.querySelector('strong')?.textContent || '',
      message: item.querySelector('.diagnostics-message')?.textContent || '',
      meta: item.querySelector('.diagnostics-meta')?.textContent || ''
    }))
  };
})()`;

async function waitForDiagnosticsPanel(cdp, sessionId, timeout = 15000) {
  return waitForValue(
    cdp,
    sessionId,
    PANEL_STATE_EXPRESSION,
    (value) => value && value.ready === 'complete' && value.items?.length > 0,
    timeout
  );
}

async function openActionPopup(cdp, extensionId) {
  const { targetInfos } = await cdp.send('Target.getTargets');
  const worker = targetInfos.find(
    (target) => target.type === 'service_worker' && target.url === `chrome-extension://${extensionId}/background.js`
  );
  if (!worker) throw new Error('Extension service worker target not found');

  const { sessionId: workerSession } = await cdp.send('Target.attachToTarget', {
    targetId: worker.targetId,
    flatten: true,
  });
  await cdp.send(
    'Runtime.evaluate',
    { expression: 'chrome.action.openPopup()', awaitPromise: true, returnByValue: true },
    workerSession
  );

  let popup;
  for (let i = 0; i < 100; i += 1) {
    const { targetInfos: current } = await cdp.send('Target.getTargets');
    popup = current.find((target) => target.url === `chrome-extension://${extensionId}/popup.html`);
    if (popup) break;
    await sleep(100);
  }
  if (!popup) throw new Error('Toolbar action popup target did not appear');

  const { sessionId } = await cdp.send('Target.attachToTarget', { targetId: popup.targetId, flatten: true });
  return { targetId: popup.targetId, targetInfo: popup, sessionId };
}

async function main() {
  if (!fs.existsSync(zipPath)) {
    throw new Error(`Missing ${path.relative(root, zipPath)}; run \`npm run chrome:smoke\` or \`npm run chrome:package\` first.`);
  }
  if (!fs.existsSync(fixturePath)) {
    throw new Error('Missing assets/fixture.pdf; run `npm run fixture` first.');
  }

  const tempRoot = await mkdtemp(path.join(os.tmpdir(), 'omnipdf-chrome-smoke-'));
  const extractRoot = path.join(tempRoot, 'extension');
  const profileRoot = path.join(tempRoot, 'profile');
  const zipBytes = await readFile(zipPath);
  const digest = createHash('sha256').update(zipBytes).digest('hex');
  const fixture = await readFile(fixturePath);
  let cdp;

  console.log('Chrome extension smoke');
  console.log(`  ZIP: ${path.relative(root, zipPath)} (${(zipBytes.length / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`  SHA-256: ${digest}`);

  try {
    await extractZip(zipPath, extractRoot);
    const extracted = await listFiles(extractRoot);
    check('packaged ZIP extracts', extracted.includes('manifest.json'));
    check(
      'shipped ZIP contains no smoke harness',
      !extracted.some((file) => /(^|\/)(scripts?|tests?)(\/|$)/i.test(file) || /smoke-chrome-extension/i.test(file)),
      extracted.filter((file) => /(^|\/)(scripts?|tests?)(\/|$)/i.test(file) || /smoke-chrome-extension/i.test(file)).join(', ')
    );

    const extractedManifest = JSON.parse(await readFile(path.join(extractRoot, 'manifest.json'), 'utf8'));
    check(
      'extracted manifest matches the packaged version',
      extractedManifest.manifest_version === 3 && extractedManifest.version === manifest.version,
      `${extractedManifest.name} ${extractedManifest.version}`
    );

    const chrome = findChrome();
    console.log(`  Chrome: ${chrome}`);
    cdp = await launchChrome(chrome, profileRoot);
    const loaded = await withTimeout(
      cdp.send('Extensions.loadUnpacked', { path: extractRoot }),
      15000,
      'Extensions.loadUnpacked'
    );
    const extensionId = loaded.id;
    check('extension loads in a fresh profile', typeof extensionId === 'string' && extensionId.length > 0, extensionId);

    const installed = await cdp.send('Extensions.getExtensions');
    const info = installed.extensions?.find((entry) => entry.id === extensionId);
    check(
      'loaded extension reports the expected manifest',
      Boolean(info && info.name === extractedManifest.name && info.version === extractedManifest.version && info.enabled),
      info ? `${info.name} ${info.version}` : 'missing'
    );

    const baseUrl = `chrome-extension://${extensionId}`;
    const viewer = await openPage(cdp, `${baseUrl}/viewer.html`);
    await waitForValue(
      cdp,
      viewer.sessionId,
      `({ ready: document.readyState, smoke: typeof window.__smokeTextLayer })`,
      (value) => value && value.ready === 'complete' && value.smoke === 'function',
      15000
    );

    const textResult = await evaluate(
      cdp,
      viewer.sessionId,
      `window.__smokeTextLayer(${JSON.stringify(fixture.toString('base64'))})`,
      60000
    );
    check('fixture viewer text layer smoke passes', textResult?.ok === true, JSON.stringify(textResult));
    check('fixture viewer rendered text items', Number(textResult?.liveItems) > 0, String(textResult?.liveItems));
    check('fixture viewer rendered text spans', Number(textResult?.liveSpans) > 0, String(textResult?.liveSpans));
    check('fixture viewer kept its live text layer intact', textResult?.layerIntact === true && textResult?.cacheIntact === true);

    const wheelResult = await evaluate(
      cdp,
      viewer.sessionId,
      `(async () => {
        const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        const viewer = document.getElementById('viewer');
        const pages = document.getElementById('pages');
        const label = document.getElementById('zoom-label');
        const page = document.querySelector('.page');
        if (!page) return { error: 'no page' };
        const before = { label: label.textContent, width: page.offsetWidth };
        const box = viewer.getBoundingClientRect();
        viewer.dispatchEvent(new WheelEvent('wheel', {
          deltaY: -120,
          ctrlKey: true,
          clientX: box.left + box.width / 2,
          clientY: box.top + box.height / 2,
          bubbles: true,
          cancelable: true,
        }));
        await settle(90);
        const preview = {
          label: label.textContent,
          width: page.offsetWidth,
          transform: pages.style.transform,
        };
        await settle(400);
        const after = {
          label: label.textContent,
          width: page.offsetWidth,
          transform: pages.style.transform,
        };
        return {
          before,
          preview,
          after,
          checks: {
            noLayoutDuringPreview: preview.width === before.width && preview.transform.includes('scale('),
            previewShowsTarget: preview.label !== before.label,
            oneCommitAfterIdle:
              after.transform === '' &&
              after.width > before.width + 1 &&
              after.label !== before.label,
          },
        };
      })()`,
      15000
    );
    check(
      'viewer wheel zoom previews without resizing pages',
      wheelResult?.checks?.noLayoutDuringPreview === true && wheelResult?.checks?.previewShowsTarget === true,
      JSON.stringify(wheelResult)
    );
    check(
      'viewer wheel zoom commits once after the gesture',
      wheelResult?.checks?.oneCommitAfterIdle === true,
      JSON.stringify(wheelResult)
    );

    const diagnostic = await evaluate(
      cdp,
      viewer.sessionId,
      `new Promise((resolve, reject) => {
        chrome.runtime.sendMessage({
          type: 'omnipdf-diagnostic',
          entry: {
            stage: 'fetch',
            message: 'Packaged extension smoke diagnostic',
            name: 'fixture.pdf',
            status: 503,
            bytes: 1234,
            durationMs: 42
          }
        }, (reply) => {
          const error = chrome.runtime.lastError;
          if (error) reject(new Error(error.message));
          else resolve(reply);
        });
      })`,
      10000
    );
    check('background diagnostic recording succeeds', diagnostic?.ok === true, JSON.stringify(diagnostic));

    const actionPopup = await openActionPopup(cdp, extensionId);
    check(
      'toolbar action opens a real popup target',
      actionPopup.targetInfo.type === 'page',
      JSON.stringify(actionPopup.targetInfo)
    );
    const actionPanel = await waitForDiagnosticsPanel(cdp, actionPopup.sessionId);
    check(
      'diagnostics panel opens in the toolbar action popup',
      actionPanel.panelOpen &&
        actionPanel.count === '1' &&
        actionPanel.countHidden === false &&
        actionPanel.items.length === 1 &&
        actionPanel.inner[0] < 800 &&
        actionPanel.inner[1] < 600,
      JSON.stringify({ target: actionPopup.targetInfo, panel: actionPanel })
    );
    await cdp.send('Target.closeTarget', { targetId: actionPopup.targetId }).catch(() => {});

    const popup = await openPage(cdp, `${baseUrl}/popup.html`);
    const panel = await waitForDiagnosticsPanel(cdp, popup.sessionId);

    check('diagnostics panel opens with an entry', panel.panelOpen && panel.count === '1' && panel.countHidden === false);
    check('diagnostics list replaces the empty state', panel.emptyHidden === true && panel.listHidden === false);
    check('diagnostics panel exposes copy and clear actions', panel.copyDisabled === false && panel.clearDisabled === false);
    check(
      'diagnostics entry contains the recorded failure',
      panel.items.length === 1 &&
        panel.items[0].label === 'Fetch failed' &&
        panel.items[0].message === 'Packaged extension smoke diagnostic' &&
        /Viewer/.test(panel.items[0].meta) &&
        /fixture\.pdf/.test(panel.items[0].meta) &&
        /1 KB/.test(panel.items[0].meta) &&
        /HTTP 503/.test(panel.items[0].meta) &&
        /42 ms/.test(panel.items[0].meta),
      JSON.stringify(panel.items)
    );

    const cleared = await evaluate(
      cdp,
      popup.sessionId,
      `(async () => {
        document.getElementById('diagnostics-clear').click();
        await new Promise((resolve) => setTimeout(resolve, 300));
        return {
          countHidden: document.getElementById('diagnostics-count').hidden,
          emptyHidden: document.getElementById('diagnostics-empty').hidden,
          listHidden: document.getElementById('diagnostics-list').hidden,
          items: document.querySelectorAll('#diagnostics-list li').length
        };
      })()`,
      10000
    );
    check(
      'diagnostics panel clears correctly',
      cleared.countHidden === true && cleared.emptyHidden === false && cleared.listHidden === true && cleared.items === 0,
      JSON.stringify(cleared)
    );

    await cdp.send('Target.closeTarget', { targetId: popup.targetId }).catch(() => {});
    await cdp.send('Target.closeTarget', { targetId: viewer.targetId }).catch(() => {});
  } finally {
    if (cdp) await cdp.close();
    if (keep) {
      console.log(`  Kept temporary files: ${tempRoot}`);
    } else {
      try {
        await rm(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      } catch (error) {
        console.warn(`  Could not remove temporary files: ${error.message}`);
      }
    }
  }

  if (process.exitCode) {
    console.error('\nChrome extension smoke failed.');
  } else {
    console.log('\nAll Chrome extension smoke checks passed.');
  }
}

main().catch((error) => {
  console.error(`\nChrome extension smoke error: ${error.stack || error}`);
  process.exitCode = 1;
});
