import { useEffect } from "react";
import { Pressable, StyleSheet, View } from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { DOCK_CAPSULE_TIMING, useDockColors } from "../dock/dock-context";
import { DockSurface } from "../dock/dock-surface";
import {
  FAVORITES_HEADER,
  type FavoritesMode,
} from "../../lib/favorites-header";
import type { ThemeTokens } from "../../theme/theme";

type SymbolName = Parameters<typeof SymbolView>[0]["name"];

/** Each list's name, colour and glyphs. */
export const FAVORITES_MODES: Record<
  FavoritesMode,
  {
    label: string;
    /** The switch's (filled) glyph and its point size at the docked size. */
    switchIcon: SymbolName;
    switchIconSize: number;
    /** The glyph beside the inline title and the count line. */
    icon: SymbolName;
  }
> = {
  favorites: {
    label: "Favorites",
    switchIcon: "heart.fill",
    switchIconSize: 21,
    icon: "heart.fill",
  },
  recent: {
    label: "Recent",
    switchIcon: "clock.fill",
    switchIconSize: 22,
    icon: "clock",
  },
};

const ORDER: FavoritesMode[] = ["favorites", "recent"];

/** Favorites is the brand purple, Recent the accent blue. */
export function modeColor(theme: ThemeTokens, mode: FavoritesMode): string {
  return mode === "favorites" ? theme.color.brand : theme.color.accent;
}

/** Docked metrics; `scale` multiplies all of them. */
const INSET = 4;
const SLOT = (FAVORITES_HEADER.switchWidth - INSET * 2) / ORDER.length;
const CAPSULE_HEIGHT = FAVORITES_HEADER.switchHeight - INSET * 2;

/**
 * The heart | clock switch between the two lists: the dock's material (glass
 * under its scrim, hairline border, shadow) and its sliding capsule, with the
 * active glyph in its list's colour. A tab list for VoiceOver.
 *
 * `scale` sizes it by layout (crisper than a transform scale-up); the header
 * renders it at the expanded size and shrinks it by transform as it docks.
 * Fading never touches the glass's ancestors (alpha there drops the effect for
 * good): pass `hidden` and `fadeProgress` (0 shown, 1 hidden) and the glass
 * fades natively while the other layers fade as plain views.
 */
export function ModeSwitch({
  theme,
  mode,
  onChange,
  scale = 1,
  hidden = false,
  fadeProgress,
}: {
  theme: ThemeTokens;
  mode: FavoritesMode;
  onChange: (mode: FavoritesMode) => void;
  scale?: number;
  hidden?: boolean;
  fadeProgress?: SharedValue<number>;
}) {
  const colors = useDockColors();
  const reducedMotion = useReducedMotion();
  const index = ORDER.indexOf(mode);
  const capsuleIndex = useSharedValue(index);

  useEffect(() => {
    capsuleIndex.set(
      reducedMotion ? index : withTiming(index, DOCK_CAPSULE_TIMING),
    );
  }, [capsuleIndex, index, reducedMotion]);

  const width = FAVORITES_HEADER.switchWidth * scale;
  const height = FAVORITES_HEADER.switchHeight * scale;
  const inset = INSET * scale;
  const slot = SLOT * scale;
  const capsuleHeight = CAPSULE_HEIGHT * scale;
  const radius = height / 2;

  const capsuleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: inset + capsuleIndex.value * slot }],
  }));
  const fadeStyle = useAnimatedStyle(() => ({
    opacity: fadeProgress ? 1 - fadeProgress.value : 1,
  }));

  const round = { borderRadius: radius, borderCurve: "continuous" } as const;

  return (
    <View
      // iOS's tab list: VoiceOver reads each glyph as "Tab, 1 of 2".
      accessibilityRole="tabbar"
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      pointerEvents={hidden ? "none" : "box-none"}
      style={{ width, height }}
    >
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, round, { boxShadow: colors.shadow }, fadeStyle]}
      />
      <View pointerEvents="none" style={[StyleSheet.absoluteFill, round, styles.clip]}>
        <DockSurface hidden={hidden} fadeProgress={fadeProgress} />
      </View>
      <Animated.View
        pointerEvents="none"
        style={[
          StyleSheet.absoluteFill,
          round,
          styles.border,
          { borderColor: colors.border },
          fadeStyle,
        ]}
      />
      <Animated.View
        pointerEvents="none"
        style={[StyleSheet.absoluteFill, fadeStyle]}
      >
        <Animated.View
          style={[
            styles.capsule,
            {
              top: inset,
              width: slot,
              height: capsuleHeight,
              borderRadius: capsuleHeight / 2,
              backgroundColor: colors.capsule,
            },
            capsuleStyle,
          ]}
        />
      </Animated.View>
      <Animated.View style={[styles.row, { paddingHorizontal: inset }, fadeStyle]}>
        {ORDER.map((option) => {
          const selected = option === mode;
          const meta = FAVORITES_MODES[option];
          return (
            <Pressable
              key={option}
              accessibilityRole="tab"
              accessibilityLabel={meta.label}
              accessibilityState={{ selected }}
              hitSlop={{ top: 6, bottom: 6 }}
              onPress={() => {
                if (selected) return;
                void Haptics.selectionAsync();
                onChange(option);
              }}
              style={[styles.item, { width: slot }]}
            >
              <SymbolView
                name={meta.switchIcon}
                size={meta.switchIconSize * scale}
                tintColor={selected ? modeColor(theme, option) : colors.inactive}
              />
            </Pressable>
          );
        })}
      </Animated.View>
    </View>
  );
}

const styles = StyleSheet.create({
  clip: {
    overflow: "hidden",
  },
  border: {
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    ...StyleSheet.absoluteFill,
    flexDirection: "row",
    alignItems: "stretch",
  },
  capsule: {
    position: "absolute",
    left: 0,
    borderCurve: "continuous",
  },
  item: {
    alignItems: "center",
    justifyContent: "center",
  },
});
