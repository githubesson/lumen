import type { ReactNode } from 'react';
import { Pressable, ScrollView, StyleSheet, View } from 'react-native';
import {
  albumCoverUrl,
  trackCoverUrl,
  type TrackListItem,
} from '@music-library/core';
import { CoverArt } from './cover-art';
import { AppText } from './primitives';
import { useHover } from './hoverable';
import { useTheme } from '../theme/theme';

export const SHELF_TILE_SIZE = 132;

/**
 * Full-bleed horizontal rail of tiles. Scrolls with the trackpad; no indicator,
 * since a shelf that shows its own scrollbar reads as a scroll view rather than
 * as a row of records.
 */
export function HorizontalShelf({ children }: { children: ReactNode }) {
  const t = useTheme();
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      contentContainerStyle={{
        paddingHorizontal: t.space.xl,
        gap: t.space.md,
      }}>
      {children}
    </ScrollView>
  );
}

function Tile({
  artwork,
  title,
  subtitle,
  onPress,
}: {
  artwork: ReactNode;
  title: string;
  subtitle?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  return (
    <Pressable
      onPress={onPress}
      style={[
        styles.tile,
        {
          padding: t.space.sm,
          borderRadius: t.radius.md,
          gap: t.space.sm,
          backgroundColor: hovered ? t.color.hover : 'transparent',
        },
      ]}
      {...hoverProps}>
      {artwork}
      <View style={styles.tileText}>
        <AppText variant="label" numberOfLines={1}>
          {title}
        </AppText>
        {subtitle ? (
          <AppText variant="caption" muted numberOfLines={1}>
            {subtitle}
          </AppText>
        ) : null}
      </View>
    </Pressable>
  );
}

export function TrackTile({
  track,
  onPress,
}: {
  track: TrackListItem;
  onPress: (track: TrackListItem) => void;
}) {
  const t = useTheme();
  return (
    <Tile
      artwork={
        <CoverArt
          url={trackCoverUrl(track, 256)}
          size={SHELF_TILE_SIZE}
          radius={t.radius.sm}
        />
      }
      title={track.title}
      subtitle={track.artist ?? undefined}
      onPress={() => onPress(track)}
    />
  );
}

export function AlbumTile({
  id,
  title,
  subtitle,
  onPress,
}: {
  id: string;
  title: string;
  subtitle?: string;
  onPress: (id: string) => void;
}) {
  const t = useTheme();
  return (
    <Tile
      artwork={
        <CoverArt
          url={albumCoverUrl(id, 256)}
          size={SHELF_TILE_SIZE}
          radius={t.radius.sm}
        />
      }
      title={title}
      subtitle={subtitle}
      onPress={() => onPress(id)}
    />
  );
}

const styles = StyleSheet.create({
  tile: { width: SHELF_TILE_SIZE + 16 },
  tileText: { gap: 1 },
});
