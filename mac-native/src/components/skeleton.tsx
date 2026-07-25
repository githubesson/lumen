import { useEffect, useRef, type ReactNode } from 'react';
import {
  Animated,
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from 'react-native';
import { useTheme } from '../theme/theme';

/**
 * Loading placeholders shaped like the content they stand in for. A screen
 * that switches straight to its skeleton reads as "already there, filling in"
 * where a spinner on an empty pane reads as a stall.
 */

export const SKELETON_ROW_HEIGHT = 56;

/**
 * Shared gentle pulse for everything inside. One animated value per group, so
 * a screenful of blocks costs a single JS-driven animation.
 */
export function SkeletonGroup({
  children,
  style,
}: {
  children: ReactNode;
  style?: StyleProp<ViewStyle>;
}) {
  const opacity = useRef(new Animated.Value(1)).current;

  useEffect(() => {
    const loop = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.55,
          duration: 650,
          useNativeDriver: false,
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 650,
          useNativeDriver: false,
        }),
      ]),
    );
    loop.start();
    return () => loop.stop();
  }, [opacity]);

  return (
    <Animated.View
      style={[styles.fill, { opacity }, style]}
      pointerEvents="none">
      {children}
    </Animated.View>
  );
}

export function SkeletonBlock({
  width,
  height,
  radius = 6,
  style,
}: {
  width: number | `${number}%`;
  height: number;
  radius?: number;
  style?: StyleProp<ViewStyle>;
}) {
  const t = useTheme();
  return (
    <View
      style={[
        { width, height, borderRadius: radius, backgroundColor: t.color.hover },
        style,
      ]}
    />
  );
}

/**
 * Stand-in for a track list: artwork square, two text lines, a duration at
 * the trailing edge. Also passable for playlist rows — anything list-shaped.
 */
export function SkeletonTrackRows({
  rows = 12,
  topInset = 0,
  art = true,
}: {
  rows?: number;
  topInset?: number;
  /** Text-only lists (artists) drop the artwork square. */
  art?: boolean;
}) {
  const t = useTheme();
  return (
    <SkeletonGroup style={{ paddingTop: topInset }}>
      {Array.from({ length: rows }, (_, index) => (
        <View
          key={index}
          style={[
            styles.row,
            {
              height: SKELETON_ROW_HEIGHT,
              paddingHorizontal: t.space.xl,
              gap: t.space.md,
            },
          ]}>
          {art ? <SkeletonBlock width={40} height={40} radius={t.radius.sm} /> : null}
          <View style={[styles.rowText, { gap: t.space.xs }]}>
            <SkeletonBlock width="42%" height={11} />
            <SkeletonBlock width="26%" height={9} />
          </View>
          <SkeletonBlock width={34} height={9} />
        </View>
      ))}
    </SkeletonGroup>
  );
}

/** Stand-in for an album grid: cover squares with two caption lines. */
export function SkeletonTileGrid({
  topInset = 0,
  tiles = 10,
  tileSize = 140,
}: {
  topInset?: number;
  tiles?: number;
  tileSize?: number;
}) {
  const t = useTheme();
  return (
    <SkeletonGroup style={{ paddingTop: topInset }}>
      <View
        style={[
          styles.grid,
          { paddingHorizontal: t.space.xl, gap: t.space.lg },
        ]}>
        {Array.from({ length: tiles }, (_, index) => (
          <View key={index} style={{ gap: t.space.sm }}>
            <SkeletonBlock
              width={tileSize}
              height={tileSize}
              radius={t.radius.sm}
            />
            <SkeletonBlock width={tileSize * 0.7} height={10} />
            <SkeletonBlock width={tileSize * 0.45} height={9} />
          </View>
        ))}
      </View>
    </SkeletonGroup>
  );
}

const styles = StyleSheet.create({
  fill: { flex: 1, overflow: 'hidden' },
  row: { flexDirection: 'row', alignItems: 'center' },
  rowText: { flex: 1 },
  grid: { flexDirection: 'row', flexWrap: 'wrap' },
});
