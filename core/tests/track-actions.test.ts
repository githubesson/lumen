import { describe, expect, it } from "vitest";
import type { TrackListItem } from "../src/api";
import {
  ALBUM_DOWNLOAD_REFRESH_MS,
  albumDownloadState,
  deleteOwnUploadMessage,
  downloadableAlbumTracks,
  trackActions,
} from "../src/track";

function track(overrides: Partial<TrackListItem> = {}): TrackListItem {
  return { id: "t", title: "Song", duration_ms: 1000, source: "local", ...overrides };
}

describe("trackActions", () => {
  it("offers a listener the shared actions on a library track", () => {
    expect(trackActions(track({ album_id: "a" }), { isAdmin: false })).toEqual({
      play: true,
      download: true,
      viewAlbum: true,
      share: true,
      editMetadata: false,
      editAlbum: false,
      moveToAlbum: false,
      deleteOwnUpload: false,
      adminRemove: false,
    });
  });

  it("lets an admin edit, move and remove a library track", () => {
    expect(trackActions(track({ album_id: "a" }), { isAdmin: true })).toMatchObject({
      editMetadata: true,
      editAlbum: true,
      moveToAlbum: true,
      adminRemove: true,
      deleteOwnUpload: false,
    });
    // Rows without a source are library rows.
    expect(trackActions(track({ source: undefined }), { isAdmin: true }).editMetadata).toBe(true);
  });

  it("never offers an admin edits of a TIDAL track, which the server rejects", () => {
    const actions = trackActions(
      track({ source: "tidal", album_id: "hidden", source_album_id: "1" }),
      { isAdmin: true },
    );
    expect(actions).toMatchObject({
      editMetadata: false,
      editAlbum: false,
      moveToAlbum: false,
      adminRemove: false,
      deleteOwnUpload: false,
      share: true,
      viewAlbum: true,
    });
  });

  it("only edits an album the track has", () => {
    expect(trackActions(track({ album_title: "Loose" }), { isAdmin: true })).toMatchObject({
      editAlbum: false,
      viewAlbum: true,
    });
    expect(trackActions(track(), { isAdmin: true }).viewAlbum).toBe(false);
  });

  it("deletes the viewer's own upload instead of removing it for everyone", () => {
    expect(trackActions(track({ owned: true }), { isAdmin: true })).toMatchObject({
      deleteOwnUpload: true,
      adminRemove: false,
    });
    expect(trackActions(track({ owned: true }), { isAdmin: false }).deleteOwnUpload).toBe(true);
  });

  it("can't play or download a track TIDAL dropped", () => {
    expect(
      trackActions(track({ source: "tidal", unavailable: true }), { isAdmin: false }),
    ).toMatchObject({ play: false, download: false, viewAlbum: true });
  });
});

describe("deleteOwnUploadMessage", () => {
  it("names the track and says the file goes", () => {
    expect(deleteOwnUploadMessage({ title: "Song" })).toBe(
      'Delete "Song" from your library? This permanently removes the file you uploaded.',
    );
  });
});

describe("albumDownloadState", () => {
  const tidal = (id: string, extra: Partial<TrackListItem> = {}) =>
    track({ id, source: "tidal", ...extra });

  it("shows progress while tracks are queued", () => {
    expect(albumDownloadState([tidal("1")], 3)).toEqual({
      kind: "queued",
      queued: 3,
      label: "Downloading · 3 left",
    });
  });

  it("offers the whole album when nothing is saved", () => {
    expect(albumDownloadState([tidal("1"), tidal("2")], 0)).toEqual({
      kind: "available",
      remaining: 2,
      anySaved: false,
      label: "Download album",
    });
  });

  it("offers the rest when some tracks are saved, skipping dropped ones", () => {
    const tracks = [track({ id: "1" }), tidal("2"), tidal("3", { unavailable: true })];
    expect(downloadableAlbumTracks(tracks).map((t) => t.id)).toEqual(["2"]);
    expect(albumDownloadState(tracks, 0)).toEqual({
      kind: "available",
      remaining: 1,
      anySaved: true,
      label: "Download 1 remaining",
    });
  });

  it("offers nothing once every track is saved or gone", () => {
    expect(albumDownloadState([track({ id: "1" }), tidal("2", { unavailable: true })], 0)).toEqual({
      kind: "none",
    });
    expect(albumDownloadState([], 0)).toEqual({ kind: "none" });
  });

  it("refreshes every 15 seconds", () => {
    expect(ALBUM_DOWNLOAD_REFRESH_MS).toBe(15_000);
  });
});
