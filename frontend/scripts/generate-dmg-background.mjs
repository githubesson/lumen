import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { deflateSync } from "node:zlib";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const outputDir = path.resolve(__dirname, "..", "electron", "assets");

// electron-builder's standard DMG geometry. Content coordinates are icon
// centers in device-independent pixels; Finder renders each icon at 80 px.
const layout = {
  width: 540,
  height: 380,
  iconSize: 80,
  frameSize: 100,
  frameRadius: 23,
  centers: [
    { x: 130, y: 220, palette: "lumen" },
    { x: 410, y: 220, palette: "applications" },
  ],
};

mkdirSync(outputDir, { recursive: true });

function renderBackground(scale, destination) {
  const width = layout.width * scale;
  const height = layout.height * scale;
  const pixels = Buffer.alloc(width * height * 4);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const px = x / scale;
      const py = y / scale;
      const vertical = py / layout.height;
      const horizontal = px / layout.width;

      // Near-black, slightly cool base with a restrained center lift. Keeping
      // it opaque avoids Finder compositing differences across macOS releases.
      const centerLift = Math.max(
        0,
        1 - Math.hypot((horizontal - 0.5) * 1.15, (vertical - 0.48) * 0.9),
      );
      const rgb = [
        3.3 + centerLift * 1.3,
        3.1 + centerLift * 0.8,
        7.2 + centerLift * 2.4,
      ];

      for (const frame of layout.centers) {
        addContour(rgb, px, py, frame);
      }

      // Sub-pixel monochrome grain prevents visible banding in the glow while
      // remaining effectively invisible at normal Finder scale.
      const grain = (hashNoise(x, y) - 0.5) * 0.75;
      const offset = (y * width + x) * 4;
      pixels[offset] = byte(rgb[0] + grain);
      pixels[offset + 1] = byte(rgb[1] + grain);
      pixels[offset + 2] = byte(rgb[2] + grain);
      pixels[offset + 3] = 255;
    }
  }

  writeFileSync(destination, encodePNG(width, height, pixels));
  console.log(`wrote ${path.relative(process.cwd(), destination)} (${width}x${height})`);
}

function addContour(rgb, x, y, frame) {
  const half = layout.frameSize / 2;
  const distance = roundedRectDistance(
    x - frame.x,
    y - frame.y,
    half,
    half,
    layout.frameRadius,
  );
  const absoluteDistance = Math.abs(distance);
  if (absoluteDistance > 24) return;

  // A precise one-pixel rim, a tight secondary bloom, and a faint 20 px spill.
  // There is intentionally no filled radial gradient inside the frame.
  const rim = gaussian(distance, 0.72) * 0.9;
  const tightBloom = Math.exp(-absoluteDistance / 2.7) * 0.24;
  const outerBloom = Math.exp(-absoluteDistance / 8.5) * 0.075;
  const intensity = rim + tightBloom + outerBloom;

  const localX = clamp((x - (frame.x - half)) / layout.frameSize, 0, 1);
  const localY = clamp((y - (frame.y - half)) / layout.frameSize, 0, 1);
  const color = contourColor(frame.palette, localX, localY);

  // Light is additive, like the edge illumination in docs/SHOWCASE.png.
  rgb[0] += color[0] * intensity;
  rgb[1] += color[1] * intensity;
  rgb[2] += color[2] * intensity;
}

function contourColor(palette, x, y) {
  const corners =
    palette === "lumen"
      ? {
          topLeft: [255, 132, 45],
          topRight: [255, 48, 164],
          bottomLeft: [35, 98, 255],
          bottomRight: [177, 42, 255],
        }
      : {
          topLeft: [122, 51, 255],
          topRight: [255, 35, 177],
          bottomLeft: [42, 92, 255],
          bottomRight: [200, 35, 255],
        };

  return [0, 1, 2].map((channel) => {
    const top = lerp(corners.topLeft[channel], corners.topRight[channel], x);
    const bottom = lerp(
      corners.bottomLeft[channel],
      corners.bottomRight[channel],
      x,
    );
    return lerp(top, bottom, y);
  });
}

// Signed distance to a rounded rectangle. Zero is the illuminated contour,
// negative values are inside, and positive values are outside.
function roundedRectDistance(x, y, halfWidth, halfHeight, radius) {
  const qx = Math.abs(x) - halfWidth + radius;
  const qy = Math.abs(y) - halfHeight + radius;
  return (
    Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) +
    Math.min(Math.max(qx, qy), 0) -
    radius
  );
}

function gaussian(value, sigma) {
  return Math.exp(-(value * value) / (2 * sigma * sigma));
}

function hashNoise(x, y) {
  let value = Math.imul(x + 1, 0x1f123bb5) ^ Math.imul(y + 1, 0x5f356495);
  value ^= value >>> 15;
  value = Math.imul(value, 0x2c1b3c6d);
  value ^= value >>> 12;
  return (value >>> 0) / 0xffffffff;
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const scanlines = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const row = y * (stride + 1);
    scanlines[row] = 0; // PNG filter: None
    rgba.copy(scanlines, row + 1, y * stride, (y + 1) * stride);
  }

  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 6; // RGBA
  header[10] = 0;
  header[11] = 0;
  header[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function pngChunk(type, data) {
  const name = Buffer.from(type, "ascii");
  const body = Buffer.concat([name, data]);
  const chunk = Buffer.alloc(data.length + 12);
  chunk.writeUInt32BE(data.length, 0);
  body.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(body), data.length + 8);
  return chunk;
}

const crcTable = Array.from({ length: 256 }, (_, index) => {
  let value = index;
  for (let bit = 0; bit < 8; bit++) {
    value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  return value >>> 0;
});

function crc32(data) {
  let crc = 0xffffffff;
  for (const byteValue of data) {
    crc = crcTable[(crc ^ byteValue) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function lerp(from, to, amount) {
  return from + (to - from) * amount;
}

function clamp(value, minimum, maximum) {
  return Math.min(maximum, Math.max(minimum, value));
}

function byte(value) {
  return Math.round(clamp(value, 0, 255));
}

renderBackground(1, path.join(outputDir, "dmg-background.png"));
renderBackground(2, path.join(outputDir, "dmg-background@2x.png"));
