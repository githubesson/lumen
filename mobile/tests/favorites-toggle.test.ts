import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import {
  FAVORITE_REMOVAL_CLOSE_MS,
  FAVORITE_UNDO_MS,
  flushPendingFavoriteRemovals,
  useFavoriteActions,
  usePendingFavoriteRemoval,
  type PendingRemovalPhase,
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

/** Where t1's removal is, as a row sees it. */
function phase(): PendingRemovalPhase | null {
  let seen: PendingRemovalPhase | null = null;
  function Probe() {
    seen = usePendingFavoriteRemoval(track.id);
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  return seen;
}

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

it("says whether a toggle will run, and whether it did", async () => {
  let finish!: () => void;
  state.favorite.mockReturnValue(new Promise<void>((resolve) => (finish = resolve)));
  const { toggle, canToggle } = useFavoriteActions();
  expect(canToggle(track)).toBe(true);
  const first = toggle(track);
  // Out now: a second one would be dropped, so a swipe mustn't confirm it.
  expect(canToggle(track)).toBe(false);
  await expect(toggle(track)).resolves.toBe(false);
  finish();
  await expect(first).resolves.toBe(true);
  expect(canToggle(track)).toBe(true);
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

  it("sends a removal whose window closes while the track's favorite is still going out", async () => {
    state.client.setQueryData(qk.favorites("user"), others);
    let finish!: () => void;
    state.favorite.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const { removeWithUndo, toggle } = useFavoriteActions();
    const favoriting = toggle(track);
    await settle();
    expect(ids()).toEqual(["t1", "a", "b"]);
    removeWithUndo(track);
    await vi.advanceTimersByTimeAsync(FAVORITE_UNDO_MS + FAVORITE_REMOVAL_CLOSE_MS);
    expect(state.unfavorite).not.toHaveBeenCalled();
    finish();
    await favoriting;
    await settle();
    expect(state.unfavorite).toHaveBeenCalledExactlyOnceWith("t1");
    expect(ids()).toEqual(["a", "b"]);
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

  it("sends what's waiting before signing out, and waits for it", async () => {
    let finish!: () => void;
    state.unfavorite.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const { removeWithUndo, undoRemoval } = useFavoriteActions();
    removeWithUndo(track);
    let flushed = false;
    const flush = flushPendingFavoriteRemovals().then(() => (flushed = true));
    await settle();
    // Sent at once, inside the Undo window; the cache is cleared after this.
    expect(state.unfavorite).toHaveBeenCalledExactlyOnceWith("t1");
    expect(ids()).toEqual(["a", "b"]);
    expect(undoRemoval(track)).toBe(false);
    expect(flushed).toBe(false);
    finish();
    await flush;
    await vi.advanceTimersByTimeAsync(FAVORITE_UNDO_MS + FAVORITE_REMOVAL_CLOSE_MS);
    expect(state.unfavorite).toHaveBeenCalledOnce();
    await expect(flushPendingFavoriteRemovals()).resolves.toBeUndefined();
  });

  it("doesn't hold sign-out for long on a slow DELETE", async () => {
    let finish!: () => void;
    state.unfavorite.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const { removeWithUndo } = useFavoriteActions();
    removeWithUndo(track);
    let flushed = false;
    void flushPendingFavoriteRemovals().then(() => (flushed = true));
    await vi.advanceTimersByTimeAsync(2900);
    expect(flushed).toBe(false);
    await vi.advanceTimersByTimeAsync(200);
    expect(flushed).toBe(true);
    finish();
    await settle();
  });

  it("folds the strip away when it's sent early, with Undo no longer offered", async () => {
    // The track's favorite is still out, so the early send has to wait.
    state.client.setQueryData(qk.favorites("user"), others);
    let finish!: () => void;
    state.favorite.mockReturnValueOnce(new Promise<void>((resolve) => (finish = resolve)));
    const { removeWithUndo, toggle, undoRemoval } = useFavoriteActions();
    const favoriting = toggle(track);
    await settle();
    expect(removeWithUndo(track)).toBe(true);
    expect(removeWithUndo(track)).toBe(false);
    expect(phase()).toBe("holding");
    state.appState?.("background");
    expect(phase()).toBe("closing");
    expect(undoRemoval(track)).toBe(false);
    finish();
    await favoriting;
    await settle();
    expect(state.unfavorite).toHaveBeenCalledExactlyOnceWith("t1");
    expect(phase()).toBeNull();
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
