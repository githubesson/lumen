import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadRecentPlaylistIds,
  parseRecentPlaylistIds,
  recentPlaylistsKey,
  rememberRecentPlaylist,
  withRecentPlaylist,
} from "../lib/recent-playlists";

const storage = vi.hoisted(() => ({
  items: new Map<string, string>(),
  failWrites: false,
}));
vi.mock("@react-native-async-storage/async-storage", () => ({
  default: {
    getItem: vi.fn(async (key: string) => storage.items.get(key) ?? null),
    setItem: vi.fn(async (key: string, value: string) => {
      // Yield first, so overlapping writes would interleave if unserialized.
      await new Promise((resolve) => setTimeout(resolve, 1));
      if (storage.failWrites) throw new Error("disk full");
      storage.items.set(key, value);
    }),
  },
}));

beforeEach(() => {
  storage.items.clear();
  storage.failWrites = false;
});

describe("recent playlists", () => {
  it("keeps the key the picker always used", () => {
    expect(recentPlaylistsKey("u1")).toBe("mlib-recent-add-playlists:u1");
  });

  it("reads only well-formed lists of ids", () => {
    expect(parseRecentPlaylistIds(null)).toEqual([]);
    expect(parseRecentPlaylistIds("{nope")).toEqual([]);
    expect(parseRecentPlaylistIds('{"a":1}')).toEqual([]);
    expect(parseRecentPlaylistIds('["a", 2, "b"]')).toEqual(["a", "b"]);
  });

  it("moves the used playlist to the front and keeps six", () => {
    expect(withRecentPlaylist(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(withRecentPlaylist(["a", "b", "c", "d", "e", "f"], "g")).toEqual([
      "g", "a", "b", "c", "d", "e",
    ]);
  });

  it("records quick successive adds without losing one", async () => {
    storage.items.set(recentPlaylistsKey("u1"), JSON.stringify(["old"]));
    await Promise.all([
      rememberRecentPlaylist("u1", "first"),
      rememberRecentPlaylist("u1", "second"),
    ]);
    expect(await loadRecentPlaylistIds("u1")).toEqual(["second", "first", "old"]);
  });

  it("never rejects when storage fails", async () => {
    storage.failWrites = true;
    await expect(rememberRecentPlaylist("u1", "p1")).resolves.toBeUndefined();
    storage.failWrites = false;
    await rememberRecentPlaylist("u1", "p2");
    expect(await loadRecentPlaylistIds("u1")).toEqual(["p2"]);
  });
});
