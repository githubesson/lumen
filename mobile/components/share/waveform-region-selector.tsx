import { useCallback, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { useTheme } from "../../theme/theme";
import { selectionTint } from "./selection-tint";

const WAVEFORM_BARS = 64;

/**
 * Decorative waveform strip with a draggable highlighted region for picking
 * the share snippet. Dragging centers the region on the finger (clamped to
 * `maxStartSec`); a thin playhead tracks the preview position.
 */
export function WaveformRegionSelector({
  durationSec,
  startSec,
  endSec,
  currentSec,
  maxStartSec,
  onStartChange,
  style,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  currentSec: number;
  maxStartSec: number;
  onStartChange: (seconds: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const bars = useMemo(() => buildWaveformBars(WAVEFORM_BARS), []);
  const selectionStart = durationSec > 0 ? startSec / durationSec : 0;
  const selectionEnd = durationSec > 0 ? endSec / durationSec : 0;
  const playhead = durationSec > 0 ? currentSec / durationSec : selectionStart;

  const setFromX = useCallback(
    (x: number) => {
      const availableWidth = widthRef.current;
      if (availableWidth <= 0 || durationSec <= 0) return;
      const ratio = Math.max(0, Math.min(1, x / availableWidth));
      const centered = ratio * durationSec - (endSec - startSec) / 2;
      onStartChange(Math.max(0, Math.min(maxStartSec, centered)));
    },
    [durationSec, endSec, maxStartSec, onStartChange, startSec],
  );

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => durationSec > 0,
        onMoveShouldSetPanResponder: () => durationSec > 0,
        onPanResponderGrant: (event) => {
          setFromX(event.nativeEvent.locationX);
          void Haptics.selectionAsync();
        },
        onPanResponderMove: (event) => {
          setFromX(event.nativeEvent.locationX);
        },
      }),
    [durationSec, setFromX],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    widthRef.current = nextWidth;
    setWidth(nextWidth);
  }, []);

  const left = width * selectionStart;
  const selectedWidth = Math.max(18, width * Math.max(0.015, selectionEnd - selectionStart));
  const playheadLeft = width * Math.max(0, Math.min(1, playhead));

  return (
    <View
      onLayout={onLayout}
      pointerEvents="box-only"
      {...panResponder.panHandlers}
      style={[
        styles.waveform,
        styles.dragSurface,
        {
          backgroundColor: theme.color.bg,
          borderColor: theme.color.separator,
        },
        style,
      ]}
    >
      <View style={styles.waveformBars}>
        {bars.map((height, index) => {
          const center = (index + 0.5) / bars.length;
          const selected = center >= selectionStart && center <= selectionEnd;
          return (
            <View
              key={index}
              style={[
                styles.waveformBar,
                {
                  height,
                  backgroundColor: selected
                    ? theme.color.accent
                    : theme.color.bgElev2,
                },
              ]}
            />
          );
        })}
      </View>
      {width > 0 ? (
        <>
          <View
            pointerEvents="none"
            style={[
              styles.selectionRegion,
              {
                left,
                width: selectedWidth,
                borderColor: theme.color.accent,
                backgroundColor: selectionTint(theme.scheme),
              },
            ]}
          >
            <View
              style={[
                styles.selectionHandle,
                { backgroundColor: theme.color.accent, left: -2 },
              ]}
            />
            <View
              style={[
                styles.selectionHandle,
                { backgroundColor: theme.color.accent, right: -2 },
              ]}
            />
          </View>
          <View
            pointerEvents="none"
            style={[
              styles.playhead,
              {
                left: playheadLeft,
                backgroundColor: theme.color.fg,
              },
            ]}
          />
        </>
      ) : null}
    </View>
  );
}

function buildWaveformBars(count: number) {
  return Array.from({ length: count }, (_, index) => {
    const t = index / Math.max(1, count - 1);
    const wave =
      Math.sin(t * Math.PI * 5.4) * 0.26 +
      Math.sin(t * Math.PI * 17.2) * 0.16 +
      Math.sin(t * Math.PI * 29.5) * 0.08;
    return 16 + Math.round((0.54 + wave) * 54);
  });
}

const styles = StyleSheet.create({
  waveform: {
    height: 116,
    borderRadius: 14,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
    overflow: "hidden",
    justifyContent: "center",
    paddingHorizontal: 10,
  },
  dragSurface: {
    userSelect: "none",
  },
  waveformBars: {
    height: 82,
    flexDirection: "row",
    alignItems: "center",
    gap: 2,
  },
  waveformBar: {
    flex: 1,
    minWidth: 2,
    borderRadius: 2,
  },
  selectionRegion: {
    position: "absolute",
    top: 8,
    bottom: 8,
    borderWidth: 2,
    borderRadius: 12,
    borderCurve: "continuous",
  },
  selectionHandle: {
    position: "absolute",
    top: 18,
    bottom: 18,
    width: 4,
    borderRadius: 2,
  },
  playhead: {
    position: "absolute",
    top: 4,
    bottom: 4,
    width: 2,
    opacity: 0.8,
  },
});
