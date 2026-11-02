'use strict';

const { app, BrowserWindow, ipcMain, dialog, Menu, shell, protocol, session } = require('electron');
const path = require('node:path');
const fsp = require('node:fs/promises');
const fs = require('node:fs');

const { saveWithEdits, extractPages } = require('./src/core/edit');
const { ensureSigner, signPdf } = require('./src/core/sign');
const ocr = require('./src/core/ocr');

const SMOKE = process.argv.includes('--smoke');
const APP_URL = 'app://bundle/index.html';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'app',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
]);

if (process.platform === 'win32') app.setAppUserModelId('tools.omnipdf.editor');

// The renderer is served from a custom protocol that changes on every edit;
// the HTTP cache has no business retaining it.
app.commandLine.appendSwitch('disable-http-cache');

const MIME = new Map(
  Object.entries({
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.mjs': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.wasm': 'application/wasm',
    '.bcmap': 'application/octet-stream',
    '.pfb': 'application/octet-stream',
    '.ttf': 'font/ttf',
  })
);

let mainWindow = null;

function userDir() {
  return app.getPath('userData');
}

async function serve(request) {
  const url = new URL(request.url);
  let rel = decodeURIComponent(url.pathname);
  if (!rel || rel === '/') rel = '/index.html';

  const isVendor = rel.startsWith('/vendor/');
  const base = isVendor
    ? path.join(__dirname, 'node_modules', 'pdfjs-dist')
    : path.join(__dirname, 'renderer');
  const relative = isVendor ? rel.slice('/vendor/'.length) : rel.slice(1);
  const target = path.resolve(base, relative);

  if (!target.toLowerCase().startsWith(path.resolve(base).toLowerCase())) {
    return new Response('Forbidden', { status: 403 });
  }

  try {
    const data = await fsp.readFile(target);
    return new Response(data, {
      headers: {
        'content-type': MIME.get(path.extname(target).toLowerCase()) || 'application/octet-stream',
        'cache-control': 'no-store',
      },
    });
  } catch {
    return new Response('Not found', { status: 404 });
  }
}

async function readDocument(filePath) {
  const data = await fsp.readFile(filePath);
  return { path: filePath, name: path.basename(filePath), bytes: data };
}

function createWindow() {
  const iconPath = path.join(__dirname, 'assets', 'icon.ico');
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 620,
    backgroundColor: '#16181c',
    title: 'OmniPDF',
    show: !SMOKE,
    ...(fs.existsSync(iconPath) ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });

  mainWindow.loadURL(APP_URL);

  if (SMOKE) {
    mainWindow.webContents.once('did-finish-load', async () => {
      try {
        const fixture = path.join(__dirname, 'assets', 'fixture.pdf');
        const b64 = fs.readFileSync(fixture).toString('base64');
        const result = await mainWindow.webContents.executeJavaScript(
          `window.__smoke(${JSON.stringify(b64)})`
        );
        process.stdout.write(`SMOKE_RESULT ${JSON.stringify(result)}\n`);
        app.exit(result && result.ok ? 0 : 1);
      } catch (error) {
        process.stdout.write(`SMOKE_ERROR ${(error && error.stack) || error}\n`);
        app.exit(1);
      }
    });
  }
}

function buildMenu() {
  const send = (action) => () => {
    const win = BrowserWindow.getFocusedWindow() || mainWindow;
    if (win) win.webContents.send('menu', action);
  };

  const template = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: send('open') },
        { type: 'separator' },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: send('save') },
        { label: 'Save As…', accelerator: 'CmdOrCtrl+Shift+S', click: send('saveAs') },
        { label: 'Extract Page…', click: send('extract') },
        { type: 'separator' },
        { role: 'quit' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
        { type: 'separator' },
        { label: 'Find', accelerator: 'CmdOrCtrl+F', click: send('focusSearch') },
      ],
    },
    {
      label: 'View',
      submenu: [
        { label: 'Zoom In', accelerator: 'CmdOrCtrl+=', click: send('zoomIn') },
        { label: 'Zoom Out', accelerator: 'CmdOrCtrl+-', click: send('zoomOut') },
        { label: 'Fit Width', accelerator: 'CmdOrCtrl+0', click: send('fit') },
        { label: 'Rotate Page', accelerator: 'CmdOrCtrl+R', click: send('rotate') },
        { type: 'separator' },
        { role: 'togglefullscreen' },
        { role: 'toggleDevTools' },
      ],
    },
    {
      label: 'Tools',
      submenu: [
        { label: 'Run OCR…', accelerator: 'CmdOrCtrl+Shift+O', click: send('ocr') },
        { label: 'Sign Document…', accelerator: 'CmdOrCtrl+Shift+D', click: send('sign') },
        { type: 'separator' },
        { label: 'Signing Identity…', click: send('cert') },
      ],
    },
  ];

  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  protocol.handle('app', serve);
  try {
    // Chromium keeps compiled module code across launches; the renderer is
    // local source and must always reflect the current files on disk.
    await session.defaultSession.clearCache();
    await session.defaultSession.clearCodeCaches({});
  } catch {
    /* best effort */
  }
  ocr.setCacheDir(path.join(userDir(), 'tessdata'));
  buildMenu();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => {
  ocr.dispose();
});

/* --------------------------------------------------------------------- IPC */

ipcMain.handle('app:info', () => ({
  version: app.getVersion(),
  electron: process.versions.electron,
  dataDir: userDir(),
}));

ipcMain.handle('cert:info', () => {
  const signer = ensureSigner(userDir());
  return { ...signer.info, path: path.join(userDir(), 'signer.p12') };
});

ipcMain.handle('file:open', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'Open PDF',
    properties: ['openFile'],
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePaths.length) return null;
  return readDocument(result.filePaths[0]);
});

ipcMain.handle('file:openPath', async (_event, filePath) => {
  if (!filePath || path.extname(filePath).toLowerCase() !== '.pdf') return null;
  return readDocument(filePath);
});

ipcMain.handle('file:save', async (_event, payload) => {
  if (!payload || !payload.path) return null;
  await fsp.writeFile(payload.path, Buffer.from(payload.bytes));
  return { path: payload.path, name: path.basename(payload.path) };
});

ipcMain.handle('file:saveAs', async (_event, payload) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'Save PDF As',
    defaultPath: payload.suggestedName || 'document.pdf',
    filters: [{ name: 'PDF documents', extensions: ['pdf'] }],
  });
  if (result.canceled || !result.filePath) return null;
  await fsp.writeFile(result.filePath, Buffer.from(payload.bytes));
  return { path: result.filePath, name: path.basename(result.filePath) };
});

ipcMain.handle('core:edit', async (_event, payload) => {
  const result = await saveWithEdits(payload.bytes, payload);
  return { bytes: result.bytes, errors: result.errors };
});

ipcMain.handle('core:sign', async (_event, payload) => {
  const edited = await saveWithEdits(payload.bytes, payload);
  const signer = ensureSigner(userDir());
  const signed = await signPdf(edited.bytes, {
    pageIndex: payload.pageIndex,
    rect: payload.rect,
    name: payload.name,
    reason: payload.reason,
    location: payload.location,
    contactInfo: payload.contactInfo,
    signer,
  });
  return { bytes: signed, errors: edited.errors };
});

ipcMain.handle('core:ocr', async (_event, payload) => {
  const edited = await saveWithEdits(payload.bytes, payload);
  const built = await ocr.buildSearchable(edited.bytes, payload.pages);
  return { bytes: built.bytes, results: built.results, errors: edited.errors };
});

ipcMain.handle('core:extract', async (_event, payload) => {
  const bytes = await extractPages(payload.bytes, payload.indices || []);
  return { bytes };
});

ipcMain.handle('shell:reveal', (_event, filePath) => {
  if (filePath && fs.existsSync(filePath)) shell.showItemInFolder(filePath);
});
