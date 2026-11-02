import fs from 'node:fs';

const SIZES = [256, 128, 64, 48, 32, 16];
const dest = 'assets/icon.ico';

const images = [];
for (const size of SIZES) {
  const file = `assets/icon-${size}.png`;
  if (!fs.existsSync(file)) {
    console.error(`missing ${file}; run scripts/make-icon.ps1 first`);
    process.exit(1);
  }
  images.push({ size, data: fs.readFileSync(file) });
}

// ICONDIR
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0); // reserved
header.writeUInt16LE(1, 2); // type = icon
header.writeUInt16LE(images.length, 4);

let offset = 6 + images.length * 16;
const entries = [];
for (const img of images) {
  const entry = Buffer.alloc(16);
  const dim = img.size >= 256 ? 0 : img.size;
  entry.writeUInt8(dim, 0); // width
  entry.writeUInt8(dim, 1); // height
  entry.writeUInt8(0, 2); // palette
  entry.writeUInt8(0, 3); // reserved
  entry.writeUInt16LE(1, 4); // colour planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(img.data.length, 8);
  entry.writeUInt32LE(offset, 12);
  entries.push(entry);
  offset += img.data.length;
}

fs.writeFileSync(dest, Buffer.concat([header, ...entries, ...images.map((i) => i.data)]));
console.log(`wrote ${dest} with ${images.length} sizes (${offset} bytes)`);
