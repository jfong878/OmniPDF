'use strict';

const { app } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

// A feed baked into the build by electron-builder's publish config. The
// placeholder keeps local builds working until a real host is chosen.
const PLACEHOLDER_HOSTS = new Set(['updates.example.com', 'example.com', 'updates.invalid']);

let initialized = false;
let supported = false;
let configured = false;
let reason = '';
let feed = '';
let autoUpdater = null;
let autoCheckTimer = null;
let repeatTimer = null;
let lastInteractive = false;
let current = { state: 'idle' };
const listeners = new Set();

function logPath() {
  return path.join(app.getPath('userData'), 'updates.log');
}

function log(message) {
  try {
    fs.appendFileSync(logPath(), `${new Date().toISOString()} ${message}\n`);
  } catch {
    /* logging must never break the app */
  }
}

function emit(next) {
  current = { ...next, at: Date.now() };
  for (const listener of listeners) {
    try {
      listener(current);
    } catch {
      /* a bad listener must not break the updater */
    }
  }
}

function onStatus(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function snapshot() {
  return {
    ...current,
    version: app.getVersion(),
    packaged: app.isPackaged,
    supported,
    configured,
    feed: feed || null,
    reason: reason || null,
  };
}

function isPlaceholder(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return PLACEHOLDER_HOSTS.has(host) || host.endsWith('.invalid');
  } catch {
    return true;
  }
}

/** electron-builder writes this next to resources when publish is configured. */
function bakedFeed() {
  try {
    const yml = fs.readFileSync(path.join(process.resourcesPath, 'app-update.yml'), 'utf8');
    const match = yml.match(/^\s*url:\s*(\S+)\s*$/m);
    return match ? match[1] : '';
  } catch {
    return '';
  }
}

function resolveFeed() {
  const override = (process.env.OMNIPDF_UPDATE_URL || '').trim();
  if (override) return { url: override, source: 'env' };
  const baked = bakedFeed().trim();
  if (baked) return { url: baked, source: 'app-update.yml' };
  return { url: '', source: '' };
}

function setup() {
  if (initialized) return snapshot();
  initialized = true;

  if (!app.isPackaged && process.env.OMNIPDF_UPDATE_FORCE !== '1') {
    supported = false;
    reason = 'Updates run only in the installed app.';
    return snapshot();
  }

  try {
    ({ autoUpdater } = require('electron-updater'));
  } catch (err) {
    supported = false;
    reason = 'electron-updater is not available in this build.';
    log(`updater require failed: ${err && err.stack ? err.stack : err}`);
    return snapshot();
  }

  supported = true;
  // Background download and install-on-quit are the "it just updates" path.
  // Installation still waits for a normal quit, so nothing restarts under the
  // user's hands; the banner offers an explicit "Restart now".
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.allowPrerelease = false;
  autoUpdater.logger = {
    info: (message) => log(`info ${message}`),
    warn: (message) => log(`warn ${message}`),
    error: (message) => log(`error ${message}`),
    debug: () => {},
  };

  const resolved = resolveFeed();
  if (resolved.url && !isPlaceholder(resolved.url)) {
    feed = resolved.url;
    configured = true;
    try {
      autoUpdater.setFeedURL({ provider: 'generic', url: feed });
      log(`feed ${feed} (${resolved.source})`);
    } catch (err) {
      configured = false;
      reason = 'The update feed URL is not valid.';
      log(`setFeedURL failed: ${err && err.message ? err.message : err}`);
    }
  } else if (resolved.url) {
    reason = 'Set a real update feed URL before publishing.';
    log(`placeholder feed ignored: ${resolved.url}`);
  } else {
    reason = 'No update feed is configured.';
  }

  autoUpdater.on('update-available', (info) => {
    emit({ state: 'downloading', version: info && info.version, percent: 0, interactive: lastInteractive });
  });
  autoUpdater.on('update-not-available', (info) => {
    emit({ state: 'none', version: info && info.version, interactive: lastInteractive });
  });
  autoUpdater.on('download-progress', (progress) => {
    emit({
      state: 'downloading',
      version: current.version,
      percent: Math.max(0, Math.min(100, Math.round((progress && progress.percent) || 0))),
      interactive: lastInteractive,
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    emit({ state: 'downloaded', version: info && info.version, interactive: lastInteractive });
  });
  autoUpdater.on('error', (err) => {
    log(`updater error: ${err && err.stack ? err.stack : err}`);
    // A download error replaces an in-flight status; a check error is only
    // noisy when the user asked for the check.
    emit({
      state: 'error',
      message: String((err && err.message) || err),
      interactive: lastInteractive,
    });
  });

  log(`ready version=${app.getVersion()} feed=${feed || '(none)'} configured=${configured} ${reason}`);

  if (configured) {
    autoCheckTimer = setTimeout(() => check({ interactive: false }), 6000);
    if (autoCheckTimer.unref) autoCheckTimer.unref();
    repeatTimer = setInterval(() => {
      if (current.state !== 'downloading' && current.state !== 'downloaded') {
        check({ interactive: false });
      }
    }, 6 * 60 * 60 * 1000);
    if (repeatTimer.unref) repeatTimer.unref();
  }

  return snapshot();
}

async function check(options = {}) {
  const interactive = options.interactive !== false;
  setup();
  lastInteractive = interactive;

  if (!supported) {
    emit({ state: 'unsupported', message: reason, interactive });
    return snapshot();
  }
  if (!configured) {
    emit({ state: 'unconfigured', message: reason, interactive });
    return snapshot();
  }

  try {
    emit({ state: 'checking', interactive });
    await autoUpdater.checkForUpdates();
  } catch (err) {
    log(`check failed: ${err && err.stack ? err.stack : err}`);
    if (current.state === 'checking') {
      emit({ state: 'error', message: String((err && err.message) || err), interactive });
    }
  }
  return snapshot();
}

async function download() {
  setup();
  if (!supported || !configured || !autoUpdater) return snapshot();
  try {
    await autoUpdater.downloadUpdate();
  } catch (err) {
    log(`download failed: ${err && err.stack ? err.stack : err}`);
    emit({ state: 'error', message: String((err && err.message) || err), interactive: true });
  }
  return snapshot();
}

function install() {
  setup();
  if (!supported) return snapshot();
  if (current.state !== 'downloaded') {
    emit({ state: 'error', message: 'No downloaded update is ready to install.', interactive: true });
    return snapshot();
  }

  log('quitAndInstall requested');
  setImmediate(() => {
    try {
      autoUpdater.quitAndInstall(false, true);
    } catch (err) {
      log(`quitAndInstall failed: ${err && err.stack ? err.stack : err}`);
      emit({ state: 'error', message: String((err && err.message) || err), interactive: true });
    }
  });
  return { ...snapshot(), installing: true };
}

/** Headless update cycle used by the local end-to-end test. */
function runE2E() {
  setup();
  const outPath = process.env.OMNIPDF_UPDATE_E2E_LOG || path.join(app.getPath('temp'), 'omnipdf-update-e2e.log');
  const record = (message) => {
    try {
      fs.appendFileSync(outPath, `${new Date().toISOString()} ${message}\n`);
    } catch {
      /* ignore */
    }
  };

  record(`start version=${app.getVersion()} feed=${feed || '(none)'} configured=${configured} supported=${supported} reason=${reason}`);
  if (!supported || !configured) {
    record('abort: updater unsupported or unconfigured');
    setTimeout(() => app.exit(2), 300);
    return;
  }

  const timeout = setTimeout(() => {
    record('timeout');
    app.exit(3);
  }, 180000);
  if (timeout.unref) timeout.unref();

  onStatus((status) => {
    record(
      `state=${status.state} version=${status.version || ''} percent=${status.percent ?? ''} message=${status.message || ''}`
    );
    if (status.state === 'downloaded') {
      clearTimeout(timeout);
      setTimeout(() => {
        record('installing');
        install();
      }, 1200);
    } else if (status.state === 'none') {
      clearTimeout(timeout);
      record('up-to-date');
      setTimeout(() => app.exit(0), 500);
    } else if (status.state === 'error' || status.state === 'unsupported' || status.state === 'unconfigured') {
      clearTimeout(timeout);
      record('failed');
      setTimeout(() => app.exit(2), 500);
    }
  });

  check({ interactive: true });
}

module.exports = { setup, check, download, install, snapshot, onStatus, runE2E };
