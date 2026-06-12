import type { ReactNode } from "react";
import type { StyleProp, ViewStyle } from "react-native";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";

/** Fallback material when Liquid Glass is unavailable (older iOS, Android, web). */
const FALLBACK_BLUR_TINT = "systemChromeMaterial";
const FALLBACK_BLUR_INTENSITY = 80;

/**
 * Liquid Glass surface with a blur fallback. Previously reimplemented in
 * three places (Now Playing's `AdaptiveGlass`, the track-actions
 * `GlassCircle`, and the library header's `GlassSurface`); centralized here so
 * the fallback material stays consistent.
 *
 * The caller's `style` should include the shape (size, borderRadius,
 * `overflow: "hidden"`); children render inside the glass.
 */
export function AdaptiveGlass({
  children,
  style,
  interactive = false,
}: {
  children: ReactNode;
  style: StyleProp<ViewStyle>;
  interactive?: boolean;
}) {
  if (isLiquidGlassAvailable()) {
    return (
      <GlassView isInteractive={interactive} style={style}>
        {children}
      </GlassView>
    );
  }

  return (
    <BlurView
      tint={FALLBACK_BLUR_TINT}
      intensity={FALLBACK_BLUR_INTENSITY}
      style={style}
    >
      {children}
    </BlurView>
  );
}
