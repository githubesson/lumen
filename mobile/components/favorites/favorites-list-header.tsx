import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type LayoutChangeEvent,
} from "react-native";
import Animated, {
  useAnimatedReaction,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import type { SortKey } from "@music-library/core";
import {
  PLAYLIST_CONTROL_SIZE as CONTROL_SIZE,
  SortMenuButton,
  type SortMenuOption,
} from "../playlists/playlist-detail-header";
import { FAVORITES_MODES, modeColor } from "./mode-switch";
import {
  DEFAULT_HEADER_GEOMETRY,
  FAVORITES_HEADER,
  controlsOpacity,
  titleClip,
  type FavoritesMode,
  type HeaderGeometry,
} from "../../lib/favorites-header";
import type { ThemeTokens } from "../../theme/theme";

// No "Plays": track lists carry no play counts. "Custom" is the list's own
// order, newest first.
const SORT_OPTIONS: Record<FavoritesMode, SortMenuOption[]> = {
  favorites: [
    { key: "custom", label: "Recently Added", symbol: "heart" },
    { key: "title", label: "Title" },
    { key: "duration", label: "Length" },
  ],
  recent: [
    { key: "custom", label: "Last Played", symbol: "clock" },
    { key: "title", label: "Title" },
    { key: "duration", label: "Length" },
  ],
};

const SUMMARY_LINE_HEIGHT = 20;

/**
 * The top of one list, scrolling with it: the large title (the list's name)
 * with a slot at its trailing end where the floating mode switch sits, the
 * count line, and the playlist page's Shuffle / Play / Sort row.
 *
 * The title is clipped at the bar's bottom edge as it scrolls under, and the
 * controls fade before they reach the bar, where the nav bar's own glass
 * buttons take over. Positions are reported up so the floating switch and the
 * bar can follow this header.
 */
export function FavoritesListHeader({
  theme,
  mode,
  summary,
  offset,
  topInset,
  trackCount,
  sortKey,
  sortAsc,
  onSelectSort,
  onToggleSortDirection,
  onPlay,
  onShuffle,
  onGeometry,
}: {
  theme: ThemeTokens;
  mode: FavoritesMode;
  summary: string;
  /** The list's raw content offset (rest is `-topInset`). */
  offset: SharedValue<number>;
  topInset: number;
  trackCount: number;
  sortKey: SortKey;
  sortAsc: boolean;
  onSelectSort: (key: SortKey) => void;
  onToggleSortDirection: () => void;
  onPlay: () => void;
  onShuffle: () => void;
  onGeometry: (mode: FavoritesMode, geometry: HeaderGeometry) => void;
}) {
  const meta = FAVORITES_MODES[mode];
  const color = modeColor(theme, mode);
  const hasControls = trackCount > 0;

  const [titleRow, setTitleRow] = useState({
    y: DEFAULT_HEADER_GEOMETRY.titleRowY,
    height: DEFAULT_HEADER_GEOMETRY.titleRowHeight,
  });
  const [summaryBottom, setSummaryBottom] = useState(
    DEFAULT_HEADER_GEOMETRY.titleRowY +
      DEFAULT_HEADER_GEOMETRY.titleRowHeight +
      SUMMARY_LINE_HEIGHT,
  );
  const [controlsBottom, setControlsBottom] = useState(
    DEFAULT_HEADER_GEOMETRY.controlsBottom,
  );
  const geometry = useMemo<HeaderGeometry>(
    () => ({
      titleRowY: titleRow.y,
      titleRowHeight: titleRow.height,
      controlsBottom: hasControls ? controlsBottom : summaryBottom,
    }),
    [titleRow, hasControls, controlsBottom, summaryBottom],
  );

  useEffect(() => {
    onGeometry(mode, geometry);
  }, [geometry, mode, onGeometry]);

  const onTitleRowLayout = (e: LayoutChangeEvent) => {
    const { y, height } = e.nativeEvent.layout;
    setTitleRow((prev) =>
      prev.y === y && prev.height === height ? prev : { y, height },
    );
  };

  // Two transforms make a clip without a layout pass: the outer box moves
  // down by the cut (its overflow hides what's above), the text moves back up.
  const clipOuterStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: titleClip(offset.value + topInset, geometry) }],
  }));
  const clipInnerStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -titleClip(offset.value + topInset, geometry) }],
  }));
  const controlsStyle = useAnimatedStyle(() => ({
    opacity: controlsOpacity(offset.value + topInset, geometry),
  }));

  // Faded-out controls must not take taps meant for the bar above them.
  const [controlsLive, setControlsLive] = useState(true);
  useAnimatedReaction(
    () => controlsOpacity(offset.value + topInset, geometry) > 0.05,
    (live, previous) => {
      if (live !== previous) scheduleOnRN(setControlsLive, live);
    },
    [offset, geometry, topInset],
  );

  return (
    <View style={styles.header}>
      <View onLayout={onTitleRowLayout} style={styles.titleRow}>
        <Animated.View pointerEvents="none" style={[styles.titleClip, clipOuterStyle]}>
          <Animated.View style={clipInnerStyle}>
            <Text
              accessibilityRole="header"
              numberOfLines={1}
              adjustsFontSizeToFit
              minimumFontScale={0.7}
              style={[styles.title, { color: theme.color.fg }]}
            >
              {meta.label}
            </Text>
          </Animated.View>
        </Animated.View>
        {/* The floating switch sits here; see FavoritesNavBar. */}
        <View style={styles.switchSlot} />
      </View>
      <View
        onLayout={(e) => {
          const { y, height } = e.nativeEvent.layout;
          setSummaryBottom(y + height);
        }}
        style={styles.summary}
      >
        {summary ? (
          <>
            <SymbolView name={meta.icon} size={15} tintColor={color} />
            <Text
              numberOfLines={1}
              style={[styles.summaryText, { color: theme.color.fgMuted }]}
            >
              {summary}
            </Text>
          </>
        ) : null}
      </View>
      {hasControls ? (
        <Animated.View
          onLayout={(e) => {
            const { y, height } = e.nativeEvent.layout;
            setControlsBottom(y + height);
          }}
          pointerEvents={controlsLive ? "box-none" : "none"}
          style={[styles.controls, controlsStyle]}
        >
          {trackCount > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Shuffle play"
              onPress={onShuffle}
              style={({ pressed }) => [
                styles.circle,
                { backgroundColor: theme.color.bgElev1, opacity: pressed ? 0.8 : 1 },
              ]}
            >
              <SymbolView name="shuffle" size={16} tintColor={theme.color.fg} />
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`Play ${meta.label}`}
            onPress={onPlay}
            style={({ pressed }) => [
              styles.play,
              { backgroundColor: theme.color.accent, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <SymbolView name="play.fill" size={15} tintColor={theme.color.onAccent} />
            <Text style={[styles.playText, { color: theme.color.onAccent }]}>
              Play
            </Text>
          </Pressable>
          {trackCount > 1 ? (
            <SortMenuButton
              theme={theme}
              sortKey={sortKey}
              sortAsc={sortAsc}
              onSelect={onSelectSort}
              onToggleDirection={onToggleSortDirection}
              options={SORT_OPTIONS[mode]}
              accessibilityLabel={`Sort ${meta.label}`}
            />
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    paddingTop: FAVORITES_HEADER.navBarHeight,
  },
  titleRow: {
    flexDirection: "row",
    alignItems: "center",
    minHeight: FAVORITES_HEADER.titleRowMinHeight,
    paddingHorizontal: FAVORITES_HEADER.sideInset,
    gap: 12,
  },
  titleClip: {
    flex: 1,
    alignSelf: "stretch",
    justifyContent: "center",
    overflow: "hidden",
  },
  title: {
    fontSize: 34,
    lineHeight: 41,
    fontWeight: "700",
  },
  switchSlot: {
    width: FAVORITES_HEADER.switchWidth * FAVORITES_HEADER.expandedScale,
    height: FAVORITES_HEADER.switchHeight * FAVORITES_HEADER.expandedScale,
  },
  summary: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    minHeight: SUMMARY_LINE_HEIGHT,
    paddingHorizontal: FAVORITES_HEADER.sideInset,
  },
  summaryText: {
    flexShrink: 1,
    fontSize: 15,
    lineHeight: SUMMARY_LINE_HEIGHT,
  },
  controls: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingTop: 14,
    paddingBottom: 10,
    paddingHorizontal: FAVORITES_HEADER.sideInset,
  },
  circle: {
    width: CONTROL_SIZE,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  play: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    height: CONTROL_SIZE,
    borderRadius: CONTROL_SIZE / 2,
    borderCurve: "continuous",
  },
  playText: {
    fontSize: 16,
    fontWeight: "600",
  },
});
