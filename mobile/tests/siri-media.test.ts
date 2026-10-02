import { ApiError } from "@music-library/core";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";

import {
  cachedSiriCatalog,
  decodeSiriMediaIdentifier,
  loadSiriMediaQueue,
  rankNamedSiriItems,
  resolveSiriMediaRequest,
  siriMediaIdentifier,
} from "../lib/siri-media";
import type { SiriPlayMediaRequest } from "../modules/siri-media";
import { qk } from "../lib/query-keys";

function request(
  input: Partial<SiriPlayMediaRequest>,
): SiriPlayMediaRequest {
  return {
    requestId: "request-1",
    mediaType: "unknown",
    mediaItems: [],
    ...input,
  };
}

describe("Siri media identifiers", () => {
  it("round-trips ids that contain separators and URL characters", () => {
    const encoded = siriMediaIdentifier("playlist", "tidal:mix/a b");
    expect(decodeSiriMediaIdentifier(encoded)).toEqual({
      type: "playlist",
      lumenId: "tidal:mix/a b",
    });
  });

  it("rejects identifiers that do not belong to Lumen", () => {
    expect(decodeSiriMediaIdentifier("other:playlist:123")).toBeNull();
  });
});

describe("Siri catalog matching", () => {
  it("ranks exact and accent-insensitive playlist names first", () => {
    const playlists = ["Cafe", "Café del Mar", "Café", "Late Café"];
    expect(rankNamedSiriItems(playlists, "cafe", (name) => name)).toEqual([
      "Cafe",
      "Café",
      "Café del Mar",
      "Late Café",
    ]);
  });

  it("resolves a spoken playlist to stable app identifiers", async () => {
    const client = {
      listPlaylists: vi.fn().mockResolvedValue([
        {
          id: "p-1",
          owner_id: "u-1",
          name: "Road Trip",
          visibility: "private",
          is_smart: false,
          created_at: "",
          updated_at: "",
        },
        {
          id: "p-2",
          owner_id: "u-1",
          name: "Road Trip Oldies",
          visibility: "private",
          is_smart: false,
          created_at: "",
          updated_at: "",
        },
      ]),
    };

    const result = await resolveSiriMediaRequest(
      request({ mediaType: "playlist", mediaName: "Road Trip" }),
      undefined,
      client as never,
    );

    expect(result.map(({ lumenId, title }) => ({ lumenId, title }))).toEqual([
      { lumenId: "p-1", title: "Road Trip" },
      { lumenId: "p-2", title: "Road Trip Oldies" },
    ]);
  });

  it("uses a donated playlist container when Siri omits media items", async () => {
    const listPlaylists = vi.fn();
    const result = await resolveSiriMediaRequest(
      request({
        mediaType: "playlist",
        mediaContainer: {
          identifier: siriMediaIdentifier("playlist", "p-container"),
          title: "Night Drive",
          type: "playlist",
        },
      }),
      undefined,
      { listPlaylists } as never,
    );

    expect(result).toEqual([
      {
        identifier: siriMediaIdentifier("playlist", "p-container"),
        lumenId: "p-container",
        title: "Night Drive",
        type: "playlist",
      },
    ]);
    expect(listPlaylists).not.toHaveBeenCalled();
  });

  it("searches playlists by a non-donated media container title", async () => {
    const listPlaylists = vi.fn().mockResolvedValue([
      {
        id: "p-1",
        owner_id: "u-1",
        name: "Night Drive",
        visibility: "private",
        is_smart: false,
        created_at: "",
        updated_at: "",
      },
    ]);

    const result = await resolveSiriMediaRequest(
      request({
        mediaType: "playlist",
        mediaContainer: {
          identifier: "",
          title: "Night Drive",
          type: "playlist",
        },
      }),
      undefined,
      { listPlaylists } as never,
    );

    expect(result[0]).toMatchObject({
      lumenId: "p-1",
      title: "Night Drive",
      type: "playlist",
    });
  });

  it("loads a resolved playlist as a player queue", async () => {
    const client = {
      listPlaylistTracks: vi.fn().mockResolvedValue({
        tracks: [
          {
            position: 0,
            track_id: "track-1",
            title: "Opening Track",
            duration_ms: 120_000,
            added_at: "",
          },
        ],
      }),
    };

    const queue = await loadSiriMediaQueue(
      {
        identifier: siriMediaIdentifier("playlist", "p-1"),
        lumenId: "p-1",
        title: "Road Trip",
        type: "playlist",
      },
      undefined,
      client as never,
    );

    expect(queue).toEqual([
      {
        id: "track-1",
        title: "Opening Track",
        duration_ms: 120_000,
        album_id: undefined,
        album_title: undefined,
        track_no: undefined,
        artist: undefined,
        source: undefined,
        source_id: undefined,
        source_album_id: undefined,
        cover_url: undefined,
      },
    ]);
  });
});

describe("cachedSiriCatalog", () => {
  const playlistTracks = {
    tracks: [{ position: 1, track_id: "t-1", title: "Downloaded", duration_ms: 1, added_at: "", play_count: 0 }],
  };

  it("reads what the screens cached while offline", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.playlistTracks("u-1", "p-1"), playlistTracks);
    const client = { listPlaylistTracks: vi.fn() };
    const catalog = cachedSiriCatalog(
      queryClient,
      "u-1",
      () => true,
      client as unknown as Parameters<typeof cachedSiriCatalog>[3],
    );

    await expect(
      loadSiriMediaQueue({ identifier: "x", lumenId: "p-1", title: "Road Trip", type: "playlist" }, undefined, catalog),
    ).resolves.toMatchObject([{ id: "t-1", title: "Downloaded" }]);
    expect(client.listPlaylistTracks).not.toHaveBeenCalled();
    // Nothing cached: fail rather than wait on a request that can't finish.
    await expect(catalog.listAlbumTracks("a-1")).rejects.toThrow("Not available offline");
  });

  it("asks the server while online", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.playlistTracks("u-1", "p-1"), { tracks: [] });
    const client = { listPlaylistTracks: vi.fn().mockResolvedValue(playlistTracks) };
    const catalog = cachedSiriCatalog(
      queryClient,
      "u-1",
      () => false,
      client as unknown as Parameters<typeof cachedSiriCatalog>[3],
    );

    await expect(catalog.listPlaylistTracks("p-1")).resolves.toBe(playlistTracks);
    expect(client.listPlaylistTracks).toHaveBeenCalledWith("p-1", undefined);
  });

  it("falls back to the cache when the server can't be reached", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.playlistTracks("u-1", "p-1"), playlistTracks);
    const unreachable = new Error("Network request failed");
    const client = {
      listPlaylistTracks: vi.fn().mockRejectedValue(unreachable),
      listAlbumTracks: vi.fn().mockRejectedValue(unreachable),
    };
    const catalog = cachedSiriCatalog(
      queryClient,
      "u-1",
      () => false,
      client as unknown as Parameters<typeof cachedSiriCatalog>[3],
    );

    await expect(catalog.listPlaylistTracks("p-1")).resolves.toBe(playlistTracks);
    await expect(catalog.listAlbumTracks("a-1")).rejects.toBe(unreachable);
  });

  it("doesn't play a cached copy of something the server refuses", async () => {
    const queryClient = new QueryClient();
    queryClient.setQueryData(qk.playlistTracks("u-1", "p-1"), playlistTracks);
    const deleted = new ApiError(404, "not found");
    const catalog = cachedSiriCatalog(
      queryClient,
      "u-1",
      () => false,
      { listPlaylistTracks: vi.fn().mockRejectedValue(deleted) } as unknown as Parameters<
        typeof cachedSiriCatalog
      >[3],
    );

    await expect(catalog.listPlaylistTracks("p-1")).rejects.toBe(deleted);
  });
});
