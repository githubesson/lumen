import {
  memo,
  startTransition,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  AppState,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Slider from "@react-native-community/slider";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { Image } from "expo-image";
import Animated, {
  Easing,
  Extrapolation,
  FadeInDown,
  FadeInLeft,
  FadeInRight,
  FadeOutLeft,
  FadeOutRight,
  FadeOutUp,
  interpolate,
  runOnJS,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { Gesture, GestureDetector } from "react-native-gesture-handler";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { SymbolView, type SymbolViewProps } from "expo-symbols";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  trackCoverUrl,
  useFavorite,
  useFavoriteActions,
  type TimeState,
  type TrackListItem,
} from "@music-library/core";
import { AdaptiveGlass } from "../components/adaptive-glass";
import { CoverArt } from "../components/cover-art";
import { TrackActionsMenuButton } from "../components/track-actions-menu";
import {
  useCurrentTrack,
  usePlayerControls,
  usePlayerPlayback,
  usePlayerQueue,
  usePlayerTime,
  usePlayerVolume,
} from "../context/player";
import {
  AirPlayRoutePickerView,
  isAirPlayRoutePickerAvailable,
} from "../modules/air-play-route-picker";
import { formatDurationSec } from "../lib/format";
import { useTheme } from "../theme/theme";

const ROW_HEIGHT = 64;
const ACTION_SIZE = 36;
const COMPACT_COVER_SIZE = 58;
const QUEUE_OPEN_ANIMATION_MS = 240;
const QUEUE_DEFER_THRESHOLD = 20;
const QUEUE_EAGER_ROWS = 6;
const QUEUE_ARTWORK_DELAY_MS = 140;
const QUEUE_ADVANCE_ANIMATION_MS = 260;
const QUEUE_PREFETCH_LIMIT = 20;
const VOLUME_UPDATE_INTERVAL_MS = 80;
const PROGRESS_DISPLAY_INTERVAL_MS = 250;
const TABLET_BREAKPOINT = 600;
const TABLET_CONTENT_MAX_WIDTH = 760;
const PHONE_BOTTOM_CONTROLS_ESTIMATE = 316;
const HERO_META_BLOCK_HEIGHT = 54;
const PHONE_ARTWORK_META_MIN_GAP = 44;
const PHONE_META_CONTROLS_GAP = 14;
const TABLET_ARTWORK_META_GAP = 82;

type DisplayedQueue = {
  queue: TrackListItem[];
  startIndex: number;
};

export default function NowPlayingScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { queue: queueParam } = useLocalSearchParams<{ queue?: string }>();
  const insets = useSafeAreaInsets();
  const { width, height } = useWindowDimensions();
  const track = useCurrentTrack();
  const { queue, index } = usePlayerQueue();
  const { shuffle, repeat } = usePlayerPlayback();
  const { jumpTo, toggleShuffle, cycleRepeat } = usePlayerControls();
  const { toggle: toggleFavorite } = useFavoriteActions();
  const [queueOpen, setQueueOpen] = useState(() => queueParam === "1");
  const [bodyHeight, setBodyHeight] = useState(0);
  const [bottomControlsHeight, setBottomControlsHeight] = useState(0);
  const transition = useSharedValue(0);
  const isTabletLayout = Math.min(width, height) >= TABLET_BREAKPOINT;
  const pad = isTabletLayout
    ? Math.max(52, Math.round((width - TABLET_CONTENT_MAX_WIDTH) / 2))
    : 28;
  const bodyWidth = Math.max(0, width - pad * 2);
  const availableBodyHeight =
    bodyHeight || Math.max(0, height - insets.bottom - 44);

  useEffect(() => {
    if (queueParam === "1") {
      setQueueOpen(true);
    }
  }, [queueParam]);

  useEffect(() => {
    transition.value = withTiming(queueOpen ? 1 : 0, {
      duration: 240,
      easing: Easing.bezier(0.2, 0.8, 0.2, 1),
    });
  }, [queueOpen, transition]);

  const measuredBottomControls =
    bottomControlsHeight ||
    (isTabletLayout ? 244 : PHONE_BOTTOM_CONTROLS_ESTIMATE);
  const bottomControlsTop = Math.max(
    0,
    availableBodyHeight - measuredBottomControls,
  );
  const trackId = track?.id ?? null;
  const favorite = useFavorite(trackId ?? "");
  const previousTrackIdRef = useRef<string | null>(null);
  const previousTrackIndexRef = useRef(index);
  const trackTransitionDirection =
    previousTrackIdRef.current != null &&
    previousTrackIdRef.current !== trackId &&
    index < previousTrackIndexRef.current
      ? -1
      : 1;
  const artworkTransitionKey = track?.album_id ?? trackId ?? "hero-cover";
  const coverStartTop = isTabletLayout
    ? Math.max(72, Math.round(availableBodyHeight * 0.11))
    : 60;
  const preferredCoverSize = isTabletLayout
    ? Math.min(
        Math.round(bodyWidth * 0.74),
        Math.round(availableBodyHeight * 0.46),
        560,
      )
    : Math.min(Math.round(width * 0.62), 320);
  const heightLimitedPhoneCoverSize = Math.max(
    COMPACT_COVER_SIZE,
    Math.round(
      bottomControlsTop -
        coverStartTop -
        PHONE_ARTWORK_META_MIN_GAP -
        HERO_META_BLOCK_HEIGHT -
        PHONE_META_CONTROLS_GAP,
    ),
  );
  const coverSize = isTabletLayout
    ? preferredCoverSize
    : Math.min(preferredCoverSize, heightLimitedPhoneCoverSize);
  const coverStartLeft = Math.max(0, (bodyWidth - coverSize) / 2);
  const coverEndTop = 2;
  const coverEndLeft = 0;
  const coverStartCenterX = coverStartLeft + coverSize / 2;
  const coverStartCenterY = coverStartTop + coverSize / 2;
  const coverEndCenterX = coverEndLeft + COMPACT_COVER_SIZE / 2;
  const coverEndCenterY = coverEndTop + COMPACT_COVER_SIZE / 2;
  const metaStartTop = isTabletLayout
    ? coverStartTop + coverSize + TABLET_ARTWORK_META_GAP
    : Math.max(
        coverStartTop + coverSize + PHONE_ARTWORK_META_MIN_GAP,
        bottomControlsTop - HERO_META_BLOCK_HEIGHT - PHONE_META_CONTROLS_GAP,
      );
  const metaEndTop = 6;
  const metaStartLeft = 0;
  const metaEndLeft = COMPACT_COVER_SIZE + 6;
  const actionsLeft = Math.max(0, bodyWidth - ACTION_SIZE * 2 - 10);
  const metaStartWidth = Math.max(120, actionsLeft - 12);
  const metaEndWidth = Math.max(120, actionsLeft - metaEndLeft - 10);
  const heroExpandedHeight = metaStartTop + 50;
  const heroCompactHeight = COMPACT_COVER_SIZE + 2;
  const queueBottomInset = measuredBottomControls + 18;
  const queueOpenTop = heroCompactHeight + 4;
  const queueClosedTop = Math.max(
    queueOpenTop,
    Math.min(
      heroExpandedHeight + 10,
      Math.max(queueOpenTop, availableBodyHeight - queueBottomInset - 24),
    ),
  );

  const heroStyle = useAnimatedStyle(() => ({
    height: interpolate(
      transition.value,
      [0, 1],
      [heroExpandedHeight, heroCompactHeight],
      Extrapolation.CLAMP,
    ),
  }));

  const coverStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          transition.value,
          [0, 1],
          [0, coverEndCenterX - coverStartCenterX],
          Extrapolation.CLAMP,
        ),
      },
      {
        translateY: interpolate(
          transition.value,
          [0, 1],
          [0, coverEndCenterY - coverStartCenterY],
          Extrapolation.CLAMP,
        ),
      },
      {
        scale: interpolate(
          transition.value,
          [0, 1],
          [1, COMPACT_COVER_SIZE / coverSize],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const metaStyle = useAnimatedStyle(() => ({
    top: interpolate(
      transition.value,
      [0, 1],
      [metaStartTop, metaEndTop],
      Extrapolation.CLAMP,
    ),
    left: interpolate(
      transition.value,
      [0, 1],
      [metaStartLeft, metaEndLeft],
      Extrapolation.CLAMP,
    ),
    width: interpolate(
      transition.value,
      [0, 1],
      [metaStartWidth, metaEndWidth],
      Extrapolation.CLAMP,
    ),
    transform: [
      {
        scale: interpolate(transition.value, [0, 1], [1, 0.8], Extrapolation.CLAMP),
      },
    ],
  }));

  const actionsStyle = useAnimatedStyle(() => ({
    top: interpolate(
      transition.value,
      [0, 1],
      [metaStartTop + 2, 10],
      Extrapolation.CLAMP,
    ),
  }));

  const queueSectionStyle = useAnimatedStyle(() => ({
    top: interpolate(
      transition.value,
      [0, 1],
      [queueClosedTop, queueOpenTop],
      Extrapolation.CLAMP,
    ),
    opacity: interpolate(
      transition.value,
      [0, 0.25, 1],
      [0, 0, 1],
      Extrapolation.CLAMP,
    ),
    marginTop: interpolate(
      transition.value,
      [0, 1],
      [0, 16],
      Extrapolation.CLAMP,
    ),
    transform: [
      {
        translateY: interpolate(
          transition.value,
          [0, 1],
          [-10, 0],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  const handleQueueJump = useCallback(
    (position: number) => {
      void Haptics.selectionAsync();
      jumpTo(position);
    },
    [jumpTo],
  );

  const handleQueueShuffle = useCallback(() => {
    void Haptics.selectionAsync();
    toggleShuffle();
  }, [toggleShuffle]);

  const handleQueueRepeat = useCallback(() => {
    void Haptics.selectionAsync();
    cycleRepeat();
  }, [cycleRepeat]);

  useEffect(() => {
    previousTrackIdRef.current = trackId;
    previousTrackIndexRef.current = index;
  }, [index, trackId]);

  if (!track) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: theme.color.bg,
          justifyContent: "center",
          alignItems: "center",
        }}
      >
        <Text style={{ color: theme.color.fgMuted }}>No track loaded.</Text>
      </View>
    );
  }

  return (
    <View
      style={{
        flex: 1,
        backgroundColor: theme.color.bg,
        paddingBottom: Math.max(insets.bottom + 8, 20),
      }}
    >
      <Pressable
        onPress={() => router.back()}
        style={styles.grabberTap}
        accessibilityRole="button"
        accessibilityLabel="Close now playing"
      >
        <View
          style={[styles.grabber, { backgroundColor: theme.color.overlayGrabber }]}
        />
      </Pressable>

      <View
        onLayout={(event) => {
          const next = event.nativeEvent.layout.height;
          setBodyHeight((prev) => (prev === next ? prev : next));
        }}
        style={[styles.body, { paddingHorizontal: pad }]}
      >
        <Animated.View style={[styles.hero, heroStyle]}>
          <Animated.View
            style={[
              styles.heroCover,
              {
                left: coverStartLeft,
                top: coverStartTop,
                width: coverSize,
                height: coverSize,
              },
              coverStyle,
            ]}
          >
            <View style={styles.heroSwapStage}>
              <Animated.View
                key={artworkTransitionKey}
                entering={
                  trackTransitionDirection > 0
                    ? FadeInRight.duration(260)
                    : FadeInLeft.duration(260)
                }
                exiting={
                  trackTransitionDirection > 0
                    ? FadeOutLeft.duration(180)
                    : FadeOutRight.duration(180)
                }
                style={styles.heroSwapLayer}
              >
                <View
                  style={{
                    borderRadius: 12,
                    boxShadow: "0 18px 40px rgba(0, 0, 0, 0.45)",
                  }}
                >
                  <CoverArt track={track} size={coverSize} />
                </View>
              </Animated.View>
            </View>
          </Animated.View>

          <Animated.View style={[styles.heroMeta, metaStyle]}>
            <View style={styles.heroMetaStage}>
              <Animated.View
                key={track.id}
                entering={FadeInDown.duration(240)}
                exiting={FadeOutUp.duration(160)}
                style={styles.heroMetaLayer}
              >
                <View style={styles.titleLine}>
                  <Text
                    numberOfLines={1}
                    selectable
                    style={{
                      color: theme.color.fg,
                      fontSize: 22,
                      fontWeight: "700",
                      letterSpacing: -0.3,
                      flexShrink: 1,
                    }}
                  >
                    {track.title}
                  </Text>
                </View>
                {track.artist ? (
                  <Text
                    numberOfLines={1}
                    style={{ color: theme.color.fgMuted, fontSize: 17 }}
                  >
                    {track.artist}
                  </Text>
                ) : null}
              </Animated.View>
            </View>
          </Animated.View>

          <Animated.View
            style={[
              styles.heroActions,
              { left: actionsLeft, width: ACTION_SIZE * 2 + 10 },
              actionsStyle,
            ]}
          >
            <Chip
              icon={favorite ? "star.fill" : "star"}
              iconSize={14}
              accessibilityLabel={
                favorite ? "Remove from favorites" : "Add to favorites"
              }
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                void toggleFavorite(track.id);
              }}
            />
            <TrackActionsMenuButton
              track={track}
              size={ACTION_SIZE}
              accessibilityLabel="More actions"
            />
          </Animated.View>
        </Animated.View>

        <Animated.View
          pointerEvents={queueOpen ? "auto" : "none"}
          style={[
            styles.queueSection,
            { bottom: queueBottomInset, left: pad, right: pad },
            queueSectionStyle,
          ]}
        >
          <QueueSection
            queueOpen={queueOpen}
            queue={queue}
            startIndex={index + 1}
            artistLabel={track.artist ?? "current queue"}
            shuffle={shuffle}
            repeat={repeat}
            onJumpToPosition={handleQueueJump}
            onToggleShuffle={handleQueueShuffle}
            onCycleRepeat={handleQueueRepeat}
          />
        </Animated.View>

        <View
          onLayout={(event) => {
            const next = event.nativeEvent.layout.height;
            setBottomControlsHeight((prev) => (prev === next ? prev : next));
          }}
          style={[styles.bottomControls, { left: pad, right: pad }]}
        >
          <NowPlayingBottomControls
            queueOpen={queueOpen}
            onToggleQueueOpen={() => setQueueOpen((value) => !value)}
          />
        </View>
      </View>
    </View>
  );
}

const NowPlayingBottomControls = memo(function NowPlayingBottomControls({
  queueOpen,
  onToggleQueueOpen,
}: {
  queueOpen: boolean;
  onToggleQueueOpen: () => void;
}) {
  const theme = useTheme();
  const controls = usePlayerControls();
  const { isPlaying, shuffle } = usePlayerPlayback();
  const { volume, muted } = usePlayerVolume();
  const time = usePlayerTime();
  const { width, height } = useWindowDimensions();
  const volumeChange = useThrottledVolumeChange(controls.setVolume);
  const isTabletLayout = Math.min(width, height) >= TABLET_BREAKPOINT;
  const { displayTime, progress, remaining, beginSeek, previewSeek, commitSeek } =
    useEstimatedPlaybackTime(time, isPlaying);

  return (
    <>
      <View style={{ width: "100%" }}>
        <Slider
          value={progress}
          minimumValue={0}
          maximumValue={1}
          onSlidingStart={beginSeek}
          onValueChange={previewSeek}
          onSlidingComplete={(value) => {
            const next = commitSeek(value);
            if (time.duration > 0) controls.seek(next);
          }}
          minimumTrackTintColor={theme.color.overlayStrong}
          maximumTrackTintColor={theme.color.overlayMuted}
          thumbTintColor="transparent"
        />
        <View style={styles.timesRow}>
          <Text style={[styles.timeText, { color: theme.color.fgMuted }]}>
            {formatDurationSec(displayTime)}
          </Text>
          <Text style={[styles.timeText, { color: theme.color.fgMuted }]}>
            {"-" + formatDurationSec(remaining)}
          </Text>
        </View>
      </View>

      <View style={[styles.transport, isTabletLayout ? styles.transportTablet : null]}>
        <Pressable
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            controls.prev();
          }}
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel="Previous track"
          style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        >
          <SymbolView
            name="backward.fill"
            size={44}
            tintColor={theme.color.fg}
          />
        </Pressable>
        <Pressable
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
            controls.toggle();
          }}
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel={isPlaying ? "Pause" : "Play"}
          style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        >
          <SymbolView
            name={isPlaying ? "pause.fill" : "play.fill"}
            size={44}
            tintColor={theme.color.fg}
          />
        </Pressable>
        <Pressable
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            controls.next();
          }}
          hitSlop={16}
          accessibilityRole="button"
          accessibilityLabel="Next track"
          style={({ pressed }) => ({ opacity: pressed ? 0.55 : 1 })}
        >
          <SymbolView
            name="forward.fill"
            size={44}
            tintColor={theme.color.fg}
          />
        </Pressable>
      </View>

      <View style={[styles.volumeRow, isTabletLayout ? styles.volumeRowTablet : null]}>
        <SymbolView
          name="speaker.fill"
          size={13}
          tintColor={theme.color.fgMuted}
        />
        <VolumeBar
          value={muted ? 0 : volume}
          onChange={volumeChange.change}
          onChangeEnd={volumeChange.commit}
        />
        <SymbolView
          name="speaker.wave.3.fill"
          size={17}
          tintColor={theme.color.fgMuted}
        />
      </View>

      {isTabletLayout ? (
        <View style={[styles.bottomToolbar, styles.bottomToolbarTablet]}>
          <NativeAirPlayRoutePickerButton />
          <View style={styles.bottomToolbarRight}>
            <NativeQueueMenuButton
              queueOpen={queueOpen}
              shuffle={shuffle}
              onPrimaryAction={() => {
                void Haptics.selectionAsync();
                onToggleQueueOpen();
              }}
            />
          </View>
        </View>
      ) : (
        <View style={styles.bottomToolbar}>
          <NativeAirPlayRoutePickerButton />
          <NativeQueueMenuButton
            queueOpen={queueOpen}
            shuffle={shuffle}
            onPrimaryAction={() => {
              void Haptics.selectionAsync();
              onToggleQueueOpen();
            }}
          />
        </View>
      )}
    </>
  );
});

/**
 * Smooth display time interpolated on top of the core's deliberately
 * quantized 250ms clock. Stays local to this screen: an anchor of
 * (core time, wall time) is re-based whenever the core reports, and a UI
 * interval estimates in between while playing in the foreground. While the
 * user drags the scrubber (`beginSeek`..`commitSeek`) the estimator is
 * paused and the dragged value is shown instead.
 */
function useEstimatedPlaybackTime(time: TimeState, isPlaying: boolean) {
  const [appState, setAppState] = useState(() => AppState.currentState);
  const [displayTime, setDisplayTime] = useState(time.currentTime);
  const seekingRef = useRef(false);
  const anchorRef = useRef({
    baseTime: time.currentTime,
    wallTime: performance.now(),
  });

  useEffect(() => {
    const subscription = AppState.addEventListener("change", setAppState);
    return () => {
      subscription.remove();
    };
  }, []);

  useEffect(() => {
    anchorRef.current = {
      baseTime: time.currentTime,
      wallTime: performance.now(),
    };
    if (!isPlaying || seekingRef.current) {
      setDisplayTime(time.currentTime);
    }
  }, [isPlaying, time.currentTime]);

  useEffect(() => {
    if (appState !== "active" || !isPlaying || seekingRef.current) {
      return;
    }
    const tick = () => {
      const { baseTime, wallTime } = anchorRef.current;
      const elapsed = (performance.now() - wallTime) / 1000;
      const next =
        time.duration > 0
          ? Math.min(baseTime + elapsed, time.duration)
          : baseTime + elapsed;
      setDisplayTime((prev) => (Math.abs(prev - next) < 0.05 ? prev : next));
    };
    tick();
    const interval = setInterval(tick, PROGRESS_DISPLAY_INTERVAL_MS);
    return () => clearInterval(interval);
  }, [appState, isPlaying, time.duration, time.currentTime]);

  const beginSeek = useCallback(() => {
    seekingRef.current = true;
  }, []);

  const previewSeek = useCallback(
    (value: number) => {
      if (time.duration <= 0) return;
      setDisplayTime(value * time.duration);
    },
    [time.duration],
  );

  /** Returns the committed time in seconds; the caller issues the seek. */
  const commitSeek = useCallback(
    (value: number) => {
      const next = time.duration > 0 ? value * time.duration : 0;
      anchorRef.current = {
        baseTime: next,
        wallTime: performance.now(),
      };
      setDisplayTime(next);
      seekingRef.current = false;
      return next;
    },
    [time.duration],
  );

  const progress =
    time.duration > 0 ? Math.min(1, displayTime / time.duration) : 0;
  const remaining = Math.max(0, (time.duration || 0) - displayTime);

  return { displayTime, progress, remaining, beginSeek, previewSeek, commitSeek };
}

function useThrottledVolumeChange(setVolume: (value: number) => void) {
  const lastUpdateRef = useRef(0);
  const pendingValueRef = useRef<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearPendingTimer = useCallback(() => {
    if (!timerRef.current) return;
    clearTimeout(timerRef.current);
    timerRef.current = null;
  }, []);

  useEffect(() => clearPendingTimer, [clearPendingTimer]);

  const flushPending = useCallback(() => {
    timerRef.current = null;
    const pending = pendingValueRef.current;
    if (pending == null) return;
    pendingValueRef.current = null;
    lastUpdateRef.current = performance.now();
    setVolume(pending);
  }, [setVolume]);

  const change = useCallback(
    (value: number) => {
      const now = performance.now();
      const elapsed = now - lastUpdateRef.current;

      if (elapsed >= VOLUME_UPDATE_INTERVAL_MS) {
        clearPendingTimer();
        pendingValueRef.current = null;
        lastUpdateRef.current = now;
        setVolume(value);
        return;
      }

      pendingValueRef.current = value;
      if (!timerRef.current) {
        timerRef.current = setTimeout(
          flushPending,
          VOLUME_UPDATE_INTERVAL_MS - elapsed,
        );
      }
    },
    [clearPendingTimer, flushPending, setVolume],
  );

  const commit = useCallback(
    (value: number) => {
      clearPendingTimer();
      pendingValueRef.current = null;
      lastUpdateRef.current = performance.now();
      setVolume(value);
    },
    [clearPendingTimer, setVolume],
  );

  return useMemo(() => ({ change, commit }), [change, commit]);
}

const QueueSection = memo(function QueueSection({
  queueOpen,
  queue,
  startIndex,
  artistLabel,
  shuffle,
  repeat,
  onJumpToPosition,
  onToggleShuffle,
  onCycleRepeat,
}: {
  queueOpen: boolean;
  queue: TrackListItem[];
  startIndex: number;
  artistLabel: string;
  shuffle: boolean;
  repeat: "off" | "all" | "one";
  onJumpToPosition: (position: number) => void;
  onToggleShuffle: () => void;
  onCycleRepeat: () => void;
}) {
  const theme = useTheme();
  const upcomingLength = Math.max(0, queue.length - startIndex);
  const [listReady, setListReady] = useState(
    queueOpen && upcomingLength <= QUEUE_DEFER_THRESHOLD,
  );
  const [showArtwork, setShowArtwork] = useState(
    queueOpen && upcomingLength <= QUEUE_DEFER_THRESHOLD,
  );
  const [renderCount, setRenderCount] = useState(() =>
    Math.min(upcomingLength, QUEUE_EAGER_ROWS),
  );
  const [displayedQueue, setDisplayedQueue] = useState<DisplayedQueue>(() => ({
    queue,
    startIndex,
  }));
  const listReadyRef = useRef(listReady);
  const displayedQueueRef = useRef(displayedQueue);
  const pendingQueueRef = useRef<DisplayedQueue | null>(null);
  const prefetchedArtworkRef = useRef(new Set<string>());
  const queueAdvanceOffset = useSharedValue(0);

  useEffect(() => {
    listReadyRef.current = listReady;
  }, [listReady]);

  const setDisplayedQueueState = useCallback((next: DisplayedQueue) => {
    displayedQueueRef.current = next;
    setDisplayedQueue(next);
  }, []);

  const finishQueueAdvance = useCallback(() => {
    const pending = pendingQueueRef.current;
    pendingQueueRef.current = null;
    queueAdvanceOffset.value = 0;
    if (pending) {
      setDisplayedQueueState(pending);
    }
  }, [queueAdvanceOffset, setDisplayedQueueState]);

  useEffect(() => {
    const eagerCount = Math.min(upcomingLength, QUEUE_EAGER_ROWS);
    let raf = 0;
    let listTimer: ReturnType<typeof setTimeout> | null = null;
    let artworkTimer: ReturnType<typeof setTimeout> | null = null;

    if (!queueOpen) {
      setListReady(false);
      setShowArtwork(false);
      setRenderCount(eagerCount);
      return;
    }

    if (upcomingLength <= QUEUE_DEFER_THRESHOLD) {
      setListReady(true);
      setShowArtwork(true);
      setRenderCount(upcomingLength);
      return;
    }

    setListReady(false);
    setShowArtwork(false);
    setRenderCount(eagerCount);
    listTimer = setTimeout(() => {
      startTransition(() => {
        setListReady(true);
        setRenderCount(eagerCount);
      });
      raf = requestAnimationFrame(() => {
        startTransition(() => {
          setRenderCount(upcomingLength);
        });
      });
      artworkTimer = setTimeout(() => {
        startTransition(() => {
          setShowArtwork(true);
        });
      }, QUEUE_ARTWORK_DELAY_MS);
    }, QUEUE_OPEN_ANIMATION_MS + 32);

    return () => {
      if (listTimer) clearTimeout(listTimer);
      if (artworkTimer) clearTimeout(artworkTimer);
      if (raf) cancelAnimationFrame(raf);
    };
  }, [queueOpen, upcomingLength]);

  useEffect(() => {
    const nextQueue: DisplayedQueue = { queue, startIndex };
    const currentQueue = displayedQueueRef.current;

    if (
      currentQueue.queue === queue &&
      currentQueue.startIndex === startIndex
    ) {
      return;
    }

    const pendingQueue = pendingQueueRef.current;
    if (
      pendingQueue?.queue === queue &&
      pendingQueue.startIndex === startIndex
    ) {
      return;
    }

    const canAnimateAdvance =
      queueOpen &&
      listReady &&
      currentQueue.queue === queue &&
      currentQueue.startIndex + 1 === startIndex &&
      currentQueue.startIndex + 1 < currentQueue.queue.length &&
      currentQueue.queue[currentQueue.startIndex + 1]?.id === queue[startIndex]?.id;

    if (!canAnimateAdvance) {
      pendingQueueRef.current = null;
      queueAdvanceOffset.value = 0;
      setDisplayedQueueState(nextQueue);
      return;
    }

    pendingQueueRef.current = nextQueue;
    queueAdvanceOffset.value = 0;
    queueAdvanceOffset.value = withTiming(
      -ROW_HEIGHT,
      {
        duration: QUEUE_ADVANCE_ANIMATION_MS,
        easing: Easing.bezier(0.2, 0.8, 0.2, 1),
      },
      (finished) => {
        if (finished) {
          runOnJS(finishQueueAdvance)();
        }
      },
    );
  }, [
    finishQueueAdvance,
    listReady,
    queueAdvanceOffset,
    queueOpen,
    setDisplayedQueueState,
    startIndex,
    queue,
  ]);

  useEffect(() => {
    if (!queueOpen || upcomingLength === 0) return;
    const requestSize = Math.max(1, Math.round(44 * PixelRatio.get()));
    const urls = Array.from(
      new Set(
        queue
          .slice(startIndex, startIndex + QUEUE_PREFETCH_LIMIT)
          .filter((track) => track.has_cover !== false)
          .map((track) => trackCoverUrl(track, requestSize)),
      ),
    ).filter((url) => !prefetchedArtworkRef.current.has(url));
    if (urls.length === 0) return;
    for (const url of urls) prefetchedArtworkRef.current.add(url);
    void Image.prefetch(urls, "memory-disk");
  }, [queue, queueOpen, startIndex, upcomingLength]);

  const isAdvancingQueue = displayedQueue.startIndex !== startIndex;
  const visibleUpcoming = useMemo(() => {
    if (!listReady) return [];
    return displayedQueue.queue.slice(
      displayedQueue.startIndex,
      Math.min(
        displayedQueue.queue.length,
        displayedQueue.startIndex + renderCount + (isAdvancingQueue ? 1 : 0),
      ),
    );
  }, [
    displayedQueue.queue,
    displayedQueue.startIndex,
    isAdvancingQueue,
    listReady,
    renderCount,
  ]);

  const renderQueueItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TrackListItem>) => (
      <QueueRow
        track={item}
        position={displayedQueue.startIndex + index}
        advanceOffset={queueAdvanceOffset}
        showArtwork={showArtwork}
        onJumpToPosition={onJumpToPosition}
      />
    ),
    [
      displayedQueue.startIndex,
      onJumpToPosition,
      queueAdvanceOffset,
      showArtwork,
    ],
  );

  const keyExtractor = useCallback(
    (item: TrackListItem, index: number) =>
      `${item.id}:${displayedQueue.startIndex + index}`,
    [displayedQueue.startIndex],
  );

  return (
    <View style={styles.queueSectionInner}>
      <View style={styles.pillsRow}>
        <ModePill
          icon="shuffle"
          selected={shuffle}
          accessibilityLabel={shuffle ? "Turn shuffle off" : "Turn shuffle on"}
          onPress={onToggleShuffle}
        />
        <ModePill
          icon={repeat === "one" ? "repeat.1" : "repeat"}
          selected={repeat !== "off"}
          accessibilityLabel={
            repeat === "off"
              ? "Repeat off. Turn on repeat"
              : repeat === "all"
                ? "Repeat all. Turn on repeat one"
                : "Repeat one. Turn repeat off"
          }
          onPress={onCycleRepeat}
        />
      </View>

      <View style={styles.queueLead}>
        <Text style={{ color: theme.color.fgMuted, fontSize: 14 }}>
          From: {artistLabel}
        </Text>
      </View>

      {listReady ? (
        <FlashList
          data={visibleUpcoming}
          renderItem={renderQueueItem}
          keyExtractor={keyExtractor}
          drawDistance={ROW_HEIGHT * 2}
          removeClippedSubviews
          overrideProps={{
            initialDrawBatchSize: Math.min(
              QUEUE_EAGER_ROWS,
              visibleUpcoming.length,
            ),
          }}
          scrollEnabled={queueOpen}
          showsVerticalScrollIndicator={false}
          style={styles.queueList}
          contentContainerStyle={styles.queueListContent}
          ListEmptyComponent={
            <View style={styles.emptyState}>
              <Text style={{ color: theme.color.fgMuted }}>
                Nothing else queued.
              </Text>
            </View>
          }
        />
      ) : (
        <View style={styles.queueList} />
      )}
    </View>
  );
});

const QueueRow = memo(function QueueRow({
  track,
  position,
  advanceOffset,
  showArtwork,
  onJumpToPosition,
}: {
  track: TrackListItem;
  position: number;
  advanceOffset: SharedValue<number>;
  showArtwork: boolean;
  onJumpToPosition: (position: number) => void;
}) {
  const theme = useTheme();
  const advanceStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: advanceOffset.value }],
  }));

  return (
    <Animated.View style={advanceStyle}>
      <Pressable
        onPress={() => onJumpToPosition(position)}
        accessibilityRole="button"
        accessibilityLabel={
          track.artist ? `${track.title} by ${track.artist}` : track.title
        }
        accessibilityHint={`Position ${position} in queue. Double tap to play.`}
        style={({ pressed }) => [
          styles.queueRow,
          pressed ? { opacity: 0.58 } : null,
        ]}
      >
        {showArtwork ? (
          <CoverArt
            track={track}
            size={44}
            transitionMs={0}
            priority="low"
            recyclingKey={`${track.album_id ?? track.id}:${track.id}`}
          />
        ) : (
          <View
            style={[
              styles.queueArtPlaceholder,
              { backgroundColor: theme.color.bgElev2 },
            ]}
          />
        )}
        <View style={{ flex: 1, minWidth: 0 }}>
          <View style={styles.titleLine}>
            <Text
              numberOfLines={1}
              style={{
                fontSize: 16,
                fontWeight: "500",
                color: theme.color.fg,
                flexShrink: 1,
              }}
            >
              {track.title}
            </Text>
          </View>
          {track.artist ? (
            <Text
              numberOfLines={1}
              style={{ fontSize: 14, color: theme.color.fgMuted }}
            >
              {track.artist}
            </Text>
          ) : null}
        </View>
        <SymbolView
          name="line.3.horizontal"
          size={22}
          tintColor={theme.color.overlayMuted}
        />
      </Pressable>
    </Animated.View>
  );
});

function NativeQueueMenuButton({
  queueOpen,
  shuffle,
  onPrimaryAction,
}: {
  queueOpen: boolean;
  shuffle: boolean;
  onPrimaryAction: () => void;
}) {
  const label = queueOpen
    ? "Hide queue"
    : shuffle
      ? "Show queue, shuffle on"
      : "Show queue";

  return (
    <AdaptiveGlass
      style={styles.bottomToolbarGlass}
      interactive
    >
      <Pressable
        onPress={onPrimaryAction}
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityState={{ selected: queueOpen || shuffle }}
        style={({ pressed }) => [
          styles.bottomToolbarButton,
          { opacity: pressed ? 0.55 : 1 },
        ]}
      >
        <QueueButtonLabel queueOpen={queueOpen} shuffle={shuffle} />
      </Pressable>
    </AdaptiveGlass>
  );
}

function BottomToolbarGlassButton({
  icon,
  accessibilityLabel,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();

  return (
    <AdaptiveGlass
      style={styles.bottomToolbarGlass}
      interactive
    >
      <Pressable
        onPress={onPress}
        hitSlop={14}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [
          styles.bottomToolbarButton,
          { opacity: pressed ? 0.55 : 1 },
        ]}
      >
        <SymbolView
          name={icon}
          size={26}
          tintColor={theme.color.fgMuted}
        />
      </Pressable>
    </AdaptiveGlass>
  );
}

function NativeAirPlayRoutePickerButton() {
  const theme = useTheme();

  if (!isAirPlayRoutePickerAvailable()) {
    return (
      <BottomToolbarGlassButton
        icon="airplayaudio"
        accessibilityLabel="AirPlay"
        onPress={() => {
          void Haptics.selectionAsync();
          if (__DEV__) {
            console.warn(
              "AirPlayRoutePicker is not available. Rebuild the iOS app to include the native route picker module.",
            );
          }
        }}
      />
    );
  }

  return (
    <AdaptiveGlass
      style={styles.bottomToolbarGlass}
      interactive
    >
      <AirPlayRoutePickerView
        accessibilityLabel="AirPlay"
        activeTintColor={theme.color.fg}
        prioritizesVideoDevices={false}
        style={styles.bottomToolbarButton}
        tintColor={theme.color.fgMuted}
      />
    </AdaptiveGlass>
  );
}

function QueueButtonLabel({
  queueOpen,
  shuffle,
}: {
  queueOpen: boolean;
  shuffle: boolean;
}) {
  const theme = useTheme();

  return (
    <View style={[styles.bottomToolbarButton, styles.queueButton]}>
      <View
        style={
          queueOpen
            ? [
                styles.queueButtonSelected,
                {
                  backgroundColor:
                    theme.scheme === "dark"
                      ? "rgba(255,255,255,0.16)"
                      : "rgba(255,255,255,0.72)",
                },
              ]
            : undefined
        }
      >
        <SymbolView
          name="list.bullet"
          size={26}
          tintColor={queueOpen ? theme.color.fg : theme.color.fgMuted}
        />
        {shuffle ? (
          <View
            style={[
              styles.shuffleBadge,
              { backgroundColor: theme.color.overlayMuted },
            ]}
          >
            <SymbolView
              name="shuffle"
              size={9}
              weight="bold"
              tintColor={theme.color.fg}
            />
          </View>
        ) : null}
      </View>
    </View>
  );
}

function ModePill({
  icon,
  selected,
  accessibilityLabel,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  selected: boolean;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const backgroundColor = selected
    ? theme.scheme === "dark"
      ? "rgba(255,255,255,0.22)"
      : "rgba(255,255,255,0.72)"
    : theme.scheme === "dark"
      ? "rgba(255,255,255,0.10)"
      : "rgba(255,255,255,0.18)";

  return (
    <AdaptiveGlass style={styles.pillShell} interactive>
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => [
          styles.pillInner,
          { backgroundColor, opacity: pressed ? 0.6 : 1 },
        ]}
      >
        <SymbolView
          name={icon}
          size={20}
          weight="regular"
          tintColor={selected ? theme.color.fg : theme.color.fgSubtle}
        />
      </Pressable>
    </AdaptiveGlass>
  );
}

function VolumeBar({
  value,
  onChange,
  onChangeEnd,
}: {
  value: number;
  onChange: (value: number) => void;
  onChangeEnd: (value: number) => void;
}) {
  const theme = useTheme();
  const width = useSharedValue(0);
  const progress = useSharedValue(Math.max(0, Math.min(1, value)));
  const active = useSharedValue(0);

  useEffect(() => {
    if (active.value === 0) {
      progress.value = withTiming(Math.max(0, Math.min(1, value)), {
        duration: 120,
      });
    }
  }, [value, active, progress]);

  const gesture = Gesture.Pan()
    .minDistance(0)
    .onBegin((event) => {
      "worklet";
      active.value = withSpring(1, { damping: 18, stiffness: 260 });
      const availableWidth = width.value;
      if (availableWidth > 0) {
        const next = Math.max(0, Math.min(1, event.x / availableWidth));
        progress.value = next;
        runOnJS(onChange)(next);
      }
    })
    .onUpdate((event) => {
      "worklet";
      const availableWidth = width.value;
      if (availableWidth > 0) {
        const next = Math.max(0, Math.min(1, event.x / availableWidth));
        progress.value = next;
        runOnJS(onChange)(next);
      }
    })
    .onFinalize(() => {
      "worklet";
      active.value = withSpring(0, { damping: 20, stiffness: 240 });
      runOnJS(onChangeEnd)(progress.value);
    });

  const trackStyle = useAnimatedStyle(() => {
    const height = 4 + active.value * 6;
    return {
      height,
      borderRadius: height / 2,
    };
  });

  const fillStyle = useAnimatedStyle(() => ({
    width: `${progress.value * 100}%`,
  }));

  return (
    <GestureDetector gesture={gesture}>
      <Animated.View style={styles.volumeHit}>
        <Animated.View
          onLayout={(event) => {
            width.value = event.nativeEvent.layout.width;
          }}
          style={[
            styles.volumeTrack,
            trackStyle,
            { backgroundColor: theme.color.overlayMuted },
          ]}
        >
          <Animated.View
            style={[
              styles.volumeFill,
              fillStyle,
              { backgroundColor: theme.color.overlayStrong },
            ]}
          />
        </Animated.View>
      </Animated.View>
    </GestureDetector>
  );
}

function Chip({
  icon,
  iconSize,
  accessibilityLabel,
  onPress,
}: {
  icon: SymbolViewProps["name"];
  iconSize: number;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  const theme = useTheme();
  const size = 36;

  return (
    <AdaptiveGlass
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
      }}
      interactive
    >
      <Pressable
        onPress={onPress}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel}
        style={({ pressed }) => ({
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
          opacity: pressed ? 0.55 : 1,
        })}
      >
        <SymbolView
          name={icon}
          size={iconSize}
          weight="semibold"
          tintColor={theme.color.fg}
        />
      </Pressable>
    </AdaptiveGlass>
  );
}

const styles = StyleSheet.create({
  grabberTap: {
    alignItems: "center",
    paddingTop: 6,
    paddingBottom: 10,
  },
  grabber: {
    width: 56,
    height: 5,
    borderRadius: 2.5,
  },
  body: {
    flex: 1,
    position: "relative",
  },
  hero: {
    position: "relative",
  },
  heroCover: {
    position: "absolute",
  },
  heroSwapStage: {
    flex: 1,
    position: "relative",
  },
  heroSwapLayer: {
    ...StyleSheet.absoluteFillObject,
  },
  heroMeta: {
    position: "absolute",
    gap: 2,
  },
  heroMetaStage: {
    minHeight: 48,
    position: "relative",
  },
  heroMetaLayer: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    gap: 2,
  },
  heroActions: {
    position: "absolute",
    flexDirection: "row",
    gap: 10,
  },
  titleLine: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
  },
  queueSection: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  queueSectionInner: {
    flex: 1,
    minHeight: 0,
    gap: 10,
  },
  pillsRow: {
    flexDirection: "row",
    gap: 8,
  },
  pillShell: {
    flex: 1,
    height: 42,
    borderRadius: 21,
    overflow: "hidden",
  },
  pillInner: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  queueLead: {
    gap: 4,
  },
  queueList: {
    flex: 1,
    minHeight: 0,
    overflow: "hidden",
  },
  queueListContent: {
    paddingBottom: 12,
  },
  queueRow: {
    height: ROW_HEIGHT,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
  },
  queueArtPlaceholder: {
    width: 44,
    height: 44,
    borderRadius: 8,
  },
  emptyState: {
    paddingVertical: 48,
    alignItems: "center",
  },
  timesRow: {
    flexDirection: "row",
    justifyContent: "space-between",
    marginTop: 2,
  },
  timeText: {
    fontSize: 12,
    fontVariant: ["tabular-nums"],
  },
  transport: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-evenly",
    marginTop: 40,
  },
  transportTablet: {
    justifyContent: "center",
    gap: 96,
    marginTop: 36,
  },
  volumeRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    marginTop: 56,
  },
  volumeRowTablet: {
    marginTop: 52,
  },
  volumeHit: {
    flex: 1,
    height: 28,
    justifyContent: "center",
  },
  volumeTrack: {
    width: "100%",
    overflow: "hidden",
  },
  volumeFill: {
    height: "100%",
  },
  bottomToolbar: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    alignSelf: "center",
    width: "72%",
    minWidth: 220,
    maxWidth: 280,
    marginTop: 44,
    paddingBottom: 4,
  },
  bottomToolbarTablet: {
    alignSelf: "stretch",
    width: "100%",
    maxWidth: TABLET_CONTENT_MAX_WIDTH,
    marginTop: 38,
  },
  bottomToolbarRight: {
    flexDirection: "row",
    alignItems: "center",
    gap: 24,
  },
  bottomToolbarButton: {
    width: 44,
    height: 44,
    alignItems: "center",
    justifyContent: "center",
  },
  bottomToolbarGlass: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
  },
  bottomControls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
  queueButton: {
    minWidth: 42,
    minHeight: 42,
    alignItems: "center",
    justifyContent: "center",
  },
  queueButtonSelected: {
    width: 42,
    height: 42,
    borderRadius: 21,
    alignItems: "center",
    justifyContent: "center",
  },
  shuffleBadge: {
    position: "absolute",
    top: -6,
    right: -8,
    width: 14,
    height: 14,
    borderRadius: 7,
    alignItems: "center",
    justifyContent: "center",
  },
});
