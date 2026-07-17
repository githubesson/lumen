// Regenerate all app-icon artifacts from the Icon Composer master render.
//
//   npm run icons
//
// Pipeline:
//   1. Extract the largest PNG layer from electron/assets/icon.icns (the
//      1024px render Icon Composer exported from resources/icon.icon).
//   2. Crop part of the macOS grid margin (icons on Windows are full-bleed,
//      so an uncropped macOS icon looks undersized next to native ones) and
//      downscale to every size Windows uses.
//   3. Pack electron/assets/icon.ico — PNG-compressed 256px layer plus
//      classic 32-bit BMP layers with AND masks for maximum shell compat.
//   4. On macOS only: compile resources/icon.icon into Assets.car via
//      scripts/generate-mac-icon-assets.sh (needs Xcode 26) so macOS 26
//      renders the light/dark/tinted appearance variants natively.
import { readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const ICNS = path.join(ROOT, "electron", "assets", "icon.icns");
const ICO = path.join(ROOT, "electron", "assets", "icon.ico");
const SIZES = [256, 64, 48, 32, 24, 16];
// macOS icon grid leaves ~10% margin per side; trim it to ~3% for Windows.
const CROP_PER_SIDE = 72 / 1024;

function largestIcnsPng(file) {
  // icns layout: 8-byte header, then (4-byte type, 4-byte BE length) chunks.
  // ic10=1024 ic09=512 ic14=256 — all PNG payloads.
  const buf = readFileSync(file);
  const want = ["ic10", "ic09", "ic14"];
  const found = {};
  for (let o = 8; o < buf.length; ) {
    const type = buf.subarray(o, o + 4).toString();
    const len = buf.readUInt32BE(o + 4);
    if (want.includes(type)) found[type] = buf.subarray(o + 8, o + len);
    o += len;
  }
  for (const type of want) if (found[type]) return found[type];
  throw new Error(`no 1024/512/256 PNG layer found in ${file}`);
}

function bmpEntry(size, rgba) {
  // ICO "BMP" entry: BITMAPINFOHEADER with doubled height, bottom-up BGRA
  // pixels (XOR), then a 1-bit AND mask padded to 32-bit rows.
  const maskRow = Math.ceil(size / 32) * 4;
  const hdr = Buffer.alloc(40);
  hdr.writeUInt32LE(40, 0);
  hdr.writeInt32LE(size, 4);
  hdr.writeInt32LE(size * 2, 8);
  hdr.writeUInt16LE(1, 12);
  hdr.writeUInt16LE(32, 14);
  hdr.writeUInt32LE(size * size * 4 + maskRow * size, 20);
  const xor = Buffer.alloc(size * size * 4);
  const and = Buffer.alloc(maskRow * size);
  for (let y = 0; y < size; y++) {
    const src = y * size * 4;
    const dst = (size - 1 - y) * size * 4;
    for (let x = 0; x < size; x++) {
      xor[dst + x * 4] = rgba[src + x * 4 + 2];
      xor[dst + x * 4 + 1] = rgba[src + x * 4 + 1];
      xor[dst + x * 4 + 2] = rgba[src + x * 4];
      xor[dst + x * 4 + 3] = rgba[src + x * 4 + 3];
      if (rgba[src + x * 4 + 3] === 0)
        and[(size - 1 - y) * maskRow + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return Buffer.concat([hdr, xor, and]);
}

function packIco(entries) {
  const dir = Buffer.alloc(6);
  dir.writeUInt16LE(1, 2);
  dir.writeUInt16LE(entries.length, 4);
  let off = 6 + entries.length * 16;
  const heads = entries.map(({ size, data }) => {
    const h = Buffer.alloc(16);
    h[0] = size === 256 ? 0 : size;
    h[1] = size === 256 ? 0 : size;
    h.writeUInt16LE(1, 4);
    h.writeUInt16LE(32, 6);
    h.writeUInt32LE(data.length, 8);
    h.writeUInt32LE(off, 12);
    off += data.length;
    return h;
  });
  return Buffer.concat([dir, ...heads, ...entries.map((e) => e.data)]);
}

const master = sharp(largestIcnsPng(ICNS));
const { width } = await master.metadata();
const margin = Math.round(width * CROP_PER_SIDE);
const cropped = master.extract({
  left: margin,
  top: margin,
  width: width - margin * 2,
  height: width - margin * 2,
});

const entries = [];
for (const size of SIZES) {
  const layer = cropped.clone().resize(size, size, { kernel: "lanczos3" });
  entries.push({
    size,
    data:
      size === 256
        ? await layer.png().toBuffer()
        : bmpEntry(size, await layer.ensureAlpha().raw().toBuffer()),
  });
}
writeFileSync(ICO, packIco(entries));
console.log(`icons: wrote ${path.relative(ROOT, ICO)} (${SIZES.join("/")}px, from ${width}px master)`);

if (process.platform === "darwin") {
  const res = spawnSync("bash", [path.join(ROOT, "scripts", "generate-mac-icon-assets.sh")], {
    stdio: "inherit",
  });
  if (res.status !== 0) process.exit(res.status ?? 1);
} else {
  console.log(
    "icons: skipping Assets.car (macOS appearance variants) — requires macOS with Xcode 26; run `npm run icons` on a Mac to regenerate it",
  );
}
