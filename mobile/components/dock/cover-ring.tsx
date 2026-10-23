import { useEffect, useRef } from "react";
import { StyleSheet, type StyleProp, type ViewStyle } from "react-native";
import Animated, {
  interpolate,
  useAnimatedReaction,
  useDerivedValue,
  useFrameCallback,
  useSharedValue,
  type AnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { Canvas, Circle, Path, Skia } from "@shopify/react-native-skia";
import { usePlayerTime } from "../../context/player";
import {
  COVER_SLOT,
  RING_CLOCK_START,
  ringFraction,
  ringNeedsRedraw,
  stepRingClock,
  type RingAnchor,
} from "../../lib/dock-cover-slot";
import { useDockColors } from "./dock-context";

const CENTER = COVER_SLOT.ringSize / 2;
const RADIUS = COVER_SLOT.ringRadius;

// One full turn from 12 o'clock, clockwise, so trimming its end grows the arc
// the way a clock hand turns.
const RING_PATH = Skia.Path.Make().addArc(
  Skia.XYWHRect(CENTER - RADIUS, CENTER - RADIUS, RADIUS * 2, RADIUS * 2),
  -90,
  360,
);

const ARC_ALPHA_PLAYING = 0.96;
const ARC_ALPHA_PAUSED = 0.42;

/**
 * The thin progress ring around the collapsed dock's cover: a hairline track
 * and an arc with a round cap from 12 o'clock. The arc moves continuously: a
 * frame clock on the UI thread extrapolates the player's position between its
 * coarse 250 ms reports (`stepRingClock`), so the ring never re-renders to
 * move. It only ticks while `ticking` and playing; paused, the arc dims and
 * holds still.
 */
export function CoverRing({
  trackKey,
  playing,
  ticking,
  drawIn,
  paused,
  style,
}: {
  trackKey: string | null;
  playing: boolean;
  /** Whether the ring is on screen. Off-screen it doesn't tick. */
  ticking: boolean;
  /** 0..1: how much of the played arc to draw (it draws in as the cover lands). */
  drawIn: SharedValue<number>;
  /** 0 playing → 1 paused, animated: dims the arc. */
  paused: SharedValue<number>;
  style?: StyleProp<AnimatedStyle<ViewStyle>>;
}) {
  const colors = useDockColors();
  const anchor = useSharedValue<RingAnchor>({
    seq: 0,
    track: null,
    position: 0,
    duration: 0,
    playing: false,
  });
  const clock = useSharedValue(RING_CLOCK_START);
  const fraction = useSharedValue(0);

  const advance = (dt: number) => {
    "worklet";
    const a = anchor.value;
    const next = stepRingClock(clock.value, a, dt);
    clock.value = next;
    const f = ringFraction(next.shown, a.duration);
    if (ringNeedsRedraw(fraction.value, f)) fraction.value = f;
  };

  const frame = useFrameCallback((info) => {
    advance((info.timeSincePreviousFrame ?? 0) / 1000);
  }, false);

  useEffect(() => {
    frame.setActive(ticking && playing);
  }, [frame, playing, ticking]);

  // While playing the frame clock owns the arc; otherwise each report (a
  // pause, a seek, a track change) is applied as it lands.
  useAnimatedReaction(
    () => anchor.value,
    (a) => {
      if (!a.playing) advance(0);
    },
  );

  const arcEnd = useDerivedValue(() => fraction.value * drawIn.value);
  const arcOpacity = useDerivedValue(() =>
    arcEnd.value > 0
      ? interpolate(paused.value, [0, 1], [ARC_ALPHA_PLAYING, ARC_ALPHA_PAUSED])
      : 0,
  );

  return (
    <Animated.View pointerEvents="none" style={[styles.ring, style]}>
      <Canvas style={styles.canvas}>
        <Circle
          cx={CENTER}
          cy={CENTER}
          r={RADIUS}
          style="stroke"
          strokeWidth={COVER_SLOT.trackWidth}
          color={colors.ringTrack}
        />
        <Path
          path={RING_PATH}
          style="stroke"
          strokeWidth={COVER_SLOT.arcWidth}
          strokeCap="round"
          color={colors.active}
          start={0}
          end={arcEnd}
          opacity={arcOpacity}
        />
      </Canvas>
      <RingClockFeed anchor={anchor} trackKey={trackKey} playing={playing} />
    </Animated.View>
  );
}

/**
 * Hands the player's clock to the ring. Its own leaf, so the clock's 4 Hz
 * re-renders stop here instead of redrawing the canvas or the dock. The
 * clock is the displayed one, so it follows another device while this phone
 * controls it.
 */
function RingClockFeed({
  anchor,
  trackKey,
  playing,
}: {
  anchor: SharedValue<RingAnchor>;
  trackKey: string | null;
  playing: boolean;
}) {
  const { currentTime, duration } = usePlayerTime();
  const seqRef = useRef(0);

  useEffect(() => {
    seqRef.current += 1;
    anchor.set({
      seq: seqRef.current,
      track: trackKey,
      position: currentTime,
      duration,
      playing,
    });
  }, [anchor, currentTime, duration, playing, trackKey]);

  return null;
}

const styles = StyleSheet.create({
  ring: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: COVER_SLOT.ringSize,
    height: COVER_SLOT.ringSize,
  },
  canvas: {
    width: COVER_SLOT.ringSize,
    height: COVER_SLOT.ringSize,
  },
});
