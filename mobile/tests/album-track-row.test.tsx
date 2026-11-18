import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import { AlbumTrackRow } from "../components/album-track-row";

const rows = vi.hoisted(() => [] as Record<string, unknown>[]);

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
}));
vi.mock("../components/list-row", () => ({
  ListRow: (props: Record<string, unknown> & { leading?: ReactNode }) => {
    rows.push(props);
    return <div>{props.leading}</div>;
  },
}));
vi.mock("../components/now-playing-bars", () => ({
  NowPlayingBars: ({ playing }: { playing: boolean }) => <i>{playing ? "bars moving" : "bars still"}</i>,
}));
vi.mock("../components/swipe/swipeable-track-row", () => ({
  SwipeableTrackRow: ({ children }: { children: (swipe: unknown) => ReactNode }) =>
    children({ favoriteMark: () => null }),
}));
vi.mock("../lib/offline-mode", () => ({ useTrackUnavailableOffline: () => false }));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ color: { accent: "blue", fgMuted: "grey" } }),
}));

const track = (artist: string, extra: Partial<TrackListItem> = {}): TrackListItem => ({
  id: "t1",
  title: "Levitating",
  artist,
  duration_ms: 203_000,
  ...extra,
});
const render = (t: TrackListItem, current = false, playing = false) => {
  const html = renderToStaticMarkup(
    <AlbumTrackRow
      track={t}
      number={12}
      albumArtists={["Dua Lipa"]}
      current={current}
      playing={playing}
      onPress={() => {}}
    />,
  );
  return { html, row: rows[rows.length - 1] };
};

beforeEach(() => {
  rows.length = 0;
});

it("leads with the track's place and leaves out the album's own artist", () => {
  const { html, row } = render(track("Dua Lipa"));
  expect(html).toContain("<span>12</span>");
  expect(row.subtitle).toBeNull();
  expect(row.titleColor).toBeUndefined();
  expect(row.trailing).toBe("3:23");
});

it("names the artists on a track that features someone else", () => {
  expect(render(track("Dua Lipa, DaBaby")).row.subtitle).toBe("Dua Lipa, DaBaby");
});

it("still says a track is gone from TIDAL", () => {
  const { row } = render(track("Dua Lipa", { unavailable: true }));
  expect(row.subtitle).toBe("Removed from TIDAL");
  expect(row.disabled).toBe(true);
});

it("marks the current track with bars, a tinted title and its state for VoiceOver", () => {
  const playing = render(track("Dua Lipa"), true, true);
  expect(playing.html).toContain("bars moving");
  expect(playing.html).not.toContain("<span>12</span>");
  expect(playing.row.titleColor).toBe("blue");
  expect(playing.row.accessibilityLabel).toBe("Levitating by Dua Lipa, now playing");
  const paused = render(track("Dua Lipa"), true, false);
  expect(paused.html).toContain("bars still");
  expect(paused.row.accessibilityLabel).toBe("Levitating by Dua Lipa, paused");
});
