import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TidalTrackInfo, TrackDetail } from "@music-library/core";
import TrackInfoScreen from "../app/(tabs)/(library,browse)/track/[id]";

type QueryState = { data?: unknown; isLoading?: boolean; isError?: boolean };
const mock = vi.hoisted(() => ({
  track: {} as { data?: unknown; isLoading?: boolean; isError?: boolean },
  tidal: {} as { data?: unknown; isLoading?: boolean; isError?: boolean },
  tidalOptions: undefined as Record<string, unknown> | undefined,
}));
vi.mock("react-native", () => ({
  ScrollView: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  StyleSheet: { hairlineWidth: 1 },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: "tidal:500" }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }): QueryState => {
    if (options.queryKey[2] === "tidal-track") {
      mock.tidalOptions = options;
      return options.enabled ? mock.tidal : {};
    }
    return mock.track;
  },
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "user" } }),
}));
vi.mock("../components/cover-art", () => ({ CoverArt: () => null }));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({ message, loading }: { message?: string; loading?: boolean }) => (
    <p>{loading ? "loading" : message}</p>
  ),
}));
vi.mock("../components/primitives", () => ({
  Card: ({ children }: { children: ReactNode }) => <section>{children}</section>,
  SectionLabel: ({ children }: { children: ReactNode }) => <h2>{children}</h2>,
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    color: { bg: "black", fg: "white", fgMuted: "gray", separator: "gray" },
    space: { sm: 8, lg: 16, xl: 24 },
  }),
}));

const row: TrackDetail = {
  id: "tidal:500",
  source: "tidal",
  source_id: "500",
  title: "Forever $cams",
  album_title: "Bin Reaper 3: New Testament",
  track_no: 1,
  disc_no: 1,
  duration_ms: 228000,
  format: "tidal",
  file_size: 0,
  artists: [{ id: "a", name: "BabyTron", role: "primary" }],
  has_cover: false,
  favorited: false,
};

const info: TidalTrackInfo = {
  id: "500",
  artists: [{ name: "BabyTron", role: "main" }],
  release_date: "2023-03-17",
  copyright: "(P) 2023 The Hip Hop Lab",
  bpm: 140,
  streamed_quality: "LOSSLESS",
  channels: 2,
  credits: [{ role: "Producer", names: ["Helluva"] }],
};

// Rows render as label then value, so look for the pair side by side.
const html = () => renderToStaticMarkup(<TrackInfoScreen />);
const pair = (label: string, value: string) => `<span>${label}</span><span>${value}</span>`;

beforeEach(() => {
  mock.track = { data: row };
  mock.tidal = { data: info };
  mock.tidalOptions = undefined;
});

it("fills a TIDAL track's rows from TIDAL", () => {
  const out = html();
  expect(mock.tidalOptions?.queryKey).toEqual(["user", "user", "tidal-track", "500"]);
  expect(out).toContain("<h2>Credits</h2>");
  expect(out).toContain(pair("Producers", "Helluva"));
  expect(out).toContain("<span>Released</span>");
  expect(out).toContain(pair("BPM", "140"));
  expect(out).toContain(pair("Copyright", "(P) 2023 The Hip Hop Lab"));
  expect(out).toContain(pair("Source", "TIDAL"));
  expect(out).toContain(pair("Format", "FLAC"));
  expect(out).toContain(pair("Quality", "Lossless"));
  expect(out).toContain(pair("Sample rate", "44.1 kHz"));
  expect(out).toContain(pair("Channels", "2"));
  expect(out).not.toContain("File size");
  expect(out).not.toContain("Couldn&#x27;t");
});

it("fetches afresh on each visit, with nothing kept to show in its place", () => {
  html();
  expect(mock.tidalOptions).toMatchObject({
    gcTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    retry: false,
  });
});

it("doesn't show an earlier answer when this visit's fetch failed", () => {
  // React Query keeps the last data alongside a failed refetch.
  mock.tidal = { data: info, isError: true };
  const out = html();
  expect(out).toContain("Couldn&#x27;t load more from TIDAL");
  expect(out).not.toContain("Released");
  expect(out).not.toContain("Helluva");
});

it("shows only the most it would stream before the server has streamed it", () => {
  mock.tidal = { data: { ...info, streamed_quality: undefined, max_quality: "LOSSLESS" } };
  const out = html();
  expect(out).toContain(pair("Quality", "Up to Lossless (16-bit / 44.1 kHz FLAC)"));
  expect(out).not.toContain("<span>Format</span>");
});

it("waits for TIDAL before showing the rows", () => {
  mock.tidal = { isLoading: true };
  expect(html()).toBe("<p>loading</p>");
});

it("shows the stored rows with a note when TIDAL can't answer", () => {
  mock.tidal = { isError: true };
  const out = html();
  expect(out).toContain("Couldn&#x27;t load more from TIDAL");
  expect(out).toContain(pair("Primary artist", "BabyTron"));
  expect(out).toContain(pair("Source", "TIDAL"));
  expect(out).toContain(pair("Quality", "—"));
  expect(out).not.toContain("Released");
});

it("notes missing credits on their own", () => {
  mock.tidal = { data: { ...info, credits: [], credits_failed: true } };
  const out = html();
  expect(out).toContain("Couldn&#x27;t load credits from TIDAL.");
  expect(out).not.toContain("Couldn&#x27;t load more");
});

it("says why TIDAL refused the credits", () => {
  const reason = "TIDAL refused the credits: Not available in your region";
  mock.tidal = { data: { ...info, credits: [], credits_failed: true, credits_failure: reason } };
  const out = html();
  expect(out).toContain(reason);
  expect(out).not.toContain("Couldn&#x27;t load credits");
});

it("never asks TIDAL about a local track", () => {
  mock.track = {
    data: { ...row, id: "t1", source: "local", source_id: undefined, format: "FLAC", file_size: 2048 },
  };
  const out = html();
  expect(mock.tidalOptions?.enabled).toBe(false);
  expect(out).toContain(pair("Format", "FLAC"));
  expect(out).toContain("File size");
  expect(out).not.toContain("Source");
});
