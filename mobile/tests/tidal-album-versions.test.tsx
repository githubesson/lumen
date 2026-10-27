import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import TidalAlbumDetailScreen from "../app/(tabs)/(library,browse)/tidal-albums/[id]";

type Album = { id: string; title: string; artist_id?: string; tracks: { id: string; title: string }[] };
const mock = vi.hoisted(() => ({
  params: {} as { id: string; artist?: string },
  album: {} as { data?: Album; isPlaceholderData?: boolean },
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
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  PixelRatio: { get: () => 3 },
}));
vi.mock("@tanstack/react-query", () => ({
  keepPreviousData: () => undefined,
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useQuery: ({ queryKey, enabled }: { queryKey: unknown[]; enabled?: boolean }) => {
    if (queryKey[2] === "tidal-album") return { ...mock.album, refetch: vi.fn() };
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
    renderItem,
  }: {
    data: unknown[];
    ListHeaderComponent: ReactNode;
    renderItem: (args: { item: unknown; index: number }) => ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.map((item, index) => (
        <div key={index}>{renderItem({ item, index })}</div>
      ))}
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
vi.mock("../lib/action-menu", () => ({ showActionMenu: vi.fn() }));
vi.mock("../components/track-row", () => ({
  TrackRow: ({ track }: { track: { title: string } }) => <span>{track.title}</span>,
}));
vi.mock("../components/empty-state", () => ({
  EmptyState: () => <span>Loading</span>,
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

const single = (sourceId: string, explicit: boolean) => ({
  id: `tidal:${sourceId}`,
  source_id: sourceId,
  title: "Powiedz To",
  release_year: 2026,
  track_count: 1,
  duration_ms: 180_000,
  explicit,
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

it("keeps the page up, buttons waiting, while the picked version loads", () => {
  mock.params = { id: "2", artist: "77" };
  mock.album.isPlaceholderData = true;
  const html = markup();
  expect(mock.pending).toBe(true);
  expect(mock.segments?.value).toBe("2");
  expect(html).toContain("Powiedz To");
});
