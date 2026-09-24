// Renders the hero screenshots in screenshots/ into width variants in
// src/assets/screens/. Resizing here with Lanczos keeps small UI text crisp;
// letting the browser shrink one big image by 2–4× smears it, especially at 1x.
//
//   npm run screens
import { mkdir, readdir, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import sharp from "sharp";

const SRC = fileURLToPath(new URL("../screenshots/", import.meta.url));
const OUT = fileURLToPath(new URL("../src/assets/screens/", import.meta.url));

// Close steps so the browser never scales a variant by more than ~1.25×.
const WIDTHS = {
  desktop: [560, 700, 880, 1100, 1280],
  mobile: [240, 300, 380, 480, 600, 760, 960, 1178],
};

// Write in place and prune stale files afterwards, never emptying the folder:
// a running dev server globs it, and an empty moment breaks the page.
await mkdir(OUT, { recursive: true });
const written = new Set();

for (const file of (await readdir(SRC)).filter((f) => f.endsWith(".webp") || f.endsWith(".png"))) {
  const name = file.replace(/\.(webp|png)$/, "");
  const kind = name.startsWith("mobile") ? "mobile" : "desktop";
  const { width: max } = await sharp(SRC + file).metadata();
  for (const w of WIDTHS[kind].filter((w) => w <= max)) {
    await sharp(SRC + file)
      .resize({ width: w, kernel: "lanczos3" })
      .webp({ quality: 88, effort: 6, smartSubsample: true })
      .toFile(`${OUT}${name}-${w}.webp`);
    written.add(`${name}-${w}.webp`);
  }
  console.log(name, WIDTHS[kind].filter((w) => w <= max).join(", "));
}

for (const file of await readdir(OUT)) {
  if (!written.has(file)) await rm(OUT + file);
}
