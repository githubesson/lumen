import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { TidalAlbum, TidalTrackInfo, TrackDetail } from "@music-library/core";
import TrackInfoScreen from "../app/(tabs)/(library,browse)/track/[id]";

type QueryState = { data?: unknown; isLoading?: boolean; isError?: boolean; error?: unknown };
const mock = vi.hoisted(() => ({
  track: {} as { data?: unknown; isLoading?: boolean; isError?: boolean },
  tidal: {} as QueryState,
  album: {} as QueryState,
  tidalOptions: undefined as Record<string, unknown> | undefined,
  albumOptions: undefined as Record<string, unknown> | undefined,
  // What each link and button does when pressed, by its text or label.
  presses: {} as Record<string, () => void>,
  push: vi.fn(),
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children, onPress }: { children?: ReactNode; onPress?: () => void }) => {
    if (!onPress) return <span>{children}</span>;
    mock.presses[String(children)] = onPress;
    return <a>{children}</a>;
  },
  Pressable: ({
    children,
    onPress,
    accessibilityLabel,
  }: {
    children?: ReactNode;
    onPress?: () => void;
    accessibilityLabel?: string;
  }) => {
    if (accessibilityLabel && onPress) mock.presses[accessibilityLabel] = onPress;
    return <button>{children}</button>;
  },
  StyleSheet: { hairlineWidth: 1, create: <T,>(styles: T) => styles },
  useWindowDimensions: () => ({ width: 393, height: 852 }),
}));
vi.mock("react-native-reanimated", () => ({
  default: {
    View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
    ScrollView: ({ children }: { children?: ReactNode }) => <main>{children}</main>,
  },
  useAnimatedStyle: (fn: () => unknown) => fn(),
  useAnimatedScrollHandler: () => vi.fn(),
  useSharedValue: (value: unknown) => ({ get: () => value, set: vi.fn() }),
  useReducedMotion: () => false,
}));
vi.mock("react-native-worklets", () => ({ scheduleOnRN: vi.fn() }));
vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 54, bottom: 34, left: 0, right: 0 }),
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: "tidal:500" }),
  useRouter: () => ({ push: mock.push }),
}));
vi.mock("expo-router/react-navigation", () => ({ useHeaderHeight: () => 98 }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-haptics", () => ({ impactAsync: vi.fn(), ImpactFeedbackStyle: { Light: "light" } }));
vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }): QueryState => {
    if (options.queryKey[2] === "tidal-track") {
      mock.tidalOptions = options;
      return options.enabled ? mock.tidal : {};
    }
    if (options.queryKey[2] === "tidal-album") {
      mock.albumOptions = options;
      return options.enabled ? mock.album : {};
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
vi.mock("../components/dock/dock-context", () => ({ useBottomDockInset: () => 120 }));
vi.mock("../components/now-playing/glass-icon-button", () => ({
  GlassIconButton: ({ accessibilityLabel, onPress }: { accessibilityLabel: string; onPress: () => void }) => {
    mock.presses[accessibilityLabel] = onPress;
    return <button>{accessibilityLabel}</button>;
  },
}));
vi.mock("../components/track-actions-menu", () => ({
  TrackActionsMenuButton: ({ accessibilityLabel }: { accessibilityLabel: string }) => (
    <button>{accessibilityLabel}</button>
  ),
}));
const player = vi.hoisted(() => ({
  current: null as { id: string } | null,
  isPlaying: false,
  play: vi.fn(),
  toggle: vi.fn(),
}));
vi.mock("../context/player", () => ({
  useCurrentTrack: () => player.current,
  useIsPlaying: () => player.isPlaying,
  usePlayTrack: () => player.play,
  usePlayerControls: () => ({ toggle: player.toggle }),
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    scheme: "dark",
    color: { bg: "#000000", fg: "#FFFFFF", fgMuted: "#8E8E93", separator: "#38383A", overlayMuted: "gray" },
    space: { sm: 8, lg: 16, xl: 24 },
  }),
  withAlpha: (color: string) => color,
}));

const row: TrackDetail = {
  id: "tidal:500",
  source: "tidal",
  source_id: "500",
  source_album_id: "900",
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
  artists: [{ id: "8123", name: "BabyTron", role: "main" }],
  release_date: "2023-03-17",
  copyright: "(P) 2023 The Hip Hop Lab",
  bpm: 140,
  streamed_quality: "LOSSLESS",
  channels: 2,
  credits: [{ role: "Producer", names: ["Helluva"], contributors: [{ name: "Helluva" }] }],
};

const local: TrackDetail = {
  ...row,
  id: "t1",
  source: "local",
  source_id: undefined,
  source_album_id: undefined,
  album_id: "al1",
  year: 2023,
  format: "FLAC",
  file_size: 2048,
  composer: "Helluva, Someone",
  artists: [
    { id: "a", name: "BabyTron", role: "primary" },
    { id: "c", name: "Helluva, Someone", role: "composer" },
  ],
};

// Rows render as label then value, so look for the pair side by side.
const html = () => renderToStaticMarkup(<TrackInfoScreen />);
const pair = (label: string, value: string) => `<span>${label}</span><span>${value}</span>`;

beforeEach(() => {
  mock.track = { data: row };
  mock.tidal = { data: info };
  mock.album = {};
  mock.tidalOptions = undefined;
  mock.albumOptions = undefined;
  mock.presses = {};
  mock.push.mockClear();
  player.current = null;
  player.isPlaying = false;
  player.play.mockClear();
  player.toggle.mockClear();
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
  mock.tidal = { data: info, isError: true, error: new Error("timeout") };
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
  // Nor does it ask for the album before knowing it needs to.
  expect(mock.albumOptions?.enabled).toBe(false);
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

it("says why TIDAL refused the track", async () => {
  const { ApiError } = await import("@music-library/core");
  mock.tidal = { isError: true, error: new ApiError(502, "TIDAL refused this track: Not available in your region") };
  const out = html();
  expect(out).toContain("TIDAL refused this track: Not available in your region");
  expect(out).not.toContain("Couldn&#x27;t load more from TIDAL");
  expect(out).toContain(pair("Primary artist", "BabyTron"));
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

it("says why TIDAL refused the album's release date", () => {
  const reason = "TIDAL refused the album&#x27;s release date: Not available in your region";
  mock.tidal = { data: { ...info, release_failure: reason.replace("&#x27;", "'") } };
  expect(html()).toContain(reason);
});

it("never asks TIDAL about a local track", () => {
  mock.track = { data: local };
  const out = html();
  expect(mock.tidalOptions?.enabled).toBe(false);
  expect(mock.albumOptions?.enabled).toBe(false);
  expect(out).toContain(pair("Format", "FLAC"));
  expect(out).toContain("File size");
  expect(out).not.toContain("Source");
});

it("splits a file's rows into Credits, Release and Audio, leaving out what it lacks", () => {
  mock.track = {
    data: {
      ...local,
      genre: "",
      comments: "Recorded live Â· 2019",
      file_name: "01 Forever.flac",
    },
  };
  const out = html();
  expect(out).toContain("<h2>Credits</h2>");
  expect(out).toContain("<h2>Release</h2>");
  expect(out).toContain("<h2>Audio</h2>");
  expect(out).not.toContain("Details");
  expect(out).toContain(pair("Comments", "Recorded live · 2019"));
  expect(out).toContain(pair("File", "01 Forever.flac"));
  expect(out).not.toContain("Genre");
  expect(out).not.toContain("Bitrate");
  // Credit rows stay, with a dash for nobody credited.
  expect(out).toContain(pair("Featured", "—"));
});

it("shows the track as Now Playing does, with its album and year", () => {
  const out = html();
  expect(out).toContain("<span>Forever $cams</span>");
  expect(out).toContain("<span>Bin Reaper 3: New Testament · 2023</span>");
  expect(out).toContain("<button>Play</button>");
  expect(out).toContain("<button>More actions</button>");
});

it("links a TIDAL track's names to TIDAL pages, in this tab's stack", () => {
  const out = html();
  // The hero line, the compact row and the Primary artist cell.
  expect(out.match(/<a>BabyTron<\/a>/g)).toHaveLength(3);
  // Helluva has no TIDAL id: plain.
  expect(out).not.toContain("<a>Helluva</a>");
  mock.presses["BabyTron"]();
  expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/(tabs)/tidal-artists/[id]", params: { id: "8123" } });
  mock.presses["Album, Bin Reaper 3: New Testament · 2023"]();
  expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/(tabs)/tidal-albums/[id]", params: { id: "900" } });
  // A new server sends the ids itself, so the album isn't needed.
  expect(mock.albumOptions?.enabled).toBe(false);
});

it("links a TIDAL track's primary artist through its album on an older server", () => {
  mock.tidal = { data: { ...info, artists: [{ name: "BabyTron", role: "main" }] } };
  expect(html()).not.toContain("<a>BabyTron</a>");
  expect(mock.albumOptions).toMatchObject({ queryKey: ["user", "user", "tidal-album", "900"], enabled: true });

  const album: Partial<TidalAlbum> = { id: "900", artist: "BabyTron", artist_id: "8123" };
  mock.album = { data: album };
  expect(html()).toContain("<a>BabyTron</a>");
  mock.presses["BabyTron"]();
  expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/(tabs)/tidal-artists/[id]", params: { id: "8123" } });
});

it("links a file's artist and album to their library pages, its producers plain", () => {
  mock.track = { data: local };
  const out = html();
  expect(out).toContain("<a>BabyTron</a>");
  expect(out).toContain(pair("Producers", "Helluva, Someone"));
  mock.presses["BabyTron"]();
  expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/(tabs)/artists/[id]", params: { id: "a" } });
  mock.presses["Album, Bin Reaper 3: New Testament · 2023"]();
  expect(mock.push).toHaveBeenLastCalledWith({ pathname: "/(tabs)/albums/[id]", params: { id: "al1" } });
});

it("offers no Play for a track dropped from TIDAL, and says why", () => {
  mock.track = { data: { ...row, unavailable: true } };
  const out = html();
  expect(out).not.toContain("<button>Play</button>");
  expect(out).toContain("<button>More actions</button>");
  expect(out).toContain("Removed from TIDAL, so it can&#x27;t play.");
});

it("doesn't ask for the album after TIDAL failed, and never twice", () => {
  mock.tidal = { isError: true, error: new Error("timeout") };
  html();
  expect(mock.albumOptions?.enabled).toBe(false);
  mock.tidal = { data: { ...info, artists: [{ name: "BabyTron", role: "main" }] } };
  html();
  expect(mock.albumOptions).toMatchObject({ enabled: true, retry: false });
});

it("plays the track, and pauses it once it's the one playing", () => {
  html();
  mock.presses["Play"]();
  expect(player.play).toHaveBeenCalledWith(expect.objectContaining({ id: "tidal:500", artist: "BabyTron" }));

  player.current = { id: "tidal:500" };
  player.isPlaying = true;
  expect(html()).toContain("<button>Pause</button>");
  mock.presses["Pause"]();
  expect(player.toggle).toHaveBeenCalledTimes(1);
  expect(player.play).toHaveBeenCalledTimes(1);
});
