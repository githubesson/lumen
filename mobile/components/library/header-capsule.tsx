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
import { DOCK_CAPSULE_TIMING, useDockColors } from "../dock/dock-context";
import { DockSurface } from "../dock/dock-surface";
import { useTheme } from "../../theme/theme";

const CAPSULE_HEIGHT = 44;
const ACTION_WIDTH = 54;
const CLOSED_WIDTH = 118;
const OPEN_WIDTH = 246;

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
 * plain action (home). The wrapper nudges the capsule toward the screen
 * edge so it sits flush with the large title's margin.
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

  // Width morphs like the dock's own pills (layout animation is the dock's
  // idiom for pill shape changes; content cross-fades use transforms).
  const shellStyle = useAnimatedStyle(() => ({
    width: expandable
      ? interpolate(
          progress.value,
          [0, 1],
          [CLOSED_WIDTH, OPEN_WIDTH],
          Extrapolation.CLAMP,
        )
      : undefined,
  }));
  const closedStyle = useAnimatedStyle(() => ({
    opacity: interpolate(progress.value, [0, 1], [1, 0], Extrapolation.CLAMP),
    transform: [
      {
        scale: interpolate(
          progress.value,
          [0, 1],
          [1, 0.92],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));
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
  const dividerStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      progress.value,
      [0, 1],
      [0.7, 0.38],
      Extrapolation.CLAMP,
    ),
  }));

  return (
    <Animated.View style={[styles.wrap, shellStyle, style]}>
      <View
        style={[
          styles.capsule,
          { borderColor: colors.border, boxShadow: colors.shadow },
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
            <Pressable
              onPress={onSearchPress}
              accessibilityRole="button"
              accessibilityLabel="Search your library"
              style={({ pressed }) => [
                styles.button,
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
          )}
          <Animated.View
            style={[
              styles.divider,
              expandable ? styles.dividerNudge : null,
              expandable ? dividerStyle : null,
              { backgroundColor: colors.border },
            ]}
          />
          <Pressable
            onPress={onUploadPress}
            accessibilityRole="button"
            accessibilityLabel="Upload music"
            style={({ pressed }) => [
              styles.button,
              pressed ? { opacity: 0.6 } : null,
            ]}
          >
            <SymbolView name="plus" size={24} tintColor={colors.active} />
          </Pressable>
        </View>
      </View>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    height: CAPSULE_HEIGHT,
    transform: [{ translateX: 8 }],
  },
  capsule: {
    height: CAPSULE_HEIGHT,
    borderRadius: CAPSULE_HEIGHT / 2,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
  },
  button: {
    width: ACTION_WIDTH,
    height: CAPSULE_HEIGHT,
    alignItems: "center",
    justifyContent: "center",
  },
  searchSlot: {
    flex: 1,
    height: CAPSULE_HEIGHT,
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
    opacity: 0.7,
  },
  dividerNudge: {
    transform: [{ translateX: -4 }],
  },
});
