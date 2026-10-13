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
 * The tracks credited to the artist named `name`, in their order. A track's
 * `artist` is its primary artists joined with ", " (as the server sends it),
 * so the name has to be one whole entry of that list: "Kestrel Bay" matches
 * "Halden Marsh, Kestrel Bay" but "Bay" matches nothing. A name that itself
 * contains ", " still matches, because the whole name is looked for between
 * separators.
 */
export function tracksByArtist<T extends { artist?: string }>(
  name: string,
  tracks: readonly T[],
): T[] {
  const needle = name.trim();
  if (!needle) return [];
  const entry = `, ${needle}, `;
  return tracks.filter((track) => !!track.artist && `, ${track.artist}, `.includes(entry));
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

/**
 * The axis label for the bucket starting at `date`. Buckets start at UTC
 * midnight, so the label reads the date in UTC: in local time a viewer west
 * of Greenwich would see every bucket named after the day before.
 */
export function activityBucketLabel(
  date: Date,
  bucket: ReplayBucket,
  style: ActivityLabelStyle,
): string {
  const cacheKey = `${style}:${bucket}`;
  let formatter = labelFormatters.get(cacheKey);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat(undefined, {
      ...LABEL_FORMATS[style][bucket],
      timeZone: "UTC",
    });
    labelFormatters.set(cacheKey, formatter);
  }
  return formatter.format(date);
}

// ── Days ────────────────────────────────────────────────────────────────────
//
// The API buckets plays by UTC day (and the period boundaries are UTC
// midnights, see `periodRange`), so everything below counts UTC days and
// hands back UTC midnights in milliseconds. Format them with
// `timeZone: "UTC"`, or a viewer west of Greenwich sees each day labelled
// as the one before.

const DAY_MS = 24 * 60 * 60 * 1000;

const floorDay = (ms: number) => Math.floor(ms / DAY_MS) * DAY_MS;

/**
 * The UTC day a bucket stands for. Buckets start at UTC midnight when the
 * database runs in UTC; rounding to the nearest midnight keeps a server in
 * another zone, whose days start a few hours either side, on the right day.
 */
const bucketDay = (iso: string) => Math.round(Date.parse(iso) / DAY_MS) * DAY_MS;

/** Months since year 0, so consecutive months differ by one. */
const monthIndex = (ms: number) => {
  const d = new Date(ms);
  return d.getUTCFullYear() * 12 + d.getUTCMonth();
};
const monthStart = (index: number) => Date.UTC(Math.floor(index / 12), index % 12, 1);

/**
 * Whether the activity series holds every play the summary counts. The
 * server caps how many buckets it returns (keeping the oldest), so a long
 * enough history asked for by day comes back without its newest days. Both
 * count the same plays, so a series that adds up to less than the total was
 * cut short.
 */
export function replaySeriesComplete(data: {
  summary: { total_plays: number };
  activity: readonly ReplayActivityBucket[];
}): boolean {
  const counted = data.activity.reduce((sum, b) => sum + b.plays, 0);
  return counted >= data.summary.total_plays;
}

/** The first and last day (UTC midnights, both inclusive) a period covers so far. */
export interface ReplayDaySpan {
  first: number;
  last: number;
}

/**
 * The days a period covers so far: from its first whole day (for all time,
 * the first day with plays) to today, or to its last day once it is over.
 * "Last 30 days" starts partway through a day, so its first whole day is the
 * one after: today and the 29 days before it.
 *
 * Pass the daily activity series when there is one: all time needs it for a
 * start, and a play the server dated after today's UTC date (a clock ahead,
 * or a server in another zone) moves the end out to it. Null when there is
 * no start yet.
 */
export function replayDaySpan(
  range: ReplayRange,
  dailyActivity?: readonly ReplayActivityBucket[] | null,
  now: Date = new Date(),
): ReplayDaySpan | null {
  let first = Infinity;
  let last = floorDay(now.getTime());
  for (const b of dailyActivity ?? []) {
    const day = bucketDay(b.bucket_start);
    if (day < first) first = day;
    if (day > last) last = day;
  }
  if (range.from) first = Math.ceil(Date.parse(range.from) / DAY_MS) * DAY_MS;
  if (range.to) last = Math.min(last, floorDay(Date.parse(range.to) - 1));
  if (!Number.isFinite(first) || last < first) return null;
  return { first, last };
}

/**
 * Plays per day -- or per month, when the series came back monthly -- over
 * the period so far. `first` and `last` are the first and last day's UTC
 * midnight, or the first and last month's first day.
 */
export interface ReplayCalendar extends ReplayDaySpan {
  unit: "day" | "month";
  /** One entry per day (or month) from `first` to `last`, zero without plays. */
  plays: number[];
  /** How many of those days (or months) had at least one play. */
  withPlays: number;
}

/**
 * Every day (or month) the period covers so far with its plays, filled in
 * from the activity series, which only lists buckets with plays. Plays
 * outside the span -- the partial day "last 30 days" starts in -- are left
 * out. A monthly series counts months: it can't say which days had plays.
 * Null for a weekly series, or when the period has nothing to count yet.
 */
export function replayCalendar(
  data: { activity: readonly ReplayActivityBucket[]; bucket: ReplayBucket },
  range: ReplayRange,
  now: Date = new Date(),
): ReplayCalendar | null {
  if (data.bucket === "day") {
    const span = replayDaySpan(range, data.activity, now);
    if (!span) return null;
    const plays = new Array<number>((span.last - span.first) / DAY_MS + 1).fill(0);
    for (const b of data.activity) {
      const i = (bucketDay(b.bucket_start) - span.first) / DAY_MS;
      if (i >= 0 && i < plays.length) plays[i] += b.plays;
    }
    return { unit: "day", ...span, plays, withPlays: plays.filter((p) => p > 0).length };
  }
  if (data.bucket !== "month") return null;
  const months = data.activity.map((b) => monthIndex(bucketDay(b.bucket_start)));
  let first = range.from
    ? monthIndex(Math.ceil(Date.parse(range.from) / DAY_MS) * DAY_MS)
    : Math.min(Infinity, ...months);
  let last = Math.max(monthIndex(now.getTime()), ...months);
  if (range.to) last = Math.min(last, monthIndex(Date.parse(range.to) - 1));
  if (!Number.isFinite(first) || last < first) return null;
  const plays = new Array<number>(last - first + 1).fill(0);
  data.activity.forEach((b, i) => {
    const at = months[i] - first;
    if (at >= 0 && at < plays.length) plays[at] += b.plays;
  });
  first = monthStart(first);
  last = monthStart(last);
  return { unit: "month", first, last, plays, withPlays: plays.filter((p) => p > 0).length };
}

/** Plays per day (or month) of the period so far; null without a calendar. */
export function playsPerUnit(totalPlays: number, calendar: ReplayCalendar | null): number | null {
  return calendar && calendar.plays.length > 0 ? totalPlays / calendar.plays.length : null;
}

function bucketStartOf(day: number, bucket: ReplayBucket): number {
  const d = new Date(day);
  switch (bucket) {
    case "day":
      return day;
    case "week":
      // Weeks start on Monday, like Postgres' date_trunc('week').
      return day - ((d.getUTCDay() + 6) % 7) * DAY_MS;
    case "month":
      return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1);
  }
}

/**
 * The calendar grouped into the activity chart's buckets, every bucket
 * present (empty ones at zero) so quiet stretches show as gaps rather than
 * closing up. A monthly calendar can only be drawn by month, whatever
 * `bucket` asks for; `bucket` in the result says which it got.
 */
export function activitySeries(
  calendar: ReplayCalendar,
  bucket: ReplayBucket,
): { bucket: ReplayBucket; buckets: ReplayActivityBucket[] } {
  const by: ReplayBucket = calendar.unit === "month" ? "month" : bucket;
  const firstMonth = monthIndex(calendar.first);
  const buckets: ReplayActivityBucket[] = [];
  let current = NaN;
  calendar.plays.forEach((plays, i) => {
    const unitStart =
      calendar.unit === "day" ? calendar.first + i * DAY_MS : monthStart(firstMonth + i);
    const start = bucketStartOf(unitStart, by);
    if (start !== current) {
      buckets.push({ bucket_start: new Date(start).toISOString(), plays: 0 });
      current = start;
    }
    buckets[buckets.length - 1].plays += plays;
  });
  return { bucket: by, buckets };
}

/** The busiest bucket (the first, on a tie); null when none has plays. */
export function activityPeak(
  buckets: readonly ReplayActivityBucket[],
): ReplayActivityBucket | null {
  let peak: ReplayActivityBucket | null = null;
  for (const b of buckets) {
    if (b.plays > 0 && (!peak || b.plays > peak.plays)) peak = b;
  }
  return peak;
}

/**
 * Each top artist's most played track among the top tracks, matched on the
 * track's primary artist names, so an artist tile can show art from music
 * the period actually played. Artists with no track in the list are absent.
 */
export function topTrackByArtist<T extends { artist?: string }>(
  artists: readonly { id: string; name: string }[],
  tracks: readonly T[],
): Map<string, T> {
  const byName = new Map<string, T>();
  for (const track of tracks) {
    for (const name of (track.artist ?? "").split(", ")) {
      const key = name.trim().toLocaleLowerCase();
      if (key && !byName.has(key)) byName.set(key, track);
    }
  }
  const out = new Map<string, T>();
  for (const artist of artists) {
    const track = byName.get(artist.name.trim().toLocaleLowerCase());
    if (track) out.set(artist.id, track);
  }
  return out;
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
