import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import {
  FAVORITE_REMOVAL_CLOSE_MS,
  FAVORITE_UNDO_MS,
  useFavoriteActions,
} from "../context/favorites";
import { qk } from "../lib/query-keys";

const state = vi.hoisted(() => ({
  client: null as unknown as QueryClient,
  favorite: vi.fn(),
  unfavorite: vi.fn(),
  appState: null as ((status: string) => void) | null,
}));
vi.mock("react-native", () => ({
  AppState: {
    addEventListener: (_: string, listener: (status: string) => void) => {
      state.appState = listener;
      return { remove: () => (state.appState = null) };
    },
  },
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

describe("removing with Undo", () => {
  const others: TrackListItem[] = [
    { id: "a", title: "A", duration_ms: 1 },
    { id: "b", title: "B", duration_ms: 1 },
  ];
  const ids = () => rows()?.map((row) => row.id);
  // Lets the commit's awaits (cancelQueries, the DELETE) run under fake timers.
  const settle = () => vi.advanceTimersByTimeAsync(0);

  beforeEach(() => {
    vi.useFakeTimers();
    state.client.setQueryData(qk.favorites("user"), [others[0], track, others[1]]);
    state.unfavorite.mockResolvedValue(undefined);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("keeps the row until the window closes, then sends it", async () => {
    const { removeWithUndo } = useFavoriteActions();
    removeWithUndo(track);
    await vi.advanceTimersByTimeAsync(FAVORITE_UNDO_MS);
    expect(ids()).toEqual(["a", "t1", "b"]);
    expect(state.unfavorite).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(FAVORITE_REMOVAL_CLOSE_MS);
    await settle();
    expect(state.unfavorite).toHaveBeenCalledExactlyOnceWith("t1");
    expect(ids()).toEqual(["a", "b"]);
  });

  it("sends nothing after Undo, or after a toggle that keeps it", async () => {
    const { removeWithUndo, undoRemoval, toggle } = useFavoriteActions();
    removeWithUndo(track);
    expect(undoRemoval(track)).toBe(true);
    removeWithUndo(track);
    await toggle(track);
    await vi.advanceTimersByTimeAsync(FAVORITE_UNDO_MS + FAVORITE_REMOVAL_CLOSE_MS);
    expect(state.unfavorite).not.toHaveBeenCalled();
    expect(state.favorite).not.toHaveBeenCalled();
    expect(ids()).toEqual(["a", "t1", "b"]);
    expect(undoRemoval(track)).toBe(false);
  });

  it("puts a failed removal back where it was", async () => {
    state.unfavorite.mockRejectedValueOnce(new Error("offline"));
    const { removeWithUndo } = useFavoriteActions();
    removeWithUndo(track);
    await vi.advanceTimersByTimeAsync(FAVORITE_UNDO_MS + FAVORITE_REMOVAL_CLOSE_MS);
    await settle();
    expect(state.unfavorite).toHaveBeenCalledOnce();
    expect(ids()).toEqual(["a", "t1", "b"]);
  });

  it("sends at once when the app goes to the background", async () => {
    const { removeWithUndo, undoRemoval } = useFavoriteActions();
    removeWithUndo(track);
    state.appState?.("inactive");
    expect(state.unfavorite).not.toHaveBeenCalled();
    state.appState?.("background");
    expect(undoRemoval(track)).toBe(false);
    await settle();
    expect(state.unfavorite).toHaveBeenCalledExactlyOnceWith("t1");
    expect(ids()).toEqual(["a", "b"]);
    // Nothing left waiting, so nothing watches the app any more.
    expect(state.appState).toBeNull();
  });
});
