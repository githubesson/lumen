import { useCallback, useEffect, useRef, useState } from "react";
import {
  AppState,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import Slider from "@react-native-community/slider";
import type { TimeState } from "@music-library/core";
import { formatDurationSec } from "../../lib/format";
import { useTheme } from "../../theme/theme";

const PROGRESS_DISPLAY_INTERVAL_MS = 250;

/**
 * Playback scrubber: a translucent slider with elapsed/remaining labels
 * underneath. Runs its own smooth display clock (see
 * `useEstimatedPlaybackTime`) on top of the core's quantized time, and only
 * calls `onSeek` with the committed position when the drag ends.
 */
export function ProgressScrubber({
  time,
  isPlaying,
  onSeek,
  style,
}: {
  time: TimeState;
  isPlaying: boolean;
  /** Receives the committed position in seconds after a drag ends. */
  onSeek: (seconds: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const { displayTime, progress, remaining, beginSeek, previewSeek, commitSeek } =
    useEstimatedPlaybackTime(time, isPlaying);

  return (
    <View style={[styles.container, style]}>
      <Slider
        value={progress}
        minimumValue={0}
        maximumValue={1}
        onSlidingStart={beginSeek}
        onValueChange={previewSeek}
        onSlidingComplete={(value) => {
          const next = commitSeek(value);
          if (time.duration > 0) onSeek(next);
        }}
        minimumTrackTintColor={theme.color.overlayStrong}
        maximumTrackTintColor={theme.color.overlayMuted}
        thumbTintColor="transparent"
      />
      <View style={styles.timesRow}>
        <Text style={[styles.timeText, { color: theme.color.fgMuted }]}>
          {formatDurationSec(displayTime)}
        </Text>
        <Text style={[styles.timeText, { color: theme.color.fgMuted }]}>
          {"-" + formatDurationSec(remaining)}
        </Text>
      </View>
    </View>
  );
}

/**
 * Smooth display time interpolated on top of the core's deliberately
 * quantized 250ms clock. Stays local to this component: an anchor of
 * (core time, wall time) is re-based whenever the core reports, and a UI
 * interval estimates in between while playing in the foreground. While the
 * user drags the scrubber (`beginSeek`..`commitSeek`) the estimator is
 * paused and the dragged value is shown instead.
 */
function useEstimatedPlaybackTime(time: TimeState, isPlaying: boolean) {
  const [appState, setAppState] = useState(() => AppState.currentState);
  const [displayTime, setDisplayTime] = useState(time.currentTime);
  const seekingRef = useRef(false);
  const anchorRef = useRef({
    baseTime: time.currentTime,
    wallTime: performance.now(),
  });

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    anchorRef.current = {
      baseTime: time.currentTime,
      wallTime: performance.now(),
    };
    if (!isPlaying || seekingRef.current) {
      setDisplayTime(time.currentTime);
    }
  }, [isPlaying, time.currentTime]);

  useEffect(() => {
    if (appState !== "active" || !isPlaying || seekingRef.current) {
      return;
    }
    const tick = () => {
      const { baseTime, wallTime } = anchorRef.current;
      const elapsed = (performance.now() - wallTime) / 1000;
      const next =
        time.duration > 0
          ? Math.min(baseTime + elapsed, time.duration)
          : baseTime + elapsed;
      setDisplayTime((prev) => (Math.abs(prev - next) < 0.05 ? prev : next));
    };
    tick();
    const interval = setInterval(tick, PROGRESS_DISPLAY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [appState, isPlaying, time.duration, time.currentTime]);

  const beginSeek = useCallback(() => {
    seekingRef.current = true;
  }, []);

  const previewSeek = useCallback(
    (value: number) => {
      if (time.duration <= 0) return;
      setDisplayTime(value * time.duration);
    },
    [time.duration],
  );

  /** Returns the committed time in seconds; the caller issues the seek. */
  const commitSeek = useCallback(
    (value: number) => {
      const next = time.duration > 0 ? value * time.duration : 0;
      anchorRef.current = {
        baseTime: next,
        wallTime: performance.now(),
      };
      setDisplayTime(next);
      seekingRef.current = false;
      return next;
    },
    [time.duration],
  );

  const progress =
    time.duration > 0 ? Math.min(1, displayTime / time.duration) : 0;
  const remaining = Math.max(0, (time.duration || 0) - displayTime);

  return { displayTime, progress, remaining, beginSeek, previewSeek, commitSeek };
}

const styles = StyleSheet.create({
  container: {
    width: "100%",
  },
  timesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 2,
  },
  timeText: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
