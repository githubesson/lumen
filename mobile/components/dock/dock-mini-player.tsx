import { useCallback, useRef } from "react";
import {
  ActionSheetIOS,
  Alert,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  findNodeHandle,
  useWindowDimensions,
} from "react-native";
import Animated, {
  Extrapolation,
  interpolate,
  useAnimatedStyle,
} from "react-native-reanimated";
import { SymbolView } from "expo-symbols";
import { useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { type TrackListItem } from "@music-library/core";
import {
  useCurrentTrack,
  useIsPlaying,
  usePlayerPlayback,
  usePlayerControls,
} from "../../context/player";
import { CoverArt } from "../cover-art";
import { useTrackActionModel } from "../track-actions-menu";
import { useTheme } from "../../theme/theme";
import {
  DOCK,
  useDockCollapsed,
  useDockColors,
  useDockControls,
} from "./dock-context";
import { DockSurface } from "./dock-surface";

let nowPlayingNavigationLockedUntil = 0;
const NOW_PLAYING_NAVIGATION_LOCK_MS = 700;

function useOpenNowPlaying() {
  const router = useRouter();

  return useCallback(
    ({ queue = false }: { queue?: boolean } = {}) => {
      const now = Date.now();
      if (now < nowPlayingNavigationLockedUntil) return;

      nowPlayingNavigationLockedUntil = now + NOW_PLAYING_NAVIGATION_LOCK_MS;
      void Haptics.selectionAsync();

      if (queue) {
        router.push({
          pathname: "/now-playing",
          params: { queue: "1" },
        });
      } else {
        router.push("/now-playing");
      }

      setTimeout(() => {
        if (Date.now() >= nowPlayingNavigationLockedUntil) {
          nowPlayingNavigationLockedUntil = 0;
        }
      }, NOW_PLAYING_NAVIGATION_LOCK_MS);
    },
    [router],
  );
}

// Shared size for everything on the phone row so `alignItems: center`
// holds true across cover, text block, and controls.
const CONTROL_SIZE = 36;
const ICON_SIZE = 20;
const PAD_ART_SIZE = 38;
const PAD_ICON_BUTTON_SIZE = 32;

/**
 * iPhone mini-player: a glass pill that the dock stacks directly above the
 * floating tab bar. The row Pressable opens the now-playing modal; the
 * transport buttons act independently.
 */
export function PhoneMiniPlayer() {
  const openNowPlaying = useOpenNowPlaying();
  const colors = useDockColors();
  const current = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const player = usePlayerControls();
  const { collapseProgress } = useDockControls();
  const collapsed = useDockCollapsed();

  // The pill cross-fades out on collapse, but never via opacity on itself or
  // an ancestor (alpha on a glass superview permanently kills the effect).
  // Each layer fades by legal means: the glass natively (DockSurface), and
  // the shadow, border, and content as plain views.
  const chromeFade = useAnimatedStyle(() => ({
    opacity: interpolate(
      collapseProgress.value,
      [0, 0.6],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  const contentFade = useAnimatedStyle(() => ({
    opacity: interpolate(
      collapseProgress.value,
      [0, 0.5],
      [1, 0],
      Extrapolation.CLAMP,
    ),
  }));

  if (!current) return null;

  return (
    <View style={styles.phoneStack}>
      <Animated.View
        pointerEvents="none"
        style={[styles.phoneShadow, { boxShadow: colors.shadow }, chromeFade]}
      />
      <View style={styles.phonePill}>
        <DockSurface hidden={collapsed} fadeProgress={collapseProgress} />
        <Animated.View
          pointerEvents="none"
          style={[styles.phoneBorder, { borderColor: colors.border }, chromeFade]}
        />
        <Animated.View style={[styles.phoneContent, contentFade]}>
      <Pressable
        onPress={() => {
          openNowPlaying();
        }}
        accessibilityRole="button"
        accessibilityLabel={
          current.artist
            ? `${current.title} by ${current.artist}. Tap to open full player.`
            : `${current.title}. Tap to open full player.`
        }
        style={styles.phoneRow}
      >
        <CoverArt track={current} size={CONTROL_SIZE} />
        <View style={styles.phoneMeta}>
          <Text
            numberOfLines={1}
            style={{
              fontSize: 15,
              fontWeight: "600",
              color: colors.active,
            }}
          >
            {current.title}
          </Text>
          {current.artist ? (
            <Text
              numberOfLines={1}
              style={{ fontSize: 13, color: colors.muted }}
            >
              {current.artist}
            </Text>
          ) : null}
        </View>
        <ControlButton
          icon="backward.fill"
          accessibilityLabel="Previous track"
          tint={colors.active}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            player.prev();
          }}
        />
        <ControlButton
          icon={isPlaying ? "pause.fill" : "play.fill"}
          accessibilityLabel={isPlaying ? "Pause" : "Play"}
          tint={colors.active}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            player.toggle();
          }}
        />
        <ControlButton
          icon="forward.fill"
          accessibilityLabel="Next track"
          tint={colors.active}
          onPress={() => {
            void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
            player.next();
          }}
        />
      </Pressable>
        </Animated.View>
      </View>
    </View>
  );
}

function ControlButton({
  icon,
  accessibilityLabel,
  tint,
  onPress,
}: {
  icon: Parameters<typeof SymbolView>[0]["name"];
  accessibilityLabel: string;
  tint: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      onPress={onPress}
      hitSlop={6}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      style={({ pressed }) => ({
        width: CONTROL_SIZE,
        height: CONTROL_SIZE,
        alignItems: "center",
        justifyContent: "center",
        opacity: pressed ? 0.55 : 1,
      })}
    >
      <SymbolView name={icon} size={ICON_SIZE} tintColor={tint} />
    </Pressable>
  );
}

/**
 * iPad mini-player island: a flex child of the dock's bottom row (the
 * floating tab bar sits to its left). Height tracks the dock's collapse
 * progress so both pills shrink together.
 */
export function PadMiniPlayer() {
  const openNowPlaying = useOpenNowPlaying();
  const colors = useDockColors();
  const current = useCurrentTrack();
  const isPlaying = useIsPlaying();
  const playback = usePlayerPlayback();
  const player = usePlayerControls();
  const { width } = useWindowDimensions();
  const { collapseProgress } = useDockControls();

  const pillStyle = useAnimatedStyle(() => {
    const h = interpolate(
      collapseProgress.value,
      [0, 1],
      [DOCK.tabBarHeight, DOCK.tabBarHeightCompact],
      Extrapolation.CLAMP,
    );
    return { height: h, borderRadius: h / 2 };
  });

  // Content shrinks with the pill (same scale as the tab bar icons). Each
  // cluster scales around its own anchor edge (via static transformOrigin)
  // so elements stay in place instead of pulling toward the row's center.
  const contentScale = useAnimatedStyle(() => ({
    transform: [
      {
        scale: interpolate(
          collapseProgress.value,
          [0, 1],
          [1, DOCK.iconCompactScale],
          Extrapolation.CLAMP,
        ),
      },
    ],
  }));

  if (!current) return null;

  const compact = width < 900;

  return (
    <Animated.View
      style={[
        styles.padPill,
        { borderColor: colors.border, boxShadow: colors.shadow },
        pillStyle,
      ]}
    >
      <DockSurface />
      <View style={styles.padContent}>
        <Animated.View
          style={[
            styles.padSideCluster,
            compact ? styles.padSideClusterCompact : styles.padSideClusterWide,
            styles.originLeft,
            contentScale,
          ]}
        >
          {compact ? null : (
            <PadIconButton
              icon="shuffle"
              selected={playback.shuffle}
              accessibilityLabel={
                playback.shuffle ? "Turn shuffle off" : "Turn shuffle on"
              }
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                player.toggleShuffle();
              }}
            />
          )}
          <PadIconButton
            icon="backward.fill"
            size={23}
            accessibilityLabel="Previous track"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              player.prev();
            }}
          />
          <PadIconButton
            icon={isPlaying ? "pause.fill" : "play.fill"}
            size={34}
            accessibilityLabel={isPlaying ? "Pause" : "Play"}
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              player.toggle();
            }}
            prominent
          />
          <PadIconButton
            icon="forward.fill"
            size={23}
            accessibilityLabel="Next track"
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
              player.next();
            }}
          />
          {compact ? null : (
            <PadIconButton
              icon={playback.repeat === "one" ? "repeat.1" : "repeat"}
              selected={playback.repeat !== "off"}
              accessibilityLabel={
                playback.repeat === "off"
                  ? "Repeat off. Turn on repeat"
                  : playback.repeat === "all"
                    ? "Repeat all. Turn on repeat one"
                    : "Repeat one. Turn repeat off"
              }
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                player.cycleRepeat();
              }}
            />
          )}
        </Animated.View>

        <Animated.View style={[styles.padTrackSlot, styles.originLeft, contentScale]}>
        <Pressable
          onPress={() => openNowPlaying()}
          accessibilityRole="button"
          accessibilityLabel={
            current.artist
              ? `${current.title} by ${current.artist}. Tap to open full player.`
              : `${current.title}. Tap to open full player.`
          }
          style={({ pressed }) => [
            styles.padTrackButton,
            { opacity: pressed ? 0.65 : 1 },
          ]}
        >
          <CoverArt track={current} size={PAD_ART_SIZE} />
          <View style={styles.padMeta}>
            <Text
              numberOfLines={1}
              style={[styles.padTitle, { color: colors.active }]}
            >
              {current.title}
            </Text>
            {current.artist ? (
              <Text
                numberOfLines={1}
                style={[styles.padArtist, { color: colors.muted }]}
              >
                {current.artist}
              </Text>
            ) : null}
          </View>
        </Pressable>
        </Animated.View>

        <Animated.View
          style={[
            styles.padActionCluster,
            compact ? styles.padActionClusterCompact : null,
            styles.originRight,
            contentScale,
          ]}
        >
          <PadTrackActionsButton track={current} />
          {compact ? null : (
            <PadIconButton
              icon="quote.bubble"
              accessibilityLabel="Lyrics"
              onPress={() => openNowPlaying()}
            />
          )}
          <PadIconButton
            icon="list.bullet"
            size={23}
            accessibilityLabel="Queue"
            onPress={() => openNowPlaying({ queue: true })}
          />
        </Animated.View>
      </View>
    </Animated.View>
  );
}

function PadIconButton({
  icon,
  accessibilityLabel,
  onPress,
  size = 21,
  selected = false,
  prominent = false,
}: {
  icon: Parameters<typeof SymbolView>[0]["name"];
  accessibilityLabel: string;
  onPress: () => void;
  size?: number;
  selected?: boolean;
  prominent?: boolean;
}) {
  const theme = useTheme();
  const colors = useDockColors();
  const tint = selected ? theme.color.accent : colors.active;

  return (
    <Pressable
      onPress={onPress}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={selected ? { selected } : undefined}
      style={({ pressed }) => [
        styles.padIconButton,
        prominent ? styles.padIconButtonProminent : null,
        { opacity: pressed ? 0.55 : 1 },
      ]}
    >
      <SymbolView name={icon} size={size} tintColor={tint} />
    </Pressable>
  );
}

type PadActionItem = {
  label: string;
  onPress: () => void;
  destructive?: boolean;
  disabled?: boolean;
};

function PadTrackActionsButton({ track }: { track: TrackListItem }) {
  const theme = useTheme();
  const colors = useDockColors();
  const actions = useTrackActionModel(track);
  const buttonRef = useRef<View>(null);

  const openActions = useCallback(() => {
    void Haptics.selectionAsync();

    const items: PadActionItem[] = [
      { label: "Play", onPress: actions.play },
      {
        label: actions.favorite
          ? "Remove from Favorites"
          : "Add to Favorites",
        onPress: actions.toggleFavorite,
      },
      { label: "Track Info", onPress: actions.openInfo },
      { label: "Share...", onPress: actions.openShare },
      { label: "Add to Playlist...", onPress: actions.openPlaylistPicker },
      {
        label: actions.downloading ? "Downloading..." : "Download File...",
        onPress: actions.download,
        disabled: actions.downloading,
      },
    ];

    if (actions.hasAlbum) {
      items.push({ label: "Go to Album", onPress: actions.openAlbum });
    }
    if (actions.isAdmin) {
      items.push({
        label: "Edit Metadata",
        onPress: actions.openEditMetadata,
      });
      if (actions.hasAlbum) {
        items.push({
          label: "Edit Album & Cover",
          onPress: actions.openEditAlbum,
        });
      }
    }
    if (actions.owned) {
      items.push({
        label: actions.deleting ? "Deleting..." : "Delete from My Library",
        onPress: actions.deleteTrack,
        destructive: true,
        disabled: actions.deleting,
      });
    }

    if (Platform.OS !== "ios") {
      Alert.alert(
        track.title,
        track.artist ?? undefined,
        [
          ...items
            .filter((item) => !item.disabled)
            .map((item) => ({
              text: item.label,
              onPress: item.onPress,
              style: item.destructive ? ("destructive" as const) : undefined,
            })),
          { text: "Cancel", style: "cancel" as const },
        ],
      );
      return;
    }

    const cancelButtonIndex = items.length;
    ActionSheetIOS.showActionSheetWithOptions(
      {
        title: track.title,
        message: track.artist ?? undefined,
        options: [...items.map((item) => item.label), "Cancel"],
        cancelButtonIndex,
        destructiveButtonIndex: items
          .map((item, index) => (item.destructive ? index : -1))
          .filter((index) => index >= 0),
        disabledButtonIndices: items
          .map((item, index) => (item.disabled ? index : -1))
          .filter((index) => index >= 0),
        tintColor: theme.color.accent,
        userInterfaceStyle: theme.scheme,
        anchor: findNodeHandle(buttonRef.current) ?? undefined,
      },
      (selectedIndex) => {
        if (selectedIndex === cancelButtonIndex) return;
        items[selectedIndex]?.onPress();
      },
    );
  }, [actions, theme.color.accent, theme.scheme, track.artist, track.title]);

  return (
    <Pressable
      ref={buttonRef}
      onPress={openActions}
      hitSlop={10}
      accessibilityRole="button"
      accessibilityLabel="More actions"
      style={({ pressed }) => [
        styles.padIconButton,
        { opacity: pressed ? 0.55 : 1 },
      ]}
    >
      <SymbolView name="ellipsis" size={21} tintColor={colors.active} />
    </Pressable>
  );
}

const styles = StyleSheet.create({
  phoneStack: {
    height: DOCK.miniHeight,
  },
  phoneShadow: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: DOCK.miniHeight / 2,
    borderCurve: "continuous",
  },
  phonePill: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: DOCK.miniHeight / 2,
    borderCurve: "continuous",
    overflow: "hidden",
  },
  phoneBorder: {
    ...StyleSheet.absoluteFillObject,
    borderRadius: DOCK.miniHeight / 2,
    borderCurve: "continuous",
    borderWidth: StyleSheet.hairlineWidth,
  },
  phoneContent: {
    flex: 1,
  },
  phoneRow: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 12,
  },
  phoneMeta: {
    flex: 1,
    minWidth: 0,
    paddingHorizontal: 2,
  },
  padPill: {
    flex: 1,
    maxWidth: DOCK.padIslandMaxWidth,
    borderCurve: "continuous",
    overflow: "hidden",
    borderWidth: StyleSheet.hairlineWidth,
  },
  padContent: {
    flex: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: 18,
  },
  padSideCluster: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-start",
  },
  padSideClusterWide: {
    width: 250,
    gap: 14,
  },
  padSideClusterCompact: {
    width: 154,
    gap: 12,
  },
  padTrackSlot: {
    flex: 1,
    minWidth: 0,
  },
  padTrackButton: {
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
  },
  // Anchors for the collapse scale: each cluster shrinks toward its own
  // edge so content stays in place instead of drifting to the row's center.
  originLeft: {
    transformOrigin: "left center",
  },
  originRight: {
    transformOrigin: "right center",
  },
  padMeta: {
    flex: 1,
    minWidth: 0,
    justifyContent: "center",
  },
  padTitle: {
    fontSize: 15,
    fontWeight: "700",
  },
  padArtist: {
    marginTop: 2,
    fontSize: 13,
    fontWeight: "500",
  },
  padActionCluster: {
    width: 124,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "flex-end",
    gap: 14,
  },
  padActionClusterCompact: {
    width: 72,
    gap: 8,
  },
  padIconButton: {
    width: PAD_ICON_BUTTON_SIZE,
    height: PAD_ICON_BUTTON_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  padIconButtonProminent: {
    width: 40,
    height: 40,
  },
});
