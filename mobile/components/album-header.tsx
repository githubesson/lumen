import { useCallback, useRef, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Pressable,
  Text,
  View,
  useWindowDimensions,
  type NativeScrollEvent,
  type NativeSyntheticEvent,
} from "react-native";
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
/** The darkened band at the top of the cover, under the status bar and back button. */
const TOP_SCRIM = 140;

/** The cover runs edge to edge, so it's as wide as the screen. */
export function useAlbumCoverSize(): number {
  return Math.round(useWindowDimensions().width);
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
 * foot. Scrims keep the status bar legible over light art and the title
 * legible in both schemes.
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
  const page = theme.scheme === "light" ? "255, 255, 255" : "0, 0, 0";
  // Shuffle and Download: the first elevation all but vanishes on white.
  const quiet = theme.scheme === "light" ? theme.color.bgElev2 : theme.color.bgElev1;
  const artistName = artist ? displayText(artist) : "";

  return (
    <View>
      <View
        style={{
          width: size,
          height: size,
          backgroundColor: theme.color.bgElev2,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {coverUri ? (
          <Image
            source={{ uri: coverUri }}
            style={{ position: "absolute", top: 0, left: 0, width: size, height: size }}
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
            top: 0,
            left: 0,
            right: 0,
            height: TOP_SCRIM,
            experimental_backgroundImage:
              "linear-gradient(to bottom, rgba(0, 0, 0, 0.35) 0%, rgba(0, 0, 0, 0) 100%)",
          }}
        />
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
 * once the hero's title has gone fully under the bar, and the light status
 * bar while the top half of the cover (the darkened part, before it fades
 * into the page) is under the status bar.
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
    overCover: y + topInset < coverSize / 2,
  };
}

/**
 * The album page's scroll-linked chrome. The nav bar title stays hidden while
 * the hero's own title is in view and shows once that has gone under the bar.
 * `overCover` is whether the cover's darkened top is still under the status
 * bar (see `AlbumStatusBar`). Wraps the list's other scroll handler.
 */
export function useAlbumHeroScroll(
  onScroll?: (event: NativeSyntheticEvent<NativeScrollEvent>) => void,
) {
  const size = useAlbumCoverSize();
  const headerHeight = useHeaderHeight();
  const { top } = useSafeAreaInsets();
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
  };
}

/**
 * Light status bar text while the cover's darkened top is under it. Only
 * light mode needs it (dark mode's is light already), and only while the
 * page is on screen, so it hands back to the app's own on the next page.
 */
export function AlbumStatusBar({ overCover }: { overCover: boolean }) {
  const theme = useTheme();
  const focused = useIsFocused();
  return theme.scheme === "light" && focused && overCover ? <StatusBar style="light" /> : null;
}
