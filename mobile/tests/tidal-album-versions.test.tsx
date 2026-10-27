import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import TidalAlbumDetailScreen from "../app/(tabs)/(library,browse)/tidal-albums/[id]";

type Album = { id: string; title: string; artist_id?: string; tracks: { id: string; title: string }[] };
const mock = vi.hoisted(() => ({
  params: {} as { id: string; artist?: string },
  album: {} as { data?: Album; isPlaceholderData?: boolean; isPaused?: boolean; isError?: boolean },
  albumOptions: undefined as Record<string, unknown> | undefined,
  keepPreviousData: vi.fn(),
  // What each labelled button does when pressed.
  presses: {} as Record<string, () => void>,
  showActionMenu: vi.fn(),
  // TIDAL artist responses by id; the artist queries asked for, by id.
  artists: {} as Record<string, { albums: unknown[] }>,
  artistQueries: [] as { id?: string; enabled?: boolean }[],
  setParams: vi.fn(),
  segments: undefined as
    | undefined
    | { options: { value: string; label: string }[]; value: string; onChange: (v: string) => void },
  pending: undefined as boolean | undefined,
}));
vi.mock("react-native", () => ({
  View: ({
    children,
    accessibilityElementsHidden,
  }: {
    children?: ReactNode;
    accessibilityElementsHidden?: boolean;
  }) => <div aria-hidden={accessibilityElementsHidden || undefined}>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
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
  PixelRatio: { get: () => 3 },
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: mock.keepPreviousData,
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useQuery: (options: { queryKey: unknown[]; enabled?: boolean }) => {
    const { queryKey, enabled } = options;
    if (queryKey[2] === "tidal-album") {
      mock.albumOptions = options;
      return { ...mock.album, isFetching: false, refetch: vi.fn() };
    }
    const id = queryKey[3] as string | undefined;
    mock.artistQueries.push({ id, enabled });
    return { data: enabled && id ? mock.artists[id] : undefined };
  },
}));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => mock.params,
  useRouter: () => ({ setParams: mock.setParams }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn() }));
// The pure album, label and artwork helpers are the real ones.
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "user" } }),
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: ({
    data,
    ListHeaderComponent,
    ListEmptyComponent,
    renderItem,
  }: {
    data: unknown[];
    ListHeaderComponent: ReactNode;
    ListEmptyComponent?: ReactNode;
    renderItem: (args: { item: unknown; index: number }) => ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length
        ? data.map((item, index) => <div key={index}>{renderItem({ item, index })}</div>)
        : ListEmptyComponent}
    </div>
  ),
}));
vi.mock("../components/album-header", () => ({
  ALBUM_ART_SIZE: 220,
  AlbumHeader: ({ title, versions, pending }: { title: string; versions?: ReactNode; pending?: boolean }) => {
    mock.pending = pending;
    return (
      <header>
        {title}
        {versions}
      </header>
    );
  },
}));
vi.mock("../components/glass-segmented-control", () => ({
  GlassSegmentedControl: (props: NonNullable<typeof mock.segments>) => {
    mock.segments = props;
    return <nav>{props.options.map((option) => option.label).join(" | ")}</nav>;
  },
}));
vi.mock("../components/optional-swift-ui", () => ({ getOptionalSwiftUI: () => null }));
vi.mock("../lib/action-menu", () => ({ showActionMenu: mock.showActionMenu }));
vi.mock("../components/track-row", () => ({
  TrackRow: ({ track }: { track: { title: string } }) => <span>{track.title}</span>,
}));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({ message, loading }: { message?: string; loading?: boolean }) => (
    <span>{loading ? "Loading" : message}</span>
  ),
  retryAction: () => undefined,
}));
vi.mock("../components/dock/dock-context", () => ({
  useBottomDockInset: () => 0,
  useDockScrollHandler: () => ({}),
}));
vi.mock("../context/player", () => ({
  usePlayTrack: () => vi.fn(),
  usePlayerPlayback: () => ({ shuffle: false }),
}));
vi.mock("../lib/use-play-queue", () => ({
  usePlayQueue: () => vi.fn(),
  listPlaybackQueue: () => [],
}));
vi.mock("../lib/album-download", () => ({ useAlbumDownloadAction: () => undefined }));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ space: { lg: 24, md: 16 }, color: { bg: "black" } }),
}));

const single = (sourceId: string, explicit: boolean, dolby_atmos = false) => ({
  id: `tidal:${sourceId}`,
  source_id: sourceId,
  title: "Powiedz To",
  release_year: 2026,
  track_count: 1,
  duration_ms: 180_000,
  explicit,
  dolby_atmos,
});

beforeEach(() => {
  mock.params = { id: "1" };
  mock.album = {
    data: { id: "tidal:1", title: "Powiedz To", tracks: [{ id: "t1", title: "Powiedz To" }] },
  };
  mock.artists = {
    "77": { albums: [single("1", true), single("2", false), { ...single("3", false), title: "LP" }] },
  };
  mock.artistQueries = [];
  mock.albumOptions = undefined;
  mock.presses = {};
  mock.showActionMenu.mockReset();
  mock.setParams.mockReset();
  mock.segments = undefined;
  mock.pending = undefined;
});
const markup = () => renderToStaticMarkup(<TidalAlbumDetailScreen />);

it("switches between versions listed by the artist it was opened from", () => {
  mock.params = { id: "2", artist: "77" };
  const html = markup();
  expect(html).toContain("Explicit | Clean");
  expect(mock.segments?.value).toBe("2");
  mock.segments?.onChange("1");
  expect(mock.setParams).toHaveBeenCalledWith({ id: "1", artist: "77" });
});

it("asks the album's own artist when it wasn't opened from one", () => {
  mock.album.data!.artist_id = "77";
  markup();
  expect(mock.artistQueries.at(-1)).toEqual({ id: "77", enabled: true });
  expect(mock.segments?.value).toBe("1");
  mock.segments?.onChange("2");
  expect(mock.setParams).toHaveBeenCalledWith({ id: "2", artist: "77" });
});

it("shows no switcher for an album without other versions", () => {
  mock.params = { id: "3", artist: "77" };
  markup();
  expect(mock.segments).toBeUndefined();
});

it("shows no switcher without an artist to ask", () => {
  markup();
  expect(mock.artistQueries.at(-1)?.enabled).toBe(false);
  expect(mock.segments).toBeUndefined();
});

it("keeps the previous version up, its rows hidden and buttons waiting, while the picked one loads", () => {
  mock.params = { id: "2", artist: "77" };
  expect(markup()).not.toContain("aria-hidden");
  expect(mock.albumOptions?.placeholderData).toBe(mock.keepPreviousData);
  mock.album.isPlaceholderData = true;
  const html = markup();
  expect(mock.pending).toBe(true);
  expect(mock.segments?.value).toBe("2");
  expect(html).toContain('aria-hidden="true"><span>Powiedz To</span>');
  expect(html).not.toContain("Couldn&#x27;t load TIDAL album.");
});

it("shows the error with the picker when the picked version can't load offline", () => {
  mock.params = { id: "2", artist: "77" };
  Object.assign(mock.album, { isPlaceholderData: true, isPaused: true });
  const html = markup();
  expect(html).toContain("Couldn&#x27;t load TIDAL album.");
  expect(html).not.toContain("<span>Powiedz To</span>");
  mock.segments?.onChange("1");
  expect(mock.setParams).toHaveBeenCalledWith({ id: "1", artist: "77" });
});

it("shows the error with the picker when the picked version fails", () => {
  mock.params = { id: "2", artist: "77" };
  mock.album = { data: undefined, isError: true };
  const html = markup();
  expect(html).toContain("Couldn&#x27;t load TIDAL album.");
  expect(mock.segments?.value).toBe("2");
});

it("lists versions in a menu when their labels are too long for segments", () => {
  mock.params = { id: "2", artist: "77" };
  // Stereo | Dolby Atmos · Explicit | Dolby Atmos · Clean
  mock.artists["77"].albums.splice(0, 1, single("4", true, true), single("5", false, true));
  markup();
  expect(mock.segments).toBeUndefined();
  mock.presses["Version: Stereo"]();
  const [{ items }] = mock.showActionMenu.mock.calls[0] as [{ items: { label: string }[] }];
  expect(items.map((item) => item.label)).toEqual([
    "Stereo · Clean · 1 track · 2026",
    "Dolby Atmos · Explicit · 1 track · 2026",
    "Dolby Atmos · Clean · 1 track · 2026",
  ]);
});

it("lists four or more versions in a menu", () => {
  mock.params = { id: "2", artist: "77" };
  mock.artists["77"].albums.push(single("4", true, true), single("5", false, true));
  markup();
  expect(mock.segments).toBeUndefined();
  mock.presses["Version: Clean"]();
  const [{ items }] = mock.showActionMenu.mock.calls[0] as [
    { items: { label: string; disabled: boolean; onPress: () => void }[] },
  ];
  expect(items.map((item) => [item.label, item.disabled])).toEqual([
    ["Stereo · Explicit · 1 track · 2026", false],
    ["Stereo · Clean · 1 track · 2026", true],
    ["Dolby Atmos · Explicit · 1 track · 2026", false],
    ["Dolby Atmos · Clean · 1 track · 2026", false],
  ]);
  items[2].onPress();
  expect(mock.setParams).toHaveBeenCalledWith({ id: "4", artist: "77" });
});
