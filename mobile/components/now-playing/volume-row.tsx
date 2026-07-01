import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Animated, {
  runOnJS,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

const VOLUME_UPDATE_INTERVAL_MS = 80;

/**
 * Volume control row: quiet/loud speaker glyphs flanking the gesture-driven
 * volume bar. Drag updates are throttled before reaching `onSetVolume` so
 * the player isn't flooded, with the final value always committed on release.
 */
export function VolumeRow({
  value,
  onSetVolume,
  style,
}: {
  /** Current volume in 0..1 (pass 0 when muted). */
  value: number;
  onSetVolume: (value: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const volumeChange = useThrottledVolumeChange(onSetVolume);

  return (
    <View style={[styles.row, style]}>
      <SymbolView
        name="speaker.fill"
        size={13}
        tintColor={theme.color.fgMuted}
      />
      <VolumeBar
        value={value}
        onChange={volumeChange.change}
        onChangeEnd={volumeChange.commit}
      />
      <SymbolView
        name="speaker.wave.3.fill"
        size={17}
        tintColor={theme.color.fgMuted}
      />
    </View>
  );
}

function useThrottledVolumeChange(setVolume: (value: number) => void) {
  const lastUpdateRef = useRef(0);
  const pendingValueRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimer = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearPendingTimer, [clearPendingTimer]);

  const flushPending = useCallback(() => {
    timerRef.current = null;
    const pending = pendingValueRef.current;
    if (pending == null) return;
    pendingValueRef.current = null;
    lastUpdateRef.current = performance.now();
    setVolume(pending);
  }, [setVolume]);

  const change = useCallback(
    (value: number) => {
      const now = performance.now();
      const elapsed = now - lastUpdateRef.current;

      if (elapsed >= VOLUME_UPDATE_INTERVAL_MS) {
        clearPendingTimer();
        pendingValueRef.current = null;
        lastUpdateRef.current = now;
        setVolume(value);
        return;
      }

      pendingValueRef.current = value;
      if (!timerRef.current) {
        timerRef.current = setTimeout(
          flushPending,
          VOLUME_UPDATE_INTERVAL_MS - elapsed,
        );
      }
    },
    [clearPendingTimer, flushPending, setVolume],
  );

  const commit = useCallback(
    (value: number) => {
      clearPendingTimer();
      pendingValueRef.current = null;
      lastUpdateRef.current = performance.now();
      setVolume(value);
    },
    [clearPendingTimer, setVolume],
  );

  return useMemo(() => ({ change, commit }), [change, commit]);
}

/**
 * The bar itself: a pan gesture over a translucent track that thickens while
 * active and animates back to the reported value when idle.
 */
function VolumeBar({
  value,
  onChange,
  onChangeEnd,
}: {
  value: number;
  onChange: (value: number) => void;
  onChangeEnd: (value: number) => void;
}) {
  const theme = useTheme();
  const width = useSharedValue(0);
  const progress = useSharedValue(Math.max(0, Math.min(1, value)));
  const active = useSharedValue(0);

  useEffect(() => {
    if (active.value === 0) {
      progress.value = withTiming(Math.max(0, Math.min(1, value)), {
        duration: 120,
      });
    }
  }, [value, active, progress]);

  const gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((event) => {
      "worklet";
      active.value = withSpring(1, { damping: 18, stiffness: 260 });
      const availableWidth = width.value;
      if (availableWidth > 0) {
        const next = Math.max(0, Math.min(1, event.x / availableWidth));
        progress.value = next;
        runOnJS(onChange)(next);
      }
    })
    .onUpdate((event) => {
      "worklet";
      const availableWidth = width.value;
      if (availableWidth > 0) {
        const next = Math.max(0, Math.min(1, event.x / availableWidth));
        progress.value = next;
        runOnJS(onChange)(next);
      }
    })
    .onFinalize(() => {
      "worklet";
      active.value = withSpring(0, { damping: 20, stiffness: 240 });
      runOnJS(onChangeEnd)(progress.value);
    });

  const trackStyle = useAnimatedStyle(() => {
    const height = 4 + active.value * 6;
    return {
      height,
      borderRadius: height / 2,
    };
  });

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={styles.hit}>
        <Animated.View
          onLayout={(event) => {
            width.value = event.nativeEvent.layout.width;
          }}
          style={[
            styles.track,
            trackStyle,
            { backgroundColor: theme.color.overlayMuted },
          ]}
        >
          <Animated.View
            style={[
              styles.fill,
              fillStyle,
              { backgroundColor: theme.color.overlayStrong },
            ]}
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  hit: {
    flex: 1,
    height: 28,
    justifyContent: "center",
  },
  track: {
    width: "100%",
    overflow: "hidden",
  },
  fill: {
    height: "100%",
  },
});
