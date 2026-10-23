import { QueryClient, type Query } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import { qk } from "../lib/query-keys";
import { shouldPersistQuery } from "../lib/query-persister";

vi.mock("expo-file-system", () => ({ Directory: class {}, File: class {}, Paths: {} }));
vi.mock("expo-file-system/legacy", () => ({}));

const succeeded = (queryKey: readonly unknown[]) =>
  ({ queryKey, state: { status: "success" } }) as unknown as Query;

describe("the picker's per-track playlists list", () => {
  it("refreshes with every playlists refresh", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.playlistsWithTrack("u1", "t1"), []);
    await queryClient.invalidateQueries({ queryKey: qk.playlists("u1") });
    expect(
      queryClient.getQueryState(qk.playlistsWithTrack("u1", "t1"))?.isInvalidated,
    ).toBe(true);
  });

  it("stays off disk, unlike the plain list", () => {
    expect(shouldPersistQuery(succeeded(qk.playlists("u1")))).toBe(true);
    expect(shouldPersistQuery(succeeded(qk.playlistsWithTrack("u1", "t1")))).toBe(false);
  });
});
