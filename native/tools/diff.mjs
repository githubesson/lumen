// Pixel diff between a reference shot (the Electron frontend) and the Rune
// port's headless render of the same scene.
//
//   node native/tools/diff.mjs <ref.png> <rune.png> [out-prefix] [--crop x,y,w,h] [--zoom n]
//
// Prints the share of pixels that differ (any channel by more than 8/255, and
// by more than 32/255), and writes <out>-diff.png (differences in red over a
// dimmed reference) and <out>-side.png (reference | rune | diff), cropped and
// zoomed when asked. Transparent pixels are composited over magenta first,
// so the window's rounded corners count too.
import sharp from "sharp";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const crop = flag("--crop")?.split(",").map(Number);
const zoom = Number(flag("--zoom") ?? 1);
const [refPath, runePath, out = "diff"] = args;
if (!refPath || !runePath) {
  console.error("usage: diff.mjs <ref.png> <rune.png> [out-prefix] [--crop x,y,w,h] [--zoom n]");
  process.exit(2);
}

async function load(path) {
  let img = sharp(path).flatten({ background: { r: 255, g: 0, b: 255 } });
  if (crop) img = img.extract({ left: crop[0], top: crop[1], width: crop[2], height: crop[3] });
  const { data, info } = await img.raw().toBuffer({ resolveWithObject: true });
  return { data, w: info.width, h: info.height, c: info.channels };
}

const a = await load(refPath);
const b = await load(runePath);
if (a.w !== b.w || a.h !== b.h) {
  console.error(`size mismatch: ref ${a.w}x${a.h}, rune ${b.w}x${b.h}`);
  process.exit(1);
}
const { w, h } = a;
const diff = Buffer.alloc(w * h * 3);
let small = 0;
let big = 0;
for (let i = 0; i < w * h; i++) {
  let d = 0;
  for (let k = 0; k < 3; k++) d = Math.max(d, Math.abs(a.data[i * a.c + k] - b.data[i * b.c + k]));
  if (d > 8) small++;
  if (d > 32) big++;
  const base = (a.data[i * a.c] + a.data[i * a.c + 1] + a.data[i * a.c + 2]) / 3;
  const dim = Math.round(base * 0.35);
  if (d > 8) {
    const s = Math.min(255, 80 + d * 2);
    diff[i * 3] = s;
    diff[i * 3 + 1] = dim * 0.3;
    diff[i * 3 + 2] = dim * 0.3;
  } else {
    diff[i * 3] = diff[i * 3 + 1] = diff[i * 3 + 2] = dim;
  }
}
const pct = (n) => ((100 * n) / (w * h)).toFixed(2);
console.log(`${w}x${h}: ${pct(small)}% differ >8, ${pct(big)}% differ >32`);

const scale = (buf, channels) =>
  sharp(buf, { raw: { width: w, height: h, channels } })
    .resize(w * zoom, h * zoom, { kernel: "nearest" })
    .png();
await scale(diff, 3).toFile(`${out}-diff.png`);
const ra = await scale(a.data, a.c).toBuffer();
const rb = await scale(b.data, b.c).toBuffer();
const rd = await scale(diff, 3).toBuffer();
const W = w * zoom;
const H = h * zoom;
await sharp({ create: { width: W * 3 + 16, height: H, channels: 3, background: "#808080" } })
  .composite([
    { input: ra, left: 0, top: 0 },
    { input: rb, left: W + 8, top: 0 },
    { input: rd, left: 2 * W + 16, top: 0 },
  ])
  .png()
  .toFile(`${out}-side.png`);
