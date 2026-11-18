import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import AlbumDetailScreen from "../app/(tabs)/(library,browse)/albums/[id]";

const mock = vi.hoisted(() => ({
  album: {} as Record<string, unknown>,
  tracks: [] as { id: string; title: string; artist?: string; track_no?: number }[],
  footer: {} as Record<string, unknown>,
  moreBy: {} as { artist?: string; onOpenArtist?: unknown },
  moreByArgs: [] as unknown[],
  list: {} as { onEndReached?: () => void; onEndReachedThreshold?: number; onLayout?: unknown },
  screen: {} as { scrollEdgeEffects?: { top: string } },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Pressable: ({ children }: { children?: ReactNode }) => <button>{children}</button>,
  PixelRatio: { get: () => 3 },
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ setQueryData: vi.fn() }),
  useQuery: ({ queryKey }: { queryKey: unknown[] }) => {
    if (queryKey[2] === "album") return { data: mock.album, refetch: vi.fn() };
    if (queryKey[2] === "album-tracks") return { data: mock.tracks, refetch: vi.fn() };
    return { data: 0 };
  },
}));
vi.mock("expo-router", () => ({
  Stack: {
    Screen: ({ options }: { options: typeof mock.screen }) => {
      mock.screen = options;
      return null;
    },
  },
  useLocalSearchParams: () => ({ id: "a1" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(), impactAsync: vi.fn(), ImpactFeedbackStyle: {} }));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "me", role: "user" } }),
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: (props: typeof mock.list & { ListFooterComponent?: ReactNode }) => {
    mock.list = props;
    return <div>{props.ListFooterComponent}</div>;
  },
}));
vi.mock("../components/album-header", () => ({
  useAlbumCoverSize: () => 440,
  useAlbumCoverInset: () => 0,
  useAlbumHeroScroll: () => ({
    onScroll: () => {},
    scrollEventThrottle: 16,
    titleShown: false,
    overCover: true,
    onTitleBottom: () => {},
    headerHeight: 116,
    bottomInset: 34,
    edgeNudge: false,
    onListLayout: () => {},
  }),
  albumScrollEdgeEffects: (under: boolean) => ({ top: under ? "soft" : "hidden" }),
  AlbumTopScrim: () => null,
  AlbumHeader: () => null,
}));
vi.mock("../components/album-footer", () => ({
  AlbumFooter: (props: Record<string, unknown>) => {
    mock.footer = props;
    return null;
  },
}));
vi.mock("../components/album-more-by", () => ({
  AlbumMoreBy: (props: typeof mock.moreBy) => {
    mock.moreBy = props;
    return null;
  },
}));
vi.mock("../lib/album-more-by", () => ({
  useLibraryMoreBy: (...args: unknown[]) => {
    mock.moreByArgs = args;
    return [];
  },
}));
vi.mock("../components/album-track-row", () => ({ AlbumTrackRow: () => null }));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({ message }: { message?: string }) => <span>{message}</span>,
  retryAction: () => undefined,
}));
vi.mock("../components/dock/dock-context", () => ({
  useBottomDockInset: () => 0,
  useDockScrollHandler: () => ({}),
}));
vi.mock("../context/player", () => ({
  usePlayTrack: () => vi.fn(),
  usePlayerPlayback: () => ({ shuffle: false }),
  useCurrentTrack: () => null,
  useIsPlaying: () => false,
}));
vi.mock("../lib/use-play-queue", () => ({ usePlayQueue: () => vi.fn(), listPlaybackQueue: () => [] }));
vi.mock("../lib/album-download", () => ({ useAlbumDownloadAction: () => undefined }));
vi.mock("../lib/use-image-failure", () => ({ useImageFailure: () => ({ failed: false, onError: () => {} }) }));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({ space: { lg: 16, md: 12 }, color: { bg: "black", fg: "white", accent: "blue" } }),
}));

beforeEach(() => {
  mock.album = {
    id: "a1",
    title: "Record",
    artist_id: "ar1",
    artist_name: "Band",
    artist_has_page: true,
    is_compilation: false,
    release_year: 2021,
    release_date: "2021-05-14",
    copyright: "© 2021 Band Records",
    track_count: 2,
    duration_ms: 300_000,
    has_cover: true,
  };
  mock.tracks = [
    { id: "t1", title: "One", artist: "Band", track_no: 1 },
    { id: "t2", title: "Two", artist: "Band", track_no: 2 },
  ];
  mock.moreByArgs = [];
});

it("closes the page with the release's date, length and copyright", () => {
  renderToStaticMarkup(<AlbumDetailScreen />);
  expect(mock.footer).toMatchObject({
    releaseDate: "2021-05-14",
    releaseYear: 2021,
    copyright: "© 2021 Band Records",
    trackCount: 2,
    durationMs: 300_000,
  });
});

it("asks for the linked artist's other albums only once the page nears its end", () => {
  renderToStaticMarkup(<AlbumDetailScreen />);
  expect(mock.moreByArgs).toEqual(["ar1", "a1", false]);
  expect(mock.moreBy.artist).toBe("Band");
  expect(typeof mock.moreBy.onOpenArtist).toBe("function");
  expect(typeof mock.list.onEndReached).toBe("function");
  expect(mock.list.onEndReachedThreshold).toBe(1);
});

it("asks the library's album artist when the copied release credits someone else", () => {
  mock.album = { ...mock.album, tidal_album_id: "77", artist_names: ["TIDAL Name"] };
  renderToStaticMarkup(<AlbumDetailScreen />);
  expect(mock.moreByArgs[0]).toBe("ar1");
  expect(mock.moreBy.artist).toBe("Band");
});

it("has no artist to ask when the album artist has no page", () => {
  mock.album = { ...mock.album, artist_has_page: false };
  renderToStaticMarkup(<AlbumDetailScreen />);
  expect(mock.moreByArgs[0]).toBeUndefined();
  expect(mock.moreBy.onOpenArtist).toBeUndefined();
});

it("keeps iOS's edge blur off the cover and re-applies it on each list layout", () => {
  renderToStaticMarkup(<AlbumDetailScreen />);
  expect(mock.screen.scrollEdgeEffects?.top).toBe("hidden");
  expect(typeof mock.list.onLayout).toBe("function");
});
