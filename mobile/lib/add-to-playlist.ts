import type { QueryClient } from "@tanstack/react-query";
import { api, errorMessage, type Playlist } from "@music-library/core";
import type { AddConfirmationResult } from "../components/add-confirmation/store";
import { qk } from "./query-keys";
import { rememberRecentPlaylist } from "./recent-playlists";

export type AddTarget =
  | { kind: "existing"; playlist: Playlist }
  | { kind: "new"; name: string };

/**
 * Adds a track to a playlist, making the playlist first for a new name, and
 * refreshes what that changes. It never rejects: a failure comes back as the
 * alert to show. It outlives the picker, which closes as soon as it starts.
 */
export async function addTrackToPlaylist({
  queryClient,
  userId,
  trackId,
  target,
}: {
  queryClient: QueryClient;
  userId: string;
  trackId: string;
  target: AddTarget;
}): Promise<AddConfirmationResult> {
  let playlistId: string;
  if (target.kind === "new") {
    try {
      playlistId = (await api.createPlaylist({ name: target.name })).id;
    } catch (error) {
      return {
        ok: false,
        title: "Couldn't create playlist",
        message: errorMessage(error, "Please try again."),
      };
    }
  } else {
    playlistId = target.playlist.id;
  }

  try {
    await api.addPlaylistTracks(playlistId, [trackId]);
  } catch (error) {
    // A playlist made just now exists even though the add failed.
    if (target.kind === "new") {
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
    }
    return {
      ok: false,
      title: "Couldn't add track",
      message: errorMessage(error, "Please try again."),
    };
  }

  void rememberRecentPlaylist(userId, playlistId);
  // Reopened for this track, the picker marks the playlist at once. Only
  // where the server reports the field: an older one never would.
  queryClient.setQueryData<Playlist[]>(
    qk.playlistsWithTrack(userId, trackId),
    (playlists) =>
      playlists?.map((playlist) =>
        playlist.id === playlistId && playlist.contains_track === false
          ? { ...playlist, contains_track: true }
          : playlist,
      ),
  );
  void queryClient.invalidateQueries({
    queryKey: qk.playlistTracks(userId, playlistId),
  });
  // updated_at moved, which orders the lists, and a new or empty playlist
  // takes its art from this track. This also refreshes the picker's lists.
  void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
  return { ok: true };
}
