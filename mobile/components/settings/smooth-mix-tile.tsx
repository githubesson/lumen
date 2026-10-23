import { useEffect, useState } from "react";
import { StyleSheet, Text, View } from "react-native";
import Animated, {
  ReduceMotion,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withSpring,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { displayText, type TrackListItem } from "@music-library/core";
import { CoverArt } from "../cover-art";
import { SETTINGS_INSET, SettingsCard, SettingsTileHeader } from "./settings-card";
import { useCurrentTrack, usePlayerQueue } from "../../context/player";
import {
  CROSSFADE_DETENTS,
  fadeAccessibilityValue,
  fadeLengthLabel,
  fadeTickLabel,
  nearestDetent,
  overlapWidth,
  stepDetent,
  timelineGeometry,
} from "../../lib/settings/crossfade-timeline";
import { smoothMixStore, useSmoothMix } from "../../lib/smooth-mix";
import { useTheme, withAlpha } from "../../theme/theme";

const MAX_SECONDS = CROSSFADE_DETENTS[CROSSFADE_DETENTS.length - 1];

/** How much of the longest fade's gradient a fade of `seconds` shows. */
function fadeScale(seconds: number): number {
  "worklet";
  return Math.min(Math.max(seconds, 0), MAX_SECONDS) / MAX_SECONDS;
}

const TIMELINE_HEIGHT = 104;
const BAND_HEIGHT = 78;
const LANE_HEIGHT = 30;
const LANE_RADIUS = 9;
const LANE_A_TOP = 6;
const LANE_B_TOP = 42;
const LANE_COVER = 24;
const LANE_GAP = 7;
const KNOB = 24;
const KNOB_TOP = LANE_A_TOP + (LANE_HEIGHT - KNOB) / 2;
const TICKS_TOP = 84;
const TICK_WIDTH = 32;
const DASH = 4;
const DASH_GAP = 3;
const DASH_WIDTH = 1.5;

/** The fade's end settling on a detent: a finger moved it, so a spring. */
const SNAP_SPRING = {
  duration: 400,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.System,
} as const;

/**
 * Smooth mix as what it does: the current song's bar runs on past the point
 * where the next one starts, and the overlap is the crossfade. Dragging the
 * end of the fade (or tapping a tick) snaps it to Off or one of the player's
 * lengths, with a selection tick at each detent; the choice is saved when the
 * finger lifts. The bars carry the playing and next songs when there are any.
 *
 * The fade's width and handle are driven on the UI thread. React only hears
 * about detent changes (for the value, the tick and the haptic), never about
 * frames.
 */
export function SmoothMixTile() {
  const theme = useTheme();
  const seconds = useSmoothMix();
  const reducedMotion = useReducedMotion();
  const current = useCurrentTrack();
  const { queue, index } = usePlayerQueue();
  const next: TrackListItem | null = current ? (queue[index + 1] ?? null) : null;

  const [width, setWidth] = useState(0);
  /** The detent under the finger while dragging; the saved length otherwise. */
  const [preview, setPreview] = useState<number | null>(null);
  const shown = preview ?? seconds;
  const geometry = timelineGeometry(width, MAX_SECONDS);

  const layout = useSharedValue(timelineGeometry(0, MAX_SECONDS));
  /** The fade length on screen, in seconds (animated). */
  const overlap = useSharedValue(seconds);
  /** Where `overlap` is headed. */
  const target = useSharedValue(seconds);
  /** The saved length, for putting the fade back when a drag is cancelled. */
  const committed = useSharedValue(seconds);
  /** The detent the finger is on, or -1 when no drag is under way. */
  const dragged = useSharedValue(-1);

  /** Sends the fade toward `detent`: sprung, or straight there with reduced motion. */
  const animateTo = (detent: number) => {
    "worklet";
    target.set(detent);
    overlap.set(reducedMotion ? detent : withSpring(detent, SNAP_SPRING));
  };

  // Follow the saved length (it loads after launch, and VoiceOver changes it)
  // unless a drag owns the fade.
  useEffect(() => {
    committed.set(seconds);
    if (dragged.get() >= 0 || target.get() === seconds) return;
    target.set(seconds);
    overlap.set(reducedMotion ? seconds : withSpring(seconds, SNAP_SPRING));
  }, [seconds, reducedMotion, committed, dragged, target, overlap]);

  const onDetent = (detent: number) => {
    void Haptics.selectionAsync();
    setPreview(detent);
  };
  const onRelease = (detent: number | null) => {
    setPreview(null);
    if (detent !== null) smoothMixStore.set(detent);
  };
  const onTapDetent = (detent: number) => {
    void Haptics.selectionAsync();
    smoothMixStore.set(detent);
  };

  /** Snaps to the detent under the finger. Crosses into React only when the
   *  detent changes, never per frame. */
  const follow = (x: number) => {
    "worklet";
    const detent = nearestDetent(x, layout.get(), CROSSFADE_DETENTS);
    if (detent === dragged.get()) return;
    dragged.set(detent);
    animateTo(detent);
    scheduleOnRN(onDetent, detent);
  };

  /** Puts the fade back on the saved length after a cancelled drag. */
  const abandonDrag = () => {
    "worklet";
    dragged.set(-1);
    animateTo(committed.get());
    scheduleOnRN(onRelease, null);
  };

  const pan = Gesture.Pan()
    // Horizontal only, so a vertical swipe across the tile still scrolls.
    .activeOffsetX([-6, 6])
    .failOffsetY([-12, 12])
    .onStart((event) => {
      "worklet";
      dragged.set(target.get());
      follow(event.x);
    })
    .onUpdate((event) => {
      "worklet";
      follow(event.x);
    })
    .onEnd((_event, success) => {
      "worklet";
      const detent = dragged.get();
      if (!success || detent < 0) {
        abandonDrag();
        return;
      }
      dragged.set(-1);
      scheduleOnRN(onRelease, detent);
    })
    .onFinalize(() => {
      "worklet";
      // A drag that was cancelled without reaching `onEnd`.
      if (dragged.get() >= 0) abandonDrag();
    });

  // The tick labels double as buttons.
  const tap = Gesture.Tap()
    .maxDistance(10)
    .onEnd((event, success) => {
      "worklet";
      if (!success || event.y < TICKS_TOP - 10) return;
      const detent = nearestDetent(event.x, layout.get(), CROSSFADE_DETENTS);
      if (detent === target.get()) return;
      animateTo(detent);
      scheduleOnRN(onTapDetent, detent);
    });

  const gesture = Gesture.Exclusive(pan, tap);

  const bandStyle = useAnimatedStyle(() => ({
    width: overlapWidth(overlap.get(), layout.get()),
  }));
  const fadeOutStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: fadeScale(overlap.get()) }],
  }));
  const fadeInStyle = useAnimatedStyle(() => ({
    transform: [{ scaleX: fadeScale(overlap.get()) }],
  }));
  const nextSolidStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: overlapWidth(overlap.get(), layout.get()) }],
  }));
  const endEdgeStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: overlapWidth(overlap.get(), layout.get()) }],
  }));
  const knobStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: overlapWidth(overlap.get(), layout.get()) }],
  }));

  const step = (direction: 1 | -1) => {
    const nextLength = stepDetent(seconds, direction, CROSSFADE_DETENTS);
    if (nextLength === seconds) return;
    void Haptics.selectionAsync();
    smoothMixStore.set(nextLength);
  };

  const longest = overlapWidth(MAX_SECONDS, geometry);
  const laneFill = withAlpha(theme.color.fgMuted, theme.scheme === "dark" ? 0.32 : 0.2);
  const laneFillClear = withAlpha(theme.color.fgMuted, 0);
  const nextFill = withAlpha(theme.color.accent, 0.55);
  const nextFillClear = withAlpha(theme.color.accent, 0);
  // The current song's title runs up to the handle at the end of its bar.
  const currentTitleWidth = Math.max(
    0,
    geometry.start + overlapWidth(shown, geometry) - 3 - LANE_COVER - LANE_GAP - KNOB / 2 - 4,
  );

  return (
    <SettingsCard>
      <SettingsTileHeader title="Smooth mix" value={fadeLengthLabel(shown)} />
      <GestureDetector gesture={gesture}>
        <View
          accessible
          accessibilityRole="adjustable"
          accessibilityLabel="Smooth mix"
          accessibilityValue={{ text: fadeAccessibilityValue(shown) }}
          accessibilityHint="How long each song fades into the next."
          accessibilityActions={[{ name: "increment" }, { name: "decrement" }]}
          onAccessibilityAction={(event) => {
            if (event.nativeEvent.actionName === "increment") step(1);
            else if (event.nativeEvent.actionName === "decrement") step(-1);
          }}
          onLayout={(event) => {
            const measured = event.nativeEvent.layout.width;
            setWidth(measured);
            layout.set(timelineGeometry(measured, MAX_SECONDS));
          }}
          style={styles.timeline}
        >
          {width > 0 ? (
            <>
              {/* The crossfade: from where the next song starts to where this one ends. */}
              <Animated.View
                style={[
                  styles.band,
                  { left: geometry.start, backgroundColor: withAlpha(theme.color.accent, 0.16) },
                  bandStyle,
                ]}
              />
              <DashedEdge
                color={withAlpha(theme.color.accent, 0.8)}
                style={{ left: geometry.start - DASH_WIDTH / 2 }}
              />
              <Animated.View
                style={[styles.edge, { left: geometry.start - DASH_WIDTH / 2 }, endEdgeStyle]}
              >
                <DashedEdge color={withAlpha(theme.color.fg, 0.35)} />
              </Animated.View>

              {/* This song: solid up to the next one's start, then fading out. */}
              <View
                style={[
                  styles.laneA,
                  { width: geometry.start, backgroundColor: laneFill },
                ]}
              />
              <Animated.View
                style={[
                  styles.laneAFade,
                  {
                    left: geometry.start,
                    width: longest,
                    experimental_backgroundImage: `linear-gradient(to right, ${laneFill}, ${laneFillClear})`,
                  },
                  fadeOutStyle,
                ]}
              />
              <View style={styles.laneAContent}>
                <LaneCover track={current} />
                <Text
                  numberOfLines={1}
                  style={[styles.laneTitle, { color: theme.color.fg, maxWidth: currentTitleWidth }]}
                >
                  {current ? displayText(current.title) : "This song"}
                </Text>
              </View>

              {/* The next song: fading in over the overlap, then solid. */}
              <View style={[styles.laneB, { left: geometry.start }]}>
                <Animated.View
                  style={[
                    styles.laneBFade,
                    {
                      width: longest,
                      experimental_backgroundImage: `linear-gradient(to right, ${nextFillClear}, ${nextFill})`,
                    },
                    fadeInStyle,
                  ]}
                />
                <Animated.View
                  style={[StyleSheet.absoluteFill, { backgroundColor: nextFill }, nextSolidStyle]}
                />
                <View style={styles.laneBContent}>
                  <Text
                    numberOfLines={1}
                    style={[styles.laneTitle, { color: theme.color.fg, flexShrink: 1 }]}
                  >
                    {next ? displayText(next.title) : "Next song"}
                  </Text>
                  <LaneCover track={next} />
                </View>
              </View>

              <Animated.View
                style={[styles.knob, { left: geometry.start - KNOB / 2 }, knobStyle]}
              />

              {CROSSFADE_DETENTS.map((detent) => {
                const on = detent === shown;
                return (
                  <Text
                    key={detent}
                    style={[
                      styles.tick,
                      {
                        left: geometry.start + overlapWidth(detent, geometry) - TICK_WIDTH / 2,
                        color: on ? theme.color.fg : theme.color.fgMuted,
                        fontWeight: on ? "600" : "400",
                      },
                    ]}
                  >
                    {fadeTickLabel(detent)}
                  </Text>
                );
              })}
            </>
          ) : null}
        </View>
      </GestureDetector>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 13,
          paddingHorizontal: SETTINGS_INSET,
          paddingTop: 6,
          paddingBottom: SETTINGS_INSET,
        }}
      >
        Albums in order stay gapless
      </Text>
    </SettingsCard>
  );
}

/** A song's cover on its bar, or a neutral note when nothing is queued. */
function LaneCover({ track }: { track: TrackListItem | null }) {
  const theme = useTheme();
  if (track) return <CoverArt track={track} size={LANE_COVER} radius={6} transitionMs={0} />;
  return (
    <View style={[styles.laneCover, { backgroundColor: theme.color.bgElev2 }]}>
      <SymbolView name="music.note" size={12} tintColor={theme.color.fgMuted} />
    </View>
  );
}

const DASH_COUNT = Math.floor((BAND_HEIGHT + DASH_GAP) / (DASH + DASH_GAP));

/** One dashed edge of the crossfade band. */
function DashedEdge({
  color,
  style,
}: {
  color: string;
  style?: { left: number };
}) {
  return (
    <View pointerEvents="none" style={[styles.edge, style]}>
      {Array.from({ length: DASH_COUNT }, (_, i) => (
        <View
          key={i}
          style={{
            width: DASH_WIDTH,
            height: DASH,
            marginBottom: DASH_GAP,
            backgroundColor: color,
          }}
        />
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  timeline: {
    height: TIMELINE_HEIGHT,
    marginTop: 12,
    marginHorizontal: SETTINGS_INSET,
  },
  band: {
    position: "absolute",
    top: 0,
    height: BAND_HEIGHT,
    borderRadius: 4,
  },
  edge: {
    position: "absolute",
    top: 0,
    width: DASH_WIDTH,
    height: BAND_HEIGHT,
  },
  laneA: {
    position: "absolute",
    top: LANE_A_TOP,
    left: 0,
    height: LANE_HEIGHT,
    borderTopLeftRadius: LANE_RADIUS,
    borderBottomLeftRadius: LANE_RADIUS,
    borderCurve: "continuous",
  },
  laneAFade: {
    position: "absolute",
    top: LANE_A_TOP,
    height: LANE_HEIGHT,
    transformOrigin: "left center",
  },
  laneAContent: {
    position: "absolute",
    top: LANE_A_TOP,
    left: 3,
    height: LANE_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: LANE_GAP,
  },
  laneB: {
    position: "absolute",
    top: LANE_B_TOP,
    right: 0,
    height: LANE_HEIGHT,
    borderRadius: LANE_RADIUS,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  laneBFade: {
    position: "absolute",
    top: 0,
    bottom: 0,
    left: 0,
    transformOrigin: "left center",
  },
  laneBContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: LANE_GAP,
    paddingLeft: 9,
    paddingRight: 3,
  },
  laneTitle: {
    fontSize: 12,
    fontWeight: "600",
  },
  laneCover: {
    width: LANE_COVER,
    height: LANE_COVER,
    borderRadius: 6,
    borderCurve: "continuous",
    alignItems: "center",
    justifyContent: "center",
  },
  knob: {
    position: "absolute",
    top: KNOB_TOP,
    width: KNOB,
    height: KNOB,
    borderRadius: KNOB / 2,
    // A slider thumb is white in either appearance.
    backgroundColor: "#FFFFFF",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.35), 0 0 0 0.5px rgba(0, 0, 0, 0.1)",
  },
  tick: {
    position: "absolute",
    top: TICKS_TOP,
    width: TICK_WIDTH,
    textAlign: "center",
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
});
