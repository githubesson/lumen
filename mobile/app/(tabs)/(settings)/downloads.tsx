import { useCallback, useMemo, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
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
import { DownloadCoverFan } from "../../../components/download-cover-fan";
import { EmptyState } from "../../../components/empty-state";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../components/list-performance";
import type { SortMenuOption } from "../../../components/playlists/playlist-detail-header";
import { TrackListControls } from "../../../components/track-list-controls";
import { TrackRow } from "../../../components/track-row";
import { usePlayerPlayback, usePlayTrack } from "../../../context/player";
import { useDownloadSummary } from "../../../lib/downloads/download-summary";
import { useDownloadedTracks } from "../../../lib/downloads/downloaded-tracks";
import { LOCAL_DEVICE_PHRASE } from "../../../lib/device-name";
import { formatBytes, pluralize } from "../../../lib/format";
import { listPlaybackQueue, usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme } from "../../../theme/theme";

/** Cap on one hero cover: four fanned out come to about 1.9 times this. */
const HERO_COVER_MAX = 160;

// "Custom" is the download order, newest first. No "Plays": the stored
// snapshots carry no play counts.
const SORT_OPTIONS: SortMenuOption[] = [
  { key: "custom", label: "Recently Downloaded", symbol: "arrow.down.circle" },
  { key: "title", label: "Title" },
  { key: "duration", label: "Length" },
];

/**
 * Every song downloaded to this device, opened from the Settings card that
 * counts them. Rows come from the snapshots the downloads keep, so the list
 * works offline like the rest of what's stored.
 */
export default function DownloadsScreen() {
  const theme = useTheme();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const play = usePlayTrack();
  const { shuffle } = usePlayerPlayback();
  const summary = useDownloadSummary();
  const downloaded = useDownloadedTracks();
  const { width } = useWindowDimensions();
  // The fan spans about as much as the playlist page's artwork.
  const heroCover = Math.min(Math.round(width * 0.4), HERO_COVER_MAX);
  const [sortKey, setSortKey] = useState<SortKey>("custom");
  const [sortAsc, setSortAsc] = useState(SORT_DEFAULT_ASC.custom);

  // Display-only, like Favorites' sort; it resets when the screen closes.
  const tracks = useMemo(
    () =>
      sortForDisplay(downloaded.tracks, sortKey, sortAsc, (a, b) =>
        compareSortableTracks(a, b, sortKey),
      ),
    [downloaded.tracks, sortKey, sortAsc],
  );
  const onTrackPress = usePlayQueue(tracks);

  const onSelectSort = useCallback((key: SortKey) => {
    void Haptics.selectionAsync();
    setSortKey((prevKey) => {
      if (prevKey !== key) setSortAsc(SORT_DEFAULT_ASC[key]);
      return key;
    });
  }, []);
  const onToggleSortDirection = useCallback(() => setSortAsc((asc) => !asc), []);

  const onPlay = useCallback(() => {
    const startable = listPlaybackQueue(tracks);
    if (startable.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startListPlayback(play, startable, shuffle);
  }, [play, shuffle, tracks]);
  const onShuffle = useCallback(() => {
    const startable = listPlaybackQueue(tracks);
    if (startable.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    startShuffledListPlayback(play, startable);
  }, [play, tracks]);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );
  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);

  // The same count and size as the Settings card, unlisted songs included.
  const songs = pluralize(summary.count, "song", undefined, { locale: true });
  const header =
    summary.count > 0 ? (
      // The playlist page's header: artwork, name, a count line, the controls.
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.lg,
          gap: theme.space.md,
        }}
      >
        <View style={styles.hero}>
          <DownloadCoverFan
            summary={summary}
            size={heroCover}
            ringColor={theme.color.bg}
            priority="high"
          />
        </View>
        <View style={styles.titles}>
          <Text accessibilityRole="header" style={[styles.title, { color: theme.color.fg }]}>
            Downloads
          </Text>
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
            {summary.bytes > 0
              ? `${songs} · ${formatBytes(summary.bytes)} on ${LOCAL_DEVICE_PHRASE}`
              : `${songs} on ${LOCAL_DEVICE_PHRASE}`}
          </Text>
        </View>
        {tracks.length > 0 ? (
          <View style={styles.controls}>
            <TrackListControls
              theme={theme}
              trackCount={tracks.length}
              playAccessibilityLabel="Play downloads"
              sortKey={sortKey}
              sortAsc={sortAsc}
              sortOptions={SORT_OPTIONS}
              sortAccessibilityLabel="Sort downloads"
              onSelectSort={onSelectSort}
              onToggleSortDirection={onToggleSortDirection}
              onPlay={onPlay}
              onShuffle={onShuffle}
            />
          </View>
        ) : null}
      </View>
    ) : null;

  const footer =
    downloaded.unlisted > 0 ? (
      <Text style={[styles.footer, { color: theme.color.fgMuted }]}>
        {downloaded.unlisted === 1
          ? "1 older download shows here once its playlist is opened online."
          : `${downloaded.unlisted.toLocaleString()} older downloads show here once their playlists are opened online.`}
      </Text>
    ) : null;

  return (
    <FlashList
      {...TRACK_FLASH_LIST_PERFORMANCE_PROPS}
      {...dockScroll}
      data={tracks}
      renderItem={renderItem}
      keyExtractor={keyExtractor}
      ListHeaderComponent={header}
      ListFooterComponent={footer}
      ListEmptyComponent={
        !summary.ready ? (
          <EmptyState loading />
        ) : summary.count === 0 ? (
          <EmptyState message="No downloads. Download a playlist to play it offline." />
        ) : null
      }
      contentInsetAdjustmentBehavior="automatic"
      style={{ backgroundColor: theme.color.bg }}
      contentContainerStyle={{ paddingBottom: dockInset + 24 }}
    />
  );
}

const styles = StyleSheet.create({
  hero: {
    alignSelf: "center",
    paddingVertical: 8,
  },
  titles: {
    gap: 4,
    alignItems: "center",
  },
  title: {
    fontSize: 24,
    fontWeight: "700",
    letterSpacing: -0.2,
    textAlign: "center",
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
  },
  footer: {
    fontSize: 13,
    textAlign: "center",
    paddingHorizontal: 32,
    paddingTop: 16,
  },
});
