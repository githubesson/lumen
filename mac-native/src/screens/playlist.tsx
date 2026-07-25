import { useCallback, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { useQuery } from '@tanstack/react-query';
import {
  api,
  formatTotalMs,
  pluralize,
  trackCoverUrl,
  useAuth,
  type PlaylistTrackEntry,
  type TrackListItem,
} from '@music-library/core';
import { Screen, TOOLBAR_INSET } from '../components/screen';
import { TrackList } from '../components/track-list';
import { CoverArt } from '../components/cover-art';
import { AppText, Button } from '../components/primitives';
import { usePlayTrack } from '../context/player';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';
import { useTheme } from '../theme/theme';

const COVER_SIZE = 220;

/**
 * Starting guess for the hero's height, corrected by its first `onLayout`.
 * Close enough that the list doesn't visibly jump when the real number lands.
 */
const HERO_HEIGHT_ESTIMATE = COVER_SIZE + 12 + 24;

/**
 * Playlist entries carry their track id as `track_id`; every list component
 * here speaks `TrackListItem`, which keys off `id`.
 */
function toTrackListItem(entry: PlaylistTrackEntry): TrackListItem {
  return { ...entry, id: entry.track_id };
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

/**
 * A playlist has no artwork of its own, so it borrows from its contents: a
 * 2×2 collage when four distinct covers exist, the first track's cover when
 * fewer do, and the standard placeholder tile when the list is empty.
 */
function PlaylistCover({
  tracks,
  size,
}: {
  tracks: TrackListItem[];
  size: number;
}) {
  const t = useTheme();

  const urls = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const track of tracks) {
      const key = track.album_id ?? track.cover_url ?? track.id;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(trackCoverUrl(track, 256));
      if (out.length === 4) break;
    }
    return out;
  }, [tracks]);

  if (urls.length < 4) {
    return <CoverArt url={urls[0]} size={size} radius={t.radius.md} />;
  }

  const half = size / 2;
  return (
    <View
      style={[
        styles.collage,
        { width: size, height: size, borderRadius: t.radius.md },
      ]}>
      {urls.map(url => (
        <CoverArt key={url} url={url} size={half} radius={0} />
      ))}
    </View>
  );
}

export function PlaylistScreen({ id, name }: { id: string; name?: string }) {
  const t = useTheme();
  const { me } = useAuth();
  const playTrack = usePlayTrack();

  const playlist = useQuery({
    queryKey: qk.playlist(me?.id, id),
    queryFn: ({ signal }) => api.getPlaylist(id, { signal }),
    staleTime: QUERY_STALE_TIME.default,
  });
  const tracks = useQuery({
    queryKey: qk.playlistTracks(me?.id, id),
    queryFn: ({ signal }) => api.listPlaylistTracks(id, { signal }),
    staleTime: QUERY_STALE_TIME.default,
  });

  const list = useMemo(
    () => tracks.data?.tracks.map(toTrackListItem),
    [tracks.data],
  );

  const meta = useMemo(() => {
    if (!list || list.length === 0) return undefined;
    const totalMs = list.reduce((sum, track) => sum + (track.duration_ms ?? 0), 0);
    return [pluralize(list.length, 'song'), formatTotalMs(totalMs)].join(', ');
  }, [list]);

  const playAll = useCallback(() => {
    if (list && list.length > 0) playTrack(list[0], list);
  }, [list, playTrack]);

  const playShuffled = useCallback(() => {
    if (!list || list.length === 0) return;
    const queue = shuffled(list);
    playTrack(queue[0], queue);
  }, [list, playTrack]);

  const empty = !list || list.length === 0;
  const description = playlist.data?.description;

  // The hero scrolls away with the rows, so its height has to be reserved as
  // scroll inset — measured from the real layout, since the name and
  // description can wrap.
  const [heroHeight, setHeroHeight] = useState(HERO_HEIGHT_ESTIMATE);

  const hero = (
    <View
      onLayout={e => setHeroHeight(Math.round(e.nativeEvent.layout.height))}
      style={[
        styles.hero,
        {
          paddingHorizontal: t.space.xl,
          paddingTop: t.space.md,
          paddingBottom: t.space.xl,
          gap: t.space.xl,
        },
      ]}>
      <PlaylistCover tracks={list ?? []} size={COVER_SIZE} />
      <View style={styles.heroInfo}>
        <View style={{ gap: t.space.xs }}>
          <AppText numberOfLines={2} style={styles.name}>
            {playlist.data?.name ?? name ?? 'Playlist'}
          </AppText>
          {description ? (
            <AppText muted numberOfLines={2}>
              {description}
            </AppText>
          ) : null}
          {meta ? (
            <AppText variant="caption" muted>
              {meta}
            </AppText>
          ) : null}
        </View>
        <View style={[styles.actions, { gap: t.space.sm }]}>
          <Button
            title="Play"
            symbol="play.fill"
            variant="primary"
            disabled={empty}
            onPress={playAll}
          />
          <Button
            title="Shuffle"
            symbol="shuffle"
            disabled={empty}
            onPress={playShuffled}
          />
        </View>
      </View>
    </View>
  );

  return (
    <Screen>
      {empty ? (
        // No rows to scroll, so the hero just sits above the empty state.
        <View style={[styles.fill, { paddingTop: TOOLBAR_INSET }]}>
          {hero}
          <TrackList
            tracks={list}
            loading={tracks.isLoading}
            emptyTitle="This playlist is empty"
          />
        </View>
      ) : (
        <TrackList
          tracks={list}
          loading={tracks.isLoading}
          topInset={TOOLBAR_INSET + heroHeight}
          header={hero}
          emptyTitle="This playlist is empty"
        />
      )}
    </Screen>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
  hero: { flexDirection: 'row' },
  heroInfo: {
    flex: 1,
    minWidth: 0,
    justifyContent: 'space-between',
    paddingVertical: 6,
  },
  name: { fontSize: 26, lineHeight: 32, fontWeight: '700', letterSpacing: -0.3 },
  actions: { flexDirection: 'row' },
  collage: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    overflow: 'hidden',
  },
});
