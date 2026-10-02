import { describe, expect, it } from "vitest";
import {
  SNIPPET_EDGE_HIT_PX,
  adjustSnippetWindow,
  normalizeSnippetSelection,
  parseTrackShareParams,
  shareClipName,
  snippetDragTarget,
  snippetHandleBounds,
  snippetWindow,
} from "../src/share-snippet";

describe("share snippet selection", () => {
  it("handles unknown, short, fractional, and long tracks", () => {
    expect(snippetWindow(0, 30, 0)).toMatchObject({
      maxDurationSec: 30,
      effectiveDurationSec: 30,
      maxStartSec: 0,
    });
    expect(snippetWindow(2.3, 30, 0)).toMatchObject({
      minDurationSec: 3,
      maxDurationSec: 3,
      endSec: 2.3,
      displayDurationSec: 2.3,
    });
    expect(snippetWindow(300, 200, 0)).toMatchObject({
      effectiveDurationSec: 120,
      maxStartSec: 180,
    });
  });
  it("rounds selections and keeps them within the track", () => {
    expect(normalizeSnippetSelection(60.8, 100, 30.4)).toEqual({
      startSec: 30,
      durationSec: 30,
    });
    expect(normalizeSnippetSelection(60, -5, 1)).toEqual({
      startSec: 0,
      durationSec: 5,
    });
    expect(normalizeSnippetSelection(0.4, 5, 10)).toEqual({
      startSec: 0,
      durationSec: 1,
    });
  });
  const bounds = {
    durationSec: 200,
    startSec: 50,
    endSec: 80,
    minDurationSec: 5,
    maxDurationSec: 120,
    maxStartSec: 170,
  };
  it("constrains each edge and preserves duration when moving the window", () => {
    expect(
      adjustSnippetWindow({ ...bounds, kind: "start", atSec: 100 }),
    ).toEqual({ startSec: 75, durationSec: 5 });
    expect(adjustSnippetWindow({ ...bounds, kind: "end", atSec: 500 })).toEqual(
      { startSec: 50, durationSec: 120 },
    );
    expect(
      adjustSnippetWindow({ ...bounds, kind: "window", atSec: 500 }),
    ).toEqual({ startSec: 170, durationSec: 30 });
  });
  it("keeps a short track's fractional end available to all input methods", () => {
    const short = {
      ...bounds,
      durationSec: 2.3,
      startSec: 0,
      endSec: 2.3,
      minDurationSec: 3,
      maxDurationSec: 3,
      maxStartSec: 0,
    };
    expect(snippetHandleBounds(short)).toEqual({
      minStartSec: 0,
      maxStartSec: 0,
      minEndSec: 2.3,
      maxEndSec: 2.3,
    });
    expect(adjustSnippetWindow({ ...short, kind: "end", atSec: 10 })).toEqual({
      startSec: 0,
      durationSec: 2.3,
    });
  });
});

describe("snippetDragTarget", () => {
  // 100 s across 200 px: the 14 px edge zone is 7 s wide.
  const strip = { startSec: 30, endSec: 60, durationSec: 100, widthPx: 200 };

  it("grabs the nearer edge within the edge zone, keeping the grab offset", () => {
    expect(SNIPPET_EDGE_HIT_PX).toBe(14);
    expect(snippetDragTarget({ ...strip, atSec: 25 })).toEqual({
      kind: "start",
      grabOffsetSec: -5,
      recenter: false,
    });
    expect(snippetDragTarget({ ...strip, atSec: 64 })).toEqual({
      kind: "end",
      grabOffsetSec: 4,
      recenter: false,
    });
    // Equidistant from both edges of a tiny window: the start wins.
    expect(
      snippetDragTarget({ ...strip, startSec: 30, endSec: 32, atSec: 31 }).kind,
    ).toBe("start");
  });

  it("grabs the window where it was pressed inside it", () => {
    expect(snippetDragTarget({ ...strip, atSec: 45 })).toEqual({
      kind: "window",
      grabOffsetSec: 15,
      recenter: false,
    });
  });

  it("grabs the window by its middle and recenters it when pressed outside", () => {
    expect(snippetDragTarget({ ...strip, atSec: 90 })).toEqual({
      kind: "window",
      grabOffsetSec: 15,
      recenter: true,
    });
  });

  it("has no edge zone before the strip is measured", () => {
    expect(snippetDragTarget({ ...strip, widthPx: 0, atSec: 29 }).kind).toBe("window");
  });
});

describe("parseTrackShareParams", () => {
  it("accepts the parameters a share URL carries", () => {
    expect(parseTrackShareParams({ trackId: "abc", t: "12", d: "75", sig: "x" })).toEqual({
      trackId: "abc",
      sig: "x",
      startSec: 12,
      durationSec: 75,
    });
    // Links minted before snippets had a length carry no `d`.
    expect(parseTrackShareParams({ trackId: "abc", t: "12", d: null, sig: "x" })).toEqual({
      trackId: "abc",
      sig: "x",
      startSec: 12,
      durationSec: undefined,
    });
    // A missing start means the top of the track.
    expect(parseTrackShareParams({ trackId: "abc", t: null, d: null, sig: "x" })?.startSec).toBe(0);
  });

  it("keeps track ids that need escaping intact", () => {
    expect(
      parseTrackShareParams({ trackId: "tidal:12/3", t: "0", d: null, sig: "x" })?.trackId,
    ).toBe("tidal:12/3");
  });

  it("rejects what the share URL parser rejects", () => {
    const ok = { trackId: "abc", t: "1", d: "30", sig: "x" };
    expect(parseTrackShareParams({ ...ok, trackId: "" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, trackId: undefined })).toBeNull();
    expect(parseTrackShareParams({ ...ok, sig: null })).toBeNull();
    expect(parseTrackShareParams({ ...ok, sig: "" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, t: "-1" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, t: "" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, d: "999" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, d: "0" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, d: "2.5" })).toBeNull();
    expect(parseTrackShareParams({ ...ok, d: "" })).toBeNull();
  });
});

describe("shareClipName", () => {
  const artists = [
    { id: "f", name: "Featured", role: "featured" },
    { id: "p", name: "Primary", role: "primary" },
  ];

  it("names a clip after its primary artist and title", () => {
    expect(shareClipName({ title: "Song", artists })).toBe("Primary - Song (clip)");
    expect(shareClipName({ title: "Song", artist: "Someone" })).toBe("Someone - Song (clip)");
  });

  it("leaves out a missing artist instead of writing Unknown artist", () => {
    expect(shareClipName({ title: "Song", artists: [] })).toBe("Song (clip)");
    expect(shareClipName({ title: "Song", artist: "  " })).toBe("Song (clip)");
    expect(shareClipName({ title: "Song" })).toBe("Song (clip)");
  });

  it("falls back to the app's name without a title, and stays filename-safe", () => {
    expect(shareClipName(null)).toBe("Lumen (clip)");
    expect(shareClipName({ title: "A/B: C?", artist: "D" })).toBe("D - A_B_ C_ (clip)");
  });
});
