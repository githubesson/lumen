import { Pressable, StyleSheet, Text } from "react-native";
import { SymbolView } from "expo-symbols";
import type { SortKey } from "@music-library/core";
import {
  PLAYLIST_CONTROL_SIZE as CONTROL_SIZE,
  SortMenuButton,
  type SortMenuOption,
} from "./playlists/playlist-detail-header";
import type { ThemeTokens } from "../theme/theme";

/**
 * The playlist page's Shuffle / Play / Sort buttons, for the track lists
 * that copy its header (Favorites, Downloads). Shuffle and Sort only show
 * with two or more songs. The caller lays out the row they sit in.
 */
export function TrackListControls({
  theme,
  trackCount,
  playAccessibilityLabel,
  sortKey,
  sortAsc,
  sortOptions,
  sortAccessibilityLabel,
  onSelectSort,
  onToggleSortDirection,
  onPlay,
  onShuffle,
}: {
  theme: ThemeTokens;
  trackCount: number;
  playAccessibilityLabel: string;
  sortKey: SortKey;
  sortAsc: boolean;
  sortOptions: SortMenuOption[];
  sortAccessibilityLabel: string;
  onSelectSort: (key: SortKey) => void;
  onToggleSortDirection: () => void;
  onPlay: () => void;
  onShuffle: () => void;
}) {
  return (
    <>
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
        accessibilityLabel={playAccessibilityLabel}
        onPress={onPlay}
        style={({ pressed }) => [
          styles.play,
          { backgroundColor: theme.color.accent, opacity: pressed ? 0.85 : 1 },
        ]}
      >
        <SymbolView name="play.fill" size={15} tintColor={theme.color.onAccent} />
        <Text style={[styles.playText, { color: theme.color.onAccent }]}>Play</Text>
      </Pressable>
      {trackCount > 1 ? (
        <SortMenuButton
          theme={theme}
          sortKey={sortKey}
          sortAsc={sortAsc}
          onSelect={onSelectSort}
          onToggleDirection={onToggleSortDirection}
          options={sortOptions}
          accessibilityLabel={sortAccessibilityLabel}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
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
