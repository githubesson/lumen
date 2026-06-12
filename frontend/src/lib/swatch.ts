/**
 * Deterministic diagonal gradient in OKLCH, hashed from any string. One
 * canonical set of constants so every placeholder (cover tiles, playlist
 * swatches, sidebar) looks cohesive — previously this was copy-pasted into 5+
 * files that had each drifted to different lightness/chroma values.
 */
export function swatchFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) | 0;
  const h = Math.abs(hash) % 360;
  const h2 = (h + 40) % 360;
  return `linear-gradient(135deg, oklch(0.68 0.15 ${h}), oklch(0.48 0.12 ${h2}))`;
}
