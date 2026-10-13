import React, { type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, expect, it, vi } from "vitest";
import type { Playlist } from "@music-library/core";
import EditPlaylistScreen from "../app/(tabs)/(playlists)/edit/[id]";

type HeaderOptions = { headerRight?: () => ReactElement<{ onPress: () => void }> };
const mock = vi.hoisted(() => ({
  playlist: undefined as Playlist | undefined,
  options: undefined as HeaderOptions | undefined,
  back: vi.fn(),
  mutate: vi.fn(),
}));
vi.mock("react-native", () => ({
  ActivityIndicator: () => <p>loading</p>,
  View: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("expo-router", () => ({
  Stack: {
    Screen: ({ options }: { options: HeaderOptions }) => {
      mock.options = options;
      return null;
    },
  },
  useLocalSearchParams: () => ({ id: "p1" }),
  useRouter: () => ({ back: mock.back }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: mock.playlist }),
  useQueryClient: () => ({ invalidateQueries: vi.fn() }),
  useMutation: () => ({ mutate: mock.mutate, isPending: false, isError: false }),
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {},
  useAuth: () => ({ me: { id: "owner", role: "user" } }),
}));
vi.mock("../components/empty-state", () => ({
  EmptyState: ({ message }: { message?: string }) => <p>{message}</p>,
}));
vi.mock("../components/form-field", () => ({ FormError: () => null }));
vi.mock("../components/form-screen", () => ({
  FormScreen: ({ children }: { children: ReactNode }) => <main>{children}</main>,
}));
vi.mock("../components/header-buttons", () => ({ HeaderTextButton: () => null }));
vi.mock("../components/playlist-fields", () => ({
  PlaylistFields: ({ name, description }: { name: string; description: string }) => (
    <form>
      <input value={name} readOnly />
      <textarea value={description} readOnly />
    </form>
  ),
}));
vi.mock("../components/playlists/playlist-cover-field", () => ({ PlaylistCoverField: () => null }));
vi.mock("../theme/theme", () => ({ useTheme: () => ({ color: { bg: "black", fgMuted: "gray" } }) }));

function playlist(overrides: Partial<Playlist> = {}): Playlist {
  return {
    id: "p1",
    owner_id: "owner",
    name: "Road trip",
    description: "Windows down",
    visibility: "private",
    is_smart: false,
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    effective_role: "owner",
    ...overrides,
  };
}

beforeEach(() => {
  mock.options = undefined;
  mock.back.mockClear();
  mock.mutate.mockClear();
});

it("waits for the playlist before showing the form", () => {
  mock.playlist = undefined;
  const html = renderToStaticMarkup(<EditPlaylistScreen />);
  expect(html).toContain("loading");
  expect(html).not.toContain("<form>");
});

it("fills the form from the playlist", () => {
  mock.playlist = playlist();
  const html = renderToStaticMarkup(<EditPlaylistScreen />);
  expect(html).toContain('value="Road trip"');
  expect(html).toContain("Windows down");
});

it("saves nothing when no field changed, so older details can't overwrite newer ones", () => {
  mock.playlist = playlist();
  renderToStaticMarkup(<EditPlaylistScreen />);
  mock.options?.headerRight?.().props.onPress();
  expect(mock.mutate).not.toHaveBeenCalled();
  expect(mock.back).toHaveBeenCalledOnce();
});
