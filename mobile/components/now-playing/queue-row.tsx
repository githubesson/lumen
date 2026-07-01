import { memo } from "react";
import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import type { TrackListItem } from "@music-library/core";
import { CoverArt } from "../cover-art";
import { useTheme } from "../../theme/theme";

/** Fixed queue row height; the advance animation slides rows by exactly this. */
export const QUEUE_ROW_HEIGHT = 64;

/**
 * One upcoming track in the Now Playing queue list. Rides the shared
 * `advanceOffset` so the whole list slides up when the queue advances, and
 * swaps its artwork for a flat placeholder until the open animation settles
 * (`showArtwork`).
 */
function QueueRowImpl({
  track,
  position,
  advanceOffset,
  showArtwork,
  onJumpToPosition,
  style,
}: {
  track: TrackListItem;
  position: number;
  advanceOffset: SharedValue<number>;
  showArtwork: boolean;
  onJumpToPosition: (position: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const advanceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: advanceOffset.value }],
  }));

  return (
    <Animated.View style={[advanceStyle, style]}>
      <Pressable
        onPress={() => onJumpToPosition(position)}
        accessibilityRole="button"
        accessibilityLabel={
          track.artist ? `${track.title} by ${track.artist}` : track.title
        }
        accessibilityHint={`Position ${position} in queue. Double tap to play.`}
        style={({ pressed }) => [
          styles.row,
          pressed ? { opacity: 0.58 } : null,
        ]}
      >
        {showArtwork ? (
          <CoverArt
            track={track}
            size={44}
            transitionMs={0}
            priority="low"
            recyclingKey={`${track.album_id ?? track.id}:${track.id}`}
          />
        ) : (
          <View
            style={[
              styles.artPlaceholder,
              { backgroundColor: theme.color.bgElev2 },
            ]}
          />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.titleLine}>
            <Text
              numberOfLines={1}
              style={{
                fontSize: 16,
                fontWeight: "500",
                color: theme.color.fg,
                flexShrink: 1,
              }}
            >
              {track.title}
            </Text>
          </View>
          {track.artist ? (
            <Text
              numberOfLines={1}
              style={{ fontSize: 14, color: theme.color.fgMuted }}
            >
              {track.artist}
            </Text>
          ) : null}
        </View>
        <SymbolView
          name="line.3.horizontal"
          size={22}
          tintColor={theme.color.overlayMuted}
        />
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  row: {
    height: QUEUE_ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  artPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 8,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});

export const QueueRow = memo(QueueRowImpl);
