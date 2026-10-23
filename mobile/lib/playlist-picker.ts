import { canAddToPlaylist, type Playlist } from "@music-library/core";

/** How many recently used playlists move to the top of the picker. */
export const RECENT_PLAYLISTS_SHOWN = 3;

export type PlaylistPickerRow =
  | { type: "new"; id: "new"; name: string }
  | { type: "playlist"; id: string; playlist: Playlist };

/**
 * The add-to-playlist picker's one list: the playlists the user can add to,
 * the few they added to last first, then the rest by when they last changed,
 * each once. A search narrows it in that order, and offers to make a playlist
 * of that name first unless one already has it.
 */
export function playlistPickerRows(
  playlists: readonly Playlist[],
  recentIds: readonly string[],
  search: string,
): PlaylistPickerRow[] {
  const editable = playlists.filter(canAddToPlaylist);
  const byId = new Map(editable.map((playlist) => [playlist.id, playlist]));
  const recent = [...new Set(recentIds)]
    .map((id) => byId.get(id))
    .filter((playlist): playlist is Playlist => playlist !== undefined)
    .slice(0, RECENT_PLAYLISTS_SHOWN);
  const recentSet = new Set(recent);
  const ordered = [
    ...recent,
    ...editable
      .filter((playlist) => !recentSet.has(playlist))
      .sort((a, b) => dateValue(b.updated_at) - dateValue(a.updated_at)),
  ];

  const name = search.trim();
  const query = name.toLocaleLowerCase();
  const matches = query
    ? ordered.filter((playlist) =>
        playlist.name.toLocaleLowerCase().includes(query),
      )
    : ordered;
  const rows: PlaylistPickerRow[] = matches.map((playlist) => ({
    type: "playlist",
    id: playlist.id,
    playlist,
  }));
  const taken = matches.some(
    (playlist) => playlist.name.trim().toLocaleLowerCase() === query,
  );
  return query && !taken ? [{ type: "new", id: "new", name }, ...rows] : rows;
}

function dateValue(value?: string) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}
