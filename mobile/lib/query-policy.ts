/**
 * Shared freshness windows for React Query data.
 *
 * Mutations still invalidate affected keys immediately, so these windows only
 * suppress redundant mount/focus requests while data is known to be fresh.
 */
import { ApiError } from "@music-library/core";

/**
 * Whether a failed read may fall back to cached data. Not when the server
 * answered with a 4xx: a 404 or 403 is its answer about the resource (deleted,
 * access revoked), which a cached copy must not override. Transport failures,
 * timeouts and 5xx (a proxy whose backend is down) say nothing of the sort.
 */
export function canServeCachedAfter(error: unknown): boolean {
  return !(error instanceof ApiError && error.status >= 400 && error.status < 500);
}

export const QUERY_STALE_TIME = {
  default: 2 * 60 * 1000,
  libraryList: 5 * 60 * 1000,
  replay: 15 * 60 * 1000,
  rediscover: 60 * 60 * 1000,
} as const;
