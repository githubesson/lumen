import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView, type SFSymbol } from "expo-symbols";
import Animated, {
  Easing,
  FadeIn,
  useAnimatedStyle,
  useSharedValue,
  withSequence,
  withSpring,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { useTheme, withAlpha, type ThemeTokens } from "../../theme/theme";

/** Points per second the parade slides left. */
const SPEED = 14;
/**
 * Off-screen run-up on each side. Wider than half the largest bubble, so a
 * bubble wraps from the left edge to the right one where nobody can see it.
 */
const EDGE_PAD = 110;

interface Bubble {
  symbol: SFSymbol;
  size: number;
  /** Vertical offset from the parade's midline. */
  y: number;
  phase: number;
}

// Listed in paint order: smaller bubbles sit behind larger ones.
const BUBBLES: Bubble[] = [
  { symbol: "hifispeaker.fill", size: 112, y: 34, phase: 4.1 },
  { symbol: "opticaldisc.fill", size: 118, y: 24, phase: 1.3 },
  { symbol: "music.mic", size: 126, y: 12, phase: 3.2 },
  { symbol: "pianokeys", size: 142, y: -10, phase: 5.0 },
  { symbol: "headphones", size: 150, y: -22, phase: 0.2 },
  { symbol: "guitars.fill", size: 160, y: -34, phase: 2.4 },
];

// Where each bubble sits along the loop, in `BUBBLES` order, as fractions of
// the loop. Interleaved so neighbors on screen alternate big and small.
const SLOTS = [0.08, 0.58, 0.25, 0.75, 0.42, 0.92];

/**
 * The welcome screen's hero: glass bubbles, each holding a piece of music
 * gear in the brand purple, drifting right to left in an endless loop while
 * they bob. Tapping one squishes it and spins what's inside.
 */
export function BubbleParade({
  clock,
  style,
}: {
  clock: SharedValue<number>;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const { width } = useWindowDimensions();
  const loop = width + EDGE_PAD * 2;
  const glass = glassStyle(theme);
  return (
    <Animated.View
      entering={FadeIn.delay(150).duration(700)}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      style={style}
    >
      <View
        pointerEvents="none"
        style={[
          styles.glow,
          {
            experimental_backgroundImage: `radial-gradient(ellipse closest-side, ${withAlpha(theme.color.brand, theme.scheme === "dark" ? 0.2 : 0.1)} 0%, ${withAlpha(theme.color.brand, 0)} 100%)`,
          },
        ]}
      />
      {BUBBLES.map((bubble, index) => (
        <GlassBubble
          key={bubble.symbol}
          bubble={bubble}
          start={SLOTS[index] * loop}
          loop={loop}
          clock={clock}
          glass={glass}
          tint={theme.color.brand}
        />
      ))}
    </Animated.View>
  );
}

/** Scheme-specific glass: a faint fill and rim, lit from above. */
function glassStyle(theme: ThemeTokens) {
  const dark = theme.scheme === "dark";
  return {
    sphere: {
      backgroundColor: dark ? "rgba(255,255,255,0.04)" : "rgba(0,0,0,0.02)",
      borderColor: dark ? "rgba(255,255,255,0.14)" : "rgba(0,0,0,0.07)",
      boxShadow: dark
        ? `inset 0 2px 6px rgba(255,255,255,0.22), inset 0 -12px 24px ${withAlpha(theme.color.brand, 0.2)}, inset 0 0 20px rgba(255,255,255,0.06)`
        : `inset 0 2px 6px rgba(255,255,255,0.9), inset 0 -12px 24px ${withAlpha(theme.color.brand, 0.08)}, inset 0 0 18px rgba(0,0,0,0.04)`,
    } satisfies ViewStyle,
    shadow: {
      boxShadow: dark
        ? "0 18px 36px rgba(0,0,0,0.6)"
        : "0 14px 30px rgba(0,0,0,0.1)",
    } satisfies ViewStyle,
    innerGlow: withAlpha(theme.color.brand, dark ? 0.22 : 0.1),
    specular: dark ? 0.45 : 0.9,
  };
}

function GlassBubble({
  bubble,
  start,
  loop,
  clock,
  glass,
  tint,
}: {
  bubble: Bubble;
  start: number;
  loop: number;
  clock: SharedValue<number>;
  glass: ReturnType<typeof glassStyle>;
  tint: string;
}) {
  const size = bubble.size;
  const squish = useSharedValue(0);
  const spin = useSharedValue(0);

  const travelStyle = useAnimatedStyle(() => {
    const t = clock.value;
    const along = (((start - t * SPEED) % loop) + loop) % loop;
    return {
      transform: [
        { translateX: along - EDGE_PAD - size / 2 },
        { translateY: bubble.y + 9 * Math.sin(t * 0.9 + bubble.phase) },
      ],
    };
  });
  const sphereStyle = useAnimatedStyle(() => ({
    transform: [
      { scaleX: 1 + 0.1 * squish.value },
      { scaleY: 1 - 0.14 * squish.value },
    ],
  }));
  const objectStyle = useAnimatedStyle(() => {
    const t = clock.value;
    return {
      transform: [
        { translateY: 3 * Math.sin(t * 1.3 + bubble.phase) },
        { rotate: `${8 * Math.sin(t * 0.8 + bubble.phase) + spin.value}deg` },
      ],
    };
  });

  const onPress = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    squish.set(
      withSequence(
        withTiming(1, { duration: 90 }),
        withSpring(0, { damping: 5, stiffness: 180 }),
      ),
    );
    spin.set(
      withTiming(spin.get() + 360, {
        duration: 750,
        easing: Easing.out(Easing.back(1.6)),
      }),
    );
  };

  const round = { width: size, height: size, borderRadius: size / 2 };
  return (
    <Animated.View
      style={[
        styles.slot,
        { width: size, height: size, marginTop: -size / 2 },
        travelStyle,
      ]}
    >
      <Pressable onPress={onPress} accessible={false}>
        {/* Kept apart from the clipped sphere so the drop shadow isn't cut off. */}
        <Animated.View style={[round, glass.shadow, sphereStyle]}>
          <View style={[round, styles.sphere, glass.sphere]}>
            <View
              style={[
                StyleSheet.absoluteFill,
                {
                  experimental_backgroundImage: `radial-gradient(circle closest-side, ${glass.innerGlow} 0%, ${withAlpha(tint, 0)} 100%)`,
                },
              ]}
            />
            <Animated.View style={objectStyle}>
              <SymbolView
                name={bubble.symbol}
                type="hierarchical"
                tintColor={tint}
                size={size * 0.42}
                weight="medium"
              />
            </Animated.View>
            <View
              style={[
                styles.specular,
                {
                  width: size * 0.36,
                  height: size * 0.2,
                  left: size * 0.14,
                  top: size * 0.12,
                  experimental_backgroundImage: `radial-gradient(ellipse closest-side, rgba(255,255,255,${glass.specular}) 0%, rgba(255,255,255,0) 100%)`,
                },
              ]}
            />
          </View>
        </Animated.View>
      </Pressable>
    </Animated.View>
  );
}

const styles = StyleSheet.create({
  glow: {
    position: "absolute",
    left: "-10%",
    right: "-10%",
    top: "15%",
    bottom: "5%",
  },
  slot: {
    position: "absolute",
    left: 0,
    // A touch below center: the headline block below is taller than the
    // wordmark above, so this balances the gaps.
    top: "54%",
  },
  sphere: {
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
    borderWidth: 1,
  },
  specular: {
    position: "absolute",
    transform: [{ rotate: "-32deg" }],
  },
});
