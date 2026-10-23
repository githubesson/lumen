import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactElement,
} from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { useNavigationContainerRef, useRouter } from "expo-router";
import { Directory, File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import {
  api,
  deleteOwnUploadMessage,
  errorMessage,
  libraryChanged,
  downloadStreamUrl,
  prepareTrackDownload,
  resolveTrackAlbumTarget,
  trackActions,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import { useFavorite, useFavoriteActions } from "../context/favorites";
import { useCanPlayNext, usePlayNext, usePlayTrack } from "../context/player";
import { useTrackUnavailableOffline } from "../lib/offline-mode";
import { AdaptiveGlass } from "./adaptive-glass";
import { setPlaylistPickerTrack } from "./playlist-picker/subject";
import { useTheme } from "../theme/theme";
import { downloadStreamToFile } from "../lib/track-download";
import { focusedInTabs } from "../lib/track-info";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
  swiftFrame,
  swiftLabelStyle,
  swiftOnAppear,
  swiftOnDisappear,
  type SwiftUIComponents,
} from "./optional-swift-ui";
import { TrackMenuPreview } from "./track-menu-preview";

type TrackActionModel = ReturnType<typeof useTrackActionModel>;

interface ContextMenuHostOptions {
  /** The row's height; the theme's row height by default. */
  height?: number;
  /** What the row sits on, behind its press morph; the list background by default. */
  backgroundColor?: string;
  /** Play Next from the menu, when the row confirms it itself (swipe rows). */
  onPlayNext?: () => void;
}

export function TrackActionsContextMenu({
  track,
  children,
  ...options
}: {
  track: TrackListItem;
  children: ReactElement;
} & ContextMenuHostOptions) {
  const swiftUI = getOptionalSwiftUI();

  if (!swiftUI) {
    return children;
  }

  return (
    <TrackActionsContextMenuHost track={track} swiftUI={swiftUI} {...options}>
      {children}
    </TrackActionsContextMenuHost>
  );
}

function TrackActionsContextMenuHost({
  track,
  swiftUI,
  children,
  height,
  backgroundColor,
  onPlayNext,
}: {
  track: TrackListItem;
  swiftUI: SwiftUIComponents;
  children: ReactElement;
} & ContextMenuHostOptions) {
  const theme = useTheme();
  const actions = useTrackActionModel(track, { onPlayNext });
  const preview = useHeldMenuPreview();
  const { ContextMenu, Group, Host, RNHostView } = swiftUI;

  return (
    <Host
      colorScheme={theme.scheme}
      style={[styles.contextHost, { height: height ?? theme.row.height }]}
    >
      <ContextMenu>
        <ContextMenu.Items>
          <TrackActionItems actions={actions} swiftUI={swiftUI} />
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView>
            {/* iOS shrinks the row in place on press, then morphs it into the
                preview. Rows are transparent, so without a backing the
                morphing row showed the rows behind it. Lists sit on the theme
                background, so it can't be seen in place. It wraps the row so a
                dimmed row's opacity doesn't thin it. */}
            <View
              collapsable={false}
              style={[
                styles.rowBacking,
                { backgroundColor: backgroundColor ?? theme.color.bg },
              ]}
              {...preview.touchHandlers}
            >
              {children}
            </View>
          </RNHostView>
        </ContextMenu.Trigger>
        <ContextMenu.Preview>
          <Group modifiers={preview.modifiers}>
            <RNHostView matchContents>
              <TrackMenuPreview track={track} active={preview.active} />
            </RNHostView>
          </Group>
        </ContextMenu.Preview>
      </ContextMenu>
    </Host>
  );
}

/**
 * Hold time before the preview mounts: longer than a tap, and well short of
 * the ~0.5 s iOS takes to open the menu.
 */
const PREVIEW_MOUNT_DELAY_MS = 150;
/** Finger travel that makes a touch a scroll rather than a press-and-hold. */
const PREVIEW_TOUCH_SLOP = 10;
/** Keeps the preview mounted through the menu's closing animation. */
const PREVIEW_UNMOUNT_DELAY_MS = 600;

/**
 * Mounts a row's menu preview (glass and artwork) only while a press is held
 * or the menu is open, so long lists don't build one per row. The menu taking
 * over cancels the row's touch where it started; a scroll cancels it after
 * moving. The preview's own appear/disappear marks the menu open and closed.
 */
function useHeldMenuPreview() {
  const [held, setHeld] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [closing, setClosing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const origin = useRef({ x: 0, y: 0 });

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  useEffect(() => {
    if (!closing) return;
    const t = setTimeout(() => setClosing(false), PREVIEW_UNMOUNT_DELAY_MS);
    return () => clearTimeout(t);
  }, [closing]);

  const touchHandlers = useMemo(() => {
    const clearTimer = () => {
      if (timer.current) clearTimeout(timer.current);
      timer.current = null;
    };
    const release = () => {
      clearTimer();
      setHeld(false);
    };
    const moved = (e: GestureResponderEvent) =>
      Math.hypot(
        e.nativeEvent.pageX - origin.current.x,
        e.nativeEvent.pageY - origin.current.y,
      ) > PREVIEW_TOUCH_SLOP;

    return {
      onTouchStart: (e: GestureResponderEvent) => {
        origin.current = { x: e.nativeEvent.pageX, y: e.nativeEvent.pageY };
        clearTimer();
        timer.current = setTimeout(() => {
          timer.current = null;
          setHeld(true);
        }, PREVIEW_MOUNT_DELAY_MS);
      },
      onTouchMove: (e: GestureResponderEvent) => {
        if (moved(e)) release();
      },
      onTouchEnd: release,
      onTouchCancel: (e: GestureResponderEvent) => {
        if (moved(e)) {
          release();
          return;
        }
        clearTimer();
        setHeld(true);
      },
    };
  }, []);

  const modifiers = useMemo(
    () => [
      swiftOnAppear(() => setMenuOpen(true)),
      swiftOnDisappear(() => {
        setMenuOpen(false);
        setHeld(false);
        setClosing(true);
      }),
    ],
    [],
  );

  return { active: held || menuOpen || closing, touchHandlers, modifiers };
}

export function TrackActionsMenuButton({
  track,
  accessibilityLabel,
  size = 36,
}: {
  track: TrackListItem;
  accessibilityLabel: string;
  size?: number;
}) {
  const theme = useTheme();
  const actions = useTrackActionModel(track);
  const swiftUI = getOptionalSwiftUI();

  if (!swiftUI) {
    return (
      <Pressable
        onPress={notifyMissingNativeMenu}
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
        <CircleMenuLabel size={size} tintColor={theme.color.fg} />
      </Pressable>
    );
  }

  const { Host, Menu, RNHostView } = swiftUI;

  return (
    <Host
      colorScheme={theme.scheme}
      style={{ width: size, height: size }}
    >
      <Menu
        label={
          <RNHostView style={{ width: size, height: size }}>
            <CircleMenuLabel
              size={size}
              tintColor={theme.color.fg}
            />
          </RNHostView>
        }
        modifiers={[
          swiftAccessibilityLabel(accessibilityLabel),
          swiftButtonStyle("plain"),
          swiftControlSize("small"),
          swiftLabelStyle("iconOnly"),
          swiftFrame({ width: size, height: size }),
        ]}
      >
        <TrackActionItems actions={actions} swiftUI={swiftUI} />
      </Menu>
    </Host>
  );
}

function CircleMenuLabel({
  size,
  tintColor,
}: {
  size: number;
  tintColor: string;
}) {
  return (
    <AdaptiveGlass
      interactive
      style={{
        width: size,
        height: size,
        borderRadius: size / 2,
        overflow: "hidden",
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        <SymbolView
          name="ellipsis"
          size={18}
          weight="semibold"
          tintColor={tintColor}
        />
      </View>
    </AdaptiveGlass>
  );
}

function TrackActionItems({
  actions,
  swiftUI,
}: {
  actions: TrackActionModel;
  swiftUI: SwiftUIComponents;
}) {
  const { Button, ControlGroup, Divider, Section } = swiftUI;

  return (
    <>
      <ControlGroup>
        <Button
          label="Play"
          systemImage="play.fill"
          modifiers={[swiftDisabled(!actions.available)]}
          onPress={actions.play}
        />
        <Button
          label={
            actions.favorite ? "Remove from Favorites" : "Add to Favorites"
          }
          systemImage={actions.favorite ? "heart.slash" : "heart"}
          onPress={actions.toggleFavorite}
        />
        <Button
          label="Track Info"
          systemImage="info.circle"
          onPress={actions.openInfo}
        />
        {actions.canShare ? (
          <Button
            label="Share..."
            systemImage="square.and.arrow.up"
            onPress={actions.openShare}
          />
        ) : null}
      </ControlGroup>
      <Divider />
      <Section title="Actions">
        {actions.showPlayNext ? (
          <Button
            label="Play Next"
            systemImage="text.line.first.and.arrowtriangle.forward"
            modifiers={[swiftDisabled(!actions.canPlayNext)]}
            onPress={actions.playNext}
          />
        ) : null}
        <Button
          label="Add to Playlist..."
          systemImage="plus.rectangle.on.folder"
          onPress={actions.openPlaylistPicker}
        />
        <Button
          label={actions.downloading ? "Downloading..." : "Download File..."}
          systemImage="arrow.down.doc"
          modifiers={[swiftDisabled(actions.downloading || !actions.available)]}
          onPress={actions.download}
        />
      </Section>
      {actions.hasAlbum ? (
        <>
          <Divider />
          <Section title="Library">
            <Button
              label="View Album"
              systemImage="square.stack"
              onPress={actions.openAlbum}
            />
          </Section>
        </>
      ) : null}
      {actions.canEditMetadata || actions.hasEditableAlbum ? (
        <>
          <Divider />
          <Section title="Edit">
            {actions.canEditMetadata ? (
              <Button
                label="Edit Metadata"
                systemImage="pencil"
                onPress={actions.openEditMetadata}
              />
            ) : null}
            {actions.hasEditableAlbum ? (
              <Button
                label="Edit Album & Cover"
                systemImage="photo"
                onPress={actions.openEditAlbum}
              />
            ) : null}
          </Section>
        </>
      ) : null}
      {actions.owned ? (
        <>
          <Divider />
          <Button
            label={actions.deleting ? "Deleting..." : "Delete from My Library"}
            systemImage="trash"
            role="destructive"
            modifiers={[swiftDisabled(actions.deleting)]}
            onPress={actions.deleteTrack}
          />
        </>
      ) : null}
    </>
  );
}

export function useTrackActionModel(
  track: TrackListItem,
  { onPlayNext }: { onPlayNext?: () => void } = {},
) {
  const router = useRouter();
  const navigation = useNavigationContainerRef();
  const playTrack = usePlayTrack();
  const playNextTrack = usePlayNext();
  // Not while controlling another device (no command for it yet), and not
  // for the track that's playing.
  const showPlayNext = useCanPlayNext(track.id);
  const unavailableOffline = useTrackUnavailableOffline(track.id);
  const favorite = useFavorite(track.id);
  const { toggle: toggleFav } = useFavoriteActions();
  const { me } = useAuth();
  const actions = trackActions(track, { isAdmin: me?.role === "admin" });
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const play = useCallback(() => {
    // Dropped from TIDAL with no library copy: nothing to stream.
    if (track.unavailable) return;
    playTrack(track);
  }, [playTrack, track]);

  const playNext = useCallback(() => {
    if (onPlayNext) {
      onPlayNext();
      return;
    }
    if (playNextTrack([track])) {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
  }, [onPlayNext, playNextTrack, track]);

  const toggleFavorite = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void toggleFav(track);
  }, [toggleFav, track]);

  const openAlbum = useCallback(() => {
    void (async () => {
      try {
        const target = await resolveTrackAlbumTarget(track);

        if (target?.kind === "tidal") {
          router.push({
            pathname: "/(tabs)/(library)/tidal-albums/[id]" as never,
            params: { id: target.id },
          });
          return;
        }

        if (target) {
          router.push({
            pathname: "/(tabs)/(library)/albums/[id]",
            params: { id: target.id },
          });
          return;
        }

        Alert.alert("Album unavailable", "No album was found for this track.");
      } catch (error) {
        Alert.alert(
          "Album unavailable",
          errorMessage(error, "Please try again."),
        );
      }
    })();
  }, [router, track]);

  // Track Info and the editor open in the current tab's stack: every tab
  // carries them, and a group-less href resolves into the tab in front. Over
  // the tabs (Now Playing) there's no tab in front, so they open in Library.
  // The state is read on press, so rows don't re-render on each navigation.
  const inTabs = useCallback(
    () => focusedInTabs(navigation.isReady() ? navigation.getRootState() : undefined),
    [navigation],
  );

  const openInfo = useCallback(() => {
    // The menu on Track Info itself: it's already showing.
    // The app declares no root param list, so the route is untyped here.
    const current = (navigation.isReady() ? navigation.getCurrentRoute() : undefined) as
      | { name: string; params?: { id?: string } }
      | undefined;
    if (current?.name === "track/[id]" && current.params?.id === track.id) return;
    router.push({
      pathname: inTabs() ? "/(tabs)/track/[id]" : "/(tabs)/(library)/track/[id]",
      params: { id: track.id },
    });
  }, [inTabs, navigation, router, track.id]);

  // Admin-only: jump to the metadata editor for this track.
  const openEditMetadata = useCallback(() => {
    router.push({
      pathname: inTabs() ? "/(tabs)/track/edit" : "/(tabs)/(library)/track/edit",
      params: { id: track.id },
    });
  }, [inTabs, router, track.id]);

  // Admin-only: edit the album this track belongs to — that's where cover
  // art lives, since artwork is shared across an album.
  const openEditAlbum = useCallback(() => {
    if (!track.album_id) return;
    router.push({
      pathname: "/(tabs)/(library)/albums/edit",
      params: { id: track.album_id },
    });
  }, [router, track.album_id]);

  const openPlaylistPicker = useCallback(() => {
    setPlaylistPickerTrack(track);
    router.push({
      pathname: "/playlist-picker",
      params: { trackId: track.id },
    });
  }, [router, track]);

  const openShare = useCallback(() => {
    router.push({
      pathname: "/share-track",
      params: { trackId: track.id },
    });
  }, [router, track.id]);

  const download = useCallback(async () => {
    if (downloading || track.unavailable) return;
    // Ask for the folder before any network work, so the picker opens at once
    // and backing out of it costs nothing.
    let selectedDir: Directory;
    try {
      selectedDir = await Directory.pickDirectoryAsync();
    } catch (error) {
      if (isPickerCancellation(error)) return;
      Alert.alert(
        "Download failed",
        error instanceof Error ? error.message : "Please try again.",
      );
      return;
    }
    setDownloading(true);
    try {
      const { filename } = await prepareTrackDownload(track);
      const destination = new File(selectedDir, filename);
      const file = await downloadStreamToFile(downloadStreamUrl(track.id), destination);

      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      Alert.alert("Downloaded", `Saved ${file.name}.`);
    } catch (error) {
      Alert.alert(
        "Download failed",
        error instanceof Error ? error.message : "Please try again.",
      );
    } finally {
      setDownloading(false);
    }
  }, [downloading, track]);

  // Personal uploads only (track.owned). Hard delete: the server removes the
  // DB row and the uploaded file, so confirm before firing.
  const deleteTrack = useCallback(() => {
    Alert.alert(
      "Delete Track",
      deleteOwnUploadMessage(track),
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => {
            void (async () => {
              setDeleting(true);
              try {
                await api.deleteTrack(track.id);
                void Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Success,
                );
                libraryChanged.emit();
              } catch (error) {
                void Haptics.notificationAsync(
                  Haptics.NotificationFeedbackType.Error,
                );
                Alert.alert(
                  "Delete failed",
                  errorMessage(error, "Please try again."),
                );
              } finally {
                setDeleting(false);
              }
            })();
          },
        },
      ],
    );
  }, [track]);

  return {
    canEditMetadata: actions.editMetadata,
    canShare: actions.share,
    deleteTrack,
    deleting,
    download,
    downloading,
    favorite,
    hasAlbum: actions.viewAlbum,
    // Edit Album & Cover is mobile-only; web edits albums from the album page.
    hasEditableAlbum: actions.editAlbum,
    openAlbum,
    openEditAlbum,
    openEditMetadata,
    openInfo,
    openPlaylistPicker,
    openShare,
    owned: actions.deleteOwnUpload,
    // Dropped from TIDAL with no library copy: no stream to play or save.
    available: actions.play,
    play,
    // A track that can't play here can't be queued either.
    canPlayNext: actions.play && !unavailableOffline,
    playNext,
    showPlayNext,
    toggleFavorite,
  };
}

function notifyMissingNativeMenu() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
  console.warn(
    "Track actions require the ExpoUI native module. Rebuild the iOS app to enable anchored Liquid Glass context menus.",
  );
}

const styles = StyleSheet.create({
  contextHost: {
    width: "100%",
  },
  rowBacking: {
    flex: 1,
  },
});

/** expo-file-system rejects with this when the user dismisses the picker. */
function isPickerCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_FILE_PICKING_CANCELLED"
  );
}
