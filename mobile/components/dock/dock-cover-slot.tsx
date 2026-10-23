import { useEffect, useMemo, useState } from "react";
import {
  Pressable,
  StyleSheet,
  useWindowDimensions,
  type AccessibilityActionEvent,
} from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedReaction,
  useAnimatedStyle,
  useReducedMotion,
  useSharedValue,
  withTiming,
  type SharedValue,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import { SymbolView } from "expo-symbols";
import { useIsFocused } from "expo-router";
import * as Haptics from "expo-haptics";
import { displayText } from "@music-library/core";
import {
  useCurrentTrack,
  useIsPlaying,
  usePlaybackErrorMessage,
  usePlayerControls,
} from "../../context/player";
import { CoverArt } from "../cover-art";
import { useTheme } from "../../theme/theme";
import {
  COVER_SLOT,
  coverFlightFrame,
  slotCoverFrame,
  type CoverSlotMetrics,
} from "../../lib/dock-cover-slot";
import { DOCK, useDockCollapsed, useDockControls } from "./dock-context";
import { CoverRing } from "./cover-ring";
import { useOpenNowPlaying } from "./dock-mini-player";
import { TAB_COUNT } from "./floating-tab-bar";

const COVER_HALF = COVER_SLOT.coverSize / 2;
const RING_HALF = COVER_SLOT.ringSize / 2;

// The cover dims under the glyph once it's in the slot, more when paused.
const DIM_PLAYING = 0.26;
const DIM_PAUSED = 0.52;
const PRESSED_SCALE = 0.88;
const PRESSED_DIM = 0.2;
const GLYPH_SIZE = 13;

// Collapse progress at which the ring shows up around the landing circle and
// the glyph comes in; on expand they're gone before the circle has moved far.
const RING_FADE_FROM = 0.8;
const RING_FADE_TO = 0.98;
const GLYPH_FADE_FROM = 0.85;
// Once the cover has landed the arc draws in and the circle takes taps; the
// arc is reset well after the ring has faded on the way back.
const COVER_LANDED_AT = 0.97;
const RING_RESET_BELOW = 0.5;

const RING_DRAW_IN = { duration: 520, easing: Easing.out(Easing.cubic) } as const;
const PAUSE_DIM = { duration: 250, easing: Easing.linear } as const;
const PRESS = { duration: 160, easing: Easing.out(Easing.cubic) } as const;
// Reduce Motion: the slot cross-fades in and out instead of flying.
const SLOT_FADE = { duration: 200, easing: Easing.linear } as const;
// Matches the mock's cover swap when the track changes.
const COVER_SWAP_MS = 220;

const ACTION_PLAY_PAUSE = "playPause";
const ACTION_OPEN_PLAYER = "openPlayer";

/**
 * The phone dock's cover, in the pill and in the tab pill. Expanded it is the
 * mini player's cover (the pill keeps the spot free); on collapse it flies
 * into a sixth slot at the right end of the compact tab pill, turning into a
 * circle, and a ring around it shows the playback position. Tapping the
 * circle plays or pauses; a long press opens Now Playing.
 *
 * Everything here is a plain view above the pills, so no fade lands on a
 * glass ancestor. The flight runs on the dock's own `collapseProgress`, so it
 * can't drift from the pills. With Reduce Motion the cover stays in the pill
 * and the slot cross-fades in and out instead.
 */
export function DockCoverSlot({
  presence,
  dockHidden,
}: {
  /** 0..1, animated: whether the tab pill makes room for the cover slot. */
  presence: SharedValue<number>;
  /** The dock has slid off-screen (for the keyboard). */
  dockHidden: boolean;
}) {
  const { width } = useWindowDimensions();
  const theme = useTheme();
  const current = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const error = usePlaybackErrorMessage(current);
  const player = usePlayerControls();
  const openNowPlaying = useOpenNowPlaying();
  const { collapseProgress } = useDockControls();
  const collapsed = useDockCollapsed();
  const reducedMotion = useReducedMotion();
  // False while a modal (Now Playing) covers the tabs.
  const focused = useIsFocused();

  // When the track goes away while collapsed, its slot takes a moment to
  // close: the last cover stays in it until it has (`presence` reaches 0).
  const [lastTrack, setLastTrack] = useState(current);
  if (current !== null && current !== lastTrack) setLastTrack(current);
  const track = current ?? lastTrack;
  const live = current !== null;
  const [landed, setLanded] = useState(false);

  const metrics = useMemo<CoverSlotMetrics>(
    () => ({ ...DOCK, tabCount: TAB_COUNT, coverRadius: theme.radius.sm }),
    [theme.radius.sm],
  );

  const paused = useSharedValue(isPlaying ? 0 : 1);
  const pressed = useSharedValue(0);
  const drawIn = useSharedValue(reducedMotion ? 1 : 0);
  const slotFade = useSharedValue(collapsed ? 1 : 0);

  useEffect(() => {
    paused.value = withTiming(isPlaying ? 0 : 1, PAUSE_DIM);
  }, [isPlaying, paused]);

  useEffect(() => {
    if (!reducedMotion) return;
    slotFade.value = withTiming(collapsed ? 1 : 0, SLOT_FADE);
  }, [collapsed, reducedMotion, slotFade]);

  // The press target unmounts on expand, maybe mid-press, so its press-out
  // never comes; let go of the press here instead.
  useEffect(() => {
    if (!collapsed) pressed.value = withTiming(0, PRESS);
  }, [collapsed, pressed]);

  // The press target waits for the landing: until then there's nothing
  // under the finger to tap.
  useAnimatedReaction(
    () => collapseProgress.value >= COVER_LANDED_AT,
    (isLanded, wasLanded) => {
      if (isLanded === wasLanded) return;
      scheduleOnRN(setLanded, isLanded);
      if (isLanded && !reducedMotion) drawIn.set(withTiming(1, RING_DRAW_IN));
    },
  );

  useAnimatedReaction(
    () => collapseProgress.value <= RING_RESET_BELOW,
    (reset, wasReset) => {
      if (reset && wasReset !== true && !reducedMotion) drawIn.set(0);
    },
  );

  useAnimatedReaction(
    () => presence.value <= 0,
    (closed, wasClosed) => {
      if (closed && wasClosed === false) scheduleOnRN(setLastTrack, null);
    },
  );

  // A track that turns up while collapsed waits for its slot to open, and
  // one that goes away leaves with it. Expanded, the cover goes with the pill.
  const layerStyle = useAnimatedStyle(() => ({
    opacity:
      (reducedMotion ? slotFade.value : 1) *
      interpolate(
        collapseProgress.value,
        [0, 1],
        [live ? 1 : 0, presence.value],
        Extrapolation.CLAMP,
      ),
  }));

  const coverStyle = useAnimatedStyle(() => {
    const f = coverFlightFrame(metrics, width, reducedMotion ? 1 : collapseProgress.value);
    const scale = f.size / COVER_SLOT.coverSize;
    const press = reducedMotion
      ? 1
      : interpolate(pressed.value, [0, 1], [1, PRESSED_SCALE]);
    return {
      borderRadius: f.radius / scale,
      transform: [
        { translateX: f.x - COVER_HALF },
        { translateY: COVER_HALF - f.y },
        { scale: scale * press },
      ],
    };
  });

  const dimStyle = useAnimatedStyle(() => {
    const landed = reducedMotion ? 1 : collapseProgress.value;
    const dim = interpolate(paused.value, [0, 1], [DIM_PLAYING, DIM_PAUSED]);
    // Reduce Motion presses darken instead of shrinking.
    const press = reducedMotion ? pressed.value * PRESSED_DIM : 0;
    return { opacity: landed * dim + press };
  });

  const glyphStyle = useAnimatedStyle(() => ({
    opacity: reducedMotion
      ? 1
      : interpolate(collapseProgress.value, [GLYPH_FADE_FROM, 1], [0, 1], Extrapolation.CLAMP),
  }));

  // The ring rides with the circle, so it can fade out on the way back
  // without being left behind.
  const ringStyle = useAnimatedStyle(() => {
    const p = reducedMotion ? 1 : collapseProgress.value;
    const f = coverFlightFrame(metrics, width, p);
    return {
      opacity: reducedMotion
        ? 1
        : interpolate(p, [RING_FADE_FROM, RING_FADE_TO], [0, 1], Extrapolation.CLAMP),
      transform: [
        { translateX: f.x - RING_HALF },
        { translateY: RING_HALF - f.y },
      ],
    };
  });

  if (!track) return null;
  const title = displayText(track.title);
  const artist = displayText(track.artist);
  const slot = slotCoverFrame(metrics, width);
  // The ring's clock only runs while it can be seen: not behind the keyboard
  // or a modal, and not for a track that has gone.
  const ringVisible = live && collapsed && !dockHidden && focused;

  const togglePlayback = () => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    player.toggle();
  };

  const onAccessibilityAction = ({ nativeEvent }: AccessibilityActionEvent) => {
    if (nativeEvent.actionName === ACTION_PLAY_PAUSE) togglePlayback();
    if (nativeEvent.actionName === ACTION_OPEN_PLAYER) openNowPlaying();
  };

  return (
    <>
      <Animated.View pointerEvents="none" style={[StyleSheet.absoluteFill, layerStyle]}>
        <Animated.View style={[styles.cover, coverStyle]}>
          <CoverArt
            track={track}
            size={COVER_SLOT.coverSize}
            radius={0}
            transitionMs={COVER_SWAP_MS}
          />
          <Animated.View style={[styles.dim, dimStyle]} />
          <Animated.View style={[styles.glyph, glyphStyle]}>
            <SymbolView
              name={isPlaying ? "pause.fill" : "play.fill"}
              size={GLYPH_SIZE}
              tintColor="#FFFFFF"
            />
          </Animated.View>
        </Animated.View>
        <CoverRing
          trackKey={track.id}
          playing={isPlaying}
          ticking={ringVisible}
          drawIn={drawIn}
          paused={paused}
          style={ringStyle}
        />
      </Animated.View>
      {live && collapsed && landed ? (
        <Pressable
          onPress={togglePlayback}
          onLongPress={() => openNowPlaying()}
          onPressIn={() => pressed.set(withTiming(1, PRESS))}
          onPressOut={() => pressed.set(withTiming(0, PRESS))}
          hitSlop={{ top: 8, bottom: 8 }}
          accessibilityRole="button"
          accessibilityLabel={artist ? `${title}, ${artist}` : title}
          accessibilityValue={{ text: error ?? (isPlaying ? "Playing" : "Paused") }}
          accessibilityHint={isPlaying ? "Pauses playback." : "Resumes playback."}
          accessibilityActions={[
            { name: ACTION_PLAY_PAUSE, label: isPlaying ? "Pause" : "Play" },
            { name: ACTION_OPEN_PLAYER, label: "Open player" },
          ]}
          onAccessibilityAction={onAccessibilityAction}
          style={[styles.hitBox, { left: slot.x - COVER_SLOT.slotWidth / 2 }]}
        />
      ) : null}
    </>
  );
}

const styles = StyleSheet.create({
  // Positioned by transform from the dock's bottom-left corner, so the
  // flight never relayouts.
  cover: {
    position: "absolute",
    left: 0,
    bottom: 0,
    width: COVER_SLOT.coverSize,
    height: COVER_SLOT.coverSize,
    overflow: "hidden",
  },
  dim: {
    ...StyleSheet.absoluteFill,
    backgroundColor: "#000000",
  },
  glyph: {
    ...StyleSheet.absoluteFill,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#000000",
    shadowOpacity: 0.7,
    shadowRadius: 3,
    shadowOffset: { width: 0, height: 1 },
  },
  // The whole sixth slot, full height like the tab buttons.
  hitBox: {
    position: "absolute",
    bottom: 0,
    width: COVER_SLOT.slotWidth,
    height: DOCK.tabBarHeightCompact,
  },
});
