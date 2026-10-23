import { useCallback, useEffect, useMemo, useState } from "react";
import { RefreshControl, StyleSheet } from "react-native";
import {
  FlashList,
  type FlashListRef,
  type ListRenderItemInfo,
} from "@shopify/flash-list";
import Animated, {
  useAnimatedStyle,
  useScrollOffset,
  useSharedValue,
  withTiming,
  type AnimatedRef,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import {
  SORT_DEFAULT_ASC,
  compareSortableTracks,
  sortForDisplay,
  type SortKey,
  type TrackListItem,
} from "@music-library/core";
import {
  startListPlayback,
  startShuffledListPlayback,
} from "@music-library/core/player/play-list";
import { EmptyState, retryAction } from "../empty-state";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../list-performance";
import { TrackRow } from "../track-row";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../dock/dock-context";
import { FavoritesListHeader } from "./favorites-list-header";
import { usePlayerPlayback, usePlayTrack } from "../../context/player";
import {
  FAVORITES_HEADER,
  listSummary,
  type FavoritesMode,
  type HeaderGeometry,
} from "../../lib/favorites-header";
import { listPlaybackQueue, usePlayQueue } from "../../lib/use-play-queue";
import { usePullToRefresh } from "../../lib/use-pull-to-refresh";
import type { ThemeTokens } from "../../theme/theme";

const LIST_FADE_MS = 220;

/** One list as shown: its sort, its count line, and its Play / Shuffle. */
export interface FavoritesListModel {
  /** In display order; Play, Shuffle and row taps queue this order. */
  tracks: TrackListItem[];
  summary: string;
  sortKey: SortKey;
  sortAsc: boolean;
  onSelectSort: (key: SortKey) => void;
  onToggleSortDirection: () => void;
  onPlay: () => void;
  onShuffle: () => void;
}

/** Display-only sorting (never saved) and list playback for one mode. */
export function useFavoritesListModel(
  mode: FavoritesMode,
  data: TrackListItem[] | undefined,
): FavoritesListModel {
  const play = usePlayTrack();
  const { shuffle } = usePlayerPlayback();
  const [sortKey, setSortKey] = useState<SortKey>("custom");
  const [sortAsc, setSortAsc] = useState(SORT_DEFAULT_ASC.custom);

  const tracks = useMemo(
    () =>
      sortForDisplay(data ?? [], sortKey, sortAsc, (a, b) =>
        compareSortableTracks(a, b, sortKey),
      ),
    [data, sortKey, sortAsc],
  );
  const summary = useMemo(() => listSummary(mode, tracks), [mode, tracks]);

  const onSelectSort = useCallback((key: SortKey) => {
    void Haptics.selectionAsync();
    setSortKey((prevKey) => {
      if (prevKey !== key) setSortAsc(SORT_DEFAULT_ASC[key]);
      return key;
    });
  }, []);

  const onToggleSortDirection = useCallback(() => {
    setSortAsc((asc) => !asc);
  }, []);

  // With shuffle mode on, Play starts somewhere random like the playlist
  // page's; from the top, every shuffled play would open on the same song.
  const onPlay = useCallback(() => {
    const queue = listPlaybackQueue(tracks);
    if (queue.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startListPlayback(play, queue, shuffle);
  }, [play, shuffle, tracks]);

  // Shuffle is queue-level: shuffle mode on, from a random track.
  const onShuffle = useCallback(() => {
    const queue = listPlaybackQueue(tracks);
    if (queue.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startShuffledListPlayback(play, queue);
  }, [play, tracks]);

  return useMemo(
    () => ({
      tracks,
      summary,
      sortKey,
      sortAsc,
      onSelectSort,
      onToggleSortDirection,
      onPlay,
      onShuffle,
    }),
    [tracks, summary, sortKey, sortAsc, onSelectSort, onToggleSortDirection, onPlay, onShuffle],
  );
}

const EMPTY_MESSAGES: Record<FavoritesMode, { error: string; empty: string }> = {
  favorites: {
    error: "Couldn't load favorites.",
    empty: "No favorites yet. Tap the heart on a track to save it here.",
  },
  recent: {
    error: "Couldn't load recent plays.",
    empty: "No recent plays.",
  },
};

/**
 * One of the tab's two lists. Both stay mounted once shown, stacked, so each
 * keeps its own scroll position natively; the inactive one is see-through,
 * untouchable and hidden from VoiceOver. Lists hold no glass, so fading them
 * is safe (the floating switch and the bar's buttons live above them).
 */
export function FavoritesList({
  theme,
  mode,
  active,
  fadeIn,
  listRef,
  offset,
  topInset,
  model,
  query,
  onGeometry,
  onContentSizeChange,
  onScrollBeginDrag,
}: {
  theme: ThemeTokens;
  mode: FavoritesMode;
  active: boolean;
  /** Fade in on mount (shown by a switch) rather than appear at once. */
  fadeIn: boolean;
  listRef: AnimatedRef<FlashListRef<TrackListItem>>;
  /** Receives the raw content offset on the UI thread. */
  offset: SharedValue<number>;
  topInset: number;
  model: FavoritesListModel;
  query: {
    isLoading: boolean;
    isError: boolean;
    isFetching: boolean;
    refetch: () => Promise<unknown>;
  };
  onGeometry: (mode: FavoritesMode, geometry: HeaderGeometry) => void;
  onContentSizeChange: (mode: FavoritesMode) => void;
  onScrollBeginDrag: (mode: FavoritesMode) => void;
}) {
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { refreshing, onRefresh } = usePullToRefresh(query.refetch);
  useScrollOffset(listRef, offset);

  const visibility = useSharedValue(active && !fadeIn ? 1 : 0);
  useEffect(() => {
    visibility.set(withTiming(active ? 1 : 0, { duration: LIST_FADE_MS }));
  }, [active, visibility]);
  const fadeStyle = useAnimatedStyle(() => ({ opacity: visibility.value }));

  const { tracks } = model;
  const handlePress = usePlayQueue(tracks);
  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={handlePress} inFavorites={mode === "favorites"} />
    ),
    [handlePress, mode],
  );
  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);

  const header = (
    <FavoritesListHeader
      theme={theme}
      mode={mode}
      summary={model.summary}
      offset={offset}
      topInset={topInset}
      trackCount={tracks.length}
      sortKey={model.sortKey}
      sortAsc={model.sortAsc}
      onSelectSort={model.onSelectSort}
      onToggleSortDirection={model.onToggleSortDirection}
      onPlay={model.onPlay}
      onShuffle={model.onShuffle}
      onGeometry={onGeometry}
    />
  );

  const messages = EMPTY_MESSAGES[mode];
  const empty = query.isLoading ? (
    <EmptyState loading />
  ) : query.isError ? (
    <EmptyState selectable message={messages.error} action={retryAction(query)} />
  ) : (
    <EmptyState message={messages.empty} />
  );

  return (
    <Animated.View
      pointerEvents={active ? "auto" : "none"}
      accessibilityElementsHidden={!active}
      importantForAccessibility={active ? "auto" : "no-hide-descendants"}
      style={[StyleSheet.absoluteFill, fadeStyle]}
    >
      <FlashList
        {...TRACK_FLASH_LIST_PERFORMANCE_PROPS}
        ref={listRef}
        data={tracks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={header}
        ListEmptyComponent={empty}
        // The native header is hidden; the automatic inset is the status
        // bar's, which the header's own top padding sits under.
        contentInsetAdjustmentBehavior="automatic"
        scrollIndicatorInsets={{ top: FAVORITES_HEADER.navBarHeight }}
        // Only the visible list answers a status-bar tap.
        scrollsToTop={active}
        scrollEventThrottle={dockScroll.scrollEventThrottle}
        onScroll={active ? dockScroll.onScroll : undefined}
        onContentSizeChange={() => onContentSizeChange(mode)}
        onScrollBeginDrag={() => onScrollBeginDrag(mode)}
        style={styles.list}
        contentContainerStyle={{ paddingBottom: dockInset + 24 }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.color.fgMuted}
          />
        }
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  list: {
    flex: 1,
    backgroundColor: "transparent",
  },
});
