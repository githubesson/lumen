import { useQuery } from '@tanstack/react-query';
import { api, pluralize, useAuth } from '@music-library/core';
import { StyleSheet, View } from 'react-native';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { TrackList } from '../components/track-list';
import { Button } from '../components/primitives';
import { usePlayTrack } from '../context/player';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';
import { useTheme } from '../theme/theme';

export function ArtistScreen({ id, name }: { id: string; name?: string }) {
  const t = useTheme();
  const { me } = useAuth();
  const playTrack = usePlayTrack();

  const artist = useQuery({
    queryKey: qk.artist(me?.id, id),
    queryFn: ({ signal }) => api.getArtist(id, { signal }),
    staleTime: QUERY_STALE_TIME.libraryList,
  });
  const tracks = useQuery({
    queryKey: qk.artistTracks(me?.id, id),
    queryFn: ({ signal }) => api.listArtistTracks(id, { signal }),
    staleTime: QUERY_STALE_TIME.libraryList,
  });

  const list = tracks.data;

  const header = (
    <View
      style={[
        styles.actions,
        { gap: t.space.sm, paddingBottom: t.space.md, paddingTop: HEADER_HEIGHT },
      ]}>
      <Button
        title="Play"
        variant="primary"
        disabled={!list || list.length === 0}
        onPress={() => list && list.length > 0 && playTrack(list[0], list)}
      />
    </View>
  );

  return (
    <Screen
      title={artist.data?.name ?? name ?? 'Artist'}
      subtitle={
        artist.data
          ? [
              pluralize(artist.data.track_count, 'track'),
              pluralize(artist.data.album_count, 'album'),
            ].join(' · ')
          : undefined
      }>
      {header}
      <TrackList tracks={list} loading={tracks.isLoading} emptyTitle="No tracks" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  actions: { flexDirection: 'row', paddingHorizontal: 12 },
});
