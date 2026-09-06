import { describe, expect, it } from "vitest";
import type { ReplayAlbum } from "@music-library/core";
import { replayAlbumTarget } from "../lib/replay-album-target";

function album(overrides: Partial<ReplayAlbum> = {}): ReplayAlbum {
  return {
    id: "materialized-album-id",
    title: "Album",
    plays: 3,
    ...overrides,
  };
}

describe("replayAlbumTarget", () => {
  it("uses the upstream album id for TIDAL albums", () => {
    expect(
      replayAlbumTarget(
        album({ source: "tidal", source_album_id: "tidal-album-id" }),
      ),
    ).toEqual({ kind: "tidal", id: "tidal-album-id" });
  });

  it("uses the materialized album id for local albums", () => {
    expect(replayAlbumTarget(album({ source: "local" }))).toEqual({
      kind: "local",
      id: "materialized-album-id",
    });
  });

  it("keeps legacy cached responses on the local fallback", () => {
    expect(replayAlbumTarget(album())).toEqual({
      kind: "local",
      id: "materialized-album-id",
    });
  });
});
