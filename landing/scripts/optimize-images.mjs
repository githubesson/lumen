// Regenerates the committed images under public/ from their sources: the app
// screenshots in assets/screens, the README showcase render (link previews
// only), and the desktop app icon. Run `npm run images` after any source
// changes; the outputs are committed so the Pages build never needs sharp.
import path from "node:path";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, "..");
const screens = path.join(root, "assets", "screens");
const showcase = path.join(root, "..", "docs", "SHOWCASE.png");
const icon = path.join(root, "..", "frontend", "electron", "assets", "icon.png");
const out = (name) => path.join(root, "public", name);

// The hero draws a laptop and a phone in CSS around these screens, one per
// theme. Widths cover the largest size each screen renders at on a 2x or 3x
// display; the sources are never enlarged.
const SCREENS = {
  desktop: [1280, 800],
  mobile: [780, 480],
};
for (const [device, widths] of Object.entries(SCREENS)) {
  for (const theme of ["dark", "light"]) {
    const src = sharp(path.join(screens, `${device}-${theme}.png`));
    for (const width of widths) {
      const base = src.clone().resize({ width, withoutEnlargement: true });
      await base.clone().avif({ quality: 62, effort: 6 }).toFile(out(`${device}-${theme}-${width}.avif`));
      await base.clone().webp({ quality: 84 }).toFile(out(`${device}-${theme}-${width}.webp`));
    }
  }
}

// Open Graph card: 1200x630 from the render, cropped toward the centre where
// the devices sit.
await sharp(showcase)
  .resize({ width: 1200, height: 630, fit: "cover", position: "centre" })
  .jpeg({ quality: 84, mozjpeg: true })
  .toFile(out("og.jpg"));

await sharp(icon).resize(180).png().toFile(out("apple-touch-icon.png"));
await sharp(icon).resize(64).png().toFile(out("favicon.png"));

console.log("images written to public/");
