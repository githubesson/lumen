import { useCallback } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  api,
  downloadStreamUrl,
  errorMessage,
  libraryChanged,
  useAuth,
  useFavorite,
  useFavoriteActions,
  type TrackDetail,
  type TrackListItem,
} from '@music-library/core';
import { showContextMenu, type ContextMenuItem } from '../native/context-menu';
import { Shell } from '../native/shell';
import { useNavigation } from '../navigation/navigation';
import { usePlayTrack } from '../context/player';
import { downloadFilename, extensionForFormat } from '../lib/track-download';
import { invalidateLibrary, qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';

const ADD_TO_PREFIX = 'addTo:';

/**
 * Builds the right-click menu for a track row and performs the chosen action.
 * Every row shares this so the menu stays identical wherever tracks are
 * listed.
 *
 * Mirrors the iOS client's long-press menu
 * (`mobile/components/track-actions-menu.tsx`) — same grouping, labels and
 * symbols — minus the entries whose destination screens don't exist here yet
 * (Track Info, Share, the admin metadata editors). "Add to Playlist" is a
 * submenu rather than a picker screen, which is the macOS idiom for the same
 * action.
 */
export function useTrackContextMenu(queue: TrackListItem[] | undefined) {
  const { me } = useAuth();
  const { push } = useNavigation();
  const playTrack = usePlayTrack();
  const queryClient = useQueryClient();
  const { toggle, refresh: refreshFavorites } = useFavoriteActions();

  // The playlist list is already cached for the sidebar, so opening a menu
  // costs nothing.
  const playlists = useQuery({
    queryKey: qk.playlists(me?.id),
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    staleTime: QUERY_STALE_TIME.default,
    enabled: Boolean(me),
  });

  return useCallback(
    async (track: TrackListItem, position: { x: number; y: number }, isFavorite: boolean) => {
      const writable = (playlists.data ?? []).filter(
        p => !p.is_smart && p.effective_role !== 'viewer',
      );
      const hasAlbum = Boolean(track.album_id || track.album_title);

      const items: ContextMenuItem[] = [
        { id: 'play', title: 'Play', symbol: 'play.fill' },
        {
          id: 'favorite',
          title: isFavorite ? 'Remove from Favorites' : 'Add to Favorites',
          symbol: isFavorite ? 'heart.slash' : 'heart',
        },
        { separator: true },
        { header: true, title: 'Actions' },
        {
          id: 'addTo',
          title: 'Add to Playlist…',
          symbol: 'plus.rectangle.on.folder',
          disabled: writable.length === 0,
          children: writable.map(p => ({
            id: `${ADD_TO_PREFIX}${p.id}`,
            title: p.name,
          })),
        },
        { id: 'download', title: 'Download File…', symbol: 'arrow.down.doc' },
      ];

      if (hasAlbum) {
        items.push({ separator: true });
        items.push({ header: true, title: 'Library' });
        items.push({ id: 'album', title: 'View Album', symbol: 'square.stack' });
      }

      if (track.owned) {
        items.push({ separator: true });
        items.push({
          id: 'delete',
          title: 'Delete from My Library',
          symbol: 'trash',
          destructive: true,
        });
      }

      const choice = await showContextMenu(items, position);
      if (!choice) return;

      if (choice === 'play') {
        playTrack(track, queue ?? [track]);
        return;
      }

      if (choice === 'favorite') {
        await toggle(track.id);
        // Two things render favorites: core's in-memory set (the heart on every
        // row) and the Favorites list query. Reconcile both from the server so
        // they cannot disagree for the rest of the session.
        void refreshFavorites();
        void queryClient.invalidateQueries({ queryKey: qk.favorites(me?.id) });
        return;
      }

      if (choice === 'album') {
        // Rows from search results can be missing the album id; one detail
        // fetch fills it in, the same way the iOS client resolves it.
        let albumId = track.album_id;
        if (!albumId) {
          try {
            albumId = (await api.getTrack(track.id)).album_id;
          } catch {
            // Fall through to the alert below.
          }
        }
        if (albumId) {
          push({ screen: 'album', id: albumId, title: track.album_title });
        } else {
          void Shell.alertDialog({
            title: 'Album unavailable',
            message: 'No album was found for this track.',
          });
        }
        return;
      }

      if (choice === 'download') {
        try {
          let detail: TrackDetail | null = null;
          try {
            detail = await api.getTrack(track.id);
          } catch {
            // The stream can still be downloaded; metadata only improves the
            // filename.
          }
          const ext = extensionForFormat(detail?.format);
          const saved = await Shell.saveDownload(
            downloadStreamUrl(track.id),
            downloadFilename(track, detail, ext),
          );
          void saved; // null means the save panel was cancelled — stay quiet.
        } catch (error) {
          void Shell.alertDialog({
            title: 'Download failed',
            message: errorMessage(error, 'Please try again.'),
          });
        }
        return;
      }

      if (choice === 'delete') {
        const confirmed = await Shell.confirmDialog({
          title: 'Delete Track',
          message: `Delete "${track.title}" from your library? This permanently removes the file you uploaded.`,
          confirmTitle: 'Delete',
          destructive: true,
        });
        if (!confirmed) return;
        try {
          await api.deleteTrack(track.id);
          libraryChanged.emit();
          invalidateLibrary(queryClient);
        } catch (error) {
          void Shell.alertDialog({
            title: 'Delete failed',
            message: errorMessage(error, 'Please try again.'),
          });
        }
        return;
      }

      if (choice.startsWith(ADD_TO_PREFIX)) {
        const playlistId = choice.slice(ADD_TO_PREFIX.length);
        await api.addPlaylistTracks(playlistId, [track.id]);
        void queryClient.invalidateQueries({
          queryKey: qk.playlistTracks(me?.id, playlistId),
        });
      }
    },
    [
      playlists.data,
      playTrack,
      queue,
      toggle,
      refreshFavorites,
      queryClient,
      me?.id,
      push,
    ],
  );
}

/** Favorite state for a single track, from core's optimistic favorites store. */
export function useIsFavorite(trackId: string): boolean {
  return useFavorite(trackId);
}
