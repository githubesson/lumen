// Re-export of the shared formatters. The implementation lives in
// `core/src/format.ts` so the web and mobile clients cannot drift apart again —
// this file and `mobile/lib/format.ts` were two independent copies that had
// already diverged on empty-duration sentinels and byte rounding.
//
// The `fmt*` names are kept because they are used in ~50 call sites here.
export {
  formatDurationSec as fmtDurationSec,
  formatTotalMs as fmtTotalMs,
  formatBytes as fmtBytes,
  pluralize,
} from "@music-library/core/format";

export { displayText } from "./text";

import { formatDurationMs } from "@music-library/core/format";

/**
 * Duration in milliseconds -> "m:ss".
 *
 * The web renders "0:00" rather than "—" for an unknown duration, which is what
 * the shared helper's `emptyLabel` parameter exists for.
 */
export function fmtDurationMs(ms: number): string {
  return formatDurationMs(ms, "0:00");
}
