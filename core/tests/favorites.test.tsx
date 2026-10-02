// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, type TrackListItem } from "../src/api";
import { createToggleGuard } from "../src/favorites/favorite-toggle";
import { FavoritesProvider, useFavorites } from "../src/favorites/favorites-core";

vi.mock("../src/auth/auth-core", () => ({ useAuth: () => ({ status: "authed" }) }));

function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const row = (id: string): TrackListItem => ({ id, title: id, duration_ms: 1 });
const wrapper = ({ children }: { children: ReactNode }) => (
  <FavoritesProvider>{children}</FavoritesProvider>
);

async function renderFavorites(initial: TrackListItem[]) {
  vi.spyOn(api, "listFavorites").mockResolvedValue(initial);
  const view = renderHook(() => useFavorites(), { wrapper });
  await waitFor(() => expect(view.result.current.loading).toBe(false));
  return view;
}

beforeEach(() => {
  vi.spyOn(api, "favorite").mockResolvedValue(undefined);
  vi.spyOn(api, "unfavorite").mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("createToggleGuard", () => {
  it("drops a second run for a key while the first is in flight", async () => {
    const guard = createToggleGuard();
    const first = deferred();
    const task = vi.fn(() => first.promise);
    const running = guard.run("t1", task);
    await expect(guard.run("t1", task)).resolves.toBe(false);
    // Other keys aren't held up.
    await expect(guard.run("t2", async () => {})).resolves.toBe(true);
    first.resolve();
    await expect(running).resolves.toBe(true);
    expect(task).toHaveBeenCalledTimes(1);
    await expect(guard.run("t1", task)).resolves.toBe(true);
  });

  it("releases the key when the task fails", async () => {
    const guard = createToggleGuard();
    await expect(guard.run("t1", () => Promise.reject(new Error("boom")))).rejects.toThrow("boom");
    await expect(guard.run("t1", async () => {})).resolves.toBe(true);
  });
});

describe("FavoritesProvider", () => {
  it("ignores a second toggle of a track while the first request is in flight", async () => {
    const { result } = await renderFavorites([]);
    const request = deferred();
    vi.mocked(api.favorite).mockReturnValue(request.promise);
    let first!: Promise<void>;
    act(() => {
      first = result.current.toggle("t1");
    });
    expect(result.current.isFavorite("t1")).toBe(true);
    await act(() => result.current.toggle("t1"));
    // The second tap would have unfavorited concurrently; it's dropped.
    expect(api.unfavorite).not.toHaveBeenCalled();
    expect(result.current.isFavorite("t1")).toBe(true);
    request.resolve();
    await act(() => first);
    expect(api.favorite).toHaveBeenCalledTimes(1);
  });

  it("drops an unfavorited row from tracks at once and restores it on failure", async () => {
    const { result } = await renderFavorites([row("a"), row("b")]);
    const request = deferred();
    vi.mocked(api.unfavorite).mockReturnValue(request.promise);
    let pending!: Promise<void>;
    act(() => {
      pending = result.current.toggle("a");
    });
    expect(result.current.tracks.map((t) => t.id)).toEqual(["b"]);
    request.reject(new Error("offline"));
    await act(() => pending);
    expect(result.current.isFavorite("a")).toBe(true);
    expect(result.current.tracks.map((t) => t.id)).toEqual(["a", "b"]);
  });

  it("adds a newly favorited track's row once the server has it", async () => {
    const { result } = await renderFavorites([row("a")]);
    vi.mocked(api.listFavorites).mockResolvedValue([row("new"), row("a")]);
    await act(() => result.current.toggle("new"));
    await waitFor(() => expect(result.current.tracks.map((t) => t.id)).toEqual(["new", "a"]));
    expect(result.current.loading).toBe(false);
  });

  it("doesn't refetch rows after a failed favorite", async () => {
    const { result } = await renderFavorites([row("a")]);
    vi.mocked(api.listFavorites).mockClear();
    vi.mocked(api.favorite).mockRejectedValue(new Error("offline"));
    await act(() => result.current.toggle("new"));
    expect(result.current.isFavorite("new")).toBe(false);
    expect(api.listFavorites).not.toHaveBeenCalled();
    expect(result.current.tracks.map((t) => t.id)).toEqual(["a"]);
  });

  it("keeps a track unfavorited during the row refetch hidden", async () => {
    const { result } = await renderFavorites([row("a")]);
    const rows = deferred<TrackListItem[]>();
    vi.mocked(api.listFavorites).mockReturnValue(rows.promise);
    await act(() => result.current.toggle("new"));
    await act(() => result.current.toggle("a"));
    rows.resolve([row("new"), row("a")]);
    await waitFor(() => expect(result.current.tracks.map((t) => t.id)).toEqual(["new"]));
  });
});
