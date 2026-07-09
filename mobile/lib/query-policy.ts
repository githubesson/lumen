/**
 * Shared freshness windows for React Query data.
 *
 * Mutations still invalidate affected keys immediately, so these windows only
 * suppress redundant mount/focus requests while data is known to be fresh.
 */
export const QUERY_STALE_TIME = {
  default: 2 * 60 * 1000,
  libraryList: 5 * 60 * 1000,
  replay: 15 * 60 * 1000,
  rediscover: 60 * 60 * 1000,
} as const;
