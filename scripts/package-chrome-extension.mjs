import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const extensionRoot = path.join(root, 'chrome-extension');
const buildScript = path.join(root, 'scripts', 'build-chrome-extension.mjs');
const outputRoot = path.join(root, 'dist', 'chrome');
const stagingRoot = path.join(outputRoot, '.staging');

const manifest = JSON.parse(await readFile(path.join(extensionRoot, 'manifest.json'), 'utf8'));
if (manifest.manifest_version !== 3) throw new Error('Expected a Manifest V3 extension');
if (!manifest.background?.service_worker) throw new Error('Missing background service worker');

const runtimeEntries = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'gmail.js',
  'gmail.css',
  'viewer.html',
  'viewer.css',
  'viewer.js',
  'icons',
  'vendor',
];

const requiredFiles = [
  'manifest.json',
  'background.js',
  'popup.html',
  'popup.css',
  'popup.js',
  'gmail.js',
  'gmail.css',
  'viewer.html',
  'viewer.css',
  'viewer.js',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  'icons/icon-128.png',
  'vendor/build/pdf.mjs',
  'vendor/build/pdf.worker.mjs',
];

process.stdout.write('Building extension assets...\n');
execFileSync(process.execPath, [buildScript], { stdio: 'inherit' });

for (const file of requiredFiles) {
  const filePath = path.join(extensionRoot, file);
  try {
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) throw new Error('empty file');
  } catch {
    throw new Error(`Missing or empty extension file: ${file}`);
  }
}

await rm(stagingRoot, { recursive: true, force: true });
await mkdir(stagingRoot, { recursive: true });
for (const entry of runtimeEntries) {
  await cp(path.join(extensionRoot, entry), path.join(stagingRoot, entry), { recursive: true });
}

const version = String(manifest.version || '0.0.0');
const zipName = `OmniPDF-Chrome-${version}.zip`;
const zipPath = path.join(outputRoot, zipName);
await rm(zipPath, { force: true });

if (process.platform === 'win32') {
  const quote = (value) => `'${value.replaceAll("'", "''")}'`;
  const command = `Compress-Archive -Path ${quote(path.join(stagingRoot, '*'))} -DestinationPath ${quote(zipPath)} -Force`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', command], { stdio: 'inherit' });
} else {
  execFileSync('zip', ['-qr', zipPath, '.'], { cwd: stagingRoot, stdio: 'inherit' });
}

const zipInfo = await stat(zipPath);
const digest = createHash('sha256').update(await readFile(zipPath)).digest('hex');
await writeFile(`${zipPath}.sha256`, `${digest}  ${zipName}\n`);
await rm(stagingRoot, { recursive: true, force: true });

process.stdout.write(
  `\nPackaged ${path.relative(root, zipPath)} (${(zipInfo.size / 1024 / 1024).toFixed(2)} MB)\n` +
    `SHA-256 ${digest}\n`
);
