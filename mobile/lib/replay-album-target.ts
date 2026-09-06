import type { ReplayAlbum } from "@music-library/core";

export type ReplayAlbumTarget =
  | { kind: "local"; id: string }
  | { kind: "tidal"; id: string };

/**
 * Replay albums use a materialized local album id for artwork, even when all
 * of their plays came from TIDAL. Navigation needs the upstream album id in
 * that case; the local id points at hidden track rows and cannot open the
 * normal library album screen.
 */
export function replayAlbumTarget(album: ReplayAlbum): ReplayAlbumTarget {
  if (album.source === "tidal" && album.source_album_id) {
    return { kind: "tidal", id: album.source_album_id };
  }
  return { kind: "local", id: album.id };
}
