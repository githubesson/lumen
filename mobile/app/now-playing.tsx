import { useCallback, useEffect, useRef, useState } from "react";
import { StyleSheet, Text, View, useWindowDimensions } from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useFavorite, useFavoriteActions } from "@music-library/core";
import { TrackActionsMenuButton } from "../components/track-actions-menu";
import { NowPlayingBottomControls } from "../components/now-playing/bottom-controls";
import {
  TABLET_BREAKPOINT,
  TABLET_CONTENT_MAX_WIDTH,
} from "../components/now-playing/constants";
import { GlassIconButton } from "../components/now-playing/glass-icon-button";
import { HeroArtwork } from "../components/now-playing/hero-artwork";
import { HeroMeta } from "../components/now-playing/hero-meta";
import { QueueSection } from "../components/now-playing/queue-section";
import { SheetGrabber } from "../components/now-playing/sheet-grabber";
import {
  useCurrentTrack,
  usePlayerControls,
  usePlayerPlayback,
  usePlayerQueue,
} from "../context/player";
import { useTheme } from "../theme/theme";

const ACTION_SIZE = 36;
const COMPACT_COVER_SIZE = 58;
const PHONE_BOTTOM_CONTROLS_ESTIMATE = 316;
const HERO_META_BLOCK_HEIGHT = 54;
const PHONE_ARTWORK_META_MIN_GAP = 44;
const PHONE_META_CONTROLS_GAP = 14;
const TABLET_ARTWORK_META_GAP = 82;

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
      <SheetGrabber onPress={() => router.back()} />

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
            <HeroArtwork
              track={track}
              size={coverSize}
              transitionKey={artworkTransitionKey}
              direction={trackTransitionDirection}
            />
          </Animated.View>

          <Animated.View style={[styles.heroMeta, metaStyle]}>
            <HeroMeta track={track} />
          </Animated.View>

          <Animated.View
            style={[
              styles.heroActions,
              { left: actionsLeft, width: ACTION_SIZE * 2 + 10 },
              actionsStyle,
            ]}
          >
            <GlassIconButton
              icon={favorite ? "star.fill" : "star"}
              iconSize={14}
              weight="semibold"
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

const styles = StyleSheet.create({
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
  heroMeta: {
    position: "absolute",
    gap: 2,
  },
  heroActions: {
    position: "absolute",
    flexDirection: "row",
    gap: 10,
  },
  queueSection: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
  },
  bottomControls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
});
