import { useQuery } from '@tanstack/react-query';
import { api, pluralize, useAuth } from '@music-library/core';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { TrackList } from '../components/track-list';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';

export function FavoritesScreen() {
  const { me } = useAuth();
  const favorites = useQuery({
    queryKey: qk.favorites(me?.id),
    queryFn: ({ signal }) => api.listFavorites({ signal }),
    staleTime: QUERY_STALE_TIME.default,
  });

  return (
    <Screen
      title="Favorites"
      subtitle={
        favorites.data ? pluralize(favorites.data.length, 'track') : undefined
      }>
      <TrackList
        tracks={favorites.data}
        loading={favorites.isLoading}
        topInset={HEADER_HEIGHT}
        emptyTitle="No favorites yet"
        emptyDetail="Tracks you favorite will collect here."
      />
    </Screen>
  );
}
