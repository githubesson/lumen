// Print pixel values: node tools/px.mjs a.png b.png x,y [x,y ...]
import sharp from "sharp";
const [a, b, ...pts] = process.argv.slice(2);
const load = async (p) => sharp(p).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const A = await load(a), B = await load(b);
for (const pt of pts) {
  const [x, y] = pt.split(",").map(Number);
  const px = (I) => { const i = (y * I.info.width + x) * 4; return [...I.data.slice(i, i + 4)].join(","); };
  console.log(`${x},${y}  ref ${px(A)}  rune ${px(B)}`);
}
