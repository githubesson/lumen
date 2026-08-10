import { useEffect, type RefObject } from "react";
import {
  Pressable,
  StyleSheet,
  TextInput,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  DOCK_CAPSULE_TIMING,
  useDockColors,
  useDockControls,
} from "../dock/dock-context";
import { DockSurface } from "../dock/dock-surface";
import { useTheme } from "../../theme/theme";

const CAPSULE_HEIGHT = 44;
const CAPSULE_HEIGHT_COMPACT = 36;
const ACTION_WIDTH = 54;
const ACTION_WIDTH_COMPACT = 46;
const CLOSED_WIDTH = 118;
const CLOSED_WIDTH_COMPACT = 100;
const OPEN_WIDTH = 246;
const OPEN_WIDTH_COMPACT = 208;
// Same content shrink as the dock's icons (DOCK.iconCompactScale).
const ICON_COMPACT_SCALE = 0.85;

interface SearchSlot {
  open: boolean;
  value: string;
  inputRef: RefObject<TextInput | null>;
  onChangeText: (value: string) => void;
  onClear: () => void;
}

/**
 * Glass capsule for a large-title header's right slot: search and upload
 * actions over the dock's material (DockSurface, hairline border, shadow),
 * separated by a hairline divider. With `search` set, the capsule expands
 * in place into a search field (browse); without it the search button is a
 * plain action (home).
 *
 * Like the dock, the capsule compacts on scroll down and expands on scroll
 * up — it consumes the same collapseProgress, so the scroll hysteresis,
 * spring, and haptic are the dock's own. Collapse is suppressed while the
 * search field is open so the input never shrinks under the user's fingers.
 * The morph is layout-only (height/width/radius, like the tab pill's):
 * transforms above the glass desync it from the scrim (the double-capsule
 * ghost). Icon/content shrink uses transforms BELOW the glass only.
 *
 * The wrapper nudges the capsule toward the screen edge so it sits flush
 * with the large title's margin — via margin, never a transform, for the
 * same glass-desync reason.
 *
 * Action haptics fire at the call sites (they own the navigation side
 * effects); the capsule owns only the clear/close button's haptic.
 */
export function HeaderCapsule({
  onSearchPress,
  onUploadPress,
  search,
  style,
}: {
  onSearchPress: () => void;
  onUploadPress: () => void;
  search?: SearchSlot;
  style?: StyleProp<ViewStyle>;
}) {
  const colors = useDockColors();
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const { collapseProgress } = useDockControls();
  // Destructured up front: the lint refs rule treats member access on an
  // object holding a ref as a ref read during render.
  const expandable = search != null;
  const open = search?.open ?? false;
  const query = search?.value ?? "";
  const inputRef = search?.inputRef;
  const onChangeText = search?.onChangeText;
  const onClear = search?.onClear;
  const progress = useSharedValue(open ? 1 : 0);

  useEffect(() => {
    if (!expandable) return;
    const target = open ? 1 : 0;
    progress.value = reducedMotion
      ? target
      : withTiming(target, DOCK_CAPSULE_TIMING);
  }, [progress, reducedMotion, open, expandable]);

  // Every style below derives the same way: p = dock collapse progress,
  // zeroed while the search field is open (progress = open/close).
  const capsuleStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value * (1 - progress.value);
    const h = interpolate(
      p,
      [0, 1],
      [CAPSULE_HEIGHT, CAPSULE_HEIGHT_COMPACT],
      Extrapolation.CLAMP,
    );
    return { height: h, borderRadius: h / 2 };
  });

  const shellStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value * (1 - progress.value);
    return {
      width: expandable
        ? interpolate(
            progress.value,
            [0, 1],
            [
              interpolate(
                p,
                [0, 1],
                [CLOSED_WIDTH, CLOSED_WIDTH_COMPACT],
                Extrapolation.CLAMP,
              ),
              interpolate(
                p,
                [0, 1],
                [OPEN_WIDTH, OPEN_WIDTH_COMPACT],
                Extrapolation.CLAMP,
              ),
            ],
            Extrapolation.CLAMP,
          )
        : undefined,
    };
  });

  const actionStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value * (1 - progress.value);
    return {
      width: interpolate(
        p,
        [0, 1],
        [ACTION_WIDTH, ACTION_WIDTH_COMPACT],
        Extrapolation.CLAMP,
      ),
    };
  });

  const iconScale = useAnimatedStyle(() => {
    const p = collapseProgress.value * (1 - progress.value);
    return {
      transform: [
        { scale: interpolate(p, [0, 1], [1, ICON_COMPACT_SCALE], Extrapolation.CLAMP) },
      ],
    };
  });

  const closedStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value * (1 - progress.value);
    return {
      opacity: interpolate(progress.value, [0, 1], [1, 0], Extrapolation.CLAMP),
      transform: [
        {
          scale:
            interpolate(progress.value, [0, 1], [1, 0.92], Extrapolation.CLAMP) *
            interpolate(p, [0, 1], [1, ICON_COMPACT_SCALE], Extrapolation.CLAMP),
        },
      ],
    };
  });

  const openStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [0, 1], Extrapolation.CLAMP),
    transform: [
      {
        translateX: interpolate(
          progress.value,
          [0, 1],
          [10, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const dividerStyle = useAnimatedStyle(() => {
    const p = collapseProgress.value * (1 - progress.value);
    return {
      opacity: interpolate(progress.value, [0, 1], [0.7, 0.38], Extrapolation.CLAMP),
      transform: [
        { scale: interpolate(p, [0, 1], [1, ICON_COMPACT_SCALE], Extrapolation.CLAMP) },
      ],
    };
  });

  return (
    <Animated.View style={[styles.wrap, shellStyle, style]}>
      <Animated.View
        style={[
          styles.capsule,
          { borderColor: colors.border, boxShadow: colors.shadow },
          capsuleStyle,
        ]}
      >
        <DockSurface />
        <View style={styles.row}>
          {expandable ? (
            <View style={styles.searchSlot}>
              <Animated.View
                pointerEvents={open ? "none" : "auto"}
                style={[StyleSheet.absoluteFill, closedStyle]}
              >
                <Pressable
                  onPress={onSearchPress}
                  accessibilityRole="button"
                  accessibilityLabel="Open search"
                  style={({ pressed }) => [
                    styles.searchClosedButton,
                    pressed ? { opacity: 0.6 } : null,
                  ]}
                >
                  <SymbolView
                    name="magnifyingglass"
                    size={21}
                    weight="semibold"
                    tintColor={colors.active}
                  />
                </Pressable>
              </Animated.View>
              <Animated.View
                pointerEvents={open ? "auto" : "none"}
                style={[styles.searchOpen, openStyle]}
              >
                <View style={styles.searchOpenRow}>
                  <SymbolView
                    name="magnifyingglass"
                    size={18}
                    weight="semibold"
                    tintColor={colors.muted}
                  />
                  <View style={styles.searchInputWrap}>
                    <TextInput
                      ref={inputRef}
                      value={query}
                      onChangeText={onChangeText}
                      placeholder="Search"
                      placeholderTextColor={colors.muted}
                      autoCapitalize="none"
                      autoCorrect={false}
                      returnKeyType="search"
                      selectionColor={theme.color.accent}
                      keyboardAppearance={theme.scheme}
                      style={[styles.searchInput, { color: colors.active }]}
                    />
                  </View>
                  <Pressable
                    onPress={() => {
                      void Haptics.selectionAsync();
                      onClear?.();
                    }}
                    accessibilityRole="button"
                    accessibilityLabel={
                      query.length > 0 ? "Clear search" : "Close search"
                    }
                    style={({ pressed }) => [
                      styles.searchClearButton,
                      pressed ? { opacity: 0.6 } : null,
                    ]}
                  >
                    <SymbolView
                      name={query.length > 0 ? "xmark.circle.fill" : "xmark"}
                      size={query.length > 0 ? 18 : 15}
                      weight="semibold"
                      tintColor={colors.muted}
                    />
                  </Pressable>
                </View>
              </Animated.View>
            </View>
          ) : (
            <Animated.View style={[styles.actionSlot, actionStyle]}>
              <Pressable
                onPress={onSearchPress}
                accessibilityRole="button"
                accessibilityLabel="Search your library"
                style={({ pressed }) => [
                  styles.action,
                  pressed ? { opacity: 0.6 } : null,
                ]}
              >
                <Animated.View style={iconScale}>
                  <SymbolView
                    name="magnifyingglass"
                    size={21}
                    weight="semibold"
                    tintColor={colors.active}
                  />
                </Animated.View>
              </Pressable>
            </Animated.View>
          )}
          <Animated.View
            style={[
              styles.divider,
              expandable ? styles.dividerNudge : null,
              dividerStyle,
              { backgroundColor: colors.border },
            ]}
          />
          <Animated.View style={[styles.actionSlot, actionStyle]}>
            <Pressable
              onPress={onUploadPress}
              accessibilityRole="button"
              accessibilityLabel="Upload music"
              style={({ pressed }) => [
                styles.action,
                pressed ? { opacity: 0.6 } : null,
              ]}
            >
              <Animated.View style={iconScale}>
                <SymbolView name="plus" size={24} tintColor={colors.active} />
              </Animated.View>
            </Pressable>
          </Animated.View>
        </View>
      </Animated.View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    marginRight: -8,
  },
  capsule: {
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  actionSlot: {
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  action: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  searchSlot: {
    flex: 1,
    height: "100%",
  },
  searchClosedButton: {
    width: "100%",
    height: "100%",
    alignItems: "center",
    justifyContent: "center",
  },
  searchOpen: {
    ...StyleSheet.absoluteFill,
    justifyContent: "center",
    paddingLeft: 14,
    paddingRight: 8,
  },
  searchOpenRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  searchInputWrap: {
    flex: 1,
  },
  searchInput: {
    fontSize: 15,
    paddingVertical: 0,
  },
  searchClearButton: {
    width: 28,
    height: 28,
    alignItems: "center",
    justifyContent: "center",
  },
  divider: {
    width: StyleSheet.hairlineWidth,
    height: 18,
  },
  dividerNudge: {
    transform: [{ translateX: -4 }],
  },
});
