/** Favorites waiting on Undo, as the Favorites tab's counts and queues see them. */
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient } from "@tanstack/react-query";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { TrackListItem } from "@music-library/core";
import {
  FAVORITE_REMOVAL_CLOSE_MS,
  FAVORITE_UNDO_MS,
  useFavoriteActions,
  usePendingFavoriteRemovalIds,
} from "../context/favorites";
import { qk } from "../lib/query-keys";

const state = vi.hoisted(() => ({
  client: null as unknown as QueryClient,
  userId: "user",
}));
vi.mock("react-native", () => ({
  AppState: { addEventListener: () => ({ remove: () => undefined }) },
}));
// The actions hook only needs stable callbacks; call it outside a renderer.
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
  api: { unfavorite: vi.fn(async () => undefined), listFavorites: vi.fn(() => new Promise(() => {})) },
  useAuth: () => ({ me: { id: state.userId } }),
}));

const a: TrackListItem = { id: "a", title: "A", duration_ms: 1 };
const b: TrackListItem = { id: "b", title: "B", duration_ms: 1 };

function pendingIds(): ReadonlySet<string> {
  let ids: ReadonlySet<string> | undefined;
  function Probe() {
    ids = usePendingFavoriteRemovalIds();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return ids!;
}

beforeEach(() => {
  vi.useFakeTimers();
  state.userId = "user";
  state.client = new QueryClient();
  state.client.setQueryData(qk.favorites("user"), [a, b]);
});
afterEach(() => {
  vi.useRealTimers();
});

it("lists the favorites waiting on Undo until they're undone or sent", async () => {
  const { removeWithUndo, undoRemoval } = useFavoriteActions();
  expect(pendingIds().size).toBe(0);

  removeWithUndo(a);
  removeWithUndo(b);
  expect([...pendingIds()].sort()).toEqual(["a", "b"]);

  undoRemoval(b);
  expect([...pendingIds()]).toEqual(["a"]);

  // Still pending while the strip folds away, gone once it's sent.
  await vi.advanceTimersByTimeAsync(FAVORITE_UNDO_MS);
  expect([...pendingIds()]).toEqual(["a"]);
  await vi.advanceTimersByTimeAsync(FAVORITE_REMOVAL_CLOSE_MS);
  await vi.advanceTimersByTimeAsync(0);
  expect(pendingIds().size).toBe(0);
});

it("keeps the same set while nothing changes, so readers don't re-render", () => {
  const { removeWithUndo, undoRemoval } = useFavoriteActions();
  removeWithUndo(a);
  const first = pendingIds();
  expect(pendingIds()).toBe(first);
  undoRemoval(a);
  expect(pendingIds()).not.toBe(first);
});

it("only counts the signed-in user's removals", () => {
  const { removeWithUndo, undoRemoval } = useFavoriteActions();
  removeWithUndo(a);
  state.userId = "someone-else";
  expect(pendingIds().size).toBe(0);
  state.userId = "user";
  expect([...pendingIds()]).toEqual(["a"]);
  undoRemoval(a);
});
