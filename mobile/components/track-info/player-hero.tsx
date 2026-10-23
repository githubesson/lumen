import { useCallback, useState } from "react";
import { Pressable, StyleSheet, Text, View, type LayoutChangeEvent } from "react-native";
import Animated, {
  useAnimatedStyle,
  type SharedValue,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  isTrackInfoLink,
  type TrackInfoLink,
  type TrackInfoName,
  type TrackListItem,
} from "@music-library/core";
import {
  useCurrentTrack,
  useIsPlaying,
  usePlayTrack,
  usePlayerControls,
} from "../../context/player";
import { CoverArt } from "../cover-art";
import { GlassIconButton } from "../now-playing/glass-icon-button";
import { TrackActionsMenuButton } from "../track-actions-menu";
import {
  FOLD,
  actionsOffset,
  coverFrame,
  foldOpacity,
  type TrackInfoFold,
} from "../../lib/track-info-fold";
import { useTheme, withAlpha } from "../../theme/theme";
import { LinkedNames } from "./linked-names";

const COVER_SHADOW = "0 18px 40px rgba(0, 0, 0, 0.45)";
const ACTIONS_WIDTH = FOLD.action * 2 + FOLD.actionGap;
// The compact row is the 58 cover's height, and its two lines fill most of
// it: at 1.25× they still fit (about 26 + 22 pt), where the largest
// accessibility sizes would spill into the content.
const COMPACT_MAX_FONT_SCALE = 1.25;

/** What the hero shows: the track as Now Playing shows it. */
export interface HeroTrack {
  item: TrackListItem;
  title: string;
  artists: readonly TrackInfoName[];
}

/**
 * The hero's cover over the scroll view, folding into the compact row's
 * cover as the content scrolls. Without the fold (reduced motion) the cover
 * sits in the content instead (`InlineCover`) and this is the compact cover,
 * shown with the compact row.
 */
export function FoldCover({
  track,
  fold,
  scrollY,
}: {
  track: TrackListItem;
  fold: TrackInfoFold;
  scrollY: SharedValue<number>;
}) {
  const frameStyle = useAnimatedStyle(() => {
    const frame = coverFrame(scrollY.get(), fold);
    return {
      borderRadius: frame.borderRadius,
      transform: [
        { translateX: frame.translateX },
        { translateY: frame.translateY },
        { scale: frame.scale },
      ],
    };
  });
  const clipStyle = useAnimatedStyle(() => ({
    borderRadius: coverFrame(scrollY.get(), fold).borderRadius,
  }));
  const compactStyle = useAnimatedStyle(() => ({
    opacity: foldOpacity(scrollY.get(), fold).compact,
  }));

  if (fold.reducedMotion) {
    return (
      <Animated.View
        pointerEvents="none"
        style={[
          styles.overlay,
          {
            left: fold.left + FOLD.compactSide,
            top: fold.top + FOLD.compactTop,
          },
          compactStyle,
        ]}
      >
        <CoverArt track={track} size={FOLD.compactCover} radius={FOLD.compactRadius} />
      </Animated.View>
    );
  }
  return (
    <Animated.View
      pointerEvents="none"
      style={[
        styles.overlay,
        {
          left: fold.left + FOLD.side,
          top: fold.top + FOLD.coverTop,
          width: fold.cover,
          height: fold.cover,
          boxShadow: COVER_SHADOW,
        },
        frameStyle,
      ]}
    >
      <Animated.View style={[styles.clip, clipStyle]}>
        <CoverArt track={track} size={fold.cover} radius={0} priority="high" />
      </Animated.View>
    </Animated.View>
  );
}

/** The hero cover in the scroll content, for when nothing folds. */
export function InlineCover({ track, fold }: { track: TrackListItem; fold: TrackInfoFold }) {
  return (
    <View
      style={{
        marginLeft: FOLD.side,
        width: fold.cover,
        height: fold.cover,
        borderRadius: FOLD.coverRadius,
        boxShadow: COVER_SHADOW,
      }}
    >
      <CoverArt track={track} size={fold.cover} radius={FOLD.coverRadius} priority="high" />
    </View>
  );
}

/**
 * The hero's title and artists, in the scroll content beside the room the
 * buttons ride in. Reports its frame so the buttons can line up with it.
 */
export function HeroMeta({
  track,
  fold,
  scrollY,
  hidden,
  onOpen,
  onLayout,
}: {
  track: HeroTrack;
  fold: TrackInfoFold;
  scrollY: SharedValue<number>;
  /** Folded away: the compact row stands in for it. */
  hidden: boolean;
  onOpen: (link: TrackInfoLink) => void;
  onLayout: (event: LayoutChangeEvent) => void;
}) {
  const theme = useTheme();
  const fade = useAnimatedStyle(() => ({
    opacity: foldOpacity(scrollY.get(), fold).meta,
  }));
  return (
    <Animated.View
      onLayout={onLayout}
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      style={[
        styles.heroMeta,
        { paddingRight: FOLD.side + ACTIONS_WIDTH + FOLD.actionGap },
        fade,
      ]}
    >
      <Text
        numberOfLines={1}
        accessibilityRole="header"
        style={{
          color: theme.color.fg,
          fontSize: 22,
          fontWeight: "700",
          letterSpacing: -0.3,
        }}
      >
        {track.title}
      </Text>
      <ArtistLine
        artists={track.artists}
        color={theme.color.fgMuted}
        fontSize={17}
        onOpen={onOpen}
      />
    </Animated.View>
  );
}

/** "<album> · <year> ›" under the hero title, opening the album when it has a page. */
export function AlbumLine({
  album,
  year,
  fold,
  scrollY,
  hidden,
  onOpen,
}: {
  album: TrackInfoName;
  year: string;
  fold: TrackInfoFold;
  scrollY: SharedValue<number>;
  hidden: boolean;
  onOpen: (link: TrackInfoLink) => void;
}) {
  const theme = useTheme();
  const fade = useAnimatedStyle(() => ({
    opacity: foldOpacity(scrollY.get(), fold).album,
  }));
  const label = year ? `${album.name} · ${year}` : album.name;
  const text = (
    <Text numberOfLines={1} style={{ color: theme.color.fgMuted, fontSize: 15, flexShrink: 1 }}>
      {label}
    </Text>
  );
  return (
    <Animated.View
      accessibilityElementsHidden={hidden}
      importantForAccessibility={hidden ? "no-hide-descendants" : "auto"}
      style={[styles.albumLine, fade]}
    >
      {isTrackInfoLink(album) ? (
        <Pressable
          onPress={() => onOpen(album)}
          accessibilityRole="link"
          accessibilityLabel={`Album, ${label}`}
          accessibilityHint="Opens the album."
          style={({ pressed }) => [
            styles.albumButton,
            pressed && { backgroundColor: theme.color.overlayMuted },
          ]}
        >
          {text}
          <SymbolView
            name="chevron.right"
            size={11}
            weight="semibold"
            tintColor={withAlpha(theme.color.fgMuted, 0.8)}
          />
        </Pressable>
      ) : (
        <View style={styles.albumButton}>{text}</View>
      )}
    </Animated.View>
  );
}

/**
 * The compact row's title and artists, pinned under the nav bar beside the
 * compact cover once the hero has folded into it.
 */
export function CompactMeta({
  track,
  fold,
  scrollY,
  pinned,
  onOpen,
}: {
  track: HeroTrack;
  fold: TrackInfoFold;
  scrollY: SharedValue<number>;
  pinned: boolean;
  onOpen: (link: TrackInfoLink) => void;
}) {
  const theme = useTheme();
  const left = fold.left + FOLD.compactSide + FOLD.compactCover + FOLD.compactGap;
  const style = useAnimatedStyle(() => {
    const shown = foldOpacity(scrollY.get(), fold).compact;
    return { opacity: shown, transform: [{ translateY: (1 - shown) * 6 }] };
  });
  return (
    <Animated.View
      pointerEvents={pinned ? "box-none" : "none"}
      accessibilityElementsHidden={!pinned}
      importantForAccessibility={pinned ? "auto" : "no-hide-descendants"}
      style={[
        styles.overlay,
        styles.compactMeta,
        {
          left,
          top: fold.top + FOLD.compactTop,
          width: Math.max(
            0,
            fold.column -
              (left - fold.left) -
              FOLD.compactSide -
              ACTIONS_WIDTH -
              FOLD.actionGap,
          ),
        },
        style,
      ]}
    >
      <Text
        numberOfLines={1}
        maxFontSizeMultiplier={COMPACT_MAX_FONT_SCALE}
        style={{
          color: theme.color.fg,
          fontSize: 17,
          fontWeight: "700",
          letterSpacing: -0.2,
        }}
      >
        {track.title}
      </Text>
      <ArtistLine
        artists={track.artists}
        color={theme.color.fgMuted}
        fontSize={14}
        maxFontSizeMultiplier={COMPACT_MAX_FONT_SCALE}
        onOpen={onOpen}
      />
    </Animated.View>
  );
}

/**
 * Play and the track menu. One pair of buttons serves both rows: it scrolls
 * with the hero title, then stays beside the compact row. Moving rather than
 * cross-fading two copies keeps opacity off the glass, which iOS would drop.
 */
export function HeroActions({
  track,
  fold,
  scrollY,
}: {
  track: TrackListItem;
  fold: TrackInfoFold;
  scrollY: SharedValue<number>;
}) {
  const play = usePlayToggle(track);
  const style = useAnimatedStyle(() => {
    const offset = actionsOffset(scrollY.get(), fold);
    return {
      transform: [
        { translateX: offset.translateX },
        { translateY: offset.translateY },
      ],
    };
  });
  return (
    <Animated.View
      pointerEvents="box-none"
      style={[
        styles.overlay,
        styles.actions,
        {
          left: fold.left + fold.column - FOLD.side - ACTIONS_WIDTH,
          top: fold.actionsTop,
        },
        style,
      ]}
    >
      {/* A track dropped from TIDAL can't play: no button to fail. */}
      {track.unavailable ? null : (
        <GlassIconButton
          icon={play.playing ? "pause.fill" : "play.fill"}
          iconSize={15}
          weight="semibold"
          accessibilityLabel={play.playing ? "Pause" : "Play"}
          onPress={play.onPress}
        />
      )}
      <TrackActionsMenuButton
        track={track}
        size={FOLD.action}
        accessibilityLabel="More actions"
      />
    </Animated.View>
  );
}

/**
 * The background behind the pinned compact row, so the content scrolls
 * under it. It fades into the content below rather than ending on an edge.
 * Pinned, it takes the touches meant for what's hidden under it.
 */
export function FoldBackdrop({
  fold,
  scrollY,
  pinned,
}: {
  fold: TrackInfoFold;
  scrollY: SharedValue<number>;
  pinned: boolean;
}) {
  const theme = useTheme();
  const solid = fold.top + FOLD.compactTop + FOLD.compactCover + 14;
  const style = useAnimatedStyle(() => ({
    opacity: foldOpacity(scrollY.get(), fold).backdrop,
  }));
  return (
    <Animated.View
      pointerEvents={pinned ? "auto" : "none"}
      style={[styles.backdrop, { height: solid + 22 }, style]}
    >
      <View style={{ height: solid, backgroundColor: theme.color.bg }} />
      <View
        style={{
          flex: 1,
          experimental_backgroundImage: `linear-gradient(to bottom, ${withAlpha(theme.color.bg, 1)} 0%, ${withAlpha(theme.color.bg, 0.7)} 45%, ${withAlpha(theme.color.bg, 0)} 100%)`,
        }}
      />
    </Animated.View>
  );
}

/** Measures `HeroMeta` for the fold, ignoring a layout that didn't move. */
export function useMetaFrame() {
  const [frame, setFrame] = useState<{ y: number; height: number } | null>(null);
  const onLayout = useCallback((event: LayoutChangeEvent) => {
    const { y, height } = event.nativeEvent.layout;
    setFrame((prev) => (prev && prev.y === y && prev.height === height ? prev : { y, height }));
  }, []);
  return [frame, onLayout] as const;
}

function ArtistLine({
  artists,
  color,
  fontSize,
  maxFontSizeMultiplier,
  onOpen,
}: {
  artists: readonly TrackInfoName[];
  color: string;
  fontSize: number;
  maxFontSizeMultiplier?: number;
  onOpen: (link: TrackInfoLink) => void;
}) {
  if (artists.length === 0) return null;
  return (
    <Text
      numberOfLines={1}
      maxFontSizeMultiplier={maxFontSizeMultiplier}
      style={{ color, fontSize }}
    >
      <LinkedNames names={artists} color={color} onOpen={onOpen} />
    </Text>
  );
}

/** ▶ plays the track; on the track already playing, it pauses and resumes it. */
function usePlayToggle(track: TrackListItem) {
  const current = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const playTrack = usePlayTrack();
  const { toggle } = usePlayerControls();
  const isCurrent = current?.id === track.id;
  const onPress = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    if (isCurrent) toggle();
    else playTrack(track);
  }, [isCurrent, playTrack, toggle, track]);
  return { playing: isCurrent && isPlaying, onPress };
}

const styles = StyleSheet.create({
  overlay: {
    position: "absolute",
  },
  clip: {
    flex: 1,
    overflow: "hidden",
  },
  heroMeta: {
    minHeight: FOLD.metaHeight,
    justifyContent: "center",
    gap: 2,
    paddingLeft: FOLD.side,
  },
  albumLine: {
    flexDirection: "row",
    marginTop: 6,
    marginLeft: FOLD.side - 4,
    marginRight: FOLD.side,
  },
  albumButton: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    flexShrink: 1,
    paddingHorizontal: 4,
    paddingVertical: 2,
    borderRadius: 8,
    borderCurve: "continuous",
  },
  compactMeta: {
    height: FOLD.compactCover,
    justifyContent: "center",
    gap: 1,
  },
  actions: {
    width: ACTIONS_WIDTH,
    flexDirection: "row",
    // Without play, the menu keeps its place at the end.
    justifyContent: "flex-end",
    gap: FOLD.actionGap,
  },
  backdrop: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
  },
});
