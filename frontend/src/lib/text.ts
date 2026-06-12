// Mojibake (double-encoded UTF-8) cleanup for track/album/artist text.
// Centralized from MiniPlayer (byte-for-byte) so corrupted metadata renders
// cleanly in lists and the command palette, not just the player bar.
// The real fix is normalizing text on ingest.
export function displayText(value: string | null | undefined, fallback = "") {
  return (value ?? fallback)
    .replace(/\u00c3\u0082\u00c2\u00b7|\u00c2\u00b7/g, "\u00b7")
    .replace(/\u00c3\u00a2\u00e2\u0082\u00ac\u00e2\u20ac\u0153/g, "\u2014")
    .replace(/\u00c3\u0085\u00c2\u0081/g, "L")
    .replace(/\u00c3\u0084/g, "")
    .replace(/\u00c2/g, "")
    .replace(/\u00c3/g, "")
    .trim();
}
