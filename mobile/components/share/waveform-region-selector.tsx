import {
  adjustSnippetWindow,
  snippetDragTarget,
  snippetHandleBounds,
} from "@music-library/core/share-snippet";
import { useCallback, useMemo, useRef, useState } from "react";
import {
  PanResponder,
  StyleSheet,
  View,
  type LayoutChangeEvent,
  type StyleProp,
  type TextStyle,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { formatDurationSec } from "../../lib/format";
import { useTheme } from "../../theme/theme";
import { selectionTint } from "./selection-tint";

const WAVEFORM_BARS = 64;
const ADJUST_ACTIONS = [
  { name: "decrement" as const, label: "Move one second earlier" },
  { name: "increment" as const, label: "Move one second later" },
];

type DragState = {
  kind: "start" | "end" | "window";
  grabOffsetSec: number;
  anchorStartSec: number;
  anchorEndSec: number;
};

/**
 * Waveform clip-window picker matching desktop: drag either edge to resize the
 * snippet, drag its middle to move it without changing its length, or tap
 * outside the selection to center it there. A thin playhead tracks preview.
 */
export function WaveformRegionSelector({
  durationSec,
  startSec,
  endSec,
  currentSec,
  maxStartSec,
  minSnippetDurationSec,
  maxSnippetDurationSec,
  onWindowChange,
  style,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  currentSec: number;
  maxStartSec: number;
  minSnippetDurationSec: number;
  maxSnippetDurationSec: number;
  onWindowChange: (startSec: number, durationSec: number) => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const [width, setWidth] = useState(0);
  const widthRef = useRef(0);
  const dragRef = useRef<DragState | null>(null);
  const bars = useMemo(() => buildWaveformBars(WAVEFORM_BARS), []);
  const selectionStart = durationSec > 0 ? startSec / durationSec : 0;
  const selectionEnd = durationSec > 0 ? endSec / durationSec : 0;
  const playhead = durationSec > 0 ? currentSec / durationSec : selectionStart;

  const updateDrag = useCallback(
    (x: number) => {
      const drag = dragRef.current;
      const availableWidth = widthRef.current;
      if (!drag || availableWidth <= 0 || durationSec <= 0) return;
      const ratio = Math.max(0, Math.min(1, x / availableWidth));
      const atSec = ratio * durationSec - drag.grabOffsetSec;

      const next = adjustSnippetWindow({
        kind: drag.kind,
        atSec,
        startSec: drag.anchorStartSec,
        endSec: drag.anchorEndSec,
        durationSec,
        minDurationSec: minSnippetDurationSec,
        maxDurationSec: maxSnippetDurationSec,
        maxStartSec,
      });
      onWindowChange(next.startSec, next.durationSec);
    },
    [
      durationSec,
      maxSnippetDurationSec,
      maxStartSec,
      minSnippetDurationSec,
      onWindowChange,
    ],
  );

  const beginDrag = useCallback(
    (x: number) => {
      const availableWidth = widthRef.current;
      if (availableWidth <= 0 || durationSec <= 0) return;
      const { kind, grabOffsetSec, recenter } = snippetDragTarget({
        atSec: clamp(x / availableWidth, 0, 1) * durationSec,
        startSec,
        endSec,
        durationSec,
        widthPx: availableWidth,
      });
      dragRef.current = {
        kind,
        grabOffsetSec,
        anchorStartSec: startSec,
        anchorEndSec: endSec,
      };
      if (recenter) updateDrag(x);

      if (process.env.EXPO_OS === "ios") void Haptics.selectionAsync();
    },
    [durationSec, endSec, startSec, updateDrag],
  );

  const panResponder = useMemo(
    () =>
      // The responder callbacks run on later gestures; no ref is read while
      // this memo is evaluated.
      // eslint-disable-next-line react-hooks/refs
      PanResponder.create({
        onStartShouldSetPanResponder: () => durationSec > 0,
        onMoveShouldSetPanResponder: () => durationSec > 0,
        onPanResponderGrant: (event) => {
          beginDrag(event.nativeEvent.locationX);
        },
        onPanResponderMove: (event) => {
          updateDrag(event.nativeEvent.locationX);
        },
        onPanResponderRelease: () => {
          dragRef.current = null;
        },
        onPanResponderTerminate: () => {
          dragRef.current = null;
        },
      }),
    [beginDrag, durationSec, updateDrag],
  );

  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    widthRef.current = nextWidth;
    setWidth(nextWidth);
  }, []);

  const left = width * selectionStart;
  const right = width * selectionEnd;
  const selectedWidth = Math.max(0, right - left);
  const playheadLeft = width * Math.max(0, Math.min(1, playhead));
  const {
    minStartSec,
    maxStartSec: maxResizeStartSec,
    minEndSec,
    maxEndSec,
  } = snippetHandleBounds({
    durationSec,
    startSec,
    endSec,
    minDurationSec: minSnippetDurationSec,
    maxDurationSec: maxSnippetDurationSec,
  });

  // Accessibility steps go through the same clamping as a drag.
  const stepBy = (kind: "start" | "end" | "window", delta: number) => {
    const next = adjustSnippetWindow({
      kind,
      atSec: (kind === "end" ? endSec : startSec) + delta,
      startSec,
      endSec,
      durationSec,
      minDurationSec: minSnippetDurationSec,
      maxDurationSec: maxSnippetDurationSec,
      maxStartSec,
    });
    onWindowChange(next.startSec, next.durationSec);
  };

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
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Move clip window"
            accessibilityValue={{
              min: 0,
              max: maxStartSec,
              now: startSec,
              text: `${formatDurationSec(startSec)} to ${formatDurationSec(endSec)}`,
            }}
            accessibilityActions={ADJUST_ACTIONS}
            onAccessibilityAction={({ nativeEvent }) => {
              if (nativeEvent.actionName === "decrement") stepBy("window", -1);
              if (nativeEvent.actionName === "increment") stepBy("window", 1);
            }}
            style={[
              styles.selectionRegion,
              {
                left,
                width: selectedWidth,
                borderColor: theme.color.accent,
                backgroundColor: selectionTint(theme.scheme),
              },
            ]}
          />
          <View
            pointerEvents="none"
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Clip start"
            accessibilityValue={{
              min: minStartSec,
              max: maxResizeStartSec,
              now: startSec,
              text: formatDurationSec(startSec),
            }}
            accessibilityActions={ADJUST_ACTIONS}
            onAccessibilityAction={({ nativeEvent }) => {
              if (nativeEvent.actionName === "decrement") stepBy("start", -1);
              if (nativeEvent.actionName === "increment") stepBy("start", 1);
            }}
            style={[
              styles.selectionHandle,
              {
                left: left - 4,
                backgroundColor: theme.color.accent,
                borderColor: theme.color.bgElev1,
              },
            ]}
          />
          <View
            pointerEvents="none"
            accessible
            accessibilityRole="adjustable"
            accessibilityLabel="Clip end"
            accessibilityValue={{
              min: minEndSec,
              max: maxEndSec,
              now: endSec,
              text: formatDurationSec(endSec),
            }}
            accessibilityActions={ADJUST_ACTIONS}
            onAccessibilityAction={({ nativeEvent }) => {
              if (nativeEvent.actionName === "decrement") stepBy("end", -1);
              if (nativeEvent.actionName === "increment") stepBy("end", 1);
            }}
            style={[
              styles.selectionHandle,
              {
                left: right - 4,
                backgroundColor: theme.color.accent,
                borderColor: theme.color.bgElev1,
              },
            ]}
          />
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

function clamp(value: number, min: number, max: number) {
  return Math.max(min, Math.min(max, value));
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
  // RN 0.86 moved `userSelect` to TextStyle; it still reaches the DOM on web,
  // where it stops text selection from hijacking drags.
  dragSurface: {
    userSelect: "none",
  } as TextStyle,
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
    top: 28,
    bottom: 28,
    width: 8,
    borderWidth: 2,
    borderRadius: 4,
  },
  playhead: {
    position: "absolute",
    top: 4,
    bottom: 4,
    width: 2,
    opacity: 0.8,
  },
});
