import { describe, expect, it } from "vitest";
import { formatBitrate, formatCalendarDate, formatDurationMs, formatSampleRate } from "../src/format";
import { trackCredits } from "../src/api-media";
import { ApiError, type TidalTrackInfo } from "../src/api";
import { tidalAudioRows, tidalRefusalMessage, tidalTrackCredits } from "../src/tidal/track-info";

describe("track info formatters", () => {
  it("formats sample rates in kHz with at most one decimal", () => {
    expect(formatSampleRate(44_100)).toBe("44.1 kHz");
    expect(formatSampleRate(48_000)).toBe("48 kHz");
    expect(formatSampleRate(96_000)).toBe("96 kHz");
    expect(formatSampleRate(88_200)).toBe("88.2 kHz");
  });

  it("formats bitrates in kbps", () => {
    expect(formatBitrate(320_000)).toBe("320 kbps");
    expect(formatBitrate(1_411_200)).toBe("1411 kbps");
  });

  it("shows an em dash for unknown values", () => {
    for (const value of [undefined, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(formatSampleRate(value)).toBe("—");
      expect(formatBitrate(value)).toBe("—");
    }
    // Duration is metadata in track info, not a clock.
    expect(formatDurationMs(0, "—")).toBe("—");
  });
});

describe("trackCredits", () => {
  it("groups credits by role in a fixed order", () => {
    expect(
      trackCredits({
        artists: [
          { id: "1", name: "A", role: "primary" },
          { id: "2", name: "B", role: "primary" },
          { id: "3", name: "F", role: "featured" },
          { id: "4", name: "C", role: "composer" },
        ],
      }),
    ).toEqual([
      { label: "Primary artist", value: "A, B" },
      { label: "Featured", value: "F" },
      { label: "Producers", value: "C" },
    ]);
  });

  it("prefers the composer tag for producers", () => {
    expect(
      trackCredits({
        composer: "  Tag Writer ",
        artists: [{ id: "4", name: "C", role: "composer" }],
      })[2],
    ).toEqual({ label: "Producers", value: "Tag Writer" });
  });

  it("shows an em dash for missing credits", () => {
    expect(trackCredits({ artists: [], composer: " " }).map((row) => row.value)).toEqual([
      "—",
      "—",
      "—",
    ]);
    expect(trackCredits({}).map((row) => row.value)).toEqual(["—", "—", "—"]);
  });
});

describe("formatCalendarDate", () => {
  it("formats a calendar day without shifting it across time zones", () => {
    expect(formatCalendarDate("2023-03-17", "en-GB")).toBe("17 Mar 2023");
    expect(formatCalendarDate("1969-01-01", "en-US")).toBe("Jan 1, 1969");
  });

  it("shows an em dash for anything else", () => {
    for (const value of [undefined, null, "", "2023", "2023-02-30", "2023-03-17T00:00:00Z", "17/03/2023"]) {
      expect(formatCalendarDate(value)).toBe("—");
    }
  });
});

describe("tidalTrackCredits", () => {
  const info = (over: Partial<TidalTrackInfo> = {}): TidalTrackInfo => ({
    id: "1",
    artists: [
      { name: "Main", role: "main" },
      { name: "Co", role: "main" },
      { name: "Guest", role: "featured" },
    ],
    credits: [
      { role: "Composer", names: ["Writer"] },
      { role: "Producer", names: ["Maker"] },
      { role: "Mixing Engineer", names: ["Mixer"] },
      { role: "producer", names: ["Maker", "Second"] },
      { role: "A&R Administrator", names: ["Scout"] },
      { role: "Vocal", names: [] },
    ],
    ...over,
  });
  // How a TIDAL row stores artists: the first primary, the rest featured.
  const stored = {
    artists: [
      { id: "a", name: "Main", role: "primary" },
      { id: "b", name: "Co", role: "featured" },
    ],
  };

  it("uses TIDAL's artists and lists every role after the producers", () => {
    expect(tidalTrackCredits(stored, info())).toEqual([
      { label: "Primary artist", value: "Main, Co" },
      { label: "Featured", value: "Guest" },
      { label: "Producers", value: "Maker, Second" },
      { label: "Composer", value: "Writer" },
      { label: "Mixing engineer", value: "Mixer" },
      { label: "A&R administrator", value: "Scout" },
    ]);
  });

  it("trusts TIDAL's split once it names a main artist", () => {
    const rows = tidalTrackCredits(stored, info({ artists: [{ name: "Main", role: "main" }] }));
    expect(rows[1]).toEqual({ label: "Featured", value: "—" });
  });

  it("falls back to the stored track for what TIDAL lacks", () => {
    expect(tidalTrackCredits(stored, info({ artists: [], credits: [] }))).toEqual([
      { label: "Primary artist", value: "Main" },
      { label: "Featured", value: "Co" },
      { label: "Producers", value: "—" },
    ]);
  });
});

describe("tidalAudioRows", () => {
  const info = (over: Partial<TidalTrackInfo>): TidalTrackInfo => ({ id: "1", artists: [], credits: [], ...over });

  it("describes the stream being served", () => {
    expect(tidalAudioRows(info({ streamed_quality: "LOSSLESS", max_quality: "HI_RES_LOSSLESS" }))).toEqual([
      { label: "Format", value: "FLAC" },
      { label: "Quality", value: "Lossless" },
      { label: "Bit depth", value: "16-bit" },
      { label: "Sample rate", value: "44.1 kHz" },
    ]);
    expect(tidalAudioRows(info({ streamed_quality: "HI_RES_LOSSLESS" }))).toContainEqual({
      label: "Sample rate",
      value: "Up to 192 kHz",
    });
    expect(tidalAudioRows(info({ streamed_quality: "HIGH" }))).toEqual([
      { label: "Format", value: "AAC" },
      { label: "Quality", value: "Lossy" },
      { label: "Bitrate", value: "320 kbps" },
    ]);
  });

  it("shows only a ceiling before anything has streamed, since playback can fall back", () => {
    expect(tidalAudioRows(info({ max_quality: "LOSSLESS" }))).toEqual([
      { label: "Quality", value: "Up to Lossless (16-bit / 44.1 kHz FLAC)", wide: true },
    ]);
    expect(tidalAudioRows(info({ max_quality: "LOW" }))[0].value).toBe("Up to AAC 96 kbps");
  });

  it("knows nothing without a tier it recognizes", () => {
    for (const unknown of [null, info({}), info({ streamed_quality: "DOLBY_ATMOS" as never })]) {
      expect(tidalAudioRows(unknown)).toEqual([{ label: "Quality", value: "—", wide: false }]);
    }
  });
});

describe("tidalRefusalMessage", () => {
  it("passes on the server's text only for a TIDAL refusal", () => {
    const refusal = "TIDAL refused this track: Not available in your region";
    expect(tidalRefusalMessage(new ApiError(502, refusal))).toBe(refusal);
    expect(tidalRefusalMessage(new ApiError(502, "tidal track unavailable"))).toBeNull();
    expect(tidalRefusalMessage(new ApiError(500, refusal))).toBeNull();
    expect(tidalRefusalMessage(new Error(refusal))).toBeNull();
  });
});
