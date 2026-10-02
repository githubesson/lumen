/**
 * The Replay screen's requests and the figures both clients derive from a
 * response. The period model itself lives in `./period`.
 */

import type {
  ReplayActivityBucket,
  ReplayBucket,
  ReplayGenreSlice,
} from "../api";
import { periodKey, periodRange, periodTitle, type Period } from "./period";

export type ReplayRange = ReturnType<typeof periodRange>;

export interface ReplayRequest {
  range: ReplayRange;
  /**
   * The period's key plus the days its range covers. Rolling periods ("this
   * month", "last 30 days") keep their key across a boundary; with the days
   * in it, a cached answer for last month never stands in for this month's,
   * while "last 30 days" still hits within a day.
   */
  cacheKey: string;
}

/**
 * The range to ask for and its cache key, as of now. Rolling periods move, so
 * callers recompute this when the local day changes (see `useLocalDay`).
 */
export function replayRequest(period: Period): ReplayRequest {
  const range = periodRange(period);
  const day = (iso?: string) => iso?.slice(0, 10) ?? "";
  return {
    range,
    cacheKey: `${periodKey(period)}:${day(range.from)}:${day(range.to)}`,
  };
}

/** How many top tracks a generated Replay playlist holds. */
export const REPLAY_PLAYLIST_LIMIT = 50;

/** The `generateReplayPlaylist` body for the range on screen. */
export function replayPlaylistRequest(period: Period, range: ReplayRange) {
  return {
    from: range.from,
    to: range.to,
    name: `Replay · ${periodTitle(period)}`,
    limit: REPLAY_PLAYLIST_LIMIT,
  };
}

/** The `getReplayImage` parameters for the range on screen. */
export function replayImageRequest(period: Period, range: ReplayRange) {
  return { from: range.from, to: range.to, title: periodTitle(period) };
}

/** The share image's file name: the period key made filename-safe. */
export function replayImageFilename(period: Period): string {
  return `replay-${periodKey(period).replace(/[^a-z0-9-]/gi, "-")}.png`;
}

/** Each top track's play count in the period, by track id. */
export function playsById(
  tracks: readonly { id: string; plays: number }[] | null | undefined,
): Map<string, number> {
  const out = new Map<string, number>();
  for (const track of tracks ?? []) out.set(track.id, track.plays);
  return out;
}

/**
 * The activity chart's scale: the tallest bucket, which the bars are drawn
 * against, and how many buckets apart the axis labels go so that at most
 * `maxLabels` show and they don't overlap.
 */
export function activityChartScale(
  buckets: readonly ReplayActivityBucket[],
  maxLabels = 6,
): { max: number; labelStep: number } {
  return {
    max: buckets.reduce((m, b) => Math.max(m, b.plays), 0),
    labelStep: Math.max(1, Math.ceil(buckets.length / maxLabels)),
  };
}

/**
 * How much an axis label says. The phone's chart is narrow, so it labels days
 * by their number and months by their initial; the web spells out the month.
 */
export type ActivityLabelStyle = "compact" | "verbose";

const LABEL_FORMATS: Record<
  ActivityLabelStyle,
  Record<ReplayBucket, Intl.DateTimeFormatOptions>
> = {
  compact: {
    day: { day: "numeric" },
    week: { month: "short", day: "numeric" },
    month: { month: "narrow" },
  },
  verbose: {
    day: { month: "short", day: "numeric" },
    week: { month: "short", day: "numeric" },
    month: { month: "short", year: "2-digit" },
  },
};

// Built on first use: a formatter is costly to set up, and a chart labels
// many buckets on every render.
const labelFormatters = new Map<string, Intl.DateTimeFormat>();

/** The axis label for the bucket starting at `date`. */
export function activityBucketLabel(
  date: Date,
  bucket: ReplayBucket,
  style: ActivityLabelStyle,
): string {
  const cacheKey = `${style}:${bucket}`;
  let formatter = labelFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, LABEL_FORMATS[style][bucket]);
    labelFormatters.set(cacheKey, formatter);
  }
  return formatter.format(date);
}

/** Each genre with its share of the listed genres' plays, as a percentage. */
export function genreShares<G extends ReplayGenreSlice>(
  genres: readonly G[],
): Array<G & { share: number }> {
  const total = genres.reduce((sum, g) => sum + g.plays, 0);
  return genres.map((g) => ({
    ...g,
    share: total > 0 ? (g.plays / total) * 100 : 0,
  }));
}
