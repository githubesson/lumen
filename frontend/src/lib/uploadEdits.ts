import type { CoverUploadFile, TrackPatch, UploadResult } from "@music-library/core";
import { api, errorMessage } from "../api";
import { waitOutRateLimit, type UploadScope } from "@music-library/core/upload";

/** Details typed in before uploading; blank fields keep the file's tags. */
export interface UploadEdits {
  /** Per file, by its place in the selection. */
  perFile: { title: string; artists: string }[];
  album: string;
  albumArtist: string;
  cover: CoverUploadFile | null;
}

export const emptyUploadEdits = (count: number): UploadEdits => ({
  perFile: Array.from({ length: count }, () => ({ title: "", artists: "" })),
  album: "",
  albumArtist: "",
  cover: null,
});

/** The patch for one uploaded file, or null when nothing was typed for it. */
export function uploadPatch(edits: UploadEdits, index: number): TrackPatch | null {
  const patch: TrackPatch = {};
  const own = edits.perFile[index];
  if (own?.title.trim()) patch.title = own.title.trim();
  const artists = (own?.artists ?? "").split(",").map((a) => a.trim()).filter(Boolean);
  if (artists.length) patch.artists = artists;
  if (edits.album.trim()) {
    patch.album_title = edits.album.trim();
    if (edits.albumArtist.trim()) patch.album_artist = edits.albumArtist.trim();
  }
  return Object.keys(patch).length ? patch : null;
}

/**
 * Apply the typed details to what an upload just added. `results[i]` is the
 * server's answer for `indexes[i]` (the file's place in the selection). Only
 * new tracks change: one that matched a track already in the library is left
 * as it is. The cover goes on each album once: the uploader's own cover for a
 * personal upload, the album's cover for a shared one. Pass the same
 * `coveredAlbums` for every batch of one upload, so an album that spans
 * batches gets its cover once; a cover waits out the server's rate limit as
 * the batches do. Aborting `signal` (Cancel upload) stops the requests.
 */
export async function applyUploadEdits(
  results: UploadResult[],
  indexes: number[],
  edits: UploadEdits,
  scope: UploadScope,
  { signal, coveredAlbums = new Set<string>() }: { signal?: AbortSignal; coveredAlbums?: Set<string> } = {},
): Promise<UploadResult[]> {
  const out: UploadResult[] = [];
  for (let i = 0; i < results.length; i++) {
    const result = results[i];
    const patch = uploadPatch(edits, indexes[i]);
    if (!result.inserted || !result.track_id || (!patch && !edits.cover)) {
      out.push(result);
      continue;
    }
    const trackId = result.track_id;
    try {
      const track = patch
        ? await api.updateTrack(trackId, patch, { signal })
        : await api.getTrack(trackId, { signal });
      const cover = edits.cover;
      if (cover && !track.album_id) {
        // Cover art hangs on an album; the server refuses it for a loose track.
        out.push({ ...result, error: "Added, but the cover art wasn't saved: the track has no album. Set an album to add it." });
        continue;
      }
      if (cover && track.album_id && !coveredAlbums.has(track.album_id)) {
        const albumId = track.album_id;
        await waitOutRateLimit<unknown>(
          () =>
            scope === "global"
              ? api.setAlbumCover(albumId, cover, { signal })
              : api.setTrackCover(trackId, cover, { signal }),
          signal,
        );
        coveredAlbums.add(albumId);
      }
      out.push(result);
    } catch (err) {
      if (signal?.aborted) throw err;
      out.push({ ...result, error: `Added, but saving the details failed: ${errorMessage(err, "unknown error")}` });
    }
  }
  return out;
}
