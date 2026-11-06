// Ink bounds of a region in two images: node tools/ink.mjs a.png b.png x,y,w,h [threshold]
import sharp from "sharp";
const [a, b, r, th = "90"] = process.argv.slice(2);
const [x0, y0, w, h] = r.split(",").map(Number);
const T = Number(th);
for (const p of [a, b]) {
  const { data, info } = await sharp(p).flatten({ background: "#ff00ff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
  // background = the region's most common value
  const hist = new Map();
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const v = data[y * info.width + x]; hist.set(v, (hist.get(v) ?? 0) + 1); }
  const bg = [...hist.entries()].sort((p, q) => q[1] - p[1])[0][0];
  let t = 1e9, bo = -1, l = 1e9, ri = -1;
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) {
    if (Math.abs(data[y * info.width + x] - bg) > T) { t = Math.min(t, y); bo = Math.max(bo, y); l = Math.min(l, x); ri = Math.max(ri, x); }
  }
  console.log(`${p.split("/").pop()}: x ${l}..${ri} y ${t}..${bo} (bg ${bg})`);
}
