// Checks a headless snapshot (`lumen --snap`) for CI: a PNG of the expected
// size that shows an actual screen, not one flat colour (a GPU or font
// failure draws nothing). No dependencies: Node's zlib and the PNG spec.
//
//   node native/packaging/check-snapshot.mjs out.png 1280 820
import { readFileSync } from "node:fs";
import { inflateSync } from "node:zlib";

const [file, wantW, wantH] = process.argv.slice(2);
const png = readFileSync(file);
if (png.readUInt32BE(0) !== 0x89504e47) throw new Error(`${file} is not a PNG`);

let offset = 8;
let width = 0, height = 0, depth = 0, type = 0;
const idat = [];
while (offset < png.length) {
  const length = png.readUInt32BE(offset);
  const kind = png.toString("latin1", offset + 4, offset + 8);
  const data = png.subarray(offset + 8, offset + 8 + length);
  if (kind === "IHDR") {
    width = data.readUInt32BE(0);
    height = data.readUInt32BE(4);
    depth = data[8];
    type = data[9];
  } else if (kind === "IDAT") idat.push(data);
  offset += 12 + length;
}
if (width !== Number(wantW) || height !== Number(wantH)) {
  throw new Error(`${file} is ${width}x${height}, expected ${wantW}x${wantH}`);
}
const channels = { 2: 3, 6: 4 }[type];
if (depth !== 8 || !channels) throw new Error(`${file}: unsupported PNG (depth ${depth}, colour type ${type})`);

// Undo the scanline filters.
const raw = inflateSync(Buffer.concat(idat));
const stride = width * channels;
const pixels = Buffer.alloc(stride * height);
for (let y = 0; y < height; y++) {
  const filter = raw[y * (stride + 1)];
  const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
  const out = pixels.subarray(y * stride, (y + 1) * stride);
  const up = y > 0 ? pixels.subarray((y - 1) * stride, y * stride) : null;
  for (let x = 0; x < stride; x++) {
    const a = x >= channels ? out[x - channels] : 0;
    const b = up ? up[x] : 0;
    const c = up && x >= channels ? up[x - channels] : 0;
    let v = line[x];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += (a + b) >> 1;
    else if (filter === 4) {
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
    }
    out[x] = v & 0xff;
  }
}

const colours = new Map();
for (let i = 0; i < pixels.length; i += channels) {
  const key = pixels.readUIntBE(i, 3);
  colours.set(key, (colours.get(key) ?? 0) + 1);
}
const commonest = Math.max(...colours.values()) / (width * height);
console.log(`${file}: ${width}x${height}, ${colours.size} colours, commonest covers ${(commonest * 100).toFixed(1)}%`);
// A rendered screen has text and covers; a failed render is one colour.
if (colours.size < 64 || commonest > 0.97) throw new Error(`${file} looks blank`);
