import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  interpolate,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { displayText, type TrackListItem } from "@music-library/core";
import { CoverArt } from "../cover-art";
import type { ThemeTokens } from "../../theme/theme";
import type { CometOutlineInset } from "../../lib/swipe-actions";

/** The slot a favorite swiped away in the Favorites list shrinks to. */
export const REMOVAL_SLOT_HEIGHT = 44;
const STRIP_INSET = 16;
const STRIP_TOP = 6;
const STRIP_HEIGHT = 32;

/**
 * The strip's outline inside a canvas the slot's full width and
 * {@link REMOVAL_SLOT_HEIGHT} tall, for the comet that traces it once.
 */
export const REMOVAL_STRIP_OUTLINE: CometOutlineInset = {
  insetX: STRIP_INSET,
  insetY: STRIP_TOP,
  radius: STRIP_HEIGHT / 2,
};

/**
 * "Removed · Undo" in the slot of a favorite swiped away in the Favorites
 * list: the cover, the title, and Undo, which puts the row back where it was.
 * `shown` runs 0 to 1 as it settles in (a fade and a slight grow).
 */
export function RemovalStrip({
  track,
  theme,
  shown,
  onUndo,
}: {
  track: TrackListItem;
  theme: ThemeTokens;
  shown: SharedValue<number>;
  onUndo: () => void;
}) {
  const title = displayText(track.title);
  const dark = theme.scheme === "dark";
  const shownStyle = useAnimatedStyle(() => {
    const p = shown.get();
    return {
      opacity: interpolate(p, [0, 0.45, 1], [0, 1, 1], "clamp"),
      transform: [{ scale: interpolate(p, [0, 1], [0.94, 1]) }],
    };
  });
  return (
    <Animated.View
      style={[
        styles.strip,
        {
          backgroundColor: theme.color.bgElev1,
          borderColor: dark ? "rgba(255,255,255,0.06)" : "rgba(0,0,0,0.06)",
        },
        shownStyle,
      ]}
    >
      <View
        accessible
        accessibilityLabel={`${title}, removed from Favorites`}
        style={styles.body}
      >
        <CoverArt track={track} size={22} radius={4} transitionMs={0} priority="low" />
        <Text
          numberOfLines={1}
          style={[styles.title, { color: theme.color.fg }]}
        >
          {title}
        </Text>
        <Text numberOfLines={1} style={[styles.removed, { color: theme.color.fgMuted }]}>
          Removed
        </Text>
      </View>
      <Pressable
        onPress={() => {
          void Haptics.selectionAsync();
          onUndo();
        }}
        accessibilityRole="button"
        accessibilityLabel="Undo"
        accessibilityHint={`Puts ${title} back in Favorites.`}
        hitSlop={{ top: 6, bottom: 6, left: 4, right: 8 }}
        style={({ pressed }) => [
          styles.undo,
          {
            backgroundColor: dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.10)",
            transform: [{ scale: pressed ? 0.92 : 1 }],
          },
        ]}
      >
        <Text style={[styles.undoLabel, { color: theme.color.accent }]}>Undo</Text>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  strip: {
    position: "absolute",
    left: STRIP_INSET,
    right: STRIP_INSET,
    top: STRIP_TOP,
    height: STRIP_HEIGHT,
    borderRadius: STRIP_HEIGHT / 2,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingLeft: 5,
    paddingRight: 3,
  },
  body: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
  },
  title: {
    flexShrink: 1,
    maxWidth: 170,
    fontSize: 13,
    fontWeight: "600",
  },
  removed: {
    flex: 1,
    fontSize: 13,
  },
  undo: {
    height: 26,
    paddingHorizontal: 12,
    borderRadius: 13,
    justifyContent: "center",
  },
  undoLabel: {
    fontSize: 14,
    fontWeight: "600",
  },
});
