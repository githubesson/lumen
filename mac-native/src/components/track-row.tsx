import { memo } from 'react';
import { Pressable, StyleSheet, View } from 'react-native';
import {
  formatDurationMs,
  trackCoverUrl,
  useFavorite,
  type TrackListItem,
} from '@music-library/core';
import { CoverArt } from './cover-art';
import { AppText } from './primitives';
import { useHover } from './hoverable';
import { ContextMenuTarget } from '../native/context-menu';
import { SFSymbol } from '../native/sf-symbol';
import { useTheme } from '../theme/theme';

export interface TrackRowProps {
  track: TrackListItem;
  active?: boolean;
  onPlay: (track: TrackListItem) => void;
  onOpenAlbum?: (albumId: string) => void;
  onContextMenu?: (
    track: TrackListItem,
    position: { x: number; y: number },
    isFavorite: boolean,
  ) => void;
}

/**
 * One track in a list. Hover swaps the artwork for a play affordance and
 * reveals the favorite toggle — the desktop equivalent of the swipe actions the
 * iOS client uses.
 */
export const TrackRow = memo(function TrackRow({
  track,
  active = false,
  onPlay,
  onOpenAlbum,
  onContextMenu,
}: TrackRowProps) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  const isFavorite = useFavorite(track.id);

  return (
    <ContextMenuTarget
      onContextMenu={position => onContextMenu?.(track, position, isFavorite)}>
      <Pressable
        onPress={() => onPlay(track)}
        style={[
          styles.row,
          {
            height: t.row.height,
            paddingHorizontal: t.space.md,
            borderRadius: t.radius.md,
            gap: t.space.md,
            backgroundColor: hovered ? t.color.hover : 'transparent',
          },
        ]}
        {...hoverProps}>
        <View>
          <CoverArt url={trackCoverUrl(track, 96)} size={40} />
          {hovered ? (
            <View style={[styles.playOverlay, { borderRadius: t.radius.sm }]}>
              <SFSymbol name="play.fill" size={14} color="#FFFFFF" />
            </View>
          ) : null}
        </View>

        <View style={styles.meta}>
          <AppText
            numberOfLines={1}
            style={[styles.title, active ? { color: t.color.accent } : null]}>
            {track.title}
          </AppText>
          <AppText variant="caption" muted numberOfLines={1}>
            {track.artist ?? 'Unknown artist'}
          </AppText>
        </View>

        {track.album_title ? (
          <Pressable
            disabled={!track.album_id || !onOpenAlbum}
            onPress={() => track.album_id && onOpenAlbum?.(track.album_id)}
            style={styles.album}>
            <AppText variant="caption" muted numberOfLines={1}>
              {track.album_title}
            </AppText>
          </Pressable>
        ) : null}

        <View style={styles.favorite}>
          {isFavorite || hovered ? (
            <SFSymbol
              name={isFavorite ? 'heart.fill' : 'heart'}
              size={12}
              color={isFavorite ? t.color.accent : t.color.fgMuted}
            />
          ) : null}
        </View>

        <AppText variant="caption" muted style={styles.duration}>
          {formatDurationMs(track.duration_ms, '—')}
        </AppText>
      </Pressable>
    </ContextMenuTarget>
  );
});

const styles = StyleSheet.create({
  row: { flexDirection: 'row', alignItems: 'center' },
  playOverlay: {
    ...StyleSheet.absoluteFillObject,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(0,0,0,0.45)',
  },
  meta: { flex: 1, gap: 2, minWidth: 0 },
  title: { fontSize: 13, fontWeight: '500' },
  album: { flex: 1, minWidth: 0 },
  favorite: { width: 20, alignItems: 'center' },
  duration: { width: 48, textAlign: 'right' },
});
