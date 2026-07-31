// Re-export of the shared Replay formatters. `formatListeningTime` lives in
// `core/src/replay/period.ts` alongside the period model; the phone uses its
// compact style (the default), which is what these tiles were already doing.
export { formatListeningTime } from "@music-library/core/replay/period";

// `playsLabel` was a hand-rolled duplicate of core's `pluralize`, which the web
// Replay page already used for the same strings.
export { pluralize } from "@music-library/core/format";
