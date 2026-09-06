// Re-export of the shared debounce hook. The implementation lives in
// `core/src/use-debounced-value.ts` — this file and a copy inlined at the
// bottom of `frontend/src/pages/Library.tsx` were the same hook twice.
export { useDebouncedValue } from "@music-library/core/use-debounced-value";
