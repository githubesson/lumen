// Regenerates the committed images under public/ from the sources the rest of
// the repo already owns: the README showcase render and the desktop app icon.
// Run `npm run images` after either source changes; the outputs are committed
// so the Pages build never needs sharp.
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const showcase = path.join(root, "..", "docs", "SHOWCASE.png");
const icon = path.join(root, "..", "frontend", "electron", "assets", "icon.png");
const out = (name) => path.join(root, "public", name);

const widths = [1672, 960];
for (const width of widths) {
  const base = sharp(showcase).resize({ width, withoutEnlargement: true });
  await base.clone().avif({ quality: 55, effort: 6 }).toFile(out(`showcase-${width}.avif`));
  await base.clone().webp({ quality: 82 }).toFile(out(`showcase-${width}.webp`));
}

// Open Graph card: 1200x630, cropped toward the centre where the devices sit.
await sharp(showcase)
  .resize({ width: 1200, height: 630, fit: "cover", position: "centre" })
  .jpeg({ quality: 84, mozjpeg: true })
  .toFile(out("og.jpg"));

await sharp(icon).resize(180).png().toFile(out("apple-touch-icon.png"));
await sharp(icon).resize(64).png().toFile(out("favicon.png"));

console.log("images written to public/");
