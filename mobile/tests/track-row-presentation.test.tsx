import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import {
  useTrackRowPresentation,
  type TrackRowPresentation,
} from "../lib/use-track-row-presentation";

const mock = vi.hoisted(() => ({ unavailableOffline: false }));
vi.mock("../lib/offline-mode", () => ({
  useTrackUnavailableOffline: () => mock.unavailableOffline,
}));

function present(track: TrackListItem, options?: { menu?: boolean }): TrackRowPresentation {
  let result: TrackRowPresentation | undefined;
  function Probe() {
    result = useTrackRowPresentation(track, options);
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return result!;
}

const track: TrackListItem = {
  id: "t1",
  title: "Intro Â· Live",
  artist: "Ã\u0085Â\u0081ights",
  duration_ms: 1,
};

beforeEach(() => {
  mock.unavailableOffline = false;
});

it("cleans the title and artist and reads them out together", () => {
  expect(present(track)).toEqual({
    title: "Intro · Live",
    artist: "Lights",
    subtitle: "Lights",
    removed: false,
    dimmed: false,
    accessibilityLabel: "Intro · Live by Lights",
    accessibilityHint: "Double tap to play. Press and hold for more actions.",
  });
});

it("fades a track that can't play offline and says why", () => {
  mock.unavailableOffline = true;
  expect(present(track)).toMatchObject({
    removed: false,
    dimmed: true,
    accessibilityHint:
      "Not downloaded, so it can't play offline. Press and hold for more actions.",
  });
});

it("marks a track gone from TIDAL as removed", () => {
  expect(present({ ...track, unavailable: true })).toMatchObject({
    subtitle: "Removed from TIDAL",
    removed: true,
    dimmed: true,
    accessibilityLabel: "Intro · Live by Lights, removed from TIDAL",
    accessibilityHint: "Press and hold for more actions.",
  });
});

it("leaves the menu out of the hint on a row without one", () => {
  expect(present(track, { menu: false }).accessibilityHint).toBe("Double tap to play.");
  expect(present({ ...track, unavailable: true }, { menu: false }).accessibilityHint).toBeUndefined();
});
