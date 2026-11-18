import { useEffect } from "react";
import { View } from "react-native";
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
} from "react-native-reanimated";

const HEIGHT = 13;
const BAR_WIDTH = 3;
// Each bar bounces between its own low and high at its own pace, so the four
// never line up; `rest` is the still shape shown while paused.
const BARS = [
  { rest: 0.55, low: 0.3, high: 1, ms: 380 },
  { rest: 1, low: 0.45, high: 0.95, ms: 520 },
  { rest: 0.35, low: 0.2, high: 0.8, ms: 300 },
  { rest: 0.75, low: 0.35, high: 1, ms: 450 },
] as const;
const EASE = Easing.inOut(Easing.quad);

function Bar({
  spec,
  moving,
  color,
}: {
  spec: (typeof BARS)[number];
  moving: boolean;
  color: string;
}) {
  const scale = useSharedValue<number>(spec.rest);
  useEffect(() => {
    if (moving) {
      scale.set(
        withRepeat(
          withSequence(
            withTiming(spec.high, { duration: spec.ms, easing: EASE }),
            withTiming(spec.low, { duration: spec.ms, easing: EASE }),
          ),
          -1,
        ),
      );
    } else {
      cancelAnimation(scale);
      scale.set(withTiming(spec.rest, { duration: 200 }));
    }
    return () => cancelAnimation(scale);
  }, [moving, scale, spec]);
  const style = useAnimatedStyle(() => ({ transform: [{ scaleY: scale.get() }] }));
  return (
    <Animated.View
      style={[
        {
          width: BAR_WIDTH,
          height: HEIGHT,
          borderRadius: BAR_WIDTH / 2,
          backgroundColor: color,
          transformOrigin: "bottom",
        },
        style,
      ]}
    />
  );
}

/**
 * Four bars marking the current track in a list: bouncing while it plays,
 * still while paused or with Reduce Motion. Decorative; the row's label says
 * it's playing.
 */
export function NowPlayingBars({ playing, color }: { playing: boolean; color: string }) {
  const reducedMotion = useReducedMotion();
  return (
    <View
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={{ flexDirection: "row", alignItems: "flex-end", gap: 2, height: HEIGHT }}
    >
      {BARS.map((spec, i) => (
        <Bar key={i} spec={spec} moving={playing && !reducedMotion} color={color} />
      ))}
    </View>
  );
}
