// Re-export of the shared Replay period model. The implementation lives in
// `core/src/replay/period.ts` — `frontend/src/pages/Replay.tsx` carried an
// identical copy of the date arithmetic, and the two had already drifted on
// the picker order and the hero title.
export {
  buildPeriodOptions,
  periodKey,
  periodLabel,
  periodRange,
  periodTitle,
  type Period,
} from "@music-library/core/replay/period";
