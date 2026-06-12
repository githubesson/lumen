import { useEffect, useState } from "react";
import { Pressable, StyleSheet, Text, View } from "react-native";
import Animated, {
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import * as Haptics from "expo-haptics";
import { useDockColors } from "./dock/dock-context";
import { DockSurface } from "./dock/dock-surface";

interface Option<T extends string> {
  label: string;
  value: T;
}

interface Props<T extends string> {
  options: Option<T>[];
  value: T;
  onChange: (v: T) => void;
}

const HEIGHT = 44;
const CAPSULE_INSET = 4;

// Same one-way slide as the dock's active-tab capsule.
const CAPSULE_TIMING = {
  duration: 180,
  easing: Easing.out(Easing.cubic),
} as const;

/**
 * Segmented switcher dressed like the floating dock: the same DockSurface
 * material (glass under a theme scrim), hairline border, shadow, and a
 * lighter capsule that slides between equal-width text slots.
 */
export function GlassSegmentedControl<T extends string>({
  options,
  value,
  onChange,
}: Props<T>) {
  const colors = useDockColors();
  const reducedMotion = useReducedMotion();
  const [width, setWidth] = useState(0);
  const index = Math.max(
    0,
    options.findIndex((o) => o.value === value),
  );
  const capsuleIndex = useSharedValue(index);

  useEffect(() => {
    capsuleIndex.value = reducedMotion
      ? index
      : withTiming(index, CAPSULE_TIMING);
  }, [capsuleIndex, index, reducedMotion]);

  const slot =
    width > 0 ? (width - CAPSULE_INSET * 2) / options.length : 0;

  const capsuleStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: CAPSULE_INSET + capsuleIndex.value * slot }],
  }));

  return (
    <View
      onLayout={(e) => setWidth(e.nativeEvent.layout.width)}
      style={[
        styles.pill,
        { borderColor: colors.border, boxShadow: colors.shadow },
      ]}
    >
      <DockSurface />
      {slot > 0 && (
        <View pointerEvents="none" style={styles.capsuleHost}>
          <Animated.View
            style={[
              styles.capsule,
              { width: slot, backgroundColor: colors.capsule },
              capsuleStyle,
            ]}
          />
        </View>
      )}
      <View style={styles.row}>
        {options.map((o) => {
          const active = o.value === value;
          return (
            <Pressable
              key={o.value}
              onPress={() => {
                void Haptics.selectionAsync();
                if (!active) onChange(o.value);
              }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
              accessibilityLabel={o.label}
              style={styles.item}
            >
              <Text
                style={{
                  color: active ? colors.active : colors.inactive,
                  fontSize: 15,
                  fontWeight: active ? "600" : "500",
                }}
              >
                {o.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  pill: {
    height: HEIGHT,
    borderRadius: HEIGHT / 2,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  capsuleHost: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: "center",
  },
  capsule: {
    height: HEIGHT - CAPSULE_INSET * 2,
    borderRadius: (HEIGHT - CAPSULE_INSET * 2) / 2,
    borderCurve: "continuous",
  },
  row: {
    flex: 1,
    flexDirection: "row",
    alignItems: "stretch",
    paddingHorizontal: CAPSULE_INSET,
  },
  item: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
