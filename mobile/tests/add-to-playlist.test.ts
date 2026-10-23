import { QueryClient } from "@tanstack/react-query";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError, type Playlist } from "@music-library/core";
import { addTrackToPlaylist } from "../lib/add-to-playlist";
import { qk } from "../lib/query-keys";

const mock = vi.hoisted(() => ({
  createPlaylist: vi.fn(),
  addPlaylistTracks: vi.fn(),
  remember: vi.fn(async () => {}),
}));
vi.mock("@music-library/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@music-library/core")>()),
  api: {
    createPlaylist: mock.createPlaylist,
    addPlaylistTracks: mock.addPlaylistTracks,
  },
}));
vi.mock("../lib/recent-playlists", () => ({
  rememberRecentPlaylist: mock.remember,
}));

function playlist(id: string, extra: Partial<Playlist> = {}): Playlist {
  return {
    id,
    owner_id: "u1",
    name: id,
    visibility: "private",
    is_smart: false,
    effective_role: "owner",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

let queryClient: QueryClient;
let invalidated: unknown[][];

beforeEach(() => {
  vi.clearAllMocks();
  mock.createPlaylist.mockResolvedValue(playlist("made"));
  mock.addPlaylistTracks.mockResolvedValue(undefined);
  queryClient = new QueryClient();
  invalidated = [];
  vi.spyOn(queryClient, "invalidateQueries").mockImplementation(async (filters) => {
    invalidated.push([...(filters?.queryKey ?? [])]);
  });
});

describe("addTrackToPlaylist", () => {
  it("adds to an existing playlist and refreshes what it changes", async () => {
    const gym = playlist("gym", { contains_track: false });
    const rage = playlist("rage", { contains_track: true });
    queryClient.setQueryData(qk.playlistsWithTrack("u1", "t1"), [gym, rage]);

    const result = await addTrackToPlaylist({
      queryClient, userId: "u1", trackId: "t1", target: { kind: "existing", playlist: gym },
    });

    expect(result).toEqual({ ok: true });
    expect(mock.createPlaylist).not.toHaveBeenCalled();
    expect(mock.addPlaylistTracks).toHaveBeenCalledWith("gym", ["t1"]);
    expect(mock.remember).toHaveBeenCalledWith("u1", "gym");
    expect(invalidated).toEqual([
      [...qk.playlistTracks("u1", "gym")],
      [...qk.playlists("u1")],
    ]);
    // Reopened, the picker already marks it.
    expect(
      queryClient
        .getQueryData<Playlist[]>(qk.playlistsWithTrack("u1", "t1"))
        ?.map((p) => p.contains_track),
    ).toEqual([true, true]);
  });

  it("marks nothing for a server that doesn't report the field", async () => {
    const gym = playlist("gym");
    queryClient.setQueryData(qk.playlistsWithTrack("u1", "t1"), [gym]);
    await addTrackToPlaylist({
      queryClient, userId: "u1", trackId: "t1", target: { kind: "existing", playlist: gym },
    });
    expect(
      queryClient.getQueryData<Playlist[]>(qk.playlistsWithTrack("u1", "t1"))?.[0]
        .contains_track,
    ).toBeUndefined();
  });

  it("makes a new playlist first, then adds to it", async () => {
    const result = await addTrackToPlaylist({
      queryClient, userId: "u1", trackId: "t1", target: { kind: "new", name: "night drive" },
    });
    expect(result).toEqual({ ok: true });
    expect(mock.createPlaylist).toHaveBeenCalledWith({ name: "night drive" });
    expect(mock.addPlaylistTracks).toHaveBeenCalledWith("made", ["t1"]);
    expect(mock.remember).toHaveBeenCalledWith("u1", "made");
  });

  it("reports a playlist it couldn't make, and adds nothing", async () => {
    mock.createPlaylist.mockRejectedValue(new ApiError(400, "name required"));
    const result = await addTrackToPlaylist({
      queryClient, userId: "u1", trackId: "t1", target: { kind: "new", name: "x" },
    });
    expect(result).toEqual({ ok: false, title: "Couldn't create playlist", message: "name required" });
    expect(mock.addPlaylistTracks).not.toHaveBeenCalled();
    expect(invalidated).toEqual([]);
  });

  it("reports a failed add, still listing a playlist it just made", async () => {
    mock.addPlaylistTracks.mockRejectedValue(new TypeError("Network request failed"));
    const result = await addTrackToPlaylist({
      queryClient, userId: "u1", trackId: "t1", target: { kind: "new", name: "x" },
    });
    expect(result).toEqual({ ok: false, title: "Couldn't add track", message: "Please try again." });
    expect(invalidated).toEqual([[...qk.playlists("u1")]]);
    expect(mock.remember).not.toHaveBeenCalled();
  });
});
