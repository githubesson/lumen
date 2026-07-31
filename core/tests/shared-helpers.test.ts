import { describe, expect, it } from "vitest";
import {
  downloadFilename,
  extensionForContentType,
  extensionForFormat,
  sanitizeFilename,
} from "../src/audio-format";
import {
  buildPeriodOptions,
  formatListeningTime,
  periodKey,
  periodRange,
} from "../src/replay/period";
import { compareSortableTracks, sortTitleKey } from "../src/track-sort";
import { canShareTrack, isLocalTrack, isTidalTrack } from "../src/track";
import { withFavorite, withFavoriteId } from "../src/favorites/favorite-toggle";
import {
  buildRemoteQueue,
  compactRemoteTrack,
  filterRemoteDevices,
  optimisticControlledState,
  remoteActivityTime,
} from "../src/player/remote-control";
import type { PlaybackActivity, TrackListItem } from "../src/api";
import type { PlaybackDevice } from "../src/player/activity-sync";

/**
 * These helpers were each duplicated between the web and mobile clients before
 * they moved here, so a regression now breaks both at once. The cases below
 * pin the behaviour the two copies agreed on.
 */

describe("sanitizeFilename", () => {
  it("replaces filesystem-illegal characters", () => {
    expect(sanitizeFilename('a<b>c:d"e/f\\g|h?i*j')).toBe("a_b_c_d_e_f_g_h_i_j");
  });

  it("strips control characters", () => {
    expect(sanitizeFilename("a\u0000b\u001Fc")).toBe("a_b_c");
  });

  // Regression guard: the illegal-character class is a range ending at \u001F.
  // Mis-transcribing it to include the literal span " -" silently replaces
  // every space and hyphen, which mangles the "Artist - Title" convention.
  it("preserves spaces and hyphens", () => {
    expect(sanitizeFilename("Artist - Title")).toBe("Artist - Title");
  });

  it("collapses whitespace, trims trailing dots, and caps length", () => {
    expect(sanitizeFilename("a   b")).toBe("a b");
    expect(sanitizeFilename("name...  ")).toBe("name");
    expect(sanitizeFilename("x".repeat(400))).toHaveLength(180);
  });
});

describe("downloadFilename", () => {
  const track = { id: "1", title: "Song", artist: "A" } as TrackListItem;

  it("falls back to the row's artist when no detail is loaded", () => {
    expect(downloadFilename(track, null, "mp3")).toBe("A - Song.mp3");
  });

  it("prefers the detail's credited artist list and title", () => {
    const detail = {
      title: "Real",
      artists: [{ name: "X" }, { name: "Y" }],
    } as never;
    expect(downloadFilename(track, detail, "flac")).toBe("X, Y - Real.flac");
  });

  it("does not double-append an extension", () => {
    const t = { id: "1", title: "Song.mp3" } as TrackListItem;
    expect(downloadFilename(t, null, "mp3")).toBe("Song.mp3");
  });

  it("never produces an empty name", () => {
    expect(downloadFilename({ id: "1", title: "" } as TrackListItem, null)).toBe(
      "track",
    );
  });
});

describe("extension detection", () => {
  it("maps the several spellings of each container", () => {
    for (const f of ["MP3", "ID3v2", "mpeg audio", ".mp3"]) {
      expect(extensionForFormat(f)).toBe("mp3");
    }
    expect(extensionForFormat("ALAC")).toBe("m4a");
    expect(extensionForFormat("WAVE")).toBe("wav");
    expect(extensionForFormat("QuickTime")).toBe("mov");
    expect(extensionForFormat("")).toBeUndefined();
    expect(extensionForFormat(undefined)).toBeUndefined();
  });

  it("ignores content-type parameters", () => {
    expect(extensionForContentType("audio/mpeg; charset=utf-8")).toBe("mp3");
    expect(extensionForContentType("application/json")).toBeUndefined();
  });
});

describe("replay periods", () => {
  it("builds UTC boundaries so buckets do not shift with the viewer", () => {
    const range = periodRange({ kind: "year", year: 2019 });
    expect(range.from).toBe("2019-01-01T00:00:00.000Z");
    expect(range.to).toBe("2020-01-01T00:00:00.000Z");
    expect(range.bucket).toBe("month");
  });

  it("uses day buckets for the short windows", () => {
    expect(periodRange({ kind: "this-month" }).bucket).toBe("day");
    expect(periodRange({ kind: "last-30" }).bucket).toBe("day");
  });

  it("leaves all-time unbounded", () => {
    expect(periodRange({ kind: "all" })).toEqual({ bucket: "month" });
  });

  it("keys years distinctly", () => {
    expect(periodKey({ kind: "year", year: 2020 })).toBe("year:2020");
    expect(periodKey({ kind: "all" })).toBe("all");
  });

  it("omits the current year from the past-years list and ends with all-time", () => {
    const now = new Date().getFullYear();
    const options = buildPeriodOptions([now, now - 1]);
    expect(options.filter((p) => p.kind === "year")).toEqual([
      { kind: "year", year: now - 1 },
    ]);
    expect(options.at(-1)).toEqual({ kind: "all" });
  });
});

describe("formatListeningTime", () => {
  it("agrees on compound values regardless of style", () => {
    for (const style of ["compact", "verbose"] as const) {
      expect(formatListeningTime(25 * 3600_000, style)).toBe("1d 1h");
      expect(formatListeningTime(90 * 60_000, style)).toBe("1h 30m");
      expect(formatListeningTime(60 * 60_000, style)).toBe("1h");
    }
  });

  it("spells single-unit tails per style", () => {
    expect(formatListeningTime(45 * 60_000)).toBe("45m");
    expect(formatListeningTime(45 * 60_000, "verbose")).toBe("45 min");
    expect(formatListeningTime(48 * 3600_000)).toBe("2d");
    expect(formatListeningTime(48 * 3600_000, "verbose")).toBe("2 days");
    expect(formatListeningTime(24 * 3600_000, "verbose")).toBe("1 day");
  });

  it("guards non-positive input", () => {
    expect(formatListeningTime(0)).toBe("0m");
    expect(formatListeningTime(-1, "verbose")).toBe("0 min");
  });
});

describe("track sorting", () => {
  it("strips emoji so titles collate on their letters", () => {
    expect(sortTitleKey("🔥 Song")).toBe("Song");
  });

  it("falls back to the original when stripping empties the title", () => {
    expect(sortTitleKey("🎵🎵")).toBe("🎵🎵");
  });

  it("breaks ties on title and leaves custom order untouched", () => {
    const a = { title: "B", duration_ms: 100, play_count: 5 };
    const b = { title: "A", duration_ms: 100, play_count: 5 };
    expect(compareSortableTracks(a, b, "duration")).toBeGreaterThan(0);
    expect(compareSortableTracks(a, b, "plays")).toBeGreaterThan(0);
    expect(compareSortableTracks(a, b, "custom")).toBe(0);
  });

  it("treats a missing play count as zero", () => {
    const a = { title: "A", duration_ms: 1, play_count: null };
    const b = { title: "B", duration_ms: 1, play_count: 3 };
    expect(compareSortableTracks(a, b, "plays")).toBeLessThan(0);
  });
});

describe("track source predicates", () => {
  it("treats an absent source as local", () => {
    expect(isLocalTrack({ source: undefined })).toBe(true);
    expect(isLocalTrack({ source: "local" })).toBe(true);
    expect(isLocalTrack({ source: "tidal" })).toBe(false);
  });

  it("allows sharing every source the API currently declares", () => {
    expect(canShareTrack({ source: "local" })).toBe(true);
    expect(canShareTrack({ source: "tidal" })).toBe(true);
    expect(canShareTrack({ source: undefined })).toBe(true);
  });

  // `TrackSource` is `"local" | "tidal"` today, so the predicate is total over
  // the declared union — the cast is how a *future* source gets exercised. The
  // point of the helper is that adding one defaults to not-shareable rather
  // than silently offering a share link the backend cannot build.
  it("refuses a source it does not know about", () => {
    expect(canShareTrack({ source: "soundcloud" as never })).toBe(false);
  });

  it("identifies tidal tracks", () => {
    expect(isTidalTrack({ source: "tidal" })).toBe(true);
    expect(isTidalTrack({ source: undefined })).toBe(false);
  });
});

describe("favorite toggle transitions", () => {
  it("is idempotent in both directions", () => {
    const ids = new Set(["a"]);
    expect([...withFavoriteId(ids, "a", true)]).toEqual(["a"]);
    expect([...withFavoriteId(ids, "b", false)]).toEqual(["a"]);
    expect([...withFavoriteId(ids, "b", true)]).toEqual(["a", "b"]);
    expect([...withFavoriteId(ids, "a", false)]).toEqual([]);
  });

  it("does not mutate the input set", () => {
    const ids = new Set(["a"]);
    withFavoriteId(ids, "b", true);
    expect([...ids]).toEqual(["a"]);
  });

  it("prepends newly favorited rows and preserves identity when unchanged", () => {
    const rows = [{ id: "a" }];
    expect(withFavorite(rows, { id: "b" }, true)).toEqual([
      { id: "b" },
      { id: "a" },
    ]);
    expect(withFavorite(rows, { id: "a" }, true)).toBe(rows);
    expect(withFavorite(rows, { id: "z" }, false)).toBe(rows);
    expect(withFavorite(rows, { id: "a" }, false)).toEqual([]);
  });
});

describe("remote playback helpers", () => {
  const base = {
    volume: 0.5,
    muted: true,
    shuffle: false,
    repeat: "off" as const,
  };

  it("clamps volume and unmutes when raised above zero", () => {
    expect(optimisticControlledState(base, "set_volume", { volume: 5 })).toEqual(
      { ...base, volume: 1, muted: false },
    );
    expect(optimisticControlledState(base, "set_volume", { volume: 0 })).toEqual(
      { ...base, volume: 0, muted: true },
    );
  });

  it("ignores malformed arguments rather than guessing", () => {
    expect(optimisticControlledState(base, "set_volume", { volume: "x" })).toBe(
      base,
    );
    expect(optimisticControlledState(base, "set_repeat", { repeat: "?" })).toBe(
      base,
    );
    expect(optimisticControlledState(base, "next", {})).toBe(base);
  });

  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({ id: String(i) }) as TrackListItem);

  it("windows the remote queue to 50 tracks anchored 24 back", () => {
    const queue = mk(200);
    const window = buildRemoteQueue(queue[100], queue);
    expect(window).toHaveLength(50);
    expect(window[0].id).toBe("76");
    expect(window.some((t) => t.id === "100")).toBe(true);
  });

  it("clamps the window at both ends of the queue", () => {
    const queue = mk(200);
    expect(buildRemoteQueue(queue[0], queue)[0].id).toBe("0");
    expect(buildRemoteQueue(queue[199], queue).at(-1)?.id).toBe("199");
  });

  it("degrades to the single track when it falls outside the queue", () => {
    const stray = { id: "stray" } as TrackListItem;
    expect(buildRemoteQueue(stray, mk(100))).toEqual([stray]);
    expect(buildRemoteQueue(stray, [])).toEqual([stray]);
  });

  it("drops incidental fields before sending a track", () => {
    const track = {
      id: "1",
      title: "T",
      lyrics: "x".repeat(1000),
    } as unknown as TrackListItem;
    expect("lyrics" in compactRemoteTrack(track)).toBe(false);
    expect(compactRemoteTrack(track).id).toBe("1");
  });

  it("only offers online, control-enabled devices that are not this one", () => {
    const device = (over: Partial<PlaybackDevice>): PlaybackDevice =>
      ({
        deviceId: "d",
        online: true,
        controlEnabled: true,
        ...over,
      }) as PlaybackDevice;
    const devices = [
      device({ deviceId: "self" }),
      device({ deviceId: "offline", online: false }),
      device({ deviceId: "no-control", controlEnabled: false }),
      device({ deviceId: "ok" }),
    ];
    expect(filterRemoteDevices(devices, "self").map((d) => d.deviceId)).toEqual([
      "ok",
    ]);
  });

  const activity = (over: Partial<PlaybackActivity>): PlaybackActivity =>
    ({
      position_sec: 10,
      duration_sec: 100,
      is_playing: false,
      updated_at: new Date(Date.now() - 5_000).toISOString(),
      ...over,
    }) as PlaybackActivity;

  it("extrapolates a playing position from the heartbeat", () => {
    expect(
      remoteActivityTime(activity({ is_playing: true })).currentTime,
    ).toBeGreaterThan(14);
  });

  it("leaves a paused position where it was reported", () => {
    expect(remoteActivityTime(activity({}))).toEqual({
      currentTime: 10,
      duration: 100,
    });
  });

  it("clamps a stale heartbeat to the track duration", () => {
    const stale = activity({
      position_sec: 95,
      is_playing: true,
      updated_at: new Date(Date.now() - 600_000).toISOString(),
    });
    expect(remoteActivityTime(stale).currentTime).toBe(100);
  });

  it("does not advance on an unparseable timestamp", () => {
    const bad = activity({ is_playing: true, updated_at: "not-a-date" });
    expect(remoteActivityTime(bad).currentTime).toBe(10);
  });

  it("reports zeroes when there is no activity", () => {
    expect(remoteActivityTime(null)).toEqual({ currentTime: 0, duration: 0 });
  });
});
