import React, { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import TidalArtistScreen from "../app/(tabs)/(library)/tidal-artists/[id]";

const mock = vi.hoisted(() => ({
  query: {
    data: undefined as
      | undefined
      | {
          albums: { id: string; title: string }[];
          tracks: { id: string; title: string }[];
          warnings?: string[];
        },
    isError: false,
    isLoading: false,
    isFetching: false,
    refetch: vi.fn(),
  },
  retry: undefined as undefined | { onPress: () => void; disabled: boolean },
}));
vi.mock("react-native", () => ({
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  Text: ({ children }: { children: ReactNode }) => <span>{children}</span>,
}));
vi.mock("@tanstack/react-query", () => ({ useQuery: () => mock.query }));
vi.mock("expo-router", () => ({
  Stack: { Screen: () => null },
  useLocalSearchParams: () => ({ id: "123", name: "Artist" }),
  useRouter: () => ({ push: vi.fn() }),
}));
vi.mock("@music-library/core", () => ({
  api: {},
  searchEntityID: vi.fn(),
  useAuth: () => ({ me: { id: "user" } }),
}));
vi.mock("@shopify/flash-list", () => ({
  FlashList: ({
    data,
    ListHeaderComponent,
    ListEmptyComponent,
    renderItem,
  }: {
    data: { type: string; item: { id: string; title: string } }[];
    ListHeaderComponent: ReactNode;
    ListEmptyComponent: ReactNode;
    renderItem: (args: {
      item: { type: string; item: { id: string; title: string } };
    }) => ReactNode;
  }) => (
    <div>
      {ListHeaderComponent}
      {data.length
        ? data.map((item) => (
            <div key={item.item.id}>{renderItem({ item })}</div>
          ))
        : ListEmptyComponent}
    </div>
  ),
}));
vi.mock("../components/track-row", () => ({
  TrackRow: ({ track }: { track: { title: string } }) => (
    <span>{track.title}</span>
  ),
}));
vi.mock("../components/album-row", () => ({
  AlbumRow: ({ album }: { album: { title: string } }) => (
    <span>{album.title}</span>
  ),
}));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({
    message,
    loading,
  }: {
    message?: string;
    loading?: boolean;
  }) => <span>{loading ? "Loading" : message}</span>,
}));
vi.mock("../components/buttons", () => ({
  SecondaryButton: (props: {
    label: string;
    onPress: () => void;
    disabled: boolean;
  }) => {
    mock.retry = props;
    return <button disabled={props.disabled}>{props.label}</button>;
  },
}));
vi.mock("../components/dock/dock-context", () => ({
  useBottomDockInset: () => 0,
  useDockScrollHandler: () => ({}),
}));
vi.mock("../lib/use-play-queue", () => ({ usePlayQueue: () => vi.fn() }));
vi.mock("../theme/theme", () => ({
  useTheme: () => ({
    space: { lg: 24, md: 16 },
    color: { bg: "black", fgMuted: "gray", danger: "red" },
  }),
}));

beforeEach(() => {
  Object.assign(mock.query, {
    data: undefined,
    isError: false,
    isLoading: false,
    isFetching: false,
  });
  mock.query.refetch.mockReset();
  mock.retry = undefined;
});
const markup = () => renderToStaticMarkup(<TidalArtistScreen />);

it("shows a total failure with a working retry control", () => {
  mock.query.isError = true;
  const html = markup();
  expect(html).toContain("Couldn&#x27;t load artist.");
  expect(html).not.toContain("No releases found.");
  mock.retry?.onPress();
  expect(mock.query.refetch).toHaveBeenCalledOnce();
});

it("keeps available releases visible with partial failure warnings and during a failed refetch", () => {
  mock.query.data = {
    albums: [{ id: "1", title: "Available album" }],
    tracks: [],
    warnings: ["Couldn't load singles and EPs."],
  };
  expect(markup()).toContain("Couldn&#x27;t load singles and EPs.");
  expect(markup()).toContain("Available album");
  mock.query.isError = true;
  expect(markup()).toContain("Couldn&#x27;t load artist.");
  expect(markup()).toContain("Available album");
  expect(mock.retry).toBeDefined();
});

it("distinguishes incomplete empty results from confirmed empty results and clears retry after recovery", () => {
  mock.query.data = {
    albums: [],
    tracks: [],
    warnings: ["Couldn't load albums."],
  };
  expect(markup()).not.toContain("No releases found.");
  mock.query.isFetching = true;
  expect(markup()).toContain("Retrying…");
  expect(mock.retry?.disabled).toBe(true);
  mock.query.isFetching = false;
  mock.query.data = { albums: [], tracks: [] };
  const html = markup();
  expect(html).toContain("No releases found.");
  expect(html).not.toContain("Retry artist");
  expect(html).not.toContain("Couldn");
});
