import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  AccessibilityInfo,
  Pressable,
  StyleSheet,
  View,
  type AccessibilityActionEvent,
  type AccessibilityActionInfo,
  type AccessibilityValue,
  type LayoutChangeEvent,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import Animated, {
  cancelAnimation,
  Easing,
  measure,
  ReduceMotion,
  useAnimatedRef,
  useAnimatedStyle,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  withDelay,
  withSequence,
  withSpring,
  withTiming,
  type AnimatedRef,
} from "react-native-reanimated";
import { scheduleOnRN } from "react-native-worklets";
import * as Haptics from "expo-haptics";
import type { TrackListItem } from "@music-library/core";
import {
  useFavorite,
  useFavoriteActions,
  usePendingFavoriteRemoval,
  type PendingRemovalPhase,
} from "../../context/favorites";
import { useCanPlayNext, usePlayNext } from "../../context/player";
import { useTrackUnavailableOffline } from "../../lib/offline-mode";
import {
  COMET_LAP_MS,
  COMET_STRIP_LAP_MS,
  SWIPE_ACTIVATE_DISTANCE,
  SWIPE_EDGE_INSET,
  SWIPE_OPEN_DISTANCE,
  commitDistance,
  resistedOffset,
  swipeRelease,
  type CometBox,
} from "../../lib/swipe-actions";
import { useTheme } from "../../theme/theme";
import { TrackActionsContextMenu } from "../track-actions-menu";
import { CometGlow } from "./comet-glow";
import { FavoriteMark } from "./favorite-mark";
import { notePeekTouch, offerPeek } from "../../lib/swipe-peek";
import { REMOVAL_SLOT_HEIGHT, RemovalStrip, removalStripBox } from "./removal-strip";
import { SwipeAction, swipeActionStyle, type SwipeActionKind } from "./swipe-action";

/** What a swipe row hands the row it wraps. */
export interface SwipeRowProps {
  /** VoiceOver's stand-ins for the swipes, for the row's own Pressable. */
  accessibilityActions: readonly AccessibilityActionInfo[];
  onAccessibilityAction: (event: AccessibilityActionEvent) => void;
  /** "Favorite" where the heart shows, so VoiceOver hears it too. */
  accessibilityValue: AccessibilityValue | undefined;
  /** The favorite heart for before the row's trailing detail, or null. */
  favoriteMark: (style?: StyleProp<ViewStyle>) => ReactElement | null;
}

// The mock's curves: --spring-soft over .5 s, --ease-out, --ease-io.
const SETTLE_SPRING = {
  duration: 500,
  dampingRatio: 0.8,
  reduceMotion: ReduceMotion.Never,
} as const;
const EASE_OUT = Easing.bezier(0.25, 1, 0.5, 1);
const EASE_IN_OUT = Easing.bezier(0.65, 0, 0.35, 1);
// Reduce Motion: the row still follows the finger and settles, but quickly
// and without the spring's overshoot.
const REDUCED_SETTLE = {
  duration: 160,
  easing: Easing.out(Easing.cubic),
  reduceMotion: ReduceMotion.Never,
} as const;
const ARM_TIMING = {
  duration: 160,
  easing: Easing.out(Easing.exp),
  reduceMotion: ReduceMotion.System,
} as const;

/** A committed swipe's comet starts this soon after the release. */
const COMET_DELAY_MS = 60;
/** The heart settles in a little after the comet sets off. */
const MARK_DELAY_MS = 620;
const MARK_POP = {
  duration: 520,
  easing: Easing.bezier(0.3, 0.7, 0.3, 1),
  reduceMotion: ReduceMotion.System,
} as const;
/** The Favorites list's removal: the row leaves, then its slot becomes the strip. */
const SLIDE_OUT_MS = 260;
const STRIP_AFTER_MS = 240;
const SLOT_MS = 320;
const STRIP_COMET_AFTER_MS = 380;
/** After Undo, the capsule stays hidden until the row is back. */
const UNDO_SETTLE_MS = 600;
/** How long the strip stays mounted to fade out after Undo. */
const STRIP_FADE_MS = 300;
/** The first-run peek (see lib/swipe-peek.ts). */
const PEEK_OPEN_MS = 420;
const PEEK_HOLD_MS = 520;
const PEEK_GAP_MS = 200;

/** The outline the comet runs around: the row, just inside its slot. */
const ROW_GLOW_INSET = 4;
const ROW_GLOW_RADIUS = 14;

// One row rests open at a time: opening or touching another closes it.
let openRowClose: (() => void) | null = null;
// Numbers comet runs, so each mounts fresh.
let glowRuns = 0;

function armHaptic(armed: boolean) {
  if (armed) void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
  else void Haptics.selectionAsync();
}

interface Glow {
  id: number;
  trackId: string;
  kind: SwipeActionKind;
  on: "row" | "strip";
  box: CometBox;
  delayMs: number;
}

/**
 * Swipe actions for a song row, the same in every list. Swipe right: Play
 * Next. Swipe left: Favorite, or Unfavorite if it already is one.
 *
 * - The pan claims the touch after 12 pt sideways; vertical travel first
 *   scrolls, and touches in the left 24 pt are left to the back swipe.
 * - Released under 64 pt the row springs back; under the commit line (45% of
 *   the row) it rests open with the action as a button; past it, or flicked,
 *   it commits. Crossing the line is the haptic moment.
 * - A commit confirms on the row: a comet in the action's colour runs once
 *   around it. Favoriting leaves a small heart by the trailing detail.
 * - `inFavorites`: unfavoriting slides the row out and leaves "Removed · Undo"
 *   in its slot (see removeWithUndo in context/favorites.ts).
 *
 * It wraps the long-press track menu too, so the row needs only this. The row
 * itself is `children(swipe)`, which takes VoiceOver's actions and the heart.
 */
export function SwipeableTrackRow({
  track,
  height,
  backgroundColor,
  inFavorites = false,
  children,
}: {
  track: TrackListItem;
  /** The row's fixed height; the theme's row height by default. */
  height?: number;
  /** What the row sits on (a card's fill); the list background by default. */
  backgroundColor?: string;
  /** The Favorites list: unfavoriting leaves an Undo strip in the row's slot. */
  inFavorites?: boolean;
  children: (swipe: SwipeRowProps) => ReactElement;
}) {
  const theme = useTheme();
  const rowHeight = height ?? theme.row.height;
  const reducedMotion = useReducedMotion();
  const favorite = useFavorite(track.id);
  const removal = usePendingFavoriteRemoval(inFavorites ? track.id : null);
  const { toggle, removeWithUndo, undoRemoval } = useFavoriteActions();
  const playNext = usePlayNext();
  const playNextHere = useCanPlayNext(track.id);
  const unavailableOffline = useTrackUnavailableOffline(track.id);
  // Not for a track that can't play here, the playing one, or while
  // controlling another device.
  const canPlayNext = playNextHere && !track.unavailable && !unavailableOffline;
  const trailKind: SwipeActionKind = favorite ? "unfavorite" : "favorite";
  const removesInPlace = inFavorites && favorite;
  const swipeable = removal === null;
  const trackId = track.id;

  const offset = useSharedValue(0);
  const dragStart = useSharedValue(0);
  const rowWidth = useSharedValue(0);
  const armed = useSharedValue(false);
  const armProgress = useSharedValue(0);
  const centered = useSharedValue(0);
  const actionsFade = useSharedValue(1);
  const slot = useSharedValue(rowHeight);
  const stripShown = useSharedValue(0);
  const markPop = useSharedValue(1);
  // Set by a swipe that removes in place, so the strip animates in.
  const removalSwiped = useSharedValue(false);
  const containerRef = useAnimatedRef<Animated.View>();

  // Keyed by track: a recycled cell must not inherit another track's state.
  const [openFor, setOpenFor] = useState<{ trackId: string; side: "lead" | "trail" } | null>(
    null,
  );
  // Play Next went away under a row open on it (the track started, say).
  if (openFor?.trackId === trackId && openFor.side === "lead" && !canPlayNext) {
    setOpenFor(null);
  }
  const isOpen = openFor?.trackId === trackId;
  const [glow, setGlow] = useState<Glow | null>(null);
  // The capsules mount on the row's first touch (or a peek, or an action
  // from VoiceOver), well before a swipe uncovers them: most rows are never
  // swiped and shouldn't carry them.
  const [actionsMounted, setActionsMounted] = useState(false);
  const [stripFor, setStripFor] = useState<string | null>(null);
  if (inFavorites && removal !== null && stripFor !== trackId) setStripFor(trackId);
  const stripMounted = inFavorites && stripFor === trackId;

  const onLayout = useCallback(
    (event: LayoutChangeEvent) => rowWidth.set(event.nativeEvent.layout.width),
    [rowWidth],
  );

  const settle = useCallback(
    (to: number) => {
      "worklet";
      offset.set(reducedMotion ? withTiming(to, REDUCED_SETTLE) : withSpring(to, SETTLE_SPRING));
    },
    [offset, reducedMotion],
  );

  // The Favorites list's removal: the row leaves to the left while its
  // capsule fills the slot, its label centred.
  const slideOut = useCallback(() => {
    "worklet";
    const width = rowWidth.get() || 1000;
    const timing = { duration: SLIDE_OUT_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.System };
    offset.set(withTiming(-width, timing));
    centered.set(withTiming(1, timing));
  }, [centered, offset, rowWidth]);

  const closeRow = useCallback(() => {
    settle(0);
    armProgress.set(withTiming(0, ARM_TIMING));
    setOpenFor(null);
  }, [armProgress, settle]);

  const setOpen = useCallback(
    (side: "lead" | "trail" | null) => setOpenFor(side ? { trackId, side } : null),
    [trackId],
  );

  const clearGlow = useCallback(() => setGlow(null), []);

  const perform = useCallback(
    (kind: SwipeActionKind, fromGesture: boolean) => {
      const glowOn = (on: Glow["on"], delayMs: number) => {
        const width = rowWidth.get();
        if (width <= 0) return;
        glowRuns += 1;
        setGlow({
          id: glowRuns,
          trackId: track.id,
          kind,
          on,
          delayMs,
          box:
            on === "strip"
              ? removalStripBox(width)
              : {
                  x: ROW_GLOW_INSET,
                  y: ROW_GLOW_INSET,
                  width: width - ROW_GLOW_INSET * 2,
                  height: rowHeight - ROW_GLOW_INSET * 2,
                  radius: ROW_GLOW_RADIUS,
                },
        });
      };
      if (kind === "next") {
        if (!playNext([track])) {
          void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
          return;
        }
        AccessibilityInfo.announceForAccessibility("Playing next");
        glowOn("row", COMET_DELAY_MS);
        return;
      }
      if (kind === "favorite") {
        void toggle(track);
        AccessibilityInfo.announceForAccessibility("Added to Favorites");
        markPop.set(0);
        markPop.set(reducedMotion ? 1 : withDelay(MARK_DELAY_MS, withTiming(1, MARK_POP)));
        glowOn("row", COMET_DELAY_MS);
        return;
      }
      if (inFavorites) {
        setActionsMounted(true);
        if (!fromGesture) slideOut();
        removalSwiped.set(true);
        removeWithUndo(track);
        AccessibilityInfo.announceForAccessibility("Removed from Favorites. Undo is available.");
        glowOn("strip", STRIP_COMET_AFTER_MS);
        return;
      }
      void toggle(track);
      AccessibilityInfo.announceForAccessibility("Removed from Favorites");
      glowOn("row", COMET_DELAY_MS);
    },
    [
      inFavorites,
      markPop,
      playNext,
      reducedMotion,
      removalSwiped,
      removeWithUndo,
      rowHeight,
      rowWidth,
      slideOut,
      toggle,
      track,
    ],
  );

  // A tap on the action of a row left open.
  const pressAction = useCallback(
    (kind: SwipeActionKind) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      setOpenFor(null);
      armProgress.set(withTiming(0, ARM_TIMING));
      if (!(kind === "unfavorite" && inFavorites)) settle(0);
      perform(kind, false);
    },
    [armProgress, inFavorites, perform, settle],
  );

  const touchBegan = useCallback(() => {
    setActionsMounted(true);
    notePeekTouch(true);
    if (openRowClose && openRowClose !== closeRow) openRowClose();
  }, [closeRow]);
  const touchEnded = useCallback(() => notePeekTouch(false), []);

  const pan = useMemo(
    () =>
      Gesture.Pan()
        .enabled(swipeable)
        .activeOffsetX([-SWIPE_ACTIVATE_DISTANCE, SWIPE_ACTIVATE_DISTANCE])
        .failOffsetY([-SWIPE_ACTIVATE_DISTANCE, SWIPE_ACTIVATE_DISTANCE])
        // The left edge belongs to the stack's back swipe.
        .hitSlop({ left: -SWIPE_EDGE_INSET })
        .onBegin(() => {
          scheduleOnRN(touchBegan);
        })
        .onStart(() => {
          cancelAnimation(offset);
          dragStart.set(offset.get());
        })
        .onUpdate((event) => {
          const raw = dragStart.get() + event.translationX;
          const allowed = raw > 0 ? canPlayNext : raw < 0;
          const limit = rowWidth.get() || 1000;
          const dx = allowed ? Math.max(-limit, Math.min(limit, raw)) : resistedOffset(raw);
          offset.set(dx);
          const isArmed = allowed && Math.abs(dx) >= commitDistance(rowWidth.get());
          if (isArmed !== armed.get()) {
            armed.set(isArmed);
            armProgress.set(withTiming(isArmed ? 1 : 0, ARM_TIMING));
            scheduleOnRN(armHaptic, isArmed);
          }
        })
        .onEnd((event, success) => {
          const dx = offset.get();
          const lead = dx > 0;
          const allowed = lead ? canPlayNext : dx < 0;
          const release =
            success && allowed ? swipeRelease(dx, event.velocityX, rowWidth.get()) : "close";
          armed.set(false);
          if (release === "commit" && !lead && removesInPlace) {
            slideOut();
            scheduleOnRN(setOpen, null);
            scheduleOnRN(perform, trailKind, true);
            return;
          }
          armProgress.set(withTiming(0, ARM_TIMING));
          if (release === "open") {
            settle(lead ? SWIPE_OPEN_DISTANCE : -SWIPE_OPEN_DISTANCE);
            scheduleOnRN(setOpen, lead ? "lead" : "trail");
            return;
          }
          settle(0);
          scheduleOnRN(setOpen, null);
          if (release === "commit") scheduleOnRN(perform, lead ? "next" : trailKind, true);
        })
        .onFinalize(() => {
          scheduleOnRN(touchEnded);
        }),
    [
      armProgress,
      armed,
      canPlayNext,
      dragStart,
      offset,
      perform,
      removesInPlace,
      rowWidth,
      setOpen,
      settle,
      slideOut,
      swipeable,
      touchBegan,
      touchEnded,
      trailKind,
    ],
  );

  // One open row at a time.
  useEffect(() => {
    if (!isOpen) return;
    if (openRowClose && openRowClose !== closeRow) openRowClose();
    openRowClose = closeRow;
    return () => {
      if (openRowClose === closeRow) openRowClose = null;
    };
  }, [closeRow, isOpen]);

  // ...and the row it was open on goes back.
  useEffect(() => {
    if (!canPlayNext && offset.get() > 0) settle(0);
  }, [canPlayNext, offset, settle]);

  // The removal strip's motion follows the pending removal, which lives in
  // context/favorites.ts so it outlasts this cell. A cell showing a
  // different track starts from where that track is, without animating.
  // Null until the first layout, which (like a recycled cell) starts still.
  const shown = useRef<{ trackId: string | null; removal: PendingRemovalPhase | null }>({
    trackId: null,
    removal: null,
  });
  useLayoutEffect(() => {
    const previous = shown.current;
    shown.current = { trackId, removal };
    const swiped = removalSwiped.get();
    removalSwiped.set(false);
    if (previous.trackId !== trackId) {
      cancelAnimation(offset);
      cancelAnimation(markPop);
      armed.set(false);
      armProgress.set(0);
      markPop.set(1);
      offset.set(removal ? -(rowWidth.get() || 1000) : 0);
      centered.set(removal ? 1 : 0);
      actionsFade.set(removal ? 0 : 1);
      slot.set(removal === "closing" ? 0 : removal ? REMOVAL_SLOT_HEIGHT : rowHeight);
      stripShown.set(removal ? 1 : 0);
      return;
    }
    if (previous.removal === removal) return;
    const animate = !reducedMotion;
    const slotTiming = { duration: SLOT_MS, easing: EASE_IN_OUT, reduceMotion: ReduceMotion.System };
    if (removal === "holding") {
      if (swiped && animate) {
        slot.set(withDelay(STRIP_AFTER_MS, withTiming(REMOVAL_SLOT_HEIGHT, slotTiming)));
        actionsFade.set(withDelay(STRIP_AFTER_MS, withTiming(0, { duration: 220 })));
        stripShown.set(
          withDelay(STRIP_AFTER_MS + 60, withTiming(1, { duration: 450, easing: EASE_OUT })),
        );
      } else {
        offset.set(-(rowWidth.get() || 1000));
        centered.set(1);
        slot.set(REMOVAL_SLOT_HEIGHT);
        actionsFade.set(0);
        stripShown.set(1);
      }
      return;
    }
    if (removal === "closing") {
      slot.set(animate ? withTiming(0, slotTiming) : 0);
      stripShown.set(animate ? withTiming(0, { duration: 200 }) : 0);
      return;
    }
    // Undone, or the DELETE failed and the row is back: the slot opens up
    // and the row slides back in over the strip.
    armProgress.set(0);
    centered.set(0);
    actionsFade.set(0);
    actionsFade.set(withDelay(UNDO_SETTLE_MS, withTiming(1, { duration: 0 })));
    slot.set(animate ? withTiming(rowHeight, slotTiming) : rowHeight);
    stripShown.set(animate ? withTiming(0, { duration: 200 }) : 0);
    offset.set(animate ? withSpring(0, SETTLE_SPRING) : 0);
  }, [
    actionsFade,
    armProgress,
    armed,
    centered,
    markPop,
    offset,
    reducedMotion,
    removal,
    removalSwiped,
    rowHeight,
    rowWidth,
    slot,
    stripShown,
    trackId,
  ]);

  // After Undo the strip stays a moment, to fade out.
  useEffect(() => {
    if (removal !== null || stripFor === null) return;
    const timer = setTimeout(() => setStripFor(null), STRIP_FADE_MS);
    return () => clearTimeout(timer);
  }, [removal, stripFor]);

  // The first-run peek: right (if Play Next applies), back, left, back.
  const runPeek = useCallback(() => {
    setActionsMounted(true);
    const open = (to: number) =>
      withTiming(to, { duration: PEEK_OPEN_MS, easing: EASE_OUT, reduceMotion: ReduceMotion.Never });
    const back = () => withDelay(PEEK_HOLD_MS, withSpring(0, SETTLE_SPRING));
    offset.set(
      canPlayNext
        ? withSequence(
            open(SWIPE_OPEN_DISTANCE),
            back(),
            withDelay(PEEK_GAP_MS, open(-SWIPE_OPEN_DISTANCE)),
            back(),
          )
        : withSequence(open(-SWIPE_OPEN_DISTANCE), back()),
    );
  }, [canPlayNext, offset]);

  useEffect(() => {
    if (!swipeable) return;
    return offerPeek({
      measure: (done) => {
        const node = containerRef.current;
        if (!node) {
          done(null);
          return;
        }
        node.measureInWindow((_x, y, _width, frameHeight) => done({ y, height: frameHeight }));
      },
      peek: runPeek,
    });
  }, [containerRef, runPeek, swipeable, trackId]);

  const onUndo = useCallback(() => {
    undoRemoval(track);
  }, [track, undoRemoval]);

  const menuPlayNext = useCallback(() => perform("next", false), [perform]);

  const accessibilityActions = useMemo<AccessibilityActionInfo[]>(
    () => [
      ...(canPlayNext ? [{ name: "playNext", label: "Play Next" }] : []),
      { name: "favorite", label: favorite ? "Remove from Favorites" : "Add to Favorites" },
    ],
    [canPlayNext, favorite],
  );
  const onAccessibilityAction = useCallback(
    (event: AccessibilityActionEvent) => {
      if (event.nativeEvent.actionName === "playNext") perform("next", false);
      else if (event.nativeEvent.actionName === "favorite") perform(trailKind, false);
    },
    [perform, trailKind],
  );

  const marked = favorite && !inFavorites;
  const markColor = swipeActionStyle("favorite", theme).color;
  const favoriteMark = useCallback(
    (style?: StyleProp<ViewStyle>) =>
      marked ? <FavoriteMark pop={markPop} color={markColor} style={style} /> : null,
    [markColor, markPop, marked],
  );

  const frontStyle = useAnimatedStyle(() => ({
    transform: [{ translateX: offset.get() }],
  }));
  const slotStyle = useAnimatedStyle(() => ({ height: slot.get() }));

  const shownGlow = glow?.trackId === trackId ? glow : null;
  const glowView = (on: Glow["on"]) =>
    shownGlow?.on === on ? (
      <CometGlow
        key={shownGlow.id}
        box={shownGlow.box}
        from={shownGlow.kind === "next" ? "left" : "right"}
        color={swipeActionStyle(shownGlow.kind, theme).color}
        lapMs={on === "strip" ? COMET_STRIP_LAP_MS : COMET_LAP_MS}
        delayMs={shownGlow.delayMs}
        reducedMotion={reducedMotion}
        onDone={clearGlow}
        style={on === "strip" ? styles.stripGlow : undefined}
      />
    ) : null;

  const actionProps = {
    theme,
    rowHeight,
    offset,
    armed,
    armProgress,
    centered,
    fade: actionsFade,
  };

  return (
    <Animated.View
      ref={containerRef}
      onLayout={onLayout}
      // Only the Favorites list's slot changes height (to the Undo strip and
      // shut); clipping it keeps the leaving row inside.
      style={inFavorites ? [styles.slot, slotStyle] : { height: rowHeight }}
    >
      <GestureDetector gesture={pan}>
        <View style={{ height: rowHeight }}>
          {actionsMounted && canPlayNext ? (
            <SwipeAction
              side="lead"
              kind="next"
              onPress={() => pressAction("next")}
              {...actionProps}
            />
          ) : null}
          {actionsMounted ? (
            <SwipeAction
              side="trail"
              kind={trailKind}
              onPress={() => pressAction(trailKind)}
              {...actionProps}
            />
          ) : null}
          <Animated.View
            style={[{ height: rowHeight }, frontStyle]}
            accessibilityElementsHidden={!swipeable}
            importantForAccessibility={swipeable ? "auto" : "no-hide-descendants"}
          >
            <TrackActionsContextMenu
              track={track}
              height={rowHeight}
              backgroundColor={backgroundColor}
              onPlayNext={menuPlayNext}
            >
              {children({
                accessibilityActions,
                onAccessibilityAction,
                accessibilityValue: marked ? { text: "Favorite" } : undefined,
                favoriteMark,
              })}
            </TrackActionsContextMenu>
            {isOpen ? (
              // A tap on a row left open closes it rather than playing.
              <Pressable
                accessible={false}
                onPress={closeRow}
                style={StyleSheet.absoluteFill}
              />
            ) : null}
          </Animated.View>
          {glowView("row")}
        </View>
      </GestureDetector>
      {stripMounted ? (
        <RemovalStrip track={track} theme={theme} shown={stripShown} onUndo={onUndo} />
      ) : null}
      {glowView("strip")}
      {isOpen ? <CloseWhenMoved target={containerRef} onMoved={closeRow} /> : null}
    </Animated.View>
  );
}

/**
 * Closes an open row once its list scrolls: watches where the row is on
 * screen, frame by frame, while it's open (one row at a time).
 */
function CloseWhenMoved({
  target,
  onMoved,
}: {
  target: AnimatedRef<Animated.View>;
  onMoved: () => void;
}) {
  const origin = useSharedValue<number | null>(null);
  const moved = useSharedValue(false);
  useFrameCallback(() => {
    if (moved.get()) return;
    const frame = measure(target);
    if (!frame) return;
    const start = origin.get();
    if (start === null) {
      origin.set(frame.pageY);
      return;
    }
    if (Math.abs(frame.pageY - start) > 4) {
      moved.set(true);
      scheduleOnRN(onMoved);
    }
  });
  return null;
}

const styles = StyleSheet.create({
  slot: {
    overflow: "hidden",
  },
  stripGlow: {
    position: "absolute",
    left: 0,
    right: 0,
    top: 0,
    height: REMOVAL_SLOT_HEIGHT,
  },
});
