#!/usr/bin/env node
// Generate the bundle icons from the local licensed brand asset
// (brand-assets/uptokey-256x256.png). Never downloads or hotlinks anything.
//   icons/icon.png  <- brand PNG (256x256)
//   icons/icon.ico  <- single-entry PNG-compressed ICO (Windows Vista+)
// Multi-size .png/.icns for macOS and Linux remain a runner-side step
// (tauri icon) because they require the Tauri CLI, which is not vendored here.
import {readFileSync, writeFileSync, existsSync} from 'node:fs';
import {join, dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, '..');
const source = join(tauriDir, 'brand-assets', 'uptokey-256x256.png');
const iconsDir = join(tauriDir, 'icons');
if (!existsSync(source)) {
  console.error('brand_png_missing:brand-assets/uptokey-256x256.png');
  process.exit(1);
}
const png = readFileSync(source);
if (png.length === 0 || png.readUInt32BE(0) !== 0x89504e47) {
  console.error('brand_png_invalid');
  process.exit(1);
}
writeFileSync(join(iconsDir, 'icon.png'), png);
const ico = Buffer.alloc(22 + png.length);
ico.writeUInt16LE(0, 0); // reserved
ico.writeUInt16LE(1, 2); // type: icon
ico.writeUInt16LE(1, 4); // one entry
ico[6] = 0; // width 256
ico[7] = 0; // height 256
ico[8] = 0; // palette
ico[9] = 0; // reserved
ico.writeUInt16LE(1, 10); // planes
ico.writeUInt16LE(32, 12); // bpp
ico.writeUInt32LE(png.length, 14); // image size
ico.writeUInt32LE(22, 18); // image offset
png.copy(ico, 22);
writeFileSync(join(iconsDir, 'icon.ico'), ico);
console.log(`icons written: icon.png ${png.length} bytes, icon.ico ${ico.length} bytes`);
