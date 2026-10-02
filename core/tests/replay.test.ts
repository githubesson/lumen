import { afterEach, describe, expect, it, vi } from "vitest";
import {
  activityBucketLabel,
  activityChartScale,
  genreShares,
  playsById,
  replayImageFilename,
  replayImageRequest,
  replayPlaylistRequest,
  replayRequest,
} from "../src/replay/replay";
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
    const date = new Date(2026, 2, 7);
    const fmt = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, options).format(date);
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
