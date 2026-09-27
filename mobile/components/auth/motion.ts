import { useEffect } from "react";
import { useIsFocused } from "expo-router";
import {
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from "react-native-reanimated";

/** Largest frame step the clock accepts, so a resume never jumps the scene. */
const MAX_FRAME_STEP = 1 / 15;

/**
 * Seconds of running animation time, advanced on the UI thread. Every ambient
 * loop on the welcome screen (bubble parade, title hop) derives
 * its phase from this one clock, so pausing is a single frame-callback toggle
 * and resuming picks up where it left off.
 */
export function useMotionClock(active: boolean): SharedValue<number> {
  const clock = useSharedValue(0);
  const frame = useFrameCallback((info) => {
    const step = (info.timeSincePreviousFrame ?? 0) / 1000;
    clock.value += Math.min(step, MAX_FRAME_STEP);
  }, false);
  useEffect(() => {
    frame.setActive(active);
  }, [active, frame]);
  return clock;
}

/**
 * The clock for an auth screen: it only runs while the screen is on top and
 * motion is allowed. With Reduce Motion the scene renders as a still frame.
 */
export function useAuthMotionClock(): SharedValue<number> {
  const reducedMotion = useReducedMotion();
  const focused = useIsFocused();
  return useMotionClock(focused && !reducedMotion);
}
