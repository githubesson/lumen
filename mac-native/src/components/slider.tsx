import { useMemo, useRef, useState } from 'react';
import { PanResponder, StyleSheet, View, type LayoutChangeEvent } from 'react-native';
import { useHover } from './hoverable';
import { useTheme } from '../theme/theme';

/**
 * Drag-and-click slider.
 *
 * `@react-native-community/slider` has no macOS support, and a stock
 * `NSSlider` would not match the app's geometry, so this is a PanResponder
 * track: the thumb appears on hover or while dragging, the way a scrubber in a
 * modern Mac player behaves.
 *
 * While dragging, the parent's `value` is ignored — otherwise the 2 Hz playback
 * clock would fight the pointer and the thumb would jump backwards.
 */
export function Slider({
  value,
  max,
  onSeek,
  onSeeking,
  height = 4,
  accent,
}: {
  value: number;
  max: number;
  onSeek: (value: number) => void;
  onSeeking?: (value: number) => void;
  height?: number;
  accent?: string;
}) {
  const t = useTheme();
  const { hovered, hoverProps } = useHover();
  const [width, setWidth] = useState(0);
  const [dragValue, setDragValue] = useState<number | null>(null);
  const widthRef = useRef(0);
  const maxRef = useRef(max);
  maxRef.current = max;

  const onLayout = (e: LayoutChangeEvent) => {
    widthRef.current = e.nativeEvent.layout.width;
    setWidth(e.nativeEvent.layout.width);
  };

  const responder = useMemo(
    () =>
      PanResponder.create({
        onStartShouldSetPanResponder: () => true,
        onMoveShouldSetPanResponder: () => true,
        onPanResponderGrant: e => {
          // The grant event carries both coordinate spaces for the same point,
          // so their difference *is* the track's page-space origin. Measuring
          // it asynchronously instead left the origin at 0 until the callback
          // landed, and a drag resolved against a 0 origin reads the pointer's
          // absolute x as if it were a position along the track — which pins
          // any control that is not flush with the window's left edge to its
          // maximum.
          originRef.current = e.nativeEvent.pageX - e.nativeEvent.locationX;
          const next = valueAt(e.nativeEvent.locationX);
          pendingRef.current = next;
          setDragValue(next);
          onSeeking?.(next);
        },
        onPanResponderMove: (_e, gesture) => {
          const next = valueAt(gesture.moveX - originRef.current);
          pendingRef.current = next;
          setDragValue(next);
          onSeeking?.(next);
        },
        onPanResponderRelease: () => {
          // Committed from the last position seen rather than recomputed from
          // the release gesture: a click with no drag reports `moveX` as 0, so
          // recomputing sent every plain click to the start of the track — a
          // click anywhere on the volume bar silenced it.
          setDragValue(null);
          onSeek(pendingRef.current);
        },
        onPanResponderTerminate: () => setDragValue(null),
      }),
    // Recreating the responder on every render would drop an in-flight drag.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  );

  // Page-space origin of the track, needed because pan gestures report absolute
  // coordinates while the initial touch reports a local one. Established on
  // every grant, so it cannot go stale when the window moves or resizes.
  const originRef = useRef(0);
  /** Latest position of the current gesture, committed on release. */
  const pendingRef = useRef(0);

  function valueAt(x: number): number {
    const w = widthRef.current;
    if (w <= 0) return 0;
    const ratio = Math.max(0, Math.min(1, x / w));
    return ratio * maxRef.current;
  }

  const shown = dragValue ?? value;
  const ratio = max > 0 ? Math.max(0, Math.min(1, shown / max)) : 0;
  const showThumb = hovered || dragValue !== null;
  const fill = accent ?? t.color.accent;

  return (
    <View
      style={styles.hitArea}
      onLayout={onLayout}
      {...hoverProps}
      {...responder.panHandlers}>
      <View
        style={[
          styles.track,
          { height, borderRadius: height / 2, backgroundColor: t.color.overlayMuted },
        ]}>
        <View
          style={{
            width: `${ratio * 100}%`,
            height,
            borderRadius: height / 2,
            backgroundColor: fill,
          }}
        />
      </View>
      {showThumb && width > 0 ? (
        <View
          pointerEvents="none"
          style={[
            styles.thumb,
            {
              left: Math.max(0, Math.min(width - 10, ratio * width - 5)),
              backgroundColor: fill,
            },
          ]}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  hitArea: { height: 18, justifyContent: 'center' },
  track: { overflow: 'hidden' },
  thumb: {
    position: 'absolute',
    width: 10,
    height: 10,
    borderRadius: 5,
  },
});
