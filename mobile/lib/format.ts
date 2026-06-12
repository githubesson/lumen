/**
 * Shared display formatters. Previously copy-pasted into several screens with
 * subtly different empty-state sentinels ("-" vs "—"); centralized here.
 */

/**
 * mm:ss for a playback position/duration given in SECONDS. Invalid/zero values
 * format as "0:00" — the right default for live playback clocks and snippet
 * pickers, where an em-dash would look broken.
 */
export function formatDurationSec(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0:00";
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  const secs = total % 60;
  return `${minutes}:${secs.toString().padStart(2, "0")}`;
}

/**
 * mm:ss for a duration given in MILLISECONDS. Unknown/zero durations format as
 * "—" — the right default for metadata and track rows, where the value may be
 * genuinely absent.
 */
export function formatDurationMs(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "—";
  return formatDurationSec(ms / 1000);
}

/** Human-readable byte size (B/KB/MB/GB). Unknown/zero → "—". */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}
