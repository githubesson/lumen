import {
  useCallback,
  useDeferredValue,
  useEffect,
  useMemo,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  TextInput,
  StyleSheet,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useInfiniteQuery, type QueryKey } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import {
  api,
  type Album,
  type Artist,
  type TrackListItem,
} from "@music-library/core";
import { AdaptiveGlass } from "../../../components/adaptive-glass";
import { EmptyState } from "../../../components/empty-state";
import { GlassSegmentedControl } from "../../../components/glass-segmented-control";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../components/list-performance";
import { TrackRow } from "../../../components/track-row";
import { AlbumRow } from "../../../components/album-row";
import { ArtistRow } from "../../../components/artist-row";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { qk } from "../../../lib/query-keys";
import { useDebouncedValue } from "../../../lib/use-debounced-value";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

type Mode = "tracks" | "albums" | "artists";
const PAGE_SIZE = 50;
const HEADER_CAPSULE_HEIGHT = 44;
const HEADER_CAPSULE_CLOSED_WIDTH = 118;
const HEADER_CAPSULE_OPEN_WIDTH = 246;
const HEADER_ACTION_WIDTH = 54;
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
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const [mode, setMode] = useState<Mode>(
    params.mode === "albums" || params.mode === "artists"
      ? params.mode
      : "tracks",
  );
  const [search, setSearch] = useState("");
  const [searchOpen, setSearchOpen] = useState(params.focusSearch === "1");
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
    fetchPage: (args) => api.listTracksPage(args),
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
    setSearchOpen(true);
  }, [closeSearch, searchOpen]);

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
      refreshControl: (
        <RefreshControl
          refreshing={q.isRefetching && !q.isFetchingNextPage}
          onRefresh={() => void q.refetch()}
          tintColor={theme.color.fgMuted}
        />
      ),
    }),
    [theme.color.fgMuted],
  );

  const commonProps = {
    ...TRACK_FLASH_LIST_PERFORMANCE_PROPS,
    ...dockScroll,
    ListHeaderComponent: header,
    keyExtractor,
    contentInsetAdjustmentBehavior: "automatic" as const,
    contentContainerStyle: { paddingBottom: dockInset + 24 },
    style: { backgroundColor: theme.color.bg },
    onEndReached,
    onEndReachedThreshold: 0.6,
  };

  const stackBits = (
    <Stack.Screen
      options={{
        headerRight: () => (
          <BrowseHeaderCapsule
            inputRef={searchInputRef}
            search={search}
            searchOpen={searchOpen}
            onSearchPress={onSearchPress}
            onSearchChangeText={setSearch}
            onSearchClear={() => {
              if ((search?.length ?? 0) > 0) {
                setSearch("");
                return;
              }
              closeSearch();
            }}
            onUploadPress={onUploadPress}
            theme={theme}
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
  headerCapsuleWrap: {
    height: HEADER_CAPSULE_HEIGHT,
    overflow: "hidden",
    transform: [{ translateX: 8 }],
  },
  headerCapsule: {
    height: HEADER_CAPSULE_HEIGHT,
    borderRadius: HEADER_CAPSULE_HEIGHT / 2,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  headerCapsuleRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  headerCapsuleButton: {
    width: HEADER_ACTION_WIDTH,
    height: HEADER_CAPSULE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  headerSearchSlot: {
    flex: 1,
    height: HEADER_CAPSULE_HEIGHT,
    position: "relative",
  },
  headerSearchClosed: {
    ...StyleSheet.absoluteFillObject,
  },
  headerSearchClosedButton: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  headerSearchOpen: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
    paddingLeft: 14,
    paddingRight: 8,
  },
  headerSearchOpenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  headerSearchInputWrap: {
    flex: 1,
  },
  headerSearchInput: {
    fontSize: 15,
    paddingVertical: 0,
  },
  headerSearchClearButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  headerCapsuleDivider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
    opacity: 0.7,
    transform: [{ translateX: -4 }],
  },
});

function BrowseHeaderCapsule({
  inputRef,
  search = "",
  searchOpen,
  onSearchPress,
  onSearchChangeText,
  onSearchClear,
  onUploadPress,
  theme,
}: {
  inputRef: RefObject<TextInput | null>;
  search: string;
  searchOpen: boolean;
  onSearchPress: () => void;
  onSearchChangeText: (value: string) => void;
  onSearchClear: () => void;
  onUploadPress: () => void;
  theme: ThemeTokens;
}) {
  const progress = useSharedValue(searchOpen ? 1 : 0);

  useEffect(() => {
    progress.value = withTiming(searchOpen ? 1 : 0, {
      duration: 140,
    });
  }, [progress, searchOpen]);

  const query = search ?? "";
  const dividerColor =
    theme.scheme === "dark"
      ? "rgba(255,255,255,0.16)"
      : "rgba(0,0,0,0.14)";
  const shellStyle = useAnimatedStyle(() => ({
    width: interpolate(
      progress.value,
      [0, 1],
      [HEADER_CAPSULE_CLOSED_WIDTH, HEADER_CAPSULE_OPEN_WIDTH],
      Extrapolation.CLAMP,
    ),
  }));
  const closedSearchStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [1, 0], Extrapolation.CLAMP),
    transform: [
      {
        scale: interpolate(progress.value, [0, 1], [1, 0.92], Extrapolation.CLAMP),
      },
    ],
  }));
  const openSearchStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
    transform: [
      {
        translateX: interpolate(progress.value, [0, 1], [10, 0], Extrapolation.CLAMP),
      },
    ],
  }));
  const dividerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0.7, 0.38], Extrapolation.CLAMP),
  }));
  const clearIcon: SymbolViewProps["name"] =
    query.length > 0 ? "xmark.circle.fill" : "xmark";

  return (
    <Animated.View style={[styles.headerCapsuleWrap, shellStyle]}>
      <AdaptiveGlass style={styles.headerCapsule}>
        <View style={styles.headerCapsuleRow}>
          <View style={styles.headerSearchSlot}>
            <Animated.View
              pointerEvents={searchOpen ? "none" : "auto"}
              style={[styles.headerSearchClosed, closedSearchStyle]}
            >
              <Pressable
                onPress={onSearchPress}
                accessibilityRole="button"
                accessibilityLabel="Open search"
                style={({ pressed }) => [
                  styles.headerSearchClosedButton,
                  pressed ? { opacity: 0.6 } : null,
                ]}
              >
                <SymbolView
                  name="magnifyingglass"
                  size={21}
                  weight="semibold"
                  tintColor={theme.color.fg}
                />
              </Pressable>
            </Animated.View>
            <Animated.View
              pointerEvents={searchOpen ? "auto" : "none"}
              style={[styles.headerSearchOpen, openSearchStyle]}
            >
              <View style={styles.headerSearchOpenRow}>
                <SymbolView
                  name="magnifyingglass"
                  size={18}
                  weight="semibold"
                  tintColor={theme.color.fgMuted}
                />
                <View style={styles.headerSearchInputWrap}>
                  <TextInput
                    ref={inputRef}
                    value={query}
                    onChangeText={onSearchChangeText}
                    placeholder="Search"
                    placeholderTextColor={theme.color.fgMuted}
                    autoCapitalize="none"
                    autoCorrect={false}
                    returnKeyType="search"
                    selectionColor={theme.color.accent}
                    keyboardAppearance={theme.scheme}
                    style={[
                      styles.headerSearchInput,
                      { color: theme.color.fg },
                    ]}
                  />
                </View>
                <Pressable
                  onPress={onSearchClear}
                  accessibilityRole="button"
                  accessibilityLabel={
                    query.length > 0 ? "Clear search" : "Close search"
                  }
                  style={({ pressed }) => [
                    styles.headerSearchClearButton,
                    pressed ? { opacity: 0.6 } : null,
                  ]}
                >
                  <SymbolView
                    name={clearIcon}
                    size={query.length > 0 ? 18 : 15}
                    weight="semibold"
                    tintColor={theme.color.fgMuted}
                  />
                </Pressable>
              </View>
            </Animated.View>
          </View>
          <Animated.View
            style={[
              styles.headerCapsuleDivider,
              dividerStyle,
              { backgroundColor: dividerColor },
            ]}
          />
          <Pressable
            onPress={onUploadPress}
            accessibilityRole="button"
            accessibilityLabel="Upload music"
            style={({ pressed }) => [
              styles.headerCapsuleButton,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <SymbolView
              name="plus"
              size={24}
              tintColor={theme.color.fg}
            />
          </Pressable>
        </View>
      </AdaptiveGlass>
    </Animated.View>
  );
}
