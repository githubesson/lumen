import { useEffect } from "react";
import { StyleSheet } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { modeColor } from "./mode-switch";
import type { FavoritesMode } from "../../lib/favorites-header";
import { withAlpha, type ThemeTokens } from "../../theme/theme";

const WASH_HEIGHT = 430;
const WASH_FADE = { duration: 350, easing: Easing.linear } as const;

function washGradient(color: string, alpha: number): string {
  return `radial-gradient(130% 75% at 20% 0%, ${withAlpha(color, alpha)} 0%, ${withAlpha(color, 0)} 72%)`;
}

/**
 * A faint wash of the list's colour behind the header. It sits behind both
 * lists (they're transparent) so switching cross-fades purple and blue rather
 * than snapping, and it scrolls with the active list. A pull to refresh leaves
 * it pinned to the top instead of opening a gap above it.
 */
export function ModeWash({
  theme,
  mode,
  offset,
  topInset,
}: {
  theme: ThemeTokens;
  mode: FavoritesMode;
  /** The active list's raw content offset (rest is `-topInset`). */
  offset: SharedValue<number>;
  topInset: number;
}) {
  const recent = useSharedValue(mode === "recent" ? 1 : 0);
  useEffect(() => {
    recent.set(withTiming(mode === "recent" ? 1 : 0, WASH_FADE));
  }, [mode, recent]);

  const followStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: -Math.max(0, offset.value + topInset) }],
  }));
  const favoritesStyle = useAnimatedStyle(() => ({ opacity: 1 - recent.value }));
  const recentStyle = useAnimatedStyle(() => ({ opacity: recent.value }));

  // Lighter on white, where the same tint reads much stronger.
  const dark = theme.scheme === "dark";
  return (
    <Animated.View pointerEvents="none" style={[styles.wash, followStyle]}>
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: washGradient(
              modeColor(theme, "favorites"),
              dark ? 0.34 : 0.18,
            ),
          },
          favoritesStyle,
        ]}
      />
      <Animated.View
        style={[
          StyleSheet.absoluteFill,
          {
            experimental_backgroundImage: washGradient(
              modeColor(theme, "recent"),
              dark ? 0.3 : 0.16,
            ),
          },
          recentStyle,
        ]}
      />
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wash: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    height: WASH_HEIGHT,
  },
});
