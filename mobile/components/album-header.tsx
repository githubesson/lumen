import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withTiming,
} from "react-native-reanimated";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { StatusBar } from "expo-status-bar";
import { useIsFocused } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { displayText } from "@music-library/core";
import { useTheme } from "../theme/theme";

/** How far the title block rides up over the foot of the cover. */
export const ALBUM_TITLE_OVERLAP = 86;
/** The playlist header's control size, so the two pages' buttons match. */
const CONTROL_SIZE = 50;
/** The darkened band under the status bar and back button, over the cover. */
const TOP_SCRIM = 140;
/**
 * The widest the cover gets. A phone's cover runs edge to edge; on an iPad it
 * stops here and a blurred copy fills the band beside it.
 */
const MAX_COVER = 560;
/**
 * How far down the cover the status bar may sit and still count as over it.
 * Below this the fade into the page has taken over.
 */
const COVER_UNDER_STATUS_BAR = 0.7;

/** The cover's side: the screen's width, up to `MAX_COVER`. */
export function useAlbumCoverSize(): number {
  return Math.min(Math.round(useWindowDimensions().width), MAX_COVER);
}

/** The admin album download, shown as a round button beside Shuffle. */
export interface AlbumDownloadButton {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  /** Tracks are downloading: the button spins, and a tap offers to cancel. */
  queued?: boolean;
}

interface Props {
  title: string;
  artist?: string | null;
  /** Opens the album artist's page. Without it the name is plain text. */
  onOpenArtist?: () => void;
  coverUri: string | null;
  coverKey?: string;
  metadata: string;
  onPlay?: () => void;
  /** Shuffle-plays the album; left out when there's nothing to shuffle. */
  onShuffle?: () => void;
  download?: AlbumDownloadButton;
  /** Switches between the release's versions, above Play. */
  versions?: ReactNode;
  /** Another version is loading: the buttons wait for it. */
  pending?: boolean;
  /** Where the title ends in the list, so the nav bar knows when to show it. */
  onTitleBottom?: (y: number) => void;
}

/**
 * The album page's hero: the cover edge to edge under the status bar, fading
 * into the page, with the title, artist and controls left-aligned over its
 * foot. The fade keeps the title legible in both schemes; `AlbumTopScrim`
 * keeps the status bar legible over the cover.
 */
export function AlbumHeader({
  title,
  artist,
  onOpenArtist,
  coverUri,
  coverKey,
  metadata,
  onPlay,
  onShuffle,
  download,
  versions,
  pending = false,
  onTitleBottom,
}: Props) {
  const theme = useTheme();
  const size = useAlbumCoverSize();
  const wide = useWindowDimensions().width > size;
  const page = theme.scheme === "light" ? "255, 255, 255" : "0, 0, 0";
  // Shuffle and Download: the first elevation all but vanishes on white.
  const quiet = theme.scheme === "light" ? theme.color.bgElev2 : theme.color.bgElev1;
  const artistName = artist ? displayText(artist) : "";

  return (
    <View>
      <View
        style={{
          height: size,
          backgroundColor: theme.color.bgElev2,
          alignItems: "center",
          justifyContent: "center",
          overflow: "hidden",
        }}
      >
        {coverUri && wide ? (
          <Image
            source={{ uri: coverUri }}
            style={{ position: "absolute", top: 0, left: 0, right: 0, bottom: 0, opacity: 0.75 }}
            contentFit="cover"
            blurRadius={48}
            cachePolicy="memory-disk"
            recyclingKey={coverKey ?? coverUri}
          />
        ) : null}
        {coverUri ? (
          <Image
            source={{ uri: coverUri }}
            style={{ width: size, height: size }}
            contentFit="cover"
            transition={120}
            cachePolicy="memory-disk"
            priority="high"
            allowDownscaling
            decodeFormat="rgb"
            recyclingKey={coverKey ?? coverUri}
            accessibilityIgnoresInvertColors
          />
        ) : (
          <SymbolView
            name="music.note"
            size={Math.round(size * 0.22)}
            tintColor={theme.color.fgMuted}
          />
        )}
        <View
          pointerEvents="none"
          style={{
            position: "absolute",
            left: 0,
            right: 0,
            bottom: 0,
            height: Math.round(size / 2),
            experimental_backgroundImage: `linear-gradient(to bottom, rgba(${page}, 0) 0%, rgba(${page}, 0.55) 50%, rgba(${page}, 1) 100%)`,
          }}
        />
      </View>

      <View
        style={{
          marginTop: -ALBUM_TITLE_OVERLAP,
          paddingHorizontal: theme.space.lg,
          paddingBottom: theme.space.sm,
        }}
      >
        <Text
          accessibilityRole="header"
          numberOfLines={3}
          onLayout={(event) => {
            const { y, height } = event.nativeEvent.layout;
            onTitleBottom?.(size - ALBUM_TITLE_OVERLAP + y + height);
          }}
          style={{
            color: theme.color.fg,
            fontSize: 32,
            lineHeight: 36,
            fontWeight: "600",
            letterSpacing: -0.8,
          }}
        >
          {displayText(title)}
        </Text>
        {artistName ? (
          onOpenArtist ? (
            <Pressable
              accessibilityRole="link"
              accessibilityLabel={artistName}
              accessibilityHint="Opens the artist"
              onPress={() => {
                void Haptics.selectionAsync();
                onOpenArtist();
              }}
              hitSlop={8}
              style={({ pressed }) => ({
                alignSelf: "flex-start",
                flexDirection: "row",
                alignItems: "center",
                gap: 4,
                marginTop: 6,
                opacity: pressed ? 0.6 : 1,
              })}
            >
              <Text
                numberOfLines={1}
                style={{ flexShrink: 1, color: theme.color.fgSubtle, fontSize: 18, fontWeight: "500" }}
              >
                {artistName}
              </Text>
              <SymbolView
                name="chevron.forward"
                size={13}
                weight="semibold"
                tintColor={theme.color.fgMuted}
              />
            </Pressable>
          ) : (
            <Text
              numberOfLines={1}
              style={{ marginTop: 6, color: theme.color.fgSubtle, fontSize: 18, fontWeight: "500" }}
            >
              {artistName}
            </Text>
          )
        ) : null}
        <Text
          style={{
            marginTop: 6,
            color: theme.color.fgMuted,
            fontSize: 14,
            fontVariant: ["tabular-nums"],
          }}
        >
          {metadata}
        </Text>

        {versions ? <View style={{ marginTop: theme.space.lg }}>{versions}</View> : null}

        {onPlay || download ? (
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              gap: 10,
              marginTop: versions ? theme.space.md : 20,
            }}
          >
            {onPlay ? (
              <Pressable
                accessibilityRole="button"
                accessibilityState={{ disabled: pending }}
                disabled={pending}
                onPress={() => {
                  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                  onPlay();
                }}
                style={({ pressed }) => ({
                  flex: 1,
                  height: CONTROL_SIZE,
                  borderRadius: CONTROL_SIZE / 2,
                  borderCurve: "continuous",
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  backgroundColor: theme.color.accent,
                  opacity: pending ? 0.5 : pressed ? 0.85 : 1,
                })}
              >
                <SymbolView name="play.fill" size={15} tintColor={theme.color.onAccent} />
                <Text style={{ color: theme.color.onAccent, fontSize: 16, fontWeight: "600" }}>
                  Play
                </Text>
              </Pressable>
            ) : null}
            {onShuffle ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Shuffle"
                accessibilityState={{ disabled: pending }}
                disabled={pending}
                onPress={onShuffle}
                style={({ pressed }) => ({
                  flex: 1,
                  height: CONTROL_SIZE,
                  borderRadius: CONTROL_SIZE / 2,
                  borderCurve: "continuous",
                  flexDirection: "row",
                  alignItems: "center",
                  justifyContent: "center",
                  gap: 8,
                  backgroundColor: quiet,
                  opacity: pending ? 0.5 : pressed ? 0.8 : 1,
                })}
              >
                <SymbolView name="shuffle" size={15} weight="semibold" tintColor={theme.color.fg} />
                <Text style={{ color: theme.color.fg, fontSize: 16, fontWeight: "600" }}>
                  Shuffle
                </Text>
              </Pressable>
            ) : null}
            {download ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={download.label}
                accessibilityHint={download.queued ? "Offers to cancel the download" : undefined}
                accessibilityState={{ disabled: pending || !!download.disabled, busy: !!download.queued }}
                disabled={pending || download.disabled}
                onPress={() => {
                  void Haptics.selectionAsync();
                  download.onPress();
                }}
                style={({ pressed }) => ({
                  width: CONTROL_SIZE,
                  height: CONTROL_SIZE,
                  borderRadius: CONTROL_SIZE / 2,
                  alignItems: "center",
                  justifyContent: "center",
                  backgroundColor: quiet,
                  opacity: pending || download.disabled ? 0.5 : pressed ? 0.8 : 1,
                })}
              >
                {download.queued ? (
                  <ActivityIndicator color={theme.color.fg} />
                ) : (
                  <SymbolView name="arrow.down" size={18} weight="semibold" tintColor={theme.color.fg} />
                )}
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * What the album page's chrome shows at scroll offset `y`: the nav bar title
 * once the hero's title has gone fully under the bar, and the top scrim
 * while the status bar is over the cover rather than its fade into the page.
 */
export function albumHeroScrollState(
  y: number,
  {
    headerHeight,
    titleBottom,
    topInset,
    coverSize,
  }: { headerHeight: number; titleBottom: number; topInset: number; coverSize: number },
): { titleShown: boolean; overCover: boolean } {
  return {
    titleShown: y + headerHeight >= titleBottom,
    overCover: y + topInset < coverSize * COVER_UNDER_STATUS_BAR,
  };
}

/**
 * The album page's scroll-linked chrome. The nav bar title stays hidden while
 * the hero's own title is in view and shows once that has gone under the bar.
 * `overCover` is whether the cover is still under the status bar (see
 * `AlbumTopScrim`). Wraps the list's other scroll handler, and hands back
 * the header height and bottom inset the list pads itself with, since it
 * runs under the bars rather than being inset by the system.
 */
export function useAlbumHeroScroll(
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void,
) {
  const size = useAlbumCoverSize();
  const headerHeight = useHeaderHeight();
  const { top, bottom: bottomInset } = useSafeAreaInsets();
  // Until the title reports its layout, assume one line.
  const [titleBottom, setTitleBottom] = useState(size - ALBUM_TITLE_OVERLAP + 36);
  const [titleShown, setTitleShown] = useState(false);
  const [overCover, setOverCover] = useState(true);
  // The last offset, so a title that changes height (another version's)
  // is judged where the list already is rather than on the next scroll.
  const lastY = useRef(0);

  const apply = useCallback(
    (y: number, bottom: number) => {
      const state = albumHeroScrollState(y, {
        headerHeight,
        titleBottom: bottom,
        topInset: top,
        coverSize: size,
      });
      setTitleShown(state.titleShown);
      setOverCover(state.overCover);
    },
    [headerHeight, top, size],
  );

  const handleScroll = useCallback(
    (event: NativeSyntheticEvent<NativeScrollEvent>) => {
      onScroll?.(event);
      lastY.current = event.nativeEvent.contentOffset.y;
      apply(lastY.current, titleBottom);
    },
    [onScroll, apply, titleBottom],
  );

  const onTitleBottom = useCallback(
    (bottom: number) => {
      setTitleBottom(bottom);
      apply(lastY.current, bottom);
    },
    [apply],
  );

  return {
    onScroll: handleScroll,
    scrollEventThrottle: 16,
    titleShown,
    overCover,
    onTitleBottom,
    headerHeight,
    bottomInset,
  };
}

/**
 * A dark band fixed at the top of the screen while the cover is under the
 * status bar, so the status bar and back button stay legible over light art
 * wherever the cover has scrolled to; light mode also turns the status bar
 * text light for it. It fades out once the page's own background comes up
 * under the status bar, and stays off without a cover, whose plain
 * placeholder needs neither. The light status bar is held only while the
 * page is focused, so it hands back to the app's own on the next page.
 */
export function AlbumTopScrim({
  overCover,
  hasCover,
}: {
  overCover: boolean;
  hasCover: boolean;
}) {
  const theme = useTheme();
  const focused = useIsFocused();
  const shown = overCover && hasCover;
  const opacity = useSharedValue(shown ? 1 : 0);
  useEffect(() => {
    opacity.set(withTiming(shown ? 1 : 0, { duration: 200 }));
  }, [shown, opacity]);
  const fade = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return (
    <>
      <Animated.View
        pointerEvents="none"
        style={[
          {
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: TOP_SCRIM,
            experimental_backgroundImage:
              "linear-gradient(to bottom, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0) 100%)",
          },
          fade,
        ]}
      />
      {theme.scheme === "light" && focused && shown ? <StatusBar style="light" /> : null}
    </>
  );
}
