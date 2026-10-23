import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedReaction,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { SymbolView, type SFSymbol } from "expo-symbols";
import type { ThemeTokens } from "../../theme/theme";
import {
  ACTION_HEIGHT,
  ACTION_ICON_SIZE,
  ACTION_INSET,
  actionContentX,
  actionIconOnly,
  actionWidth,
} from "../../lib/swipe-actions";

export type SwipeActionKind = "next" | "favorite" | "unfavorite";

/**
 * What each swipe does, and its colour: Play Next in the accent, Favorite in
 * systemPink, Unfavorite in systemGray2. Unfavorite is gray rather than red:
 * it can be undone and isn't Delete, and the same motion never looks the same
 * while doing the opposite thing.
 */
export function swipeActionStyle(kind: SwipeActionKind, theme: ThemeTokens) {
  const dark = theme.scheme === "dark";
  switch (kind) {
    case "next":
      return {
        label: "Play Next",
        icon: "text.line.first.and.arrowtriangle.forward" as SFSymbol,
        color: theme.color.accent,
      };
    case "favorite":
      return {
        label: "Favorite",
        icon: "heart.fill" as SFSymbol,
        color: dark ? "#FF375F" : "#FF2D55",
      };
    case "unfavorite":
      return {
        label: "Unfavorite",
        icon: "heart.slash.fill" as SFSymbol,
        // Light mode's systemGray2 is too pale under a white label.
        color: dark ? "#636366" : "#8E8E93",
      };
  }
}

const ICON_POP = 1.22;
const ICON_POP_SPRING = {
  duration: 320,
  dampingRatio: 0.5,
  reduceMotion: ReduceMotion.System,
} as const;

/**
 * The capsule a swipe uncovers: it grows from the screen edge with the row's
 * offset, inset 8 pt from the edge and the row. Its icon and label sit by the
 * screen edge until the swipe passes the commit line, then jump to the row's
 * edge and the icon pops. Too narrow for the label, it shows the icon alone.
 * Left open, it's a button for the same action. Faded out (behind the Undo
 * strip, or until a restored row is back) or `disabled`, it takes no touches.
 */
export function SwipeAction({
  side,
  kind,
  theme,
  rowHeight,
  offset,
  armed,
  armProgress,
  centered,
  fade,
  disabled = false,
  onPress,
}: {
  side: "lead" | "trail";
  kind: SwipeActionKind;
  theme: ThemeTokens;
  rowHeight: number;
  /** The row's offset; positive is swiped right. */
  offset: SharedValue<number>;
  /** Past the commit line. */
  armed: SharedValue<boolean>;
  /** 0 to 1 toward the commit layout, eased behind `armed`. */
  armProgress: SharedValue<number>;
  /** 0 to 1 toward centred content, as a removed row leaves. */
  centered: SharedValue<number>;
  fade: SharedValue<number>;
  disabled?: boolean;
  onPress: () => void;
}) {
  const { label, icon, color } = swipeActionStyle(kind, theme);
  const contentWidth = useSharedValue(0);
  const labelOpacity = useSharedValue(1);
  const iconScale = useSharedValue(1);

  useAnimatedReaction(
    () => actionIconOnly(actionWidth(offset.get()), contentWidth.get()),
    (iconOnly, previous) => {
      if (iconOnly === previous) return;
      labelOpacity.set(
        withTiming(iconOnly ? 0 : 1, { duration: 120, reduceMotion: ReduceMotion.System }),
      );
    },
  );
  useAnimatedReaction(
    () => armed.get(),
    (isArmed, previous) => {
      if (isArmed === previous) return;
      iconScale.set(withSpring(isArmed ? ICON_POP : 1, ICON_POP_SPRING));
    },
  );

  const capsuleStyle = useAnimatedStyle(() => {
    const dx = offset.get();
    const mine = side === "lead" ? dx > 0 : dx < 0;
    const shown = fade.get();
    return {
      width: mine ? actionWidth(dx) : 0,
      opacity: shown,
      // Opacity alone leaves it pressable where it peeks out around the strip.
      pointerEvents: shown < 1 ? "none" : "box-none",
    };
  });
  const contentStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: actionContentX(
          side,
          actionWidth(offset.get()),
          contentWidth.get(),
          armProgress.get(),
          centered.get(),
        ),
      },
    ],
  }));
  const iconStyle = useAnimatedStyle(() => ({
    transform: [{ scale: iconScale.get() }],
  }));
  const labelStyle = useAnimatedStyle(() => ({ opacity: labelOpacity.get() }));

  return (
    <Animated.View
      // The row's accessibility actions stand in for these.
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={[
        styles.capsule,
        {
          top: (rowHeight - ACTION_HEIGHT) / 2,
          backgroundColor: color,
          [side === "lead" ? "left" : "right"]: ACTION_INSET,
        },
        capsuleStyle,
      ]}
    >
      <Pressable onPress={onPress} disabled={disabled} style={StyleSheet.absoluteFill}>
        {({ pressed }) => (
          <>
            <Animated.View style={[styles.track, contentStyle]}>
              <View
                style={styles.content}
                onLayout={(event) => contentWidth.set(event.nativeEvent.layout.width)}
              >
                <Animated.View style={iconStyle}>
                  <SymbolView
                    name={icon}
                    size={ACTION_ICON_SIZE}
                    tintColor="#FFFFFF"
                    style={styles.icon}
                  />
                </Animated.View>
                <Animated.Text numberOfLines={1} style={[styles.label, labelStyle]}>
                  {label}
                </Animated.Text>
              </View>
            </Animated.View>
            {pressed ? <View style={styles.pressed} /> : null}
          </>
        )}
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  capsule: {
    position: "absolute",
    height: ACTION_HEIGHT,
    borderRadius: ACTION_HEIGHT / 2,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  // Wider than any label, so the text is measured at its full width however
  // narrow the capsule is; the capsule clips it.
  track: {
    position: "absolute",
    left: 0,
    top: 0,
    width: 320,
    height: ACTION_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
  },
  content: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  icon: {
    width: ACTION_ICON_SIZE,
    height: ACTION_ICON_SIZE,
  },
  label: {
    color: "#FFFFFF",
    fontSize: 15,
    fontWeight: "600",
    letterSpacing: -0.15,
  },
  // The mock darkens a pressed capsule (brightness .8).
  pressed: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "rgba(0,0,0,0.2)",
  },
});
