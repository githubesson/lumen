import { describe, expect, it } from "vitest";
import { ApiError } from "../src/api-transport";
import type { LyricsResult } from "../src/api";
import {
  activeLineIndex,
  activeWordIndexForLine,
  lyricsContent,
  lyricsErrorMessage,
  lyricsRequest,
  lyricsTimingDuration,
  parsePlainLyrics,
  parseSyncedLyrics,
} from "../src/lyrics";

describe("lyrics", () => {
  it("parses repeated timestamps, fractions, and section labels in time order", () => {
    expect(
      parseSyncedLyrics(
        "[ar:Artist]\n[01:02.34][00:01.5] Hello \n[00:02.003][Chorus]\n[00:03.0]   ",
      ),
    ).toEqual([
      { time: 1.5, text: "Hello", section: false },
      { time: 2.003, text: "[Chorus]", section: true },
      { time: 62.34, text: "Hello", section: false },
    ]);
    expect(parseSyncedLyrics(null)).toEqual([]);
    expect(parsePlainLyrics("\n [Verse] \n Hello \n\n")).toEqual([
      { text: "[Verse]", section: true },
      { text: "Hello", section: false },
    ]);
  });

  it("selects the last timestamp reached, including ties and backwards seeks", () => {
    const lines = parseSyncedLyrics("[00:01]A\n[00:02]B\n[00:02]C");
    expect(activeLineIndex(lines, 0)).toBe(-1);
    expect(activeLineIndex(lines, 2)).toBe(2);
    expect(activeLineIndex(lines, 100)).toBe(2);
    expect(activeLineIndex(lines, 1)).toBe(0);
    expect(activeLineIndex([], 10)).toBe(-1);
  });

  it("weights word timing by length and constrains time before/after the line", () => {
    const line = { time: 10, text: "a longer", section: false };
    const next = { ...line, time: 14 };
    expect(activeWordIndexForLine(line, next, 0, 30)).toBe(0);
    expect(activeWordIndexForLine(line, next, 10.5, 30)).toBe(0);
    expect(activeWordIndexForLine(line, next, 11, 30)).toBe(1);
    expect(activeWordIndexForLine(line, next, 100, 30)).toBe(1);
    expect(
      activeWordIndexForLine({ ...line, text: " " }, next, 11, 30),
    ).toBeNull();
  });

  it("handles final lines, punctuation, Unicode, and overlapping timestamps", () => {
    const line = { time: 10, text: "你好 !!!", section: false };
    expect(activeWordIndexForLine(line, undefined, 100, 11)).toBe(1);
    expect(activeWordIndexForLine(line, { ...line }, 10.2, 10)).toBe(1);
  });
});

describe("lyricsRequest", () => {
  it("sends the track's metadata and its duration in whole seconds", () => {
    expect(
      lyricsRequest({ title: "Song", artist: "Artist", album_title: "Album", duration_ms: 181_600 }),
    ).toEqual({ track_name: "Song", artist_name: "Artist", album_name: "Album", duration: 182 });
  });

  it("leaves out a missing or zero duration", () => {
    expect(lyricsRequest({ title: "Song", duration_ms: 0 }).duration).toBeUndefined();
    expect(lyricsRequest({ title: "Song" }).duration).toBeUndefined();
  });
});

describe("lyricsContent", () => {
  const result = (fields: Partial<LyricsResult>): LyricsResult => ({
    id: 1,
    trackName: "Song",
    artistName: "Artist",
    ...fields,
  });

  it("recognises an instrumental result that carries no text", () => {
    // The web cached this shape as a miss and showed "No lyrics found".
    expect(lyricsContent(result({ instrumental: true }))).toEqual({ kind: "instrumental" });
    expect(
      lyricsContent(result({ instrumental: true, plainLyrics: "la la" })).kind,
    ).toBe("instrumental");
  });

  it("prefers synced lines and falls back to plain ones", () => {
    const synced = lyricsContent(result({ syncedLyrics: "[00:01]Hi", plainLyrics: "Hi" }));
    expect(synced).toEqual({ kind: "synced", lines: [{ time: 1, text: "Hi", section: false }] });
    // Synced text without a usable timestamp is not synced lyrics.
    const plain = lyricsContent(result({ syncedLyrics: "no stamps", plainLyrics: "Hi" }));
    expect(plain).toEqual({ kind: "plain", lines: [{ text: "Hi", section: false }] });
  });

  it("treats a missing result or blank text as no lyrics", () => {
    expect(lyricsContent(null)).toEqual({ kind: "none" });
    expect(lyricsContent(result({ syncedLyrics: "", plainLyrics: "  \n " }))).toEqual({ kind: "none" });
  });
});

describe("lyricsErrorMessage", () => {
  it("reports the server's 404 as no lyrics and anything else as a load failure", () => {
    expect(lyricsErrorMessage(new ApiError(404, "lyrics_not_found"))).toBe("No lyrics found");
    expect(lyricsErrorMessage(new ApiError(502, "bad gateway"))).toBe("Couldn't load lyrics");
    expect(lyricsErrorMessage(new TypeError("Network request failed"))).toBe("Couldn't load lyrics");
  });
});

describe("lyricsTimingDuration", () => {
  it("uses the track's duration before the player's", () => {
    expect(lyricsTimingDuration({ duration_ms: 200_000 }, 150)).toBe(200);
    expect(lyricsTimingDuration({ duration_ms: 0 }, 150)).toBe(150);
    expect(lyricsTimingDuration(null, 150)).toBe(150);
  });

  it("never returns less than a second", () => {
    expect(lyricsTimingDuration({ duration_ms: 400 }, 150)).toBe(1);
    expect(lyricsTimingDuration(null, 0)).toBe(1);
    expect(lyricsTimingDuration(null, Number.NaN)).toBe(1);
  });
});
