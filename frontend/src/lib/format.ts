// Shared formatting helpers. Previously each of these lived inline in 4-6
// different files (fmtDuration/fmtTime/fmtSecs/fmtBytes/fmtTotal); centralizing
// keeps them consistent and removes the ms-vs-seconds drift that caused the
// duplication in the first place.

export { displayText } from "./text";

/** Duration in milliseconds -> "m:ss". */
export function fmtDurationMs(ms: number): string {
  return fmtDurationSec((ms ?? 0) / 1000);
}

/** Duration in seconds -> "m:ss". Guards against NaN/Infinity/negative. */
export function fmtDurationSec(sec: number): string {
  if (!Number.isFinite(sec) || sec < 0) return "0:00";
  const s = Math.floor(sec);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}

/** Total duration in milliseconds -> "12 min" / "1 hr 23 min". */
export function fmtTotalMs(totalMs: number): string {
  const mins = Math.floor(Math.max(0, totalMs) / 60000);
  if (mins < 60) return `${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `${h} hr ${m} min`;
}

/** Byte count -> human-readable size ("4.2 MB"); em dash for non-positive. */
export function fmtBytes(n: number): string {
  if (n <= 0) return "—";
  const units = ["B", "KB", "MB", "GB"];
  let u = 0;
  let v = n;
  while (v >= 1024 && u < units.length - 1) {
    v /= 1024;
    u++;
  }
  return `${v.toFixed(v >= 100 ? 0 : 1)} ${units[u]}`;
}

/** "1 track" / "2 tracks". */
export function pluralize(n: number, singular: string, plural?: string): string {
  return `${n} ${n === 1 ? singular : plural ?? `${singular}s`}`;
}
