import { useCallback, useEffect, useRef, useState } from "react";
import {
  Platform,
  StyleSheet,
  Text,
  View,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Easing,
  Extrapolation,
  ReduceMotion,
  interpolate,
  useAnimatedStyle,
  useSharedValue,
  withSpring,
  withTiming,
} from "react-native-reanimated";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { TrackActionsMenuButton } from "../components/track-actions-menu";
import { NowPlayingBottomControls } from "../components/now-playing/bottom-controls";
import {
  TABLET_BREAKPOINT,
  TABLET_CONTENT_MAX_WIDTH,
} from "../components/now-playing/constants";
import { GlassIconButton } from "../components/now-playing/glass-icon-button";
import { HeroArtwork } from "../components/now-playing/hero-artwork";
import { HeroMeta } from "../components/now-playing/hero-meta";
import { LyricsLanguageSelector } from "../components/now-playing/lyrics-language-selector";
import {
  LyricsSection,
  type LyricsSectionHandle,
  type LyricsTranslationRequest,
  type LyricsTranslationState,
} from "../components/now-playing/lyrics-section";
import { QueueSection } from "../components/now-playing/queue-section";
import { SheetGrabber } from "../components/now-playing/sheet-grabber";
import { useFavorite, useFavoriteActions } from "../context/favorites";
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
  const [lyricsOpen, setLyricsOpen] = useState(false);
  const [bodyHeight, setBodyHeight] = useState(0);
  const [bottomControlsHeight, setBottomControlsHeight] = useState(0);
  const lyricsSectionRef = useRef<LyricsSectionHandle>(null);
  const [lyricsAvailableTrackId, setLyricsAvailableTrackId] = useState<
    string | null
  >(null);
  const [translationSelectorOpen, setTranslationSelectorOpen] = useState(false);
  const [sourceLanguage, setSourceLanguage] = useState<string | null>(null);
  const [targetLanguage, setTargetLanguage] = useState<string | null>(null);
  const [translationBusy, setTranslationBusy] = useState(false);
  const [translationError, setTranslationError] = useState<string | null>(null);
  const [completedTranslation, setCompletedTranslation] = useState<
    (LyricsTranslationRequest & { trackId: string; visible: boolean }) | null
  >(null);
  const transition = useSharedValue(queueParam === "1" ? 1 : 0);
  const queueVisibility = useSharedValue(queueParam === "1" ? 1 : 0);
  const isTabletLayout = Math.min(width, height) >= TABLET_BREAKPOINT;
  const panelOpen = queueOpen || lyricsOpen;
  const pad = isTabletLayout
    ? Math.max(52, Math.round((width - TABLET_CONTENT_MAX_WIDTH) / 2))
    : 28;
  const bodyWidth = Math.max(0, width - pad * 2);
  const availableBodyHeight =
    bodyHeight || Math.max(0, height - insets.bottom - 44);

  useEffect(() => {
    if (queueParam === "1") {
      // The router parameter is an external navigation request to open queue.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQueueOpen(true);
      setLyricsOpen(false);
      setTranslationSelectorOpen(false);
    }
  }, [queueParam]);

  useEffect(() => {
    transition.set(
      withSpring(panelOpen ? 1 : 0, {
        duration: 300,
        dampingRatio: 1,
        overshootClamping: true,
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [panelOpen, transition]);

  useEffect(() => {
    queueVisibility.set(
      withTiming(queueOpen ? 1 : 0, {
        duration: queueOpen ? 240 : 180,
        easing: Easing.bezier(0.23, 1, 0.32, 1),
        reduceMotion: ReduceMotion.System,
      }),
    );
  }, [queueOpen, queueVisibility]);

  const measuredBottomControls =
    bottomControlsHeight ||
    (isTabletLayout ? 244 : PHONE_BOTTOM_CONTROLS_ESTIMATE);
  const bottomControlsTop = Math.max(
    0,
    availableBodyHeight - measuredBottomControls,
  );
  const trackId = track?.id ?? null;
  const favorite = useFavorite(trackId ?? "");
  const supportsInlineTranslation =
    process.env.EXPO_OS === "ios" &&
    Number.parseFloat(String(Platform.Version)) >= 18;
  const translationControlVisible =
    lyricsOpen &&
    trackId !== null &&
    lyricsAvailableTrackId === trackId &&
    supportsInlineTranslation;
  const headerActionCount = translationControlVisible ? 3 : 2;
  const headerActionsWidth =
    ACTION_SIZE * headerActionCount + 10 * (headerActionCount - 1);
  const selectedPairMatches =
    completedTranslation?.trackId === trackId &&
    completedTranslation.sourceLanguage === sourceLanguage &&
    completedTranslation.targetLanguage === targetLanguage;
  const translationActionLabel = selectedPairMatches
    ? completedTranslation.visible
      ? "Hide Translation"
      : "Show Translation"
    : "Translate Lyrics";
  const previousTrackIdRef = useRef<string | null>(null);
  const previousTrackIndexRef = useRef(index);
  // These refs hold the last committed track solely to choose the direction of
  // the next artwork transition. Reading them does not affect rendered data.
  /* eslint-disable react-hooks/refs */
  const trackTransitionDirection =
    previousTrackIdRef.current != null &&
    previousTrackIdRef.current !== trackId &&
    index < previousTrackIndexRef.current
      ? -1
      : 1;
  /* eslint-enable react-hooks/refs */
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
  const metaEndLeft = COMPACT_COVER_SIZE + 6;
  const actionsLeft = Math.max(0, bodyWidth - headerActionsWidth);
  const minimumMetaWidth = translationControlVisible ? 64 : 120;
  const metaStartWidth = Math.max(minimumMetaWidth, actionsLeft - 12);
  const metaEndWidth = Math.max(
    minimumMetaWidth,
    actionsLeft - metaEndLeft - 10,
  );
  const heroExpandedHeight = metaStartTop + 50;
  const heroCompactHeight = COMPACT_COVER_SIZE + 2;
  const queueBottomInset = measuredBottomControls + 18;
  const queueOpenTop = heroCompactHeight + 20;

  const coverStyle = useAnimatedStyle(() => ({
    transform: [
      {
        translateX: interpolate(
          transition.get(),
          [0, 1],
          [0, coverEndCenterX - coverStartCenterX],
          Extrapolation.CLAMP,
        ),
      },
      {
        translateY: interpolate(
          transition.get(),
          [0, 1],
          [0, coverEndCenterY - coverStartCenterY],
          Extrapolation.CLAMP,
        ),
      },
      {
        scale: interpolate(
          transition.get(),
          [0, 1],
          [1, COMPACT_COVER_SIZE / coverSize],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  // Both text layouts have fixed widths. Crossfade between them while their
  // shared transform follows the cover, avoiding text re-layout every frame.
  const metaStyle = useAnimatedStyle(() => ({
    transform: [
      { translateX: metaEndLeft * transition.get() },
      { translateY: (metaEndTop - metaStartTop) * transition.get() },
      { scale: 1 - 0.2 * transition.get() },
    ],
  }));
  const expandedMetaStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      transition.get(),
      [0, 0.45, 0.75],
      [1, 1, 0],
      Extrapolation.CLAMP,
    ),
  }));
  const compactMetaStyle = useAnimatedStyle(() => ({
    opacity: interpolate(
      transition.get(),
      [0.45, 0.75, 1],
      [0, 1, 1],
      Extrapolation.CLAMP,
    ),
  }));

  const actionsStyle = useAnimatedStyle(() => ({
    transform: [{ translateY: (10 - metaStartTop - 2) * transition.get() }],
  }));

  // The list always has its final viewport. Translating this surface avoids
  // asking FlashList/Yoga to remeasure rows throughout the opening animation.
  const queueSectionStyle = useAnimatedStyle(() => ({
    opacity: queueVisibility.get(),
    transform: [{ translateY: 24 * (1 - queueVisibility.get()) }],
  }));
  const lyricsSectionStyle = useAnimatedStyle(() => ({
    opacity: transition.get(),
    transform: [{ translateY: 24 * (1 - transition.get()) }],
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

  const handleLyricsAvailabilityChange = useCallback(
    (availableTrackId: string, available: boolean) => {
      if (available) {
        setLyricsAvailableTrackId(availableTrackId);
        return;
      }
      setLyricsAvailableTrackId((current) =>
        current === availableTrackId ? null : current,
      );
      setTranslationSelectorOpen(false);
      setTranslationError(null);
      setCompletedTranslation((current) =>
        current?.trackId === availableTrackId ? null : current,
      );
    },
    [],
  );

  const handleLyricsTranslationChange = useCallback(
    (translatedTrackId: string, translation: LyricsTranslationState | null) => {
      if (!translation) {
        setCompletedTranslation((current) =>
          current?.trackId === translatedTrackId ? null : current,
        );
        return;
      }
      setCompletedTranslation({ trackId: translatedTrackId, ...translation });
      setSourceLanguage(translation.sourceLanguage);
      setTargetLanguage(translation.targetLanguage);
    },
    [],
  );

  const handleTranslationAction = useCallback(async () => {
    if (!trackId || !targetLanguage || translationBusy) return;

    if (selectedPairMatches && completedTranslation) {
      const visible = !completedTranslation.visible;
      lyricsSectionRef.current?.setTranslationVisible(visible);
      setCompletedTranslation({ ...completedTranslation, visible });
      setTranslationError(null);
      setTranslationSelectorOpen(false);
      return;
    }

    const section = lyricsSectionRef.current;
    if (!section) return;
    setTranslationBusy(true);
    setTranslationError(null);
    const result = await section.translate({
      sourceLanguage,
      targetLanguage,
    });
    if (result.success) {
      setCompletedTranslation({
        trackId,
        sourceLanguage,
        targetLanguage,
        visible: true,
      });
      setTranslationSelectorOpen(false);
    } else {
      setTranslationError(result.message);
    }
    setTranslationBusy(false);
  }, [
    completedTranslation,
    selectedPairMatches,
    sourceLanguage,
    targetLanguage,
    trackId,
    translationBusy,
  ]);

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
        <View style={[styles.hero, { height: heroExpandedHeight }]}>
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

          <Animated.View
            pointerEvents={panelOpen ? "none" : "auto"}
            accessibilityElementsHidden={panelOpen}
            importantForAccessibility={
              panelOpen ? "no-hide-descendants" : "auto"
            }
            style={[
              styles.heroMeta,
              { top: metaStartTop, left: 0, width: metaStartWidth },
              metaStyle,
              expandedMetaStyle,
            ]}
          >
            <HeroMeta track={track} />
          </Animated.View>
          <Animated.View
            pointerEvents={panelOpen ? "auto" : "none"}
            accessibilityElementsHidden={!panelOpen}
            importantForAccessibility={
              panelOpen ? "auto" : "no-hide-descendants"
            }
            style={[
              styles.heroMeta,
              { top: metaStartTop, left: 0, width: metaEndWidth },
              metaStyle,
              compactMetaStyle,
            ]}
          >
            <HeroMeta track={track} />
          </Animated.View>

          <Animated.View
            style={[
              styles.heroActions,
              {
                left: actionsLeft,
                top: metaStartTop + 2,
                width: headerActionsWidth,
              },
              actionsStyle,
            ]}
          >
            {translationControlVisible ? (
              <GlassIconButton
                icon="translate"
                iconSize={15}
                weight="semibold"
                tintColor={
                  translationSelectorOpen ||
                  (selectedPairMatches && completedTranslation?.visible)
                    ? theme.color.accent
                    : theme.color.fg
                }
                accessibilityLabel="Lyrics translation languages"
                onPress={() => {
                  void Haptics.selectionAsync();
                  setTranslationError(null);
                  setTranslationSelectorOpen((open) => !open);
                }}
              />
            ) : null}
            <GlassIconButton
              icon={favorite ? "star.fill" : "star"}
              iconSize={14}
              weight="semibold"
              accessibilityLabel={
                favorite ? "Remove from favorites" : "Add to favorites"
              }
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                void toggleFavorite(track);
              }}
            />
            <TrackActionsMenuButton
              track={track}
              size={ACTION_SIZE}
              accessibilityLabel="More actions"
            />
          </Animated.View>
        </View>

        {translationControlVisible && translationSelectorOpen ? (
          <View
            style={[
              styles.translationSelector,
              {
                top: heroCompactHeight + 8,
                right: pad,
                width: Math.min(320, bodyWidth),
              },
            ]}
          >
            <LyricsLanguageSelector
              sourceLanguage={sourceLanguage}
              targetLanguage={targetLanguage}
              busy={translationBusy}
              error={translationError}
              actionLabel={translationActionLabel}
              onSourceChange={(language) => {
                setSourceLanguage(language);
                setTranslationError(null);
              }}
              onTargetChange={(language) => {
                setTargetLanguage(language);
                setTranslationError(null);
              }}
              onAction={() => void handleTranslationAction()}
            />
          </View>
        ) : null}

        <Animated.View
          pointerEvents={queueOpen ? "auto" : "none"}
          accessibilityElementsHidden={!queueOpen}
          importantForAccessibility={queueOpen ? "auto" : "no-hide-descendants"}
          style={[
            styles.queueSection,
            {
              top: queueOpenTop,
              bottom: queueBottomInset,
              left: pad,
              right: pad,
            },
            queueSectionStyle,
          ]}
        >
          <QueueSection
            queueOpen={queueOpen}
            queue={queue}
            startIndex={index + 1}
            shuffle={shuffle}
            repeat={repeat}
            onJumpToPosition={handleQueueJump}
            onToggleShuffle={handleQueueShuffle}
            onCycleRepeat={handleQueueRepeat}
          />
        </Animated.View>

        {lyricsOpen ? (
          <Animated.View
            style={[
              styles.queueSection,
              {
                top: queueOpenTop,
                bottom: queueBottomInset,
                left: pad,
                right: pad,
              },
              lyricsSectionStyle,
            ]}
          >
            <LyricsSection
              key={track.id}
              ref={lyricsSectionRef}
              track={track}
              onAvailabilityChange={handleLyricsAvailabilityChange}
              onTranslationChange={handleLyricsTranslationChange}
            />
          </Animated.View>
        ) : null}

        <View
          onLayout={(event) => {
            const next = event.nativeEvent.layout.height;
            setBottomControlsHeight((prev) => (prev === next ? prev : next));
          }}
          style={[styles.bottomControls, { left: pad, right: pad }]}
        >
          <NowPlayingBottomControls
            queueOpen={queueOpen}
            lyricsOpen={lyricsOpen}
            onToggleQueueOpen={() => {
              setLyricsOpen(false);
              setTranslationSelectorOpen(false);
              setQueueOpen((value) => !value);
            }}
            onToggleLyricsOpen={() => {
              setQueueOpen(false);
              if (lyricsOpen) setTranslationSelectorOpen(false);
              setLyricsOpen(!lyricsOpen);
            }}
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
    transformOrigin: "left top",
    gap: 2,
  },
  heroActions: {
    position: "absolute",
    flexDirection: "row",
    gap: 10,
    zIndex: 40,
  },
  translationSelector: {
    position: "absolute",
    zIndex: 30,
  },
  queueSection: {
    position: "absolute",
    left: 0,
    right: 0,
    overflow: "hidden",
    zIndex: 1,
  },
  bottomControls: {
    position: "absolute",
    left: 0,
    right: 0,
    bottom: 0,
  },
});
