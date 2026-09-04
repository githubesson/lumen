import { useCallback, useEffect, useMemo, useRef } from "react";
import {
  StyleSheet,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Slider from "@react-native-community/slider";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";

const VOLUME_UPDATE_INTERVAL_MS = 80;

/**
 * Volume control row: quiet/loud speaker glyphs flanking the native
 * volume slider. Drag updates are throttled before reaching `onSetVolume` so
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
      <Slider
        style={{ flex: 1, height: 44 }}
        value={value}
        minimumValue={0}
        maximumValue={1}
        step={0.01}
        accessibilityLabel="Volume"
        accessibilityValue={{ min: 0, max: 100, now: Math.round(value * 100), text: `${Math.round(value * 100)} percent` }}
        onValueChange={volumeChange.change}
        onSlidingComplete={volumeChange.commit}
        minimumTrackTintColor={theme.color.overlayStrong}
        maximumTrackTintColor={theme.color.overlayMuted}
        thumbTintColor={theme.color.fg}
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

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
});
