import { useEffect, useRef, useState } from "react";
import {
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { DOCK_CAPSULE_TIMING } from "../dock/dock-context";
import { useTheme } from "../../theme/theme";
import { periodKey, periodLabel, type Period } from "./period";

const TRACK_INSET = 4;

type PillLayout = { x: number; width: number };

/**
 * Horizontal pill scroller for choosing the Replay time window, dressed like
 * the dock's segmented family: a filled track with an accent capsule that
 * slides between the pills (the same one-way slide as the active-tab
 * capsule). Selection fires a haptic.
 */
export function PeriodPicker({
  options,
  selected,
  onSelect,
  style,
}: {
  options: Period[];
  selected: Period;
  onSelect: (p: Period) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  // Pills vary in width by label, so the capsule can't use equal slots —
  // measure each pill and drive the capsule's translateX/width instead.
  const [layouts, setLayouts] = useState<Record<string, PillLayout>>({});
  const capsuleX = useSharedValue(0);
  const capsuleW = useSharedValue(0);
  const positioned = useRef(false);

  const target = layouts[periodKey(selected)];

  useEffect(() => {
    if (!target) return;
    const x = TRACK_INSET + target.x;
    if (reducedMotion || !positioned.current) {
      capsuleX.value = x;
      capsuleW.value = target.width;
    } else {
      capsuleX.value = withTiming(x, DOCK_CAPSULE_TIMING);
      capsuleW.value = withTiming(target.width, DOCK_CAPSULE_TIMING);
    }
    positioned.current = true;
  }, [target, reducedMotion, capsuleX, capsuleW]);

  const capsuleStyle = useAnimatedStyle(() => ({
    width: capsuleW.value,
    transform: [{ translateX: capsuleX.value }],
  }));

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      style={style}
      contentContainerStyle={{ paddingHorizontal: theme.space.lg }}
    >
      <View style={[styles.track, { backgroundColor: theme.color.bgElev1 }]}>
        {target ? (
          <Animated.View
            pointerEvents="none"
            style={[
              styles.capsule,
              { backgroundColor: theme.color.accent },
              capsuleStyle,
            ]}
          />
        ) : null}
        <View style={styles.row}>
          {options.map((p) => {
            const key = periodKey(p);
            const active = key === periodKey(selected);
            return (
              <Pressable
                key={key}
                onLayout={(e) => {
                  const { x, width } = e.nativeEvent.layout;
                  setLayouts((prev) => {
                    const current = prev[key];
                    if (current && current.x === x && current.width === width) {
                      return prev;
                    }
                    return { ...prev, [key]: { x, width } };
                  });
                }}
                onPress={() => {
                  void Haptics.selectionAsync();
                  onSelect(p);
                }}
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                accessibilityLabel={periodLabel(p)}
                style={({ pressed }) => [
                  styles.pill,
                  pressed ? { opacity: 0.6 } : null,
                ]}
              >
                <Text
                  style={{
                    color: active ? theme.color.onAccent : theme.color.fg,
                    fontSize: 14,
                    fontWeight: active ? "600" : "500",
                  }}
                >
                  {periodLabel(p)}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  track: {
    borderRadius: 999,
    borderCurve: "continuous",
    padding: TRACK_INSET,
  },
  capsule: {
    position: "absolute",
    left: 0,
    top: TRACK_INSET,
    bottom: TRACK_INSET,
    borderRadius: 999,
    borderCurve: "continuous",
  },
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
  pill: {
    paddingHorizontal: 14,
    paddingVertical: 8,
  },
});
