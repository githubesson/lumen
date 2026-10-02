import { describe, expect, it } from "vitest";
import { formatBitrate, formatDurationMs, formatSampleRate } from "../src/format";
import { trackCredits } from "../src/api-media";

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
