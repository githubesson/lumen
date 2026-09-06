/**
 * Display formatters shared by the web and mobile clients.
 *
 * These previously existed as two independent copies — `frontend/src/lib/format.ts`
 * and `mobile/lib/format.ts` — each of which carried a comment explaining that it
 * had been created to *de*-duplicate inline helpers. They then drifted from each
 * other: different empty-duration sentinels and a different byte-rounding rule.
 * This is the single implementation; the platform modules are thin re-exports.
 */

/** Duration in seconds -> "m:ss". Guards against NaN/Infinity/negative. */
export function formatDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const total = Math.floor(sec);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/**
 * Duration in milliseconds -> "m:ss".
 *
 * `emptyLabel` is the one place the two clients deliberately disagreed, and the
 * disagreement is legitimate: a live playback clock wants "0:00" (an em dash
 * there looks broken), while a metadata row wants "—" (the value may genuinely
 * be absent). It is a parameter rather than two implementations.
 */
export function formatDurationMs(
  ms: number | null | undefined,
  emptyLabel = "0:00",
): string {
  if (ms == null || !Number.isFinite(ms) || ms <= 0) return emptyLabel;
  return formatDurationSec(ms / 1000);
}

/** Total duration in milliseconds -> "12 min" / "1 hr 23 min". */
export function formatTotalMs(totalMs: number): string {
  const mins = Math.floor(Math.max(0, totalMs) / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hr ${m} min`;
}

/**
 * Byte count -> human-readable size ("4.2 MB"); em dash for non-positive.
 *
 * Rounding takes the useful half of each old copy: whole numbers for raw bytes
 * (the web copy printed "50.0 B") and for values at or above 100 (the mobile
 * copy printed "146.5 KB"), one decimal otherwise.
 */
export function formatBytes(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = bytes;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 || v >= 100 ? 0 : 1)} ${units[i]}`;
}

/** "1 track" / "2 tracks". */
export function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : (plural ?? `${singular}s`)}`;
}
