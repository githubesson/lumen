import { useEffect, useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  ReduceMotion,
  cancelAnimation,
  useAnimatedProps,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { FullWindowOverlay } from "react-native-screens";
import { BlurView } from "expo-blur";
import { GlassView, isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import { useTheme } from "../../theme/theme";
import { HUD, flightFrame, hudOrigin, trackSlot } from "./flight";
import {
  finishAddConfirmation,
  useAddConfirmation,
  type AddConfirmation,
  type AddConfirmationResult,
} from "./store";

const FALLBACK_BLUR_TINT = "systemChromeMaterial";
const FALLBACK_BLUR_INTENSITY = 80;

/** The sheet starts down before anything moves (mock timings, in ms). */
const START_DELAY_MS = 60;
const FLIGHT_MS = 500;
const FLIGHT_EASING = Easing.bezier(0.45, 0, 0.25, 1);
const LANDING_SCALE = 1.12;
const EXIT_EASING = Easing.bezier(0.25, 1, 0.5, 1);
const FADE_IN_MS = 160;
const HUD_SPRING = { duration: 450, dampingRatio: 0.5 } as const;
const CHECK_SPRING = { duration: 380, dampingRatio: 0.5 } as const;
/** The check follows the landing by at least this much. */
const CHECK_AFTER_LANDING_MS = 90;
/** How long the finished HUD stays before it fades. */
const HOLD_MS = 750;
const FADE_OUT_MS = 250;
const EXIT_MS = 300;
/** With Reduce Motion: fades only, a little slower so they still read. */
const REDUCED_FADE_MS = 200;

const AnimatedBlurView = Animated.createAnimatedComponent(BlurView);

/**
 * The add-to-playlist confirmation, mounted once at the root. It plays over
 * everything, the closing picker sheet included, and never takes a touch.
 */
export function AddConfirmationOverlay() {
  const confirmation = useAddConfirmation();
  if (!confirmation) return null;
  if (Platform.OS !== "ios") {
    return (
      <View
        key={confirmation.id}
        pointerEvents="none"
        style={StyleSheet.absoluteFill}
      >
        <AddConfirmationHud confirmation={confirmation} />
      </View>
    );
  }
  // A new overlay per confirmation: UIKit stacks it above whatever is
  // presented when it mounts, so the sheet closing at that moment stays
  // under the flight. Not modal, so VoiceOver keeps the screen behind.
  return (
    <FullWindowOverlay
      key={confirmation.id}
      unstable_accessibilityContainerViewIsModal={false}
    >
      <AddConfirmationHud confirmation={confirmation} />
    </FullWindowOverlay>
  );
}

/**
 * A glass HUD in the middle of the window: the playlist's cover, the track's
 * cover flying from the picker's card onto it, then a check once the add
 * succeeds. A failed add fades it straight away (the store shows the alert).
 */
function AddConfirmationHud({
  confirmation,
}: {
  confirmation: AddConfirmation;
}) {
  const theme = useTheme();
  const reducedMotion = useReducedMotion();
  const window = useWindowDimensions();
  const origin = hudOrigin(window);
  const slot = trackSlot(origin);
  const from = reducedMotion ? null : confirmation.from;
  const fills = confirmation.playlistArt === null;
  const ring = theme.scheme === "dark" ? theme.color.bgElev2 : theme.color.bg;

  // 0 → 1 as the HUD comes in, back to 0 as it goes.
  const appear = useSharedValue(0);
  const scale = useSharedValue(reducedMotion ? 1 : 0.8);
  // The flying cover's journey; at 1 it has landed in the slot.
  const flight = useSharedValue(from ? 0 : 1);
  // Fades the flying cover if the HUD leaves before it lands.
  const flyerPresence = useSharedValue(1);
  // The landed cover starts swollen and settles: the squash on landing.
  const squash = useSharedValue(from ? LANDING_SCALE : 1);
  const fill = useSharedValue(0);
  const check = useSharedValue(0);
  // Liquid Glass can't fade by opacity (UIKit drops it for good), so it
  // switches its effect on and off natively instead.
  const [glassOn, setGlassOn] = useState(false);

  useEffect(() => {
    const { id, done } = confirmation;
    let active = true;
    let exiting = false;
    let landedAt: number | null = null;
    let result: AddConfirmationResult | null = null;
    const timers: ReturnType<typeof setTimeout>[] = [];
    const later = (ms: number, run: () => void) => {
      timers.push(
        setTimeout(() => {
          if (active) run();
        }, ms),
      );
    };
    // Fades run with Reduce Motion too: they're its whole animation.
    const fade = (ms: number) => ({
      duration: ms,
      easing: Easing.linear,
      reduceMotion: ReduceMotion.Never,
    });

    const exit = () => {
      if (exiting) return;
      exiting = true;
      setGlassOn(false);
      appear.value = withTiming(0, fade(FADE_OUT_MS));
      flyerPresence.value = withTiming(0, fade(FADE_OUT_MS));
      if (!reducedMotion) {
        scale.value = withTiming(0.92, { duration: EXIT_MS, easing: EXIT_EASING });
      }
      later(EXIT_MS, () => finishAddConfirmation(id));
    };

    // The check pops once the cover has landed and the add went through.
    const confirm = () => {
      if (exiting || landedAt === null || !result?.ok) return;
      const wait = CHECK_AFTER_LANDING_MS - (Date.now() - landedAt);
      later(Math.max(0, wait), () => {
        check.value = reducedMotion
          ? withTiming(1, fade(REDUCED_FADE_MS))
          : withSpring(1, CHECK_SPRING);
        void Haptics.notificationAsync(
          Haptics.NotificationFeedbackType.Success,
        );
        later(HOLD_MS, exit);
      });
    };
    const landed = () => {
      if (!active || landedAt !== null) return;
      landedAt = Date.now();
      confirm();
    };

    later(START_DELAY_MS, () => setGlassOn(true));
    if (reducedMotion) {
      appear.value = withDelay(START_DELAY_MS, withTiming(1, fade(REDUCED_FADE_MS)));
      if (fills) {
        fill.value = withDelay(START_DELAY_MS, withTiming(1, fade(REDUCED_FADE_MS)));
      }
      later(START_DELAY_MS + REDUCED_FADE_MS, landed);
    } else {
      appear.value = withDelay(START_DELAY_MS, withTiming(1, fade(FADE_IN_MS)));
      scale.value = withDelay(START_DELAY_MS, withSpring(1, HUD_SPRING));
      if (from) {
        flight.value = withDelay(
          START_DELAY_MS,
          withTiming(1, { duration: FLIGHT_MS, easing: FLIGHT_EASING }, (finished) => {
            if (!finished) return;
            // Lands with a squash; a new playlist's tile takes the art.
            squash.value = withSequence(
              withTiming(0.95, { duration: 165, easing: Easing.out(Easing.quad) }),
              withTiming(1, { duration: 135, easing: Easing.out(Easing.quad) }),
            );
            if (fills) fill.value = withTiming(1, { duration: 300 });
            scheduleOnRN(landed);
          }),
        );
      } else {
        // Nothing to fly from: the cover is already in place.
        if (fills) fill.value = withDelay(START_DELAY_MS, withTiming(1, { duration: 300 }));
        later(START_DELAY_MS + FLIGHT_MS, landed);
      }
    }

    void done.then((outcome) => {
      if (!active) return;
      result = outcome;
      if (outcome.ok) confirm();
      else exit();
    });

    return () => {
      active = false;
      timers.forEach(clearTimeout);
      for (const value of [appear, scale, flight, flyerPresence, squash, fill, check]) {
        cancelAnimation(value);
      }
    };
  }, [
    appear,
    check,
    confirmation,
    fill,
    fills,
    flight,
    flyerPresence,
    from,
    reducedMotion,
    scale,
    squash,
  ]);

  const hudStyle = useAnimatedStyle(() => ({
    transform: [{ scale: scale.value }],
  }));
  const appearStyle = useAnimatedStyle(() => ({ opacity: appear.value }));
  const blurProps = useAnimatedProps(() => ({
    intensity: FALLBACK_BLUR_INTENSITY * appear.value,
  }));
  const slotStyle = useAnimatedStyle(() => ({
    opacity: flight.value >= 1 ? 1 : 0,
    transform: [{ scale: squash.value }],
  }));
  const fillStyle = useAnimatedStyle(() => ({ opacity: fill.value }));
  const checkStyle = useAnimatedStyle(() =>
    reducedMotion
      ? { opacity: check.value }
      : { opacity: check.value > 0 ? 1 : 0, transform: [{ scale: check.value }] },
  );
  const flyerStyle = useAnimatedStyle(() => {
    if (!from) return { opacity: 0 };
    const frame = flightFrame(flight.value, from, slot);
    return {
      opacity: flight.value < 1 ? flyerPresence.value : 0,
      transform: [
        { translateX: frame.translateX },
        { translateY: frame.translateY },
        { scale: frame.scale },
      ],
    };
  });

  const { trackArt, playlistArt } = confirmation;
  // The flight starts as the card's own image, already on screen.
  const flyerUri = trackArt.placeholder ?? trackArt.uri;
  return (
    <View
      pointerEvents="none"
      style={StyleSheet.absoluteFill}
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
    >
      <Animated.View
        style={[styles.hud, { left: origin.x, top: origin.y }, hudStyle]}
      >
        <Animated.View style={[styles.hudShadow, appearStyle]} />
        <View style={styles.hudClip}>
          {isLiquidGlassAvailable() ? (
            <GlassView
              colorScheme={theme.scheme}
              glassEffectStyle={{
                style: glassOn ? "regular" : "none",
                animate: true,
                animationDuration: (glassOn ? FADE_IN_MS : FADE_OUT_MS) / 1000,
              }}
              style={StyleSheet.absoluteFill}
            />
          ) : (
            <AnimatedBlurView
              tint={FALLBACK_BLUR_TINT}
              animatedProps={blurProps}
              style={StyleSheet.absoluteFill}
            />
          )}
        </View>
        <Animated.View style={[styles.content, appearStyle]}>
          <View style={styles.pair}>
            <View
              style={[styles.playlist, { backgroundColor: theme.color.bgElev2 }]}
            >
              {playlistArt ? (
                <Image
                  source={{ uri: playlistArt.uri }}
                  placeholder={
                    playlistArt.placeholder ? { uri: playlistArt.placeholder } : undefined
                  }
                  placeholderContentFit="cover"
                  style={styles.fillImage}
                  contentFit="cover"
                  cachePolicy="memory-disk"
                  allowDownscaling
                  decodeFormat="rgb"
                />
              ) : (
                <>
                  <SymbolView
                    name={confirmation.playlistGlyph}
                    size={26}
                    tintColor={theme.color.fgMuted}
                  />
                  {trackArt.uri ? (
                    <Animated.View style={[StyleSheet.absoluteFill, fillStyle]}>
                      <TrackImage art={trackArt} />
                    </Animated.View>
                  ) : null}
                </>
              )}
            </View>
            <Animated.View
              style={[
                styles.trackRing,
                { backgroundColor: ring },
                slotStyle,
              ]}
            >
              <View
                style={[styles.track, { backgroundColor: theme.color.bgElev2 }]}
              >
                <TrackImage art={trackArt} />
              </View>
            </Animated.View>
            <Animated.View
              style={[styles.checkRing, { backgroundColor: ring }, checkStyle]}
            >
              <View
                style={[styles.check, { backgroundColor: theme.color.success }]}
              >
                <SymbolView
                  name="checkmark"
                  size={15}
                  weight="bold"
                  tintColor={theme.scheme === "dark" ? "#000000" : "#FFFFFF"}
                />
              </View>
            </Animated.View>
          </View>
          <Text
            numberOfLines={1}
            style={[styles.title, { color: theme.color.fg }]}
          >
            {confirmation.playlistName}
          </Text>
          <Text style={[styles.subtitle, { color: theme.color.fgMuted }]}>
            {confirmation.created ? "New Playlist" : "Added"}
          </Text>
        </Animated.View>
      </Animated.View>

      {from ? (
        <Animated.View
          style={[
            styles.flyer,
            {
              left: from.x,
              top: from.y,
              width: from.width,
              height: from.height,
              backgroundColor: theme.color.bgElev2,
            },
            flyerStyle,
          ]}
        >
          {flyerUri ? (
            <Image
              source={{ uri: flyerUri }}
              style={styles.fillImage}
              contentFit="cover"
              cachePolicy="memory-disk"
              allowDownscaling
              decodeFormat="rgb"
            />
          ) : null}
        </Animated.View>
      ) : null}
    </View>
  );
}

function TrackImage({ art }: { art: AddConfirmation["trackArt"] }) {
  if (!art.uri) return null;
  return (
    <Image
      source={{ uri: art.uri }}
      placeholder={art.placeholder ? { uri: art.placeholder } : undefined}
      placeholderContentFit="cover"
      style={styles.fillImage}
      contentFit="cover"
      cachePolicy="memory-disk"
      allowDownscaling
      decodeFormat="rgb"
    />
  );
}

const styles = StyleSheet.create({
  hud: {
    position: "absolute",
    width: HUD.width,
    borderRadius: HUD.radius,
  },
  hudShadow: {
    ...StyleSheet.absoluteFill,
    borderRadius: HUD.radius,
    borderCurve: "continuous",
    boxShadow: "0 20px 50px rgba(0,0,0,0.45)",
  },
  hudClip: {
    ...StyleSheet.absoluteFill,
    borderRadius: HUD.radius,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  content: {
    alignItems: "center",
    gap: 4,
    paddingTop: HUD.paddingTop,
    paddingHorizontal: HUD.paddingX,
    paddingBottom: HUD.paddingBottom,
  },
  pair: {
    width: HUD.pairWidth,
    height: HUD.pairHeight,
    marginBottom: HUD.pairGap,
  },
  playlist: {
    position: "absolute",
    right: 0,
    top: 0,
    width: HUD.playlistSize,
    height: HUD.playlistSize,
    borderRadius: HUD.playlistRadius,
    borderCurve: "continuous",
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
  trackRing: {
    position: "absolute",
    left: -HUD.ring,
    bottom: -HUD.ring,
    padding: HUD.ring,
    borderRadius: HUD.trackRadius + HUD.ring,
    borderCurve: "continuous",
    boxShadow: "0 6px 14px rgba(0,0,0,0.45)",
  },
  track: {
    width: HUD.trackSize,
    height: HUD.trackSize,
    borderRadius: HUD.trackRadius,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  checkRing: {
    position: "absolute",
    right: -6 - HUD.ring,
    bottom: -4 - HUD.ring,
    padding: HUD.ring,
    borderRadius: HUD.checkSize / 2 + HUD.ring,
  },
  check: {
    width: HUD.checkSize,
    height: HUD.checkSize,
    borderRadius: HUD.checkSize / 2,
    alignItems: "center",
    justifyContent: "center",
  },
  title: {
    fontSize: 17,
    lineHeight: 22,
    fontWeight: "600",
    maxWidth: HUD.width - HUD.paddingX * 2,
  },
  subtitle: {
    fontSize: 13,
    lineHeight: 18,
  },
  flyer: {
    position: "absolute",
    borderRadius: 8,
    borderCurve: "continuous",
    overflow: "hidden",
    boxShadow: "0 10px 26px rgba(0,0,0,0.5)",
  },
  fillImage: {
    width: "100%",
    height: "100%",
  },
});
