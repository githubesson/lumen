import { StyleSheet } from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedProps,
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import { useDockColors } from "./dock-context";

const FALLBACK_BLUR_TINT = "systemChromeMaterial";
const FALLBACK_BLUR_INTENSITY = 80;
const GLASS_FADE_DURATION_S = 0.24;

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/**
 * The one dock surface: glass underneath, theme-bg scrim ON TOP. Every dock
 * pill (tab bar, phone mini-player, iPad island) renders this same pair so
 * the material is guaranteed identical. The scrim must stay above the glass
 * because Liquid Glass ignores colors painted beneath it and auto-adapts to
 * the content behind, which makes pills render different shades.
 *
 * Fading: alpha < 1 on a UIVisualEffectView or any of its superviews
 * permanently drops the effect, so the surface must NEVER be hidden via
 * opacity on an ancestor. Instead, pass `hidden` + `fadeProgress`: the glass
 * cross-fades natively (UIView.animate swapping the effect to "none"), the
 * scrim fades as a plain view, and the blur fallback animates its intensity.
 * The caller fades its own content/border/shadow layers the same way.
 */
export function DockSurface({
  hidden = false,
  fadeProgress,
}: {
  /** Mirrors the dock's collapsed state; drives the native glass fade. */
  hidden?: boolean;
  /** 0 = fully visible, 1 = fully hidden. Drives scrim/blur fades. */
  fadeProgress?: SharedValue<number>;
}) {
  const colors = useDockColors();

  const scrimStyle = useAnimatedStyle(() => ({
    opacity: fadeProgress
      ? interpolate(fadeProgress.value, [0, 0.6], [1, 0], Extrapolation.CLAMP)
      : 1,
  }));

  const blurProps = useAnimatedProps(() => ({
    intensity:
      FALLBACK_BLUR_INTENSITY *
      (fadeProgress
        ? interpolate(fadeProgress.value, [0, 0.6], [1, 0], Extrapolation.CLAMP)
        : 1),
  }));

  const scrim = (
    <Animated.View
      pointerEvents="none"
      style={[
        StyleSheet.absoluteFill,
        { backgroundColor: colors.scrim },
        scrimStyle,
      ]}
    />
  );

  if (isLiquidGlassAvailable()) {
    return (
      <>
        <GlassView
          isInteractive
          glassEffectStyle={{
            style: hidden ? "none" : "regular",
            animate: true,
            animationDuration: GLASS_FADE_DURATION_S,
          }}
          style={StyleSheet.absoluteFill}
        />
        {scrim}
      </>
    );
  }

  return (
    <>
      <AnimatedBlurView
        tint={FALLBACK_BLUR_TINT}
        animatedProps={blurProps}
        style={StyleSheet.absoluteFill}
      />
      {scrim}
    </>
  );
}
