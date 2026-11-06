// Ink-weighted centroid (x, y) of a region in two images, against the
// region's background: node tools/centroid.mjs a.png b.png x,y,w,h [...]
import sharp from "sharp";
const [a, b, ...regions] = process.argv.slice(2);
const load = async (p) => sharp(p).flatten({ background: "#ff00ff" }).greyscale().raw().toBuffer({ resolveWithObject: true });
const A = await load(a), B = await load(b);
for (const r of regions) {
  const [x0, y0, w, h] = r.split(",").map(Number);
  const c = (I) => {
    const W = I.info.width, hist = new Map();
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const v = I.data[y * W + x]; hist.set(v, (hist.get(v) ?? 0) + 1); }
    const bg = [...hist.entries()].sort((p, q) => q[1] - p[1])[0][0];
    let sx = 0, sy = 0, t = 0;
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) { const v = Math.abs(I.data[y * W + x] - bg); sx += v * x; sy += v * y; t += v; }
    return [sx / t, sy / t];
  };
  const [ax, ay] = c(A), [bx, by] = c(B);
  console.log(`${r}: dx ${(bx - ax).toFixed(2)} dy ${(by - ay).toFixed(2)}`);
}
