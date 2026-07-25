import { useEffect, useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, useAuth, type Playlist } from '@music-library/core';
import { Shell, onSidebarSelect, type ShellSidebarSection } from '../native/shell';
import { useNavigation } from '../navigation/navigation';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';

const PLAYLIST_PREFIX = 'playlist:';

/**
 * Feeds the native sidebar and routes its selections.
 *
 * The sidebar itself is an `NSOutlineView` owned by the window (see
 * `LMShellModule`), not a React view — so this hook is the whole of the JS
 * side: publish the rows, and translate clicks into navigation.
 */
export function useNativeSidebar() {
  const { me } = useAuth();
  const { section, route, selectSection, push } = useNavigation();

  const playlists = useQuery({
    queryKey: qk.playlists(me?.id),
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    staleTime: QUERY_STALE_TIME.default,
    enabled: Boolean(me),
  });

  const sections = useMemo<ShellSidebarSection[]>(
    () => [
      {
        items: [
          { id: 'home', label: 'Home', symbol: 'house' },
          { id: 'browse', label: 'Browse', symbol: 'magnifyingglass' },
          { id: 'favorites', label: 'Favorites', symbol: 'heart' },
        ],
      },
      {
        title: 'Playlists',
        items: [
          { id: 'playlists', label: 'All Playlists', symbol: 'music.note.list' },
          ...(playlists.data ?? []).map((playlist: Playlist) => ({
            id: `${PLAYLIST_PREFIX}${playlist.id}`,
            label: playlist.name,
            symbol:
              playlist.visibility === 'collaborative'
                ? 'person.2'
                : 'music.note.list',
          })),
        ],
      },
    ],
    [playlists.data],
  );

  const selectedId =
    route.screen === 'playlist' ? `${PLAYLIST_PREFIX}${route.id}` : section;

  useEffect(() => {
    Shell.setSidebar(sections, selectedId);
  }, [sections, selectedId]);

  useEffect(() => {
    const subscription = onSidebarSelect(id => {
      if (id.startsWith(PLAYLIST_PREFIX)) {
        const playlistId = id.slice(PLAYLIST_PREFIX.length);
        const playlist = (playlists.data ?? []).find(p => p.id === playlistId);
        selectSection('playlists');
        push({ screen: 'playlist', id: playlistId, name: playlist?.name });
        return;
      }
      if (
        id === 'home' ||
        id === 'browse' ||
        id === 'favorites' ||
        id === 'playlists' ||
        id === 'settings'
      ) {
        selectSection(id);
      }
    });
    return () => subscription.remove();
  }, [selectSection, push, playlists.data]);
}
