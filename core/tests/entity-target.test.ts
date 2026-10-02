import { afterEach, describe, expect, it, vi } from "vitest";
import { api, type ReplayAlbum, type TrackDetail } from "../src/api";
import {
  replayAlbumTarget,
  resolveTrackAlbumTarget,
  searchEntityTarget,
  trackAlbumTarget,
} from "../src/entity-target";
import { tidalArtistReleases, libraryArtistReleases } from "../src/artist-releases";

afterEach(() => vi.restoreAllMocks());

function detail(overrides: Partial<TrackDetail> = {}): TrackDetail {
  return {
    id: "t",
    source: "local",
    title: "Song",
    duration_ms: 1000,
    format: "flac",
    file_size: 1,
    artists: [],
    has_cover: false,
    favorited: false,
    ...overrides,
  };
}

describe("trackAlbumTarget", () => {
  it("opens a library track's album", () => {
    expect(trackAlbumTarget({ source: "local", album_id: "a1" })).toEqual({ kind: "local", id: "a1" });
    // Rows from older payloads carry no source: they're library rows.
    expect(trackAlbumTarget({ album_id: "a1" })).toEqual({ kind: "local", id: "a1" });
  });

  it("opens a TIDAL track's release rather than its hidden library album", () => {
    expect(
      trackAlbumTarget({ source: "tidal", album_id: "hidden", source_album_id: "123" }),
    ).toEqual({ kind: "tidal", id: "123" });
  });

  it("doesn't know without the id the track's source needs", () => {
    expect(trackAlbumTarget({ source: "tidal", album_id: "hidden" })).toBeNull();
    expect(trackAlbumTarget({ source: "local", source_album_id: "123" })).toBeNull();
    expect(trackAlbumTarget({ source: "local" })).toBeNull();
  });
});

describe("resolveTrackAlbumTarget", () => {
  it("answers from the row without a request when it can", async () => {
    const getTrack = vi.spyOn(api, "getTrack");
    await expect(
      resolveTrackAlbumTarget({ id: "t", source: "local", album_id: "a1" }),
    ).resolves.toEqual({ kind: "local", id: "a1" });
    expect(getTrack).not.toHaveBeenCalled();
  });

  it("falls back to the track's detail for a missing id", async () => {
    const getTrack = vi
      .spyOn(api, "getTrack")
      .mockResolvedValue(detail({ source: "tidal", album_id: "hidden", source_album_id: "123" }));
    await expect(
      resolveTrackAlbumTarget({ id: "tidal:9", source: "tidal", album_id: "hidden" }),
    ).resolves.toEqual({ kind: "tidal", id: "123" });
    expect(getTrack).toHaveBeenCalledWith("tidal:9", {});

    getTrack.mockResolvedValue(detail({ album_id: "a2" }));
    await expect(resolveTrackAlbumTarget({ id: "t", source: "local" })).resolves.toEqual({
      kind: "local",
      id: "a2",
    });
  });

  it("keeps a TIDAL track off its hidden album when the detail has no release id", async () => {
    vi.spyOn(api, "getTrack").mockResolvedValue(detail({ source: "tidal", album_id: "hidden" }));
    await expect(
      resolveTrackAlbumTarget({ id: "tidal:9", source: "tidal", album_id: "hidden" }),
    ).resolves.toBeNull();
  });

  it("uses the detail's source for a row without one", async () => {
    vi.spyOn(api, "getTrack").mockResolvedValue(
      detail({ source: "tidal", album_id: "hidden", source_album_id: "123" }),
    );
    await expect(resolveTrackAlbumTarget({ id: "tidal:9" })).resolves.toEqual({
      kind: "tidal",
      id: "123",
    });
  });

  it("returns null for a track with no album and rejects on a failed read", async () => {
    const getTrack = vi.spyOn(api, "getTrack").mockResolvedValue(detail());
    await expect(resolveTrackAlbumTarget({ id: "t", source: "local" })).resolves.toBeNull();
    getTrack.mockRejectedValue(new Error("offline"));
    await expect(resolveTrackAlbumTarget({ id: "t", source: "local" })).rejects.toThrow("offline");
  });
});

describe("replayAlbumTarget", () => {
  function album(overrides: Partial<ReplayAlbum> = {}): ReplayAlbum {
    return { id: "materialized-album-id", title: "Album", plays: 3, ...overrides };
  }

  it("uses the upstream album id for TIDAL albums", () => {
    expect(replayAlbumTarget(album({ source: "tidal", source_album_id: "tidal-album-id" }))).toEqual({
      kind: "tidal",
      id: "tidal-album-id",
    });
  });

  it("uses the materialized album id for local albums", () => {
    expect(replayAlbumTarget(album({ source: "local" }))).toEqual({
      kind: "local",
      id: "materialized-album-id",
    });
  });

  it("keeps legacy cached responses on the local fallback", () => {
    expect(replayAlbumTarget(album())).toEqual({ kind: "local", id: "materialized-album-id" });
    expect(replayAlbumTarget(album({ source: "tidal" }))).toEqual({
      kind: "local",
      id: "materialized-album-id",
    });
  });
});

describe("searchEntityTarget", () => {
  it("opens TIDAL results by TIDAL id and library results by library id", () => {
    expect(searchEntityTarget({ id: "tidal:42", source: "tidal", source_id: "42" })).toEqual({
      kind: "tidal",
      id: "42",
    });
    expect(searchEntityTarget({ id: "uuid", source: "local" })).toEqual({ kind: "local", id: "uuid" });
    expect(searchEntityTarget({ id: "uuid" })).toEqual({ kind: "local", id: "uuid" });
  });

  it("strips the prefix from older payloads without source_id", () => {
    expect(searchEntityTarget({ id: "tidal:42", source: "tidal" })).toEqual({ kind: "tidal", id: "42" });
  });

  it("opens artist releases where they came from", () => {
    const [tidal] = tidalArtistReleases([
      {
        id: "tidal:42",
        title: "LP",
        source: "tidal",
        source_id: "42",
        is_compilation: false,
        track_count: 10,
        duration_ms: 40 * 60_000,
        has_cover: true,
      },
    ]);
    expect(searchEntityTarget(tidal)).toEqual({ kind: "tidal", id: "42" });
    const [library] = libraryArtistReleases([
      { id: "t", title: "Song", duration_ms: 1, album_id: "a1", album_title: "LP" },
    ]);
    expect(searchEntityTarget(library)).toEqual({ kind: "local", id: "a1" });
  });
});
