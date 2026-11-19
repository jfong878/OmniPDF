import { copyFile, cp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pdfRoot = path.join(root, 'node_modules', 'pdfjs-dist');
const extensionRoot = path.join(root, 'chrome-extension');
const vendorRoot = path.join(extensionRoot, 'vendor');
const iconRoot = path.join(extensionRoot, 'icons');

await mkdir(vendorRoot, { recursive: true });
await mkdir(iconRoot, { recursive: true });
await rm(vendorRoot, { recursive: true, force: true });
await rm(iconRoot, { recursive: true, force: true });
await mkdir(path.join(vendorRoot, 'build'), { recursive: true });
await mkdir(iconRoot, { recursive: true });

// PDF.js 6 targets the very latest JavaScript built-ins. Chrome 130 still
// lacks several of them, and the legacy build's renderer hangs in this
// environment, so use the modern renderer with the small compatibility shim.
const compat = await readFile(path.join(root, 'scripts', 'pdfjs-compat.js'), 'utf8');
for (const file of ['pdf.mjs', 'pdf.worker.mjs']) {
  const source = await readFile(path.join(pdfRoot, 'build', file), 'utf8');
  await writeFile(path.join(vendorRoot, 'build', file), `${compat}\n${source}`);
}

for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'iccs']) {
  await cp(path.join(pdfRoot, directory), path.join(vendorRoot, directory), { recursive: true });
}

for (const size of [16, 32, 48]) {
  await copyFile(
    path.join(root, 'assets', `icon-${size}.png`),
    path.join(iconRoot, `icon-${size}.png`)
  );
}
// Chrome Web Store artwork: 96px of visible icon inside 16px transparent
// padding on every side. The toolbar/action icons keep their normal sizes.
await copyFile(
  path.join(root, 'assets', 'chrome-icon-128.png'),
  path.join(iconRoot, 'icon-128.png')
);

const files = await readdir(path.join(vendorRoot, 'build'));
process.stdout.write(`Built chrome-extension/vendor (${files.join(', ')}) and icons.\n`);
