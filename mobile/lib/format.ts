// Re-export of the shared formatters. The implementation lives in
// `core/src/format.ts` so the web and mobile clients cannot drift apart again —
// this file and `frontend/src/lib/format.ts` were two independent copies that
// had already diverged on empty-duration sentinels and byte rounding.
export {
  formatDurationSec,
  formatBytes,
  formatTotalMs,
  pluralize,
} from "@music-library/core/format";

import { formatDurationMs as sharedFormatDurationMs } from "@music-library/core/format";

/**
 * mm:ss for a duration given in MILLISECONDS. Unknown/zero durations format as
 * "—" — the right default for metadata and track rows, where the value may be
 * genuinely absent. (Playback clocks use `formatDurationSec`, which falls back
 * to "0:00".)
 */
export function formatDurationMs(ms: number | null | undefined): string {
  return sharedFormatDurationMs(ms, "—");
}
