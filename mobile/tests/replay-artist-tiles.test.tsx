import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import ReplayScreen from "../app/(tabs)/(settings)/replay";

interface Tile {
  title: string;
  accessibilityLabel: string;
  art: { kind: string; imageUrl?: string | null };
  onPress?: () => void;
}

const mock = vi.hoisted(() => ({
  push: vi.fn(),
  play: vi.fn(() => true),
  tiles: [] as Tile[],
  data: undefined as unknown,
}));

vi.mock("react-native", () => ({
  Alert: { alert: vi.fn() },
  RefreshControl: () => null,
  ScrollView: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  Share: { share: vi.fn() },
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mock.data, isLoading: false, isError: false, refetch: vi.fn() }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
}));
vi.mock("expo-file-system", () => ({ Directory: vi.fn(), File: vi.fn(), Paths: {} }));
vi.mock("expo-router", () => ({ useRouter: () => ({ push: mock.push }) }));
vi.mock("expo-haptics", () => ({
  notificationAsync: vi.fn(),
  NotificationFeedbackType: {},
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "me" } }),
  useLocalDay: () => "2026-11-03",
}));
vi.mock("../context/player", () => ({ usePlayTrack: () => mock.play }));
vi.mock("../lib/use-play-queue", () => ({
  listPlaybackQueue: <T,>(tracks: T[]) => tracks,
  usePlayQueue: () => vi.fn(),
}));
vi.mock("../lib/use-pull-to-refresh", () => ({
  usePullToRefresh: () => ({ refreshing: false, onRefresh: vi.fn() }),
}));
vi.mock("../lib/app-resume", () => ({ subscribeAppActive: vi.fn() }));
vi.mock("../lib/share-dismissal", () => ({ isShareDismissal: () => false }));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    color: { bg: "#000", fgMuted: "#888" },
    space: { sm: 8, lg: 16, xl: 24 },
  }),
}));
vi.mock("../components/dock/dock-context", () => ({
  useBottomDockInset: () => 0,
  useDockScrollHandler: () => ({}),
}));
vi.mock("../components/empty-state", () => ({ EmptyState: () => null }));
vi.mock("../components/horizontal-shelf", () => ({
  HorizontalShelf: ({ children }: { children: ReactNode }) => <ul>{children}</ul>,
}));
vi.mock("../components/section", () => ({
  Section: ({ children }: { children: ReactNode }) => <section>{children}</section>,
}));
vi.mock("../components/replay/activity-chart", () => ({ ActivityChart: () => null }));
vi.mock("../components/replay/genre-list", () => ({ GenreList: () => null }));
vi.mock("../components/replay/format", () => ({
  pluralize: (n: number, noun: string) => `${n} ${noun}s`,
}));
vi.mock("../components/replay/period", () => ({
  buildPeriodOptions: () => [],
  periodTitle: () => "2026",
}));
vi.mock("../components/replay/period-picker", () => ({ PeriodPicker: () => null }));
vi.mock("../components/replay/replay-action-button", () => ({
  ReplayActionButton: () => null,
}));
vi.mock("../components/replay/replay-empty-state", () => ({ ReplayEmptyState: () => null }));
vi.mock("../components/replay/replay-hero", () => ({ ReplayHero: () => null }));
vi.mock("../components/replay/summary-grid", () => ({ SummaryGrid: () => null }));
vi.mock("../components/replay/top-track-list", () => ({ TopTrackList: () => null }));
vi.mock("../components/replay/ranked-shelf-tile", () => ({
  RankedShelfTile: (props: Tile) => {
    mock.tiles.push(props);
    return null;
  },
}));

const track = (id: string, artist: string, artistId: string) => ({
  id,
  title: id,
  artist,
  artist_id: artistId,
  artists: [{ id: artistId, name: artist }],
  album_id: `album-${id}`,
  has_cover: true,
  plays: 1,
});

function render(topArtists: { id: string; name: string; plays: number; has_page?: boolean }[]) {
  mock.tiles = [];
  mock.data = {
    summary: { total_plays: 9, total_ms: 1000, unique_tracks: 2, unique_artists: 2 },
    available_years: [],
    top_tracks: [track("t1", "Library Artist", "lib"), track("t2", "Streamed Artist", "tidal")],
    top_artists: topArtists,
    top_albums: [],
    top_genres: [],
    activity: [],
    bucket: "month",
  };
  renderToStaticMarkup(<ReplayScreen />);
  return mock.tiles;
}

beforeEach(() => {
  mock.push.mockClear();
  mock.play.mockClear();
});

it("opens the artist's page when the server says there is one", () => {
  const [tile] = render([{ id: "lib", name: "Library Artist", plays: 5, has_page: true }]);
  expect(tile.accessibilityLabel).toBe("View artist Library Artist");
  tile.onPress?.();
  expect(mock.push).toHaveBeenCalledWith({
    pathname: "/(tabs)/(settings)/artists/[id]",
    params: { id: "lib" },
  });
  expect(mock.play).not.toHaveBeenCalled();
});

it("plays a streamed artist's top tracks, rather than opening Not found", () => {
  const [tile] = render([{ id: "tidal", name: "Streamed Artist", plays: 4, has_page: false }]);
  expect(tile.accessibilityLabel).toBe("Play Streamed Artist");
  tile.onPress?.();
  expect(mock.push).not.toHaveBeenCalled();
  expect(mock.play).toHaveBeenCalledTimes(1);
  expect(mock.play.mock.calls[0]).toMatchObject([
    { id: "t2" },
    [{ id: "t2" }],
  ]);
});

it("does nothing for an artist with no page and no top tracks", () => {
  const [tile] = render([{ id: "gone", name: "Gone Artist", plays: 1 }]);
  expect(tile.accessibilityLabel).toBe("Gone Artist");
  expect(tile.onPress).toBeUndefined();
  expect(tile.art).toEqual({ kind: "artist", imageUrl: null });
});

it("shows a cover from the artist's own tracks", () => {
  const [tile] = render([{ id: "lib", name: "Library Artist", plays: 5, has_page: true }]);
  expect(tile.art.imageUrl).toContain("album-t1");
});
