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
import { displayText, type TrackListItem } from "@music-library/core";
import { CoverArt } from "../cover-art";
import { useTheme } from "../../theme/theme";

/** Fixed queue row height; the advance animation slides rows by exactly this. */
export const QUEUE_ROW_HEIGHT = 64;

/**
 * One upcoming track in the Now Playing queue list. Rides the shared
 * `advanceOffset` so the whole list slides up when the queue advances.
 * Artwork mounts with the row and uses the normal image cache.
 */
function QueueRowImpl({
  track,
  position,
  queuePosition,
  advanceOffset,
  onJumpToPosition,
  style,
}: {
  track: TrackListItem;
  /** Index in the displayed queue, which is what `jumpTo` takes. */
  position: number;
  /** 1-based place in the whole queue, for the accessibility hint. */
  queuePosition: number;
  advanceOffset: SharedValue<number>;
  onJumpToPosition: (position: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const title = displayText(track.title);
  const artist = displayText(track.artist);
  const advanceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: advanceOffset.get() }],
  }));

  return (
    <Animated.View style={[advanceStyle, style]}>
      <Pressable
        onPress={() => onJumpToPosition(position)}
        accessibilityRole="button"
        accessibilityLabel={artist ? `${title} by ${artist}` : title}
        accessibilityHint={`Position ${queuePosition} in queue. Double tap to play.`}
        style={({ pressed }) => [
          styles.row,
          pressed ? { opacity: 0.58 } : null,
        ]}
      >
        <CoverArt
          track={track}
          size={44}
          transitionMs={120}
          priority="normal"
        />
        <View style={{ flex: 1, minWidth: 0, gap: 3 }}>
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
              {title}
            </Text>
          </View>
          {artist ? (
            <Text
              numberOfLines={1}
              style={{ fontSize: 14, color: theme.color.fgMuted }}
            >
              {artist}
            </Text>
          ) : null}
        </View>
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
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
});

export const QueueRow = memo(QueueRowImpl);
