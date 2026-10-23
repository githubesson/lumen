import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Playlist, TrackListItem } from "@music-library/core";
import PlaylistPickerScreen from "../app/playlist-picker";
import { setPlaylistPickerTrack } from "../components/playlist-picker/subject";

type Item = { type: string; id: string };
const mock = vi.hoisted(() => ({
  playlists: undefined as Playlist[] | undefined,
  trackId: "t1" as string | undefined,
  renderItem: undefined as ((info: { item: Item }) => ReactElement) | undefined,
  data: [] as Item[],
  back: vi.fn(),
  dismiss: vi.fn(),
  add: vi.fn(),
  show: vi.fn(),
}));

vi.mock("react-native", () => ({
  View: ({ children }: { children?: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children?: ReactNode }) => <span>{children}</span>,
  TextInput: ({ placeholder }: { placeholder?: string }) => <input placeholder={placeholder} />,
  Pressable: ({
    children,
    accessibilityLabel,
    accessibilityHint,
    disabled,
  }: {
    children?: ReactNode;
    accessibilityLabel?: string;
    accessibilityHint?: string;
    disabled?: boolean;
  }) => (
    <button aria-label={accessibilityLabel} title={accessibilityHint} disabled={disabled}>
      {children}
    </button>
  ),
  Keyboard: { dismiss: mock.dismiss },
  PixelRatio: { get: () => 2 },
  StyleSheet: { create: <T,>(styles: T) => styles, hairlineWidth: 1, absoluteFill: {} },
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: ({
    data,
    renderItem,
    ListEmptyComponent,
  }: {
    data: Item[];
    renderItem: (info: { item: Item }) => ReactElement;
    ListEmptyComponent: ReactElement;
  }) => {
    mock.data = data;
    mock.renderItem = renderItem;
    return data.length ? (
      <ul>{data.map((item) => <li key={item.id}>{renderItem({ item })}</li>)}</ul>
    ) : (
      ListEmptyComponent
    );
  },
}));
vi.mock("expo-router", () => ({
  useLocalSearchParams: () => ({ trackId: mock.trackId }),
  useRouter: () => ({ back: mock.back }),
}));
vi.mock("expo-glass-effect", () => ({ isLiquidGlassAvailable: () => false }));
vi.mock("expo-haptics", () => ({ selectionAsync: vi.fn(async () => {}) }));
vi.mock("expo-symbols", () => ({ SymbolView: () => null }));
vi.mock("expo-image", () => ({
  Image: ({ source }: { source: { uri: string } }) => <img src={source.uri} alt="" />,
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mock.playlists, isError: false }),
  useQueryClient: () => ({ getQueryData: () => undefined }),
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "u1" } }),
}));
vi.mock("../components/adaptive-glass", () => ({
  AdaptiveGlass: ({ children }: { children: ReactNode }) => <>{children}</>,
}));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({ message, loading }: { message?: string; loading?: boolean }) => (
    <p>{loading ? "loading" : message}</p>
  ),
}));
vi.mock("../components/playlist-artwork", () => ({ PlaylistArtwork: () => null }));
vi.mock("../lib/downloads", () => ({ downloadStore: { coverUriFor: () => undefined } }));
vi.mock("../lib/recent-playlists", () => ({ loadRecentPlaylistIds: async () => [] }));
vi.mock("../lib/add-to-playlist", () => ({ addTrackToPlaylist: mock.add }));
vi.mock("../components/add-confirmation/store", () => ({ showAddConfirmation: mock.show }));
vi.mock("../components/playlist-picker/measure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../components/playlist-picker/measure")>()),
  measureRect: async () => ({ x: 24, y: 36, width: 48, height: 48 }),
  screenOffsetOfPress: async () => ({ x: 8, y: 410 }),
}));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    scheme: "dark",
    color: {
      bg: "black", bgElev1: "#111", bgElev2: "#222", fg: "#FFFFFF", fgMuted: "gray",
      separator: "gray", accent: "#0A84FF", success: "green",
    },
    space: { xl: 24 },
  }),
  withAlpha: (color: string) => color,
}));

const track: TrackListItem = {
  id: "t1",
  title: "Missouri",
  artist: "Lil Uzi Vert",
  album_id: "a1",
  album_title: "Eternal Atake 2",
  duration_ms: 185000,
};

function playlist(id: string, name: string, extra: Partial<Playlist> = {}): Playlist {
  return {
    id,
    owner_id: "u1",
    name,
    visibility: "private",
    is_smart: false,
    effective_role: "owner",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mock.trackId = "t1";
  mock.add.mockReturnValue(new Promise(() => {}));
  setPlaylistPickerTrack(track);
});

describe("PlaylistPickerScreen", () => {
  it("shows the track and marks only the playlists that already have it", () => {
    mock.playlists = [
      playlist("p1", "late night", { contains_track: true }),
      playlist("p2", "999", {
        owner_id: "kilo",
        owner_name: "kilo",
        visibility: "collaborative",
        effective_role: "editor",
        contains_track: false,
      }),
      playlist("p3", "gym", { contains_track: false }),
    ];
    const html = renderToStaticMarkup(<PlaylistPickerScreen />);
    expect(html).toContain("Missouri");
    expect(html).toContain("Lil Uzi Vert · Eternal Atake 2");
    expect(html).toContain("3:05");
    expect(html).toContain('placeholder="Find or name a new playlist"');
    expect(html.match(/>Added</g)).toHaveLength(1);
    expect(html).toContain('aria-label="late night" title="Already has this track." disabled=""');
    // Only the shared playlist gets a subtitle.
    expect(html).toContain("kilo · Collaborative");
    expect(html).not.toContain("Private");
  });

  it("leaves everything pickable for a server without the field", () => {
    mock.playlists = [playlist("p1", "late night"), playlist("p2", "gym")];
    const html = renderToStaticMarkup(<PlaylistPickerScreen />);
    expect(html).not.toContain(">Added<");
    expect(html).not.toContain("disabled");
  });

  it("says so when opened without a track, rather than listing playlists", () => {
    mock.trackId = undefined;
    mock.playlists = [playlist("p1", "late night")];
    const html = renderToStaticMarkup(<PlaylistPickerScreen />);
    expect(html).toContain("No track to add.");
    expect(html).not.toContain("late night");
    expect(html).not.toContain("loading");
  });

  it("closes on the first tap and hands the add to the confirmation", async () => {
    const gym = playlist("p3", "gym", { contains_track: false });
    mock.playlists = [gym];
    renderToStaticMarkup(<PlaylistPickerScreen />);
    const row = mock.renderItem!({ item: mock.data[0] });
    const onPick = (row.props as { onPick: (...args: unknown[]) => void }).onPick;
    onPick({ kind: "existing", playlist: gym }, null, { nativeEvent: {} });
    onPick({ kind: "existing", playlist: gym }, null, { nativeEvent: {} });
    await vi.waitFor(() => expect(mock.back).toHaveBeenCalled());

    expect(mock.add).toHaveBeenCalledTimes(1);
    expect(mock.add).toHaveBeenCalledWith(
      expect.objectContaining({ userId: "u1", trackId: "t1", target: { kind: "existing", playlist: gym } }),
    );
    expect(mock.dismiss).toHaveBeenCalled();
    expect(mock.show).toHaveBeenCalledTimes(1);
    expect(mock.show).toHaveBeenCalledWith(
      expect.objectContaining({
        from: { x: 32, y: 446, width: 48, height: 48 },
        playlistName: "gym",
        playlistArt: null,
        created: false,
        trackArt: {
          uri: "/api/albums/a1/cover?size=128",
          placeholder: "/api/albums/a1/cover?size=96",
        },
        done: mock.add.mock.results[0].value,
      }),
    );
    expect(mock.back).toHaveBeenCalledTimes(1);
  });
});
