import { describe, expect, it } from "vitest";
import { mergeSearchWarnings, nextPageParam, SEARCH_DEBOUNCE_MS } from "../src/api";
import { RELEASE_FILTER_OPTIONS } from "../src/artist-releases";

describe("nextPageParam", () => {
  it("pages offset lists until the total is loaded", () => {
    expect(nextPageParam({ total: 120 }, 50)).toEqual({ offset: 50 });
    expect(nextPageParam({ total: 120 }, 120)).toBeUndefined();
    expect(nextPageParam({ total: 0 }, 0)).toBeUndefined();
  });

  it("follows search cursors and stops when they're exhausted", () => {
    expect(nextPageParam({ total: 25, nextOffsets: { local: 25, tidal: 10 } }, 35)).toEqual({
      offset: 35,
      searchOffsets: { local: 25, tidal: 10 },
    });
    // The total is only a running count for search; the cursors decide.
    expect(nextPageParam({ total: 100, nextOffsets: {} }, 35)).toBeUndefined();
  });
});

describe("mergeSearchWarnings", () => {
  it("keeps each warning once across pages", () => {
    expect(mergeSearchWarnings(["TIDAL is slow."], ["TIDAL is slow.", "Local index rebuilding."])).toEqual([
      "TIDAL is slow.",
      "Local index rebuilding.",
    ]);
  });

  it("starts fresh without previous warnings and drops empties", () => {
    expect(mergeSearchWarnings(null, ["", "A"])).toEqual(["A"]);
    expect(mergeSearchWarnings(undefined, undefined)).toEqual([]);
  });
});

describe("shared constants", () => {
  it("debounces searches by 250 ms on both clients", () => {
    expect(SEARCH_DEBOUNCE_MS).toBe(250);
  });

  it("labels the release filters the same everywhere", () => {
    expect(RELEASE_FILTER_OPTIONS).toEqual([
      { value: "all", label: "All" },
      { value: "albums", label: "Albums" },
      { value: "singles", label: "Singles & EPs" },
    ]);
  });
});
