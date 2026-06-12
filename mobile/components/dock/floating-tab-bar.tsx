import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import type { BottomTabBarProps } from "@react-navigation/bottom-tabs";
import { DOCK, useDockColors, useDockControls } from "./dock-context";
import { DockSurface } from "./dock-surface";

type SymbolName = Parameters<typeof SymbolView>[0]["name"];

const TAB_ICONS: Record<string, SymbolName> = {
  "(library)": "music.note.list",
  "(playlists)": "music.note",
  "(favorites)": "heart.fill",
  "(settings)": "gearshape",
};

// One-way slide for the active-tab capsule: fast ease-out, no overshoot.
const CAPSULE_TIMING = {
  duration: 180,
  easing: Easing.out(Easing.cubic),
} as const;

const TAB_COUNT = Object.keys(TAB_ICONS).length;

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);

/**
 * Instagram-style icon-only pill tab bar. A lighter capsule highlights the
 * active tab and springs between fixed-width icon slots; the pill's height
 * tracks the dock's collapse progress (expanded 64 → compact 52).
 */
export function FloatingTabBar({
  state,
  descriptors,
  navigation,
}: BottomTabBarProps) {
  const { collapseProgress, expand } = useDockControls();
  const colors = useDockColors();
  const reducedMotion = useReducedMotion();
  const capsuleIndex = useSharedValue(state.index);

  useEffect(() => {
    capsuleIndex.value = reducedMotion
      ? state.index
      : withTiming(state.index, CAPSULE_TIMING);
  }, [capsuleIndex, reducedMotion, state.index]);

  const pillStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value;
    const h = interpolate(
      p,
      [0, 1],
      [DOCK.tabBarHeight, DOCK.tabBarHeightCompact],
      Extrapolation.CLAMP,
    );
    const slot = interpolate(
      p,
      [0, 1],
      [DOCK.tabItemWidth, DOCK.tabItemWidthCompact],
      Extrapolation.CLAMP,
    );
    return {
      height: h,
      borderRadius: h / 2,
      width: slot * TAB_COUNT + DOCK.tabPillHPadding * 2,
    };
  });

  const itemStyle = useAnimatedStyle(() => ({
    width: interpolate(
      collapseProgress.value,
      [0, 1],
      [DOCK.tabItemWidth, DOCK.tabItemWidthCompact],
      Extrapolation.CLAMP,
    ),
  }));

  const capsuleStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value;
    const h = interpolate(
      p,
      [0, 1],
      [DOCK.capsuleHeight, DOCK.capsuleHeightCompact],
      Extrapolation.CLAMP,
    );
    const w = interpolate(
      p,
      [0, 1],
      [DOCK.capsuleWidth, DOCK.capsuleWidthCompact],
      Extrapolation.CLAMP,
    );
    const slot = interpolate(
      p,
      [0, 1],
      [DOCK.tabItemWidth, DOCK.tabItemWidthCompact],
      Extrapolation.CLAMP,
    );
    return {
      height: h,
      width: w,
      borderRadius: h / 2,
      transform: [
        {
          translateX:
            DOCK.tabPillHPadding +
            capsuleIndex.value * slot +
            (slot - w) / 2,
        },
      ],
    };
  });

  const iconStyle = useAnimatedStyle(() => ({
    transform: [
      {
        scale: interpolate(
          collapseProgress.value,
          [0, 1],
          [1, DOCK.iconCompactScale],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  return (
    <Animated.View
      style={[
        styles.pill,
        { borderColor: colors.border, boxShadow: colors.shadow },
        pillStyle,
      ]}
    >
      <DockSurface />
      <View pointerEvents="none" style={styles.capsuleHost}>
        <Animated.View
          style={[
            styles.capsule,
            { backgroundColor: colors.capsule },
            capsuleStyle,
          ]}
        />
      </View>
      <View style={styles.row}>
        {state.routes.map((route, index) => {
          const isFocused = state.index === index;
          const options = descriptors[route.key]?.options;
          const icon = TAB_ICONS[route.name];
          if (!icon) return null;

          const onPress = () => {
            void Haptics.selectionAsync();
            expand();
            const event = navigation.emit({
              type: "tabPress",
              target: route.key,
              canPreventDefault: true,
            });
            if (!isFocused && !event.defaultPrevented) {
              navigation.navigate(route.name, route.params);
            }
          };

          const onLongPress = () => {
            navigation.emit({ type: "tabLongPress", target: route.key });
          };

          return (
            <AnimatedPressable
              key={route.key}
              onPress={onPress}
              onLongPress={onLongPress}
              hitSlop={{ top: 8, bottom: 8 }}
              accessibilityRole="button"
              accessibilityState={{ selected: isFocused }}
              accessibilityLabel={options?.title ?? route.name}
              style={[styles.item, itemStyle]}
            >
              <Animated.View style={iconStyle}>
                <SymbolView
                  name={icon}
                  size={DOCK.iconSize}
                  tintColor={isFocused ? colors.active : colors.inactive}
                />
              </Animated.View>
            </AnimatedPressable>
          );
        })}
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  pill: {
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  capsuleHost: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
  },
  capsule: {
    borderCurve: "continuous",
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: DOCK.tabPillHPadding,
  },
  item: {
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
});
