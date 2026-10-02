import { QueryClient } from "@tanstack/react-query";
import { beforeEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import { useFavoriteActions } from "../context/favorites";
import { qk } from "../lib/query-keys";

const state = vi.hoisted(() => ({
  client: null as unknown as QueryClient,
  favorite: vi.fn(),
  unfavorite: vi.fn(),
}));
// The hook only needs stable callbacks; call it outside a renderer.
vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useCallback: <T,>(fn: T) => fn,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => state.client,
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: { favorite: state.favorite, unfavorite: state.unfavorite, listFavorites: vi.fn(() => new Promise(() => {})) },
  useAuth: () => ({ me: { id: "user" } }),
}));

const track: TrackListItem = { id: "t1", title: "Song", duration_ms: 1 };
const rows = () => state.client.getQueryData<TrackListItem[]>(qk.favorites("user"));

beforeEach(() => {
  state.client = new QueryClient();
  state.client.setQueryData(qk.favorites("user"), []);
  state.favorite.mockReset();
  state.unfavorite.mockReset();
});

it("drops a second toggle of a track while the first is in flight", async () => {
  let finish!: () => void;
  state.favorite.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const { toggle } = useFavoriteActions();
  const first = toggle(track);
  await vi.waitFor(() => expect(rows()).toEqual([track]));
  await toggle(track);
  expect(state.unfavorite).not.toHaveBeenCalled();
  expect(rows()).toEqual([track]);
  finish();
  await first;
  expect(state.favorite).toHaveBeenCalledTimes(1);
});

it("rolls back a failed toggle and accepts the next one", async () => {
  state.favorite.mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  const { toggle } = useFavoriteActions();
  await toggle(track);
  expect(rows()).toEqual([]);
  await toggle(track);
  expect(state.favorite).toHaveBeenCalledTimes(2);
});
