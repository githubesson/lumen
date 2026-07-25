import { useMemo, type ReactNode } from 'react';
import {
  requireNativeComponent,
  type NativeSyntheticEvent,
  type ViewProps,
} from 'react-native';
import {
  formatDurationMs,
  trackCoverUrl,
  type TrackListItem,
} from '@music-library/core';

/**
 * Columnar payload. An array of objects would repeat every key once per row and
 * allocate a dictionary per row crossing the bridge; parallel arrays keep the
 * payload small and let the native side walk homogeneous arrays.
 */
interface RowData {
  ids: string[];
  titles: string[];
  artists: string[];
  albums: string[];
  durations: string[];
  artworkUrls: string[];
  /** 0/1 rather than booleans — cheaper to serialize. */
  favorites: number[];
}

interface RowActivatedEvent {
  index: number;
  id: string;
}

interface RowContextMenuEvent {
  index: number;
  id: string;
  x: number;
  y: number;
}

interface NativeProps extends ViewProps {
  children?: ReactNode;
  rowData?: RowData;
  nowPlayingId?: string;
  rowHeight?: number;
  topInset?: number;
  bottomInset?: number;
  accentColor?: string;
  onRowActivated?: (e: NativeSyntheticEvent<RowActivatedEvent>) => void;
  onRowContextMenu?: (e: NativeSyntheticEvent<RowContextMenuEvent>) => void;
  onEndReached?: () => void;
}

const NativeTrackTable = requireNativeComponent<NativeProps>('LMTrackTable');

export interface TrackTableProps extends Omit<ViewProps, 'children'> {
  /**
   * Rendered inside the scroll surface, above the first row, so it scrolls
   * away with the list. Reserve its height (plus any chrome above it) via
   * `topInset`.
   */
  header?: ReactNode;
  tracks: TrackListItem[];
  favoriteIds: Set<string>;
  nowPlayingId?: string;
  rowHeight?: number;
  /** Room for the floating screen header the list scrolls underneath. */
  topInset?: number;
  bottomInset?: number;
  accentColor?: string;
  onActivate: (track: TrackListItem, index: number) => void;
  onContextMenu: (
    track: TrackListItem,
    position: { x: number; y: number },
  ) => void;
  /** Fired once per row count when the tail comes within a screenful. */
  onEndReached?: () => void;
}

/**
 * A track list rendered by `NSTableView`.
 *
 * The React Native list this replaced could not be made smooth: every row's
 * `<Text>` allocated a TextKit stack and every hover handler registered a
 * scroll observer, so scrolling spent most of its time allocating and tearing
 * those down. AppKit recycles a screenful of cells instead.
 *
 * Consequences worth knowing: rows are drawn natively, so they follow the
 * system appearance rather than the JS theme (only the accent is passed
 * through), and activation is a double-click, which is the macOS convention a
 * native table brings with it.
 */
export function TrackTable({
  header,
  tracks,
  favoriteIds,
  nowPlayingId,
  rowHeight = 56,
  topInset = 0,
  bottomInset = 0,
  accentColor,
  onActivate,
  onContextMenu,
  onEndReached,
  ...rest
}: TrackTableProps) {
  // Memoized so the payload only crosses the bridge when the list really
  // changes — a new array identity means a full re-serialize and reload.
  const rowData = useMemo<RowData>(() => {
    const ids: string[] = [];
    const titles: string[] = [];
    const artists: string[] = [];
    const albums: string[] = [];
    const durations: string[] = [];
    const artworkUrls: string[] = [];
    const favorites: number[] = [];

    for (const track of tracks) {
      ids.push(track.id);
      titles.push(track.title);
      artists.push(track.artist ?? 'Unknown artist');
      albums.push(track.album_title ?? '');
      durations.push(formatDurationMs(track.duration_ms, '—'));
      artworkUrls.push(trackCoverUrl(track, 96));
      favorites.push(favoriteIds.has(track.id) ? 1 : 0);
    }

    return { ids, titles, artists, albums, durations, artworkUrls, favorites };
  }, [tracks, favoriteIds]);

  return (
    <NativeTrackTable
      rowData={rowData}
      nowPlayingId={nowPlayingId}
      rowHeight={rowHeight}
      topInset={topInset}
      bottomInset={bottomInset}
      accentColor={accentColor}
      onEndReached={onEndReached}
      onRowActivated={e => {
        const track = tracks[e.nativeEvent.index];
        if (track) onActivate(track, e.nativeEvent.index);
      }}
      onRowContextMenu={e => {
        const track = tracks[e.nativeEvent.index];
        if (track) {
          onContextMenu(track, { x: e.nativeEvent.x, y: e.nativeEvent.y });
        }
      }}
      {...rest}>
      {header}
    </NativeTrackTable>
  );
}
