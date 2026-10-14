import { api, type ReplayData } from "../api";
import { dropCache, readCache, writeCache } from "./resourceCache";
import { replaySeriesComplete, type ReplayQueries, type ReplayQuery } from "@music-library/core/replay/replay";

/**
 * A Replay period's numbers, as the Replay page and Home's period panels
 * both load and cache them, so either warms the other.
 */

/** Where the Replay page remembers which past years have plays (its pills). */
export const REPLAY_YEARS_KEY = "replay:years";

/**
 * The period's plays, asked for by day whatever its chart shows: days with
 * plays and the daily average need them, and the chart adds them up into
 * months itself (see `activitySeries`). The server caps how many buckets it
 * sends, so an all-time history longer than that comes back without its
 * newest days; then it is asked for again by month, and the figures count
 * months instead (see `replayCalendar`). Only all time has that fallback
 * (`monthly`): a bounded period can't reach the cap. Once all time has come
 * back by month, it is asked for by month straight away, rather than
 * fetching every day again only to throw them away. Says which query
 * answered, since the two are cached apart.
 */
export async function fetchReplay(
  request: ReplayQueries,
  signal: AbortSignal,
): Promise<{ query: ReplayQuery; data: ReplayData }> {
  const { daily, monthly } = request;
  const byMonth = async (query: ReplayQuery) => ({ query, data: await api.getReplay(query.params, { signal }) });
  if (monthly && readCache(monthly.cacheKey) !== undefined) return byMonth(monthly);
  const data = await api.getReplay(daily.params, { signal });
  if (!monthly || replaySeriesComplete(data)) return { query: daily, data };
  return byMonth(monthly);
}

/**
 * The period's last answer: by day, or by month under its own key when the
 * days were cut short. Only one is kept (see `storeReplay`), so this is the
 * latest either way.
 */
export function readReplayCache(request: ReplayQueries): ReplayData | null {
  const byDay = readCache<ReplayData>(request.daily.cacheKey);
  return byDay ?? (request.monthly ? readCache<ReplayData>(request.monthly.cacheKey) : undefined) ?? null;
}

/**
 * Keeps one answer per period, under the key of the query that gave it:
 * the daily key never holds months, and an older answer under the other key
 * can't come back in front of this one. Also notes the years with plays.
 */
export function storeReplay(request: ReplayQueries, query: ReplayQuery, data: ReplayData) {
  const other = query === request.daily ? request.monthly : request.daily;
  if (other) dropCache(other.cacheKey);
  writeCache(query.cacheKey, data);
  writeCache(REPLAY_YEARS_KEY, data.available_years ?? []);
}
