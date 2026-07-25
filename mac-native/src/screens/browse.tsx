import { useCallback, useEffect, useMemo, useState } from 'react';
import { FlatList, Pressable, StyleSheet, View } from 'react-native';
import { useInfiniteQuery, type QueryKey } from '@tanstack/react-query';
import {
  albumCoverUrl,
  api,
  pluralize,
  type Album,
  type Artist,
} from '@music-library/core';
import { HEADER_HEIGHT, Screen } from '../components/screen';
import { DOCK_CLEARANCE, TrackList } from '../components/track-list';
import { CoverArt } from '../components/cover-art';
import { AppText, EmptyState } from '../components/primitives';
import { SkeletonTileGrid, SkeletonTrackRows } from '../components/skeleton';
import { useHover } from '../components/hoverable';
import { Shell, onToolbarSearch, onToolbarSegment } from '../native/shell';
import { useNavigation } from '../navigation/navigation';
import { useDebouncedValue } from '../lib/use-debounced-value';
import { qk } from '../lib/query-keys';
import { QUERY_STALE_TIME } from '../lib/query-policy';
import { useTheme } from '../theme/theme';

type Mode = 'tracks' | 'albums' | 'artists';

const MODES: Mode[] = ['tracks', 'albums', 'artists'];
const MODE_LABELS = ['Tracks', 'Albums', 'Artists'];
const PAGE_SIZE = 100;
const ARTIST_ROW_HEIGHT = 44;

/**
 * One paged, searchable browse list. The three modes differ only in their key
 * and page fetcher, so the paging recipe lives here once — the same shape the
 * iOS client uses (`mobile/app/(tabs)/(library)/browse.tsx`).
 */
function useBrowsePages<T>({
  queryKey,
  search,
  fetchPage,
}: {
  queryKey: QueryKey;
  search: string;
  fetchPage: (args: {
    q?: string;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }) => Promise<{ items: T[]; total: number }>;
}) {
  const query = useInfiniteQuery({
    queryKey,
    staleTime: QUERY_STALE_TIME.libraryList,
    queryFn: ({ pageParam, signal }) =>
      fetchPage({
        q: search || undefined,
        limit: PAGE_SIZE,
        offset: pageParam,
        signal,
      }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((sum, page) => sum + page.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });

  const items = useMemo(
    () => query.data?.pages.flatMap(page => page.items) ?? [],
    [query.data],
  );

  // Guarded rather than passed straight through: both list surfaces can report
  // the end more than once before a page lands, and an unguarded call would
  // fetch the same offset repeatedly.
  const loadMore = useCallback(() => {
    if (query.hasNextPage && !query.isFetchingNextPage) void query.fetchNextPage();
  }, [query]);

  return { items, loadMore, isLoading: query.isLoading };
}

/**
 * The search field and mode picker live in the window's `NSToolbar`, not in
 * this view — that is where macOS puts them, and it is the only way to get the
 * system's capsule search field and segmented control.
 */
export function BrowseScreen({ focusNonce }: { focusNonce: number }) {
  const [mode, setMode] = useState<Mode>('tracks');
  const [search, setSearch] = useState('');
  const query = useDebouncedValue(search.trim(), 250);

  useEffect(() => {
    Shell.setToolbar({
      showsSearch: true,
      searchPlaceholder: 'Search Library',
      segments: MODE_LABELS,
      selectedSegment: MODES.indexOf(mode),
    });
  }, [mode]);

  useEffect(() => {
    const searchSub = onToolbarSearch(setSearch);
    const segmentSub = onToolbarSegment(index => {
      const next = MODES[index];
      if (next) setMode(next);
    });
    return () => {
      searchSub.remove();
      segmentSub.remove();
    };
  }, []);

  useEffect(() => {
    if (focusNonce > 0) Shell.focusSearch();
  }, [focusNonce]);

  return (
    <Screen title="Browse">
      {mode === 'tracks' ? (
        <TracksPane query={query} />
      ) : mode === 'albums' ? (
        <AlbumsPane query={query} />
      ) : (
        <ArtistsPane query={query} />
      )}
    </Screen>
  );
}

function TracksPane({ query }: { query: string }) {
  const { items, loadMore, isLoading } = useBrowsePages({
    queryKey: qk.tracksList(query || undefined),
    search: query,
    fetchPage: api.listTracksPage,
  });

  return (
    <TrackList
      tracks={items}
      loading={isLoading}
      topInset={HEADER_HEIGHT}
      onEndReached={loadMore}
      emptyTitle={query ? 'No matching tracks' : 'Library is empty'}
    />
  );
}

function AlbumsPane({ query }: { query: string }) {
  const t = useTheme();
  const { push } = useNavigation();
  const { items, loadMore, isLoading } = useBrowsePages<Album>({
    queryKey: qk.albumsList(query || undefined),
    search: query,
    fetchPage: api.listAlbumsPage,
  });

  if (isLoading && items.length === 0) {
    return <SkeletonTileGrid topInset={HEADER_HEIGHT} />;
  }
  if (items.length === 0) {
    return <EmptyState title={query ? 'No matching albums' : 'No albums'} />;
  }

  return (
    <FlatList
      key="albums"
      data={items}
      numColumns={5}
      keyExtractor={item => item.id}
      columnWrapperStyle={{ gap: t.space.lg }}
      contentContainerStyle={{
        paddingHorizontal: t.space.xl,
        paddingTop: HEADER_HEIGHT,
        paddingBottom: DOCK_CLEARANCE,
        gap: t.space.lg,
      }}
      onEndReached={loadMore}
      onEndReachedThreshold={0.6}
      renderItem={({ item }) => (
        <AlbumCard
          album={item}
          onPress={() => push({ screen: 'album', id: item.id, title: item.title })}
        />
      )}
    />
  );
}

function AlbumCard({ album, onPress }: { album: Album; onPress: () => void }) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.card,
        {
          borderRadius: t.radius.md,
          padding: t.space.sm,
          gap: t.space.sm,
          backgroundColor: hovered ? t.color.hover : 'transparent',
        },
      ]}
      {...hoverProps}>
      <CoverArt url={albumCoverUrl(album.id, 300)} size={140} radius={t.radius.sm} />
      <View style={styles.cardText}>
        <AppText variant="label" numberOfLines={1}>
          {album.title}
        </AppText>
        <AppText variant="caption" muted numberOfLines={1}>
          {album.artist_name ?? 'Unknown artist'}
        </AppText>
      </View>
    </Pressable>
  );
}

function ArtistsPane({ query }: { query: string }) {
  const t = useTheme();
  const { push } = useNavigation();
  const { items, loadMore, isLoading } = useBrowsePages<Artist>({
    queryKey: qk.artistsList(query || undefined),
    search: query,
    fetchPage: api.listArtistsPage,
  });

  if (isLoading && items.length === 0) {
    return <SkeletonTrackRows topInset={HEADER_HEIGHT} art={false} />;
  }
  if (items.length === 0) {
    return <EmptyState title={query ? 'No matching artists' : 'No artists'} />;
  }

  return (
    <FlatList
      key="artists"
      data={items}
      keyExtractor={item => item.id}
      contentContainerStyle={{
        paddingHorizontal: t.space.lg,
        paddingTop: HEADER_HEIGHT,
        paddingBottom: DOCK_CLEARANCE,
      }}
      onEndReached={loadMore}
      onEndReachedThreshold={0.6}
      renderItem={({ item }) => (
        <ArtistRow
          artist={item}
          onPress={() => push({ screen: 'artist', id: item.id, name: item.name })}
        />
      )}
      getItemLayout={(_data, index) => ({
        length: ARTIST_ROW_HEIGHT,
        offset: ARTIST_ROW_HEIGHT * index,
        index,
      })}
      initialNumToRender={20}
      maxToRenderPerBatch={16}
      windowSize={7}
    />
  );
}

function ArtistRow({ artist, onPress }: { artist: Artist; onPress: () => void }) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.artistRow,
        {
          height: ARTIST_ROW_HEIGHT,
          paddingHorizontal: t.space.md,
          borderRadius: t.radius.md,
          backgroundColor: hovered ? t.color.hover : 'transparent',
        },
      ]}
      {...hoverProps}>
      <AppText variant="label" numberOfLines={1} style={styles.grow}>
        {artist.name}
      </AppText>
      <AppText variant="caption" muted>
        {pluralize(artist.track_count, 'track')}
      </AppText>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  card: { flex: 1, maxWidth: 172 },
  cardText: { gap: 2 },
  artistRow: { flexDirection: 'row', alignItems: 'center' },
  grow: { flex: 1 },
});
