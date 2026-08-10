import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  ActivityIndicator,
  Alert,
  Platform,
  RefreshControl,
  TextInput,
  StyleSheet,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  api,
  type Album,
  type Artist,
  type TrackListItem,
} from "@music-library/core";
import { EmptyState } from "../../../components/empty-state";
import { GlassSegmentedControl } from "../../../components/glass-segmented-control";
import { HeaderCapsule } from "../../../components/library/header-capsule";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../components/list-performance";
import { TrackRow } from "../../../components/track-row";
import { AlbumRow } from "../../../components/album-row";
import { ArtistRow } from "../../../components/artist-row";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { qk } from "../../../lib/query-keys";
import { QUERY_STALE_TIME } from "../../../lib/query-policy";
import { useIsOffline } from "../../../lib/offline-mode";
import { useDebouncedValue } from "../../../lib/use-debounced-value";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { usePullToRefresh } from "../../../lib/use-pull-to-refresh";
import { useTheme } from "../../../theme/theme";

type Mode = "tracks" | "albums" | "artists";
const PAGE_SIZE = 50;
const SEARCH_DEBOUNCE_MS = 250;

/**
 * One paged, searchable library list. The three tabs are byte-identical apart
 * from the query key and API page fetcher, so the paging recipe lives here
 * once.
 */
function useLibraryListQuery<T>({
  queryKey,
  enabled,
  search,
  fetchPage,
}: {
  queryKey: QueryKey;
  enabled: boolean;
  search: string;
  fetchPage: (args: {
    q: string;
    limit: number;
    offset: number;
    signal: AbortSignal;
  }) => Promise<{ items: T[]; total: number }>;
}) {
  return useInfiniteQuery({
    queryKey,
    enabled,
    staleTime: QUERY_STALE_TIME.libraryList,
    queryFn: ({ pageParam = 0, signal }) =>
      fetchPage({ q: search, limit: PAGE_SIZE, offset: pageParam, signal }),
    initialPageParam: 0,
    getNextPageParam: (last, pages) => {
      const loaded = pages.reduce((s, p) => s + p.items.length, 0);
      return loaded < last.total ? loaded : undefined;
    },
  });
}

export default function BrowseScreen() {
  const theme = useTheme();
  const router = useRouter();
  const params = useLocalSearchParams<{ mode?: string; focusSearch?: string }>();
  const headerHeight = useHeaderHeight();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const [mode, setMode] = useState<Mode>(
    params.mode === "albums" || params.mode === "artists"
      ? params.mode
      : "tracks",
  );
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(params.focusSearch === "1");
  const offline = useIsOffline();
  const searchInputRef = useRef<TextInput>(null);
  const debouncedSearch = useDebouncedValue(search.trim(), SEARCH_DEBOUNCE_MS);
  const deferredSearch = useDeferredValue(debouncedSearch);

  useEffect(() => {
    if (!searchOpen) return;
    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  const tracksQuery = useLibraryListQuery({
    queryKey: qk.tracksList(deferredSearch),
    enabled: mode === "tracks",
    search: deferredSearch,
    fetchPage: async (args) => {
      if (!args.q) return api.listTracksPage(args);

      // /api/tracks is the local-library browse endpoint. Text searches need
      // the unified endpoint so remote TIDAL matches are included as well.
      // Search returns up to PAGE_SIZE results per source and no total count,
      // so expose the combined result as a single page.
      const result = await api.searchTracks({
        ...args,
        sources: ["local", "tidal"],
      });
      return {
        items: result.tracks ?? [],
        total: result.tracks?.length ?? 0,
      };
    },
  });

  const albumsQuery = useLibraryListQuery({
    queryKey: qk.albumsList(deferredSearch),
    enabled: mode === "albums",
    search: deferredSearch,
    fetchPage: (args) => api.listAlbumsPage(args),
  });

  const artistsQuery = useLibraryListQuery({
    queryKey: qk.artistsList(deferredSearch),
    enabled: mode === "artists",
    search: deferredSearch,
    fetchPage: (args) => api.listArtistsPage(args),
  });

  const tracks = useMemo<TrackListItem[]>(
    () => tracksQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [tracksQuery.data],
  );
  const albums = useMemo<Album[]>(
    () => albumsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [albumsQuery.data],
  );
  const artists = useMemo<Artist[]>(
    () => artistsQuery.data?.pages.flatMap((p) => p.items) ?? [],
    [artistsQuery.data],
  );

  const activeQuery =
    mode === "tracks"
      ? tracksQuery
      : mode === "albums"
        ? albumsQuery
        : artistsQuery;
  const activeHasNextPage = activeQuery.hasNextPage;
  const activeIsFetchingNextPage = activeQuery.isFetchingNextPage;
  const activeFetchNextPage = activeQuery.fetchNextPage;
  const { refreshing, onRefresh } = usePullToRefresh(activeQuery.refetch);

  const onTrackPress = usePlayQueue(tracks);

  const onAlbumPress = useCallback(
    (album: Album) => router.push({ pathname: "/(tabs)/(library)/albums/[id]", params: { id: album.id } }),
    [router],
  );

  const onArtistPress = useCallback(
    (artist: Artist) =>
      router.push({ pathname: "/(tabs)/(library)/artists/[id]", params: { id: artist.id } }),
    [router],
  );

  const renderTrack = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );
  const renderAlbum = useCallback(
    ({ item }: ListRenderItemInfo<Album>) => (
      <AlbumRow album={item} onPress={onAlbumPress} />
    ),
    [onAlbumPress],
  );
  const renderArtist = useCallback(
    ({ item }: ListRenderItemInfo<Artist>) => (
      <ArtistRow artist={item} onPress={onArtistPress} />
    ),
    [onArtistPress],
  );

  const keyExtractor = useCallback(
    (item: TrackListItem | Album | Artist) => item.id,
    [],
  );

  const onEndReached = useCallback(() => {
    if (activeHasNextPage && !activeIsFetchingNextPage) {
      void activeFetchNextPage();
    }
  }, [activeFetchNextPage, activeHasNextPage, activeIsFetchingNextPage]);

  const closeSearch = useCallback(() => {
    searchInputRef.current?.blur();
    setSearch("");
    setSearchOpen(false);
  }, []);

  const onSearchPress = useCallback(() => {
    void Haptics.selectionAsync();
    if (searchOpen) {
      closeSearch();
      return;
    }
    // Searched lists are never persisted, so offline search could only hang
    // on paused queries — refuse up front instead.
    if (offline) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        "Search unavailable offline",
        "Reconnect to search your library.",
      );
      return;
    }
    setSearchOpen(true);
  }, [closeSearch, offline, searchOpen]);

  // Connectivity dropping mid-search would strand a spinner on paused
  // queries — close the search UI instead.
  useEffect(() => {
    if (offline && searchOpen) closeSearch();
  }, [offline, searchOpen, closeSearch]);

  const onUploadPress = useCallback(() => {
    void Haptics.selectionAsync();
    router.push("/(tabs)/(library)/upload");
  }, [router]);

  const header = useMemo(
    () => (
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.md,
        }}
      >
        <GlassSegmentedControl<Mode>
          options={[
            { label: "Tracks", value: "tracks" },
            { label: "Albums", value: "albums" },
            { label: "Artists", value: "artists" },
          ]}
          value={mode}
          onChange={setMode}
        />
      </View>
    ),
    [mode, theme.space.lg, theme.space.md, theme.space.sm],
  );

  const emptyOrFooter = useCallback(
    (q: typeof activeQuery, label: string) => ({
      ListEmptyComponent: q.isLoading ? (
        <EmptyState loading />
      ) : q.isError ? (
        <EmptyState message={`Couldn't load ${label}.`} />
      ) : (
        <EmptyState message={`No ${label}.`} />
      ),
      ListFooterComponent: q.isFetchingNextPage ? (
        <View style={styles.footer}>
          <ActivityIndicator color={theme.color.fgMuted} />
        </View>
      ) : null,
    }),
    [theme.color.fgMuted],
  );

  const commonProps = {
    ...TRACK_FLASH_LIST_PERFORMANCE_PROPS,
    ...dockScroll,
    ListHeaderComponent: header,
    keyExtractor,
    contentInsetAdjustmentBehavior: "automatic" as const,
    // FlashList v2 wraps its ScrollView in a recycler container. On iOS that
    // can leave the initial offset at zero after the native large-title inset
    // is applied, visually adding the header height twice. Seed the same
    // negative offset that a root FlatList receives automatically.
    contentOffset:
      Platform.OS === "ios" ? { x: 0, y: -headerHeight } : undefined,
    contentContainerStyle: { paddingBottom: dockInset + 24 },
    style: { backgroundColor: theme.color.bg },
    refreshControl: (
      <RefreshControl
        refreshing={refreshing}
        onRefresh={onRefresh}
        tintColor={theme.color.fgMuted}
      />
    ),
    onEndReached,
    onEndReachedThreshold: 0.6,
  };

  const stackBits = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <HeaderCapsule
            search={{
              open: searchOpen,
              value: search,
              inputRef: searchInputRef,
              onChangeText: setSearch,
              onClear: () => {
                if ((search?.length ?? 0) > 0) {
                  setSearch("");
                  return;
                }
                closeSearch();
              },
            }}
            onSearchPress={onSearchPress}
            onUploadPress={onUploadPress}
          />
        ),
      }}
    />
  );

  if (mode === "tracks") {
    const fx = emptyOrFooter(tracksQuery, "tracks");
    return (
      <>
        {stackBits}
        <FlashList
          {...commonProps}
          data={tracks}
          renderItem={renderTrack}
          {...fx}
        />
      </>
    );
  }
  if (mode === "albums") {
    const fx = emptyOrFooter(albumsQuery, "albums");
    return (
      <>
        {stackBits}
        <FlashList
          {...commonProps}
          data={albums}
          renderItem={renderAlbum}
          {...fx}
        />
      </>
    );
  }
  const fx = emptyOrFooter(artistsQuery, "artists");
  return (
    <>
      {stackBits}
      <FlashList
        {...commonProps}
        data={artists}
        renderItem={renderArtist}
        {...fx}
      />
    </>
  );
}

const styles = StyleSheet.create({
  footer: {
    paddingVertical: 24,
    alignItems: "center",
  },
});
