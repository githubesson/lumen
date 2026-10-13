import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityBucketLabel,
  activityChartScale,
  activityPeak,
  activitySeries,
  genreShares,
  playsById,
  playsPerUnit,
  replayCalendar,
  replayDaySpan,
  replayImageFilename,
  replayImageRequest,
  replayPlaylistRequest,
  replayQueries,
  replayRequest,
  replaySeriesComplete,
  replayAlbumSubtitle,
  replayTrackArtists,
  topArtistAction,
  topArtistTracks,
  tracksByArtist,
} from "../src/replay/replay";
import { canonicalPeriodKey, parsePeriodKey, periodKey, type Period } from "../src/replay/period";
import { pluralize } from "../src/format";

afterEach(() => {
  vi.useRealTimers();
});

describe("replayRequest", () => {
  it("keys a rolling period on the days it covers, not just its name", () => {
    vi.useFakeTimers({ now: new Date(2026, 8, 30, 12) });
    const september = replayRequest({ kind: "this-month" });
    vi.setSystemTime(new Date(2026, 9, 1, 12));
    const october = replayRequest({ kind: "this-month" });
    expect(september.cacheKey).toBe("this-month:2026-09-01:2026-10-01");
    expect(october.cacheKey).toBe("this-month:2026-10-01:2026-11-01");
  });

  it("keeps the last-30-days key within a day and moves it the next", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 2, 1)) });
    const morning = replayRequest({ kind: "last-30" });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 2, 22)));
    const evening = replayRequest({ kind: "last-30" });
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 3, 1)));
    const tomorrow = replayRequest({ kind: "last-30" });
    expect(evening.cacheKey).toBe(morning.cacheKey);
    // The request still asks for the moving window itself.
    expect(evening.range.to).not.toBe(morning.range.to);
    expect(tomorrow.cacheKey).not.toBe(morning.cacheKey);
    expect(tomorrow.cacheKey).toBe("last-30:2026-09-03:2026-10-03");
  });

  it("keys all time with empty days", () => {
    expect(replayRequest({ kind: "all" })).toEqual({
      range: { bucket: "month" },
      cacheKey: "all::",
    });
  });
});

describe("replayQueries", () => {
  it("asks Home and Replay for the same days, by day, under one key", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 2, 13)) });
    const { range, daily } = replayQueries({ kind: "last-30" });
    expect(daily).toEqual({
      params: { from: range.from, to: range.to, bucket: "day" },
      cacheKey: "replay:daily:last-30:2026-09-02:2026-10-02",
    });
    // The chart's own bucket stays on the range, for the page to draw with.
    expect(range.bucket).toBe("day");
    expect(replayQueries({ kind: "this-year" }).daily.params.bucket).toBe("day");
  });

  it("keeps the monthly fallback under a key of its own", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 2, 13)) });
    const { range, daily, monthly } = replayQueries({ kind: "all" });
    expect(range).toEqual({ bucket: "month" });
    expect(daily).toEqual({ params: { from: undefined, to: undefined, bucket: "day" }, cacheKey: "replay:daily:all::" });
    expect(monthly).toEqual({ params: { from: undefined, to: undefined, bucket: "month" }, cacheKey: "replay:monthly:all::" });
  });

  it("has no monthly fallback for a bounded period, which can't outgrow the server's cap", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 2, 13)) });
    for (const period of [
      { kind: "this-year" },
      { kind: "year", year: 2025 },
      { kind: "this-month" },
      { kind: "last-30" },
    ] as const) {
      expect(replayQueries(period).monthly, period.kind).toBeNull();
    }
  });

  it("moves the key with the days a rolling period covers", () => {
    vi.useFakeTimers({ now: new Date(Date.UTC(2026, 9, 2, 1)) });
    const morning = replayQueries({ kind: "last-30" }).daily.cacheKey;
    vi.setSystemTime(new Date(Date.UTC(2026, 9, 3, 1)));
    expect(replayQueries({ kind: "last-30" }).daily.cacheKey).not.toBe(morning);
  });
});

describe("Replay request builders", () => {
  const period = { kind: "year" as const, year: 2025 };
  const { range } = replayRequest(period);

  it("builds the generated playlist from the range on screen", () => {
    expect(replayPlaylistRequest(period, range)).toEqual({
      from: "2025-01-01T00:00:00.000Z",
      to: "2026-01-01T00:00:00.000Z",
      name: "Replay · 2025",
      limit: 50,
    });
  });

  it("builds the share image request and its file name", () => {
    expect(replayImageRequest(period, range)).toEqual({
      from: range.from,
      to: range.to,
      title: "2025",
    });
    expect(replayImageFilename(period)).toBe("replay-year-2025.png");
    expect(replayImageFilename({ kind: "last-30" })).toBe("replay-last-30.png");
  });

  it("asks for all time without a range", () => {
    const all = { kind: "all" as const };
    expect(replayPlaylistRequest(all, replayRequest(all).range)).toEqual({
      from: undefined,
      to: undefined,
      name: "Replay · All time",
      limit: 50,
    });
  });
});

describe("playsById", () => {
  it("maps each track id to its plays", () => {
    const map = playsById([
      { id: "a", plays: 3 },
      { id: "b", plays: 1 },
    ]);
    expect(map.get("a")).toBe(3);
    expect(map.get("b")).toBe(1);
    expect(playsById(undefined).size).toBe(0);
  });
});

describe("tracksByArtist", () => {
  const tracks = [
    { id: "solo", artist: "Kestrel Bay" },
    { id: "duet", artist: "Halden Marsh, Kestrel Bay" },
    { id: "comma", artist: "Tyler, The Creator, Kali Uchis" },
    { id: "ewf", artist: "Earth, Wind & Fire" },
    { id: "other", artist: "Kestrel Bayside" },
    { id: "lower", artist: "kestrel bay" },
    { id: "none" },
  ];
  const ids = (artist: { id?: string; name: string }, list = tracks) =>
    tracksByArtist(artist, list).map((t) => t.id);

  it("matches the name as a whole entry of the primary artists, without case", () => {
    expect(ids({ name: "Kestrel Bay" })).toEqual(["solo", "duet", "lower"]);
    expect(ids({ name: "Bay" })).toEqual([]);
  });

  it("matches a name that contains the separator", () => {
    expect(ids({ name: "Earth, Wind & Fire" })).toEqual(["ewf"]);
    expect(ids({ name: "Tyler, The Creator" })).toEqual(["comma"]);
    expect(ids({ name: "Kali Uchis" })).toEqual(["comma"]);
  });

  it("matches on ids when the tracks list them, so a name inside another can't", () => {
    const credited = [
      { id: "ewf", artist: "Earth, Wind & Fire", primary_artists: [{ id: "ar-ewf" }] },
      { id: "earth", artist: "Earth", primary_artists: [{ id: "ar-earth" }] },
      { id: "both", artist: "Earth, Earth, Wind & Fire", primary_artists: [{ id: "ar-earth" }, { id: "ar-ewf" }] },
    ];
    // By name, "Earth" is also the first entry of "Earth, Wind & Fire".
    expect(ids({ name: "Earth" }, credited)).toEqual(["ewf", "earth", "both"]);
    expect(ids({ id: "ar-earth", name: "Earth" }, credited)).toEqual(["earth", "both"]);
    expect(ids({ id: "ar-ewf", name: "Earth, Wind & Fire" }, credited)).toEqual(["ewf", "both"]);
  });

  it("matches nothing for a blank name", () => {
    expect(ids({ name: "  " })).toEqual([]);
  });
});

describe("topArtistTracks", () => {
  const tracks = [
    { id: "t1", artist: "Hana Okoro, The Velvet Meridian" },
    { id: "t2", artist: "Halden Marsh" },
    { id: "t3", artist: "the velvet meridian" },
    { id: "t4", artist: "Earth, Wind & Fire" },
  ];

  it("lists each top artist's tracks in order, credited alone or with others", () => {
    const map = topArtistTracks(
      [
        { id: "ar-velvet", name: "The Velvet Meridian" },
        { id: "ar-halden", name: "Halden Marsh" },
        { id: "ar-ewf", name: "Earth, Wind & Fire" },
        { id: "ar-kestrel", name: "Kestrel Bay" },
      ],
      tracks,
    );
    expect(map.get("ar-velvet")?.map((t) => t.id)).toEqual(["t1", "t3"]);
    expect(map.get("ar-halden")?.map((t) => t.id)).toEqual(["t2"]);
    // A name with commas in it was never found when names were split.
    expect(map.get("ar-ewf")?.map((t) => t.id)).toEqual(["t4"]);
    expect(map.get("ar-kestrel")).toEqual([]);
  });

  it("keeps two artists apart when one's name is part of the other's", () => {
    const map = topArtistTracks(
      [
        { id: "ar-ewf", name: "Earth, Wind & Fire" },
        { id: "ar-earth", name: "Earth" },
      ],
      [{ id: "t4", artist: "Earth, Wind & Fire", primary_artists: [{ id: "ar-ewf" }] }],
    );
    expect(map.get("ar-ewf")?.map((t) => t.id)).toEqual(["t4"]);
    expect(map.get("ar-earth")).toEqual([]);
  });
});

describe("topArtistAction", () => {
  const track = { id: "t", title: "T", duration_ms: 1 };

  it("opens the artist's page when there is one, and plays them otherwise", () => {
    expect(topArtistAction({ has_page: true }, [])).toBe("open");
    expect(topArtistAction({ has_page: false }, [track])).toBe("play");
    // A server that doesn't say can't promise a page.
    expect(topArtistAction({}, [track])).toBe("play");
  });

  it("does nothing without a page or anything playable", () => {
    expect(topArtistAction({ has_page: false }, [])).toBeNull();
    expect(topArtistAction({ has_page: false }, [{ ...track, unavailable: true }])).toBeNull();
  });
});

describe("replayTrackArtists", () => {
  it("links each of a top track's artists that has a page", () => {
    expect(
      replayTrackArtists({
        artist: "Earth, Wind & Fire, Guest",
        primary_artists: [
          { id: "ar-ewf", name: "Earth, Wind & Fire", has_page: true },
          { id: "ar-guest", name: "Guest", has_page: false },
        ],
      }),
    ).toEqual([{ name: "Earth, Wind & Fire", artistId: "ar-ewf" }, { name: "Guest" }]);
  });

  it("keeps the names whole and unlinked when the server doesn't list them", () => {
    expect(replayTrackArtists({ artist: "Earth, Wind & Fire" })).toEqual([{ name: "Earth, Wind & Fire" }]);
    expect(replayTrackArtists({})).toEqual([]);
  });
});

describe("replayAlbumSubtitle", () => {
  it("puts the cleaned artist before the play count", () => {
    expect(replayAlbumSubtitle({ artist: " A Â· B ", plays: 1234 })).toBe(
      `A · B · ${(1234).toLocaleString()} plays`,
    );
    expect(replayAlbumSubtitle({ artist: "Solo", plays: 1 })).toBe("Solo · 1 play");
  });

  it("leaves out an artist that is missing or cleans to nothing", () => {
    expect(replayAlbumSubtitle({ plays: 2 })).toBe("2 plays");
    expect(replayAlbumSubtitle({ artist: "Â", plays: 2 })).toBe("2 plays");
  });
});

describe("parsePeriodKey", () => {
  it("reads back every key periodKey writes", () => {
    const periods: Period[] = [
      { kind: "all" },
      { kind: "this-year" },
      { kind: "this-month" },
      { kind: "last-30" },
      { kind: "year", year: 2024 },
    ];
    for (const period of periods) expect(parsePeriodKey(periodKey(period))).toEqual(period);
  });

  it("rejects anything else", () => {
    for (const key of [null, undefined, "", "last-7", "year:", "year:24", "year:2024x"]) {
      expect(parsePeriodKey(key)).toBeNull();
    }
  });
});

describe("canonicalPeriodKey", () => {
  it("keeps a period that has a pill", () => {
    expect(canonicalPeriodKey("last-30", [2025])).toBe("last-30");
    expect(canonicalPeriodKey("all", [])).toBe("all");
    expect(canonicalPeriodKey("year:2025", [2025, 2026], 2026)).toBe("year:2025");
  });

  it("falls back to the default for this year, by either name, and for values that aren't periods", () => {
    expect(canonicalPeriodKey(null, [2025])).toBeNull();
    expect(canonicalPeriodKey("this-year", [2025])).toBeNull();
    expect(canonicalPeriodKey("year:2026", [2025, 2026], 2026)).toBeNull();
    expect(canonicalPeriodKey("bogus", [2025])).toBeNull();
  });

  it("drops a year without plays once the years are known, and keeps it until then", () => {
    expect(canonicalPeriodKey("year:1999", [2025], 2026)).toBeNull();
    expect(canonicalPeriodKey("year:1999", null, 2026)).toBe("year:1999");
  });
});

describe("activity chart", () => {
  const buckets = (plays: number[]) =>
    plays.map((p, i) => ({ bucket_start: `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00Z`, plays: p }));

  it("scales against the busiest bucket and spaces labels to at most six", () => {
    expect(activityChartScale(buckets([1, 5, 2]))).toEqual({ max: 5, labelStep: 1 });
    expect(activityChartScale(buckets(Array(30).fill(0)))).toEqual({ max: 0, labelStep: 5 });
    expect(activityChartScale(buckets(Array(31).fill(1))).labelStep).toBe(6);
    expect(activityChartScale([])).toEqual({ max: 0, labelStep: 1 });
  });

  it("labels buckets tersely on the phone and fully on the web", () => {
    const date = new Date(Date.UTC(2026, 2, 7));
    const fmt = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(date);
    expect(activityBucketLabel(date, "day", "compact")).toBe(fmt({ day: "numeric" }));
    expect(activityBucketLabel(date, "month", "compact")).toBe(fmt({ month: "narrow" }));
    expect(activityBucketLabel(date, "day", "verbose")).toBe(fmt({ month: "short", day: "numeric" }));
    expect(activityBucketLabel(date, "week", "verbose")).toBe(fmt({ month: "short", day: "numeric" }));
    expect(activityBucketLabel(date, "week", "compact")).toBe(fmt({ month: "short", day: "numeric" }));
    expect(activityBucketLabel(date, "month", "verbose")).toBe(fmt({ month: "short", year: "2-digit" }));
  });
});

describe("genreShares", () => {
  it("gives each genre its percentage of the listed plays", () => {
    expect(
      genreShares([
        { genre: "Rock", plays: 3 },
        { genre: "Jazz", plays: 1 },
      ]),
    ).toEqual([
      { genre: "Rock", plays: 3, share: 75 },
      { genre: "Jazz", plays: 1, share: 25 },
    ]);
  });

  it("gives zero shares when nothing was played", () => {
    expect(genreShares([{ genre: "Rock", plays: 0 }])).toEqual([
      { genre: "Rock", plays: 0, share: 0 },
    ]);
  });
});

describe("pluralize with locale-formatted counts", () => {
  it("groups large counts and keeps the singular for one", () => {
    expect(pluralize(1234, "play", undefined, { locale: true })).toBe(
      `${(1234).toLocaleString()} plays`,
    );
    expect(pluralize(1, "play", undefined, { locale: true })).toBe("1 play");
    expect(pluralize(1234, "play")).toBe("1234 plays");
  });
});

const DAY = 24 * 60 * 60 * 1000;
const utc = (y: number, m: number, d: number) => Date.UTC(y, m - 1, d);
const day = (y: number, m: number, d: number, plays: number) => ({
  bucket_start: new Date(utc(y, m, d)).toISOString(),
  plays,
});

describe("replayDaySpan", () => {
  // Tuesday, Oct 13 2026, mid-afternoon UTC.
  const now = new Date(Date.UTC(2026, 9, 13, 15, 20));

  it("runs from the period's first day to today while it is under way", () => {
    expect(
      replayDaySpan({ from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" }, null, now),
    ).toEqual({ first: utc(2026, 10, 1), last: utc(2026, 10, 13) });
  });

  it("covers a finished period to its last day", () => {
    expect(
      replayDaySpan({ from: "2025-01-01T00:00:00.000Z", to: "2026-01-01T00:00:00.000Z" }, null, now),
    ).toEqual({ first: utc(2025, 1, 1), last: utc(2025, 12, 31) });
  });

  it("starts the last 30 days on the first whole day, so it holds 30 of them", () => {
    const to = now.toISOString();
    const from = new Date(now.getTime() - 30 * DAY).toISOString();
    const span = replayDaySpan({ from, to }, null, now)!;
    expect(span).toEqual({ first: utc(2026, 9, 14), last: utc(2026, 10, 13) });
    expect((span.last - span.first) / DAY + 1).toBe(30);
  });

  it("starts all time on the first day with plays, and has no start without them", () => {
    const activity = [day(2026, 3, 17, 4), day(2026, 6, 2, 1)];
    expect(replayDaySpan({}, activity, now)).toEqual({ first: utc(2026, 3, 17), last: utc(2026, 10, 13) });
    expect(replayDaySpan({}, [], now)).toBeNull();
    expect(replayDaySpan({}, null, now)).toBeNull();
  });

  it("reaches a play the server dated after today, within the period", () => {
    const range = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };
    expect(replayDaySpan(range, [day(2026, 10, 14, 2)], now)?.last).toBe(utc(2026, 10, 14));
    // A server in UTC+2 starts its days two hours early.
    const early = { bucket_start: "2026-10-13T22:00:00Z", plays: 1 };
    expect(replayDaySpan(range, [early], now)?.last).toBe(utc(2026, 10, 14));
  });
});

describe("replayCalendar", () => {
  const now = new Date(Date.UTC(2026, 9, 13, 15, 20));
  const thisMonth = { from: "2026-10-01T00:00:00.000Z", to: "2026-11-01T00:00:00.000Z" };

  it("fills the days without plays and counts the days with them", () => {
    const days = replayCalendar(
      { bucket: "day", activity: [day(2026, 10, 1, 3), day(2026, 10, 4, 5), day(2026, 10, 13, 1)] },
      thisMonth,
      now,
    )!;
    expect(days.unit).toBe("day");
    expect(days.plays).toEqual([3, 0, 0, 5, 0, 0, 0, 0, 0, 0, 0, 0, 1]);
    expect(days.withPlays).toBe(3);
    expect(playsPerUnit(9, days)).toBeCloseTo(9 / 13);
  });

  it("leaves out the partial day the last 30 days start in", () => {
    const to = now.toISOString();
    const from = new Date(now.getTime() - 30 * DAY).toISOString();
    const days = replayCalendar(
      { bucket: "day", activity: [day(2026, 9, 13, 7), day(2026, 9, 14, 2), day(2026, 10, 13, 4)] },
      { from, to },
      now,
    )!;
    expect(days.plays).toHaveLength(30);
    expect(days.plays[0]).toBe(2);
    expect(days.plays[29]).toBe(4);
    expect(days.withPlays).toBe(2);
  });

  it("counts months, not days, from a monthly series", () => {
    // All time, from the first month with plays to this one.
    const months = replayCalendar(
      { bucket: "month", activity: [day(2025, 11, 1, 40), day(2026, 2, 1, 12), day(2026, 10, 1, 9)] },
      {},
      now,
    )!;
    expect(months.unit).toBe("month");
    expect(months.first).toBe(utc(2025, 11, 1));
    expect(months.last).toBe(utc(2026, 10, 1));
    expect(months.plays).toEqual([40, 0, 0, 12, 0, 0, 0, 0, 0, 0, 0, 9]);
    expect(months.withPlays).toBe(3);
    expect(playsPerUnit(61, months)).toBeCloseTo(61 / 12);
    // A server in UTC+2 starts its months two hours early.
    const early = replayCalendar({ bucket: "month", activity: [{ bucket_start: "2026-09-30T22:00:00Z", plays: 5 }] }, {}, now)!;
    expect(early.first).toBe(utc(2026, 10, 1));
    expect(early.plays).toEqual([5]);
  });

  it("can't count weekly buckets, and has nothing to count without plays", () => {
    expect(replayCalendar({ bucket: "week", activity: [day(2026, 10, 5, 9)] }, thisMonth, now)).toBeNull();
    expect(replayCalendar({ bucket: "month", activity: [] }, {}, now)).toBeNull();
    expect(playsPerUnit(9, null)).toBeNull();
  });
});

describe("replaySeriesComplete", () => {
  const summary = (total_plays: number) => ({ total_plays });

  it("accepts a series that holds every play", () => {
    expect(replaySeriesComplete({ summary: summary(9), activity: [day(2026, 10, 1, 4), day(2026, 10, 2, 5)] })).toBe(true);
    expect(replaySeriesComplete({ summary: summary(0), activity: [] })).toBe(true);
  });

  it("catches a series the server cut short", () => {
    // Plays recorded after the summary was counted only add to the series.
    expect(replaySeriesComplete({ summary: summary(8), activity: [day(2026, 10, 1, 9)] })).toBe(true);
    expect(replaySeriesComplete({ summary: summary(12), activity: [day(2026, 10, 1, 9)] })).toBe(false);
  });
});

describe("activitySeries", () => {
  const days = {
    unit: "day" as const,
    first: utc(2026, 1, 30),
    last: utc(2026, 3, 2),
    plays: Array.from({ length: 32 }, (_, i) => (i % 10 === 0 ? 2 : 0)),
    withPlays: 4,
  };

  it("keeps one bucket per day for a daily chart", () => {
    const { bucket, buckets } = activitySeries(days, "day");
    expect(bucket).toBe("day");
    expect(buckets).toHaveLength(32);
    expect(buckets[0]).toEqual({ bucket_start: "2026-01-30T00:00:00.000Z", plays: 2 });
    expect(buckets[1].plays).toBe(0);
  });

  it("adds the days up into months, the empty ones included", () => {
    expect(activitySeries(days, "month").buckets).toEqual([
      { bucket_start: "2026-01-01T00:00:00.000Z", plays: 2 },
      { bucket_start: "2026-02-01T00:00:00.000Z", plays: 4 },
      { bucket_start: "2026-03-01T00:00:00.000Z", plays: 2 },
    ]);
    const quiet = { ...days, plays: days.plays.map((p, i) => (i < 3 ? p : 0)) };
    expect(activitySeries(quiet, "month").buckets.map((b) => b.plays)).toEqual([2, 0, 0]);
  });

  it("adds the days up into weeks starting on Monday", () => {
    // Jan 30 2026 is a Friday; its week began on Monday the 26th.
    const weeks = activitySeries(days, "week").buckets;
    expect(weeks[0]).toEqual({ bucket_start: "2026-01-26T00:00:00.000Z", plays: 2 });
    expect(weeks[1].bucket_start).toBe("2026-02-02T00:00:00.000Z");
    expect(weeks.reduce((sum, w) => sum + w.plays, 0)).toBe(8);
  });

  it("draws a monthly calendar by month, whatever the chart asked for", () => {
    const months = { unit: "month" as const, first: utc(2025, 12, 1), last: utc(2026, 2, 1), plays: [3, 0, 7], withPlays: 2 };
    expect(activitySeries(months, "day")).toEqual({
      bucket: "month",
      buckets: [
        { bucket_start: "2025-12-01T00:00:00.000Z", plays: 3 },
        { bucket_start: "2026-01-01T00:00:00.000Z", plays: 0 },
        { bucket_start: "2026-02-01T00:00:00.000Z", plays: 7 },
      ],
    });
  });
});

describe("activityPeak", () => {
  it("picks the busiest bucket, the earlier one on a tie", () => {
    const series = [day(2026, 10, 1, 3), day(2026, 10, 2, 8), day(2026, 10, 3, 8)];
    expect(activityPeak(series)).toBe(series[1]);
  });

  it("has no peak without plays", () => {
    expect(activityPeak([day(2026, 10, 1, 0)])).toBeNull();
    expect(activityPeak([])).toBeNull();
  });
});
