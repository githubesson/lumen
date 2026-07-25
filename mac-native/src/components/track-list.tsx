import { useCallback, type ReactNode } from 'react';
import { StyleSheet, View } from 'react-native';
import { useFavorites, type TrackListItem } from '@music-library/core';
import { TrackTable } from '../native/track-table';
import { useTrackContextMenu } from './track-context-menu';
import { EmptyState } from './primitives';
import { SkeletonTrackRows } from './skeleton';
import { useCurrentTrack, usePlayTrack } from '../context/player';
import { useTheme } from '../theme/theme';

/** Bottom inset so the floating dock never covers the final row. */
export const DOCK_CLEARANCE = 108;

export const ROW_HEIGHT = 56;

/**
 * Track lists are rendered by AppKit (`LMTrackTable`), not React Native. A
 * `FlatList` of RN rows could not scroll smoothly here: each row's text
 * allocated a TextKit stack and each hover handler registered a scroll
 * observer, so scrolling was dominated by allocation and teardown.
 *
 * `header` is intentionally gone — a native scroll view cannot host an RN
 * header. Screens that had one now render it above the table instead.
 */
export function TrackList({
  tracks,
  loading,
  emptyTitle,
  emptyDetail,
  topInset = 0,
  header,
  onEndReached,
}: {
  tracks: TrackListItem[] | undefined;
  loading: boolean;
  emptyTitle: string;
  emptyDetail?: string;
  /** Scrollable room for the floating screen header. */
  topInset?: number;
  /** Scrolls away with the rows — include its height in `topInset`. */
  header?: ReactNode;
  onEndReached?: () => void;
}) {
  const t = useTheme();
  const playTrack = usePlayTrack();
  const current = useCurrentTrack();
  const { ids: favoriteIds } = useFavorites();
  const openContextMenu = useTrackContextMenu(tracks);

  const onActivate = useCallback(
    (track: TrackListItem) => playTrack(track, tracks ?? [track]),
    [playTrack, tracks],
  );

  const onContextMenu = useCallback(
    (track: TrackListItem, position: { x: number; y: number }) => {
      void openContextMenu(track, position, favoriteIds.has(track.id));
    },
    [openContextMenu, favoriteIds],
  );

  if (loading && !tracks) return <SkeletonTrackRows topInset={topInset} />;
  if (!tracks || tracks.length === 0) {
    return <EmptyState title={emptyTitle} detail={emptyDetail} />;
  }

  return (
    <View style={styles.fill}>
      <TrackTable
        style={styles.fill}
        header={header}
        tracks={tracks}
        favoriteIds={favoriteIds}
        nowPlayingId={current?.id}
        rowHeight={ROW_HEIGHT}
        topInset={topInset}
        bottomInset={DOCK_CLEARANCE}
        accentColor={t.color.accent}
        onActivate={onActivate}
        onContextMenu={onContextMenu}
        onEndReached={onEndReached}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1 },
});
