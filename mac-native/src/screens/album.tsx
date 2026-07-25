import { useQuery } from '@tanstack/react-query';
import {
  albumCoverUrl,
  api,
  formatTotalMs,
  pluralize,
  useAuth,
} from '@music-library/core';
import { StyleSheet, View } from 'react-native';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { TrackList } from '../components/track-list';
import { CoverArt } from '../components/cover-art';
import { AppText, Button } from '../components/primitives';
import { usePlayTrack } from '../context/player';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';
import { useTheme } from '../theme/theme';

export function AlbumScreen({ id, title }: { id: string; title?: string }) {
  const t = useTheme();
  const { me } = useAuth();
  const playTrack = usePlayTrack();

  const album = useQuery({
    queryKey: qk.album(me?.id, id),
    queryFn: ({ signal }) => api.getAlbum(id, { signal }),
    staleTime: QUERY_STALE_TIME.libraryList,
  });
  const tracks = useQuery({
    queryKey: qk.albumTracks(me?.id, id),
    queryFn: ({ signal }) => api.listAlbumTracks(id, { signal }),
    staleTime: QUERY_STALE_TIME.libraryList,
  });

  const data = album.data;
  const list = tracks.data;

  const header = (
    <View
      style={[
        styles.hero,
        { gap: t.space.lg, paddingBottom: t.space.lg, paddingTop: HEADER_HEIGHT },
      ]}>
      <CoverArt url={albumCoverUrl(id, 512)} size={160} radius={t.radius.md} />
      <View style={[styles.heroText, { gap: t.space.xs }]}>
        <AppText variant="heading" numberOfLines={2}>
          {data?.title ?? title ?? 'Album'}
        </AppText>
        <AppText muted numberOfLines={1}>
          {data?.artist_name ?? 'Unknown artist'}
        </AppText>
        <AppText variant="caption" muted>
          {[
            data?.release_year ? String(data.release_year) : null,
            data ? pluralize(data.track_count, 'track') : null,
            data && data.duration_ms > 0 ? formatTotalMs(data.duration_ms) : null,
          ]
            .filter(Boolean)
            .join(' · ')}
        </AppText>
        <View style={[styles.actions, { gap: t.space.sm, paddingTop: t.space.sm }]}>
          <Button
            title="Play"
            variant="primary"
            disabled={!list || list.length === 0}
            onPress={() => list && list.length > 0 && playTrack(list[0], list)}
          />
        </View>
      </View>
    </View>
  );

  return (
    <Screen title={data?.title ?? title ?? 'Album'}>
      {/* Above the list, not inside it: the native table owns its scroll view
          and cannot host a React Native header. */}
      {header}
      <TrackList tracks={list} loading={tracks.isLoading} emptyTitle="No tracks" />
    </Screen>
  );
}

const styles = StyleSheet.create({
  hero: { flexDirection: 'row', paddingHorizontal: 12 },
  heroText: { flex: 1, justifyContent: 'flex-end' },
  actions: { flexDirection: 'row' },
});
