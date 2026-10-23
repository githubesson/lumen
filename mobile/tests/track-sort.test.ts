import { describe, expect, it, vi } from "vitest";
import {
  DEFAULT_TRACK_SORT,
  selectTrackSort,
  toggleTrackSortDirection,
} from "../lib/use-track-sort";

vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));

describe("selectTrackSort", () => {
  it("starts a new key in its natural direction", () => {
    expect(selectTrackSort(DEFAULT_TRACK_SORT, "title")).toEqual({ key: "title", asc: true });
    expect(selectTrackSort(DEFAULT_TRACK_SORT, "plays")).toEqual({ key: "plays", asc: false });
  });

  it("keeps the direction when the same key is picked again", () => {
    const flipped = toggleTrackSortDirection({ key: "title", asc: true });
    expect(selectTrackSort(flipped, "title")).toBe(flipped);
  });

  it("builds on the latest state across back-to-back picks", () => {
    const picked = selectTrackSort(selectTrackSort(DEFAULT_TRACK_SORT, "plays"), "duration");
    expect(picked).toEqual({ key: "duration", asc: true });
  });

  it("is pure: running it twice gives the same result and leaves the input alone", () => {
    const prev = { key: "custom" as const, asc: true };
    expect(selectTrackSort(prev, "plays")).toEqual(selectTrackSort(prev, "plays"));
    expect(prev).toEqual({ key: "custom", asc: true });
  });
});

describe("toggleTrackSortDirection", () => {
  it("flips only the direction", () => {
    expect(toggleTrackSortDirection({ key: "duration", asc: true })).toEqual({
      key: "duration",
      asc: false,
    });
  });
});
