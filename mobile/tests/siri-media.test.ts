import { describe, expect, it, vi } from "vitest";

import {
  decodeSiriMediaIdentifier,
  loadDefaultSiriMediaQueue,
  loadSiriMediaQueue,
  rankNamedSiriItems,
  resolveSiriMediaRequest,
  siriMediaIdentifier,
} from "../lib/siri-media";
import type { SiriPlayMediaRequest } from "../modules/siri-media";

function request(
  input: Partial<SiriPlayMediaRequest>,
): SiriPlayMediaRequest {
  return {
    requestId: "request-1",
    phase: "resolve",
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
        phase: "play",
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
        phase: "play",
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

  it("uses recent listening for a generic play or shuffle request", async () => {
    const recent = [
      {
        id: "track-1",
        title: "Recently Played",
        duration_ms: 120_000,
      },
    ];
    const client = {
      listRecent: vi.fn().mockResolvedValue(recent),
    };

    await expect(
      loadDefaultSiriMediaQueue(undefined, client as never),
    ).resolves.toBe(recent);
    expect(client.listRecent).toHaveBeenCalledWith(100, { signal: undefined });
  });
});
