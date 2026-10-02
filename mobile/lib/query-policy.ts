/**
 * Shared freshness windows for React Query data.
 *
 * Mutations still invalidate affected keys immediately, so these windows only
 * suppress redundant mount/focus requests while data is known to be fresh.
 */
import { ApiError } from "@music-library/core";

const REFUSAL_STATUSES = new Set([401, 403, 404, 410]);

/**
 * Whether the server refused a read: the resource is gone (404, 410) or not
 * this user's (401, 403). That's its answer about the resource, so a cached
 * copy must not be served in its place, now or later: drop it. Transport
 * failures, timeouts, rate limits and 5xx (a proxy whose backend is down) say
 * nothing about the resource, and cached data may stand in.
 */
export function isRefusal(error: unknown): boolean {
  return error instanceof ApiError && REFUSAL_STATUSES.has(error.status);
}

export const QUERY_STALE_TIME = {
  default: 2 * 60 * 1000,
  libraryList: 5 * 60 * 1000,
  replay: 15 * 60 * 1000,
  rediscover: 60 * 60 * 1000,
} as const;
