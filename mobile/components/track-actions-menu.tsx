import { useCallback, useState, type ReactElement } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Directory, File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import {
  api,
  deleteOwnUploadMessage,
  libraryChanged,
  downloadStreamUrl,
  prepareTrackDownload,
  resolveTrackAlbumTarget,
  trackActions,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import { useFavorite, useFavoriteActions } from "../context/favorites";
import { usePlayTrack } from "../context/player";
import { AdaptiveGlass } from "./adaptive-glass";
import { useTheme } from "../theme/theme";
import { downloadStreamToFile } from "../lib/track-download";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
  swiftFrame,
  swiftLabelStyle,
  type SwiftUIComponents,
} from "./optional-swift-ui";

type TrackActionModel = ReturnType<typeof useTrackActionModel>;

export function TrackActionsContextMenu({
  track,
  children,
}: {
  track: TrackListItem;
  children: ReactElement;
}) {
  const swiftUI = getOptionalSwiftUI();

  if (!swiftUI) {
    return children;
  }

  return (
    <TrackActionsContextMenuHost track={track} swiftUI={swiftUI}>
      {children}
    </TrackActionsContextMenuHost>
  );
}

function TrackActionsContextMenuHost({
  track,
  swiftUI,
  children,
}: {
  track: TrackListItem;
  swiftUI: SwiftUIComponents;
  children: ReactElement;
}) {
  const theme = useTheme();
  const actions = useTrackActionModel(track);
  const { ContextMenu, Host, RNHostView } = swiftUI;

  return (
    <Host
      colorScheme={theme.scheme}
      style={[styles.contextHost, { height: theme.row.height }]}
    >
      <ContextMenu>
        <ContextMenu.Items>
          <TrackActionItems actions={actions} swiftUI={swiftUI} />
        </ContextMenu.Items>
        <ContextMenu.Trigger>
          <RNHostView>{children}</RNHostView>
        </ContextMenu.Trigger>
      </ContextMenu>
    </Host>
  );
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

export function useTrackActionModel(track: TrackListItem) {
  const router = useRouter();
  const playTrack = usePlayTrack();
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
          error instanceof Error ? error.message : "Please try again.",
        );
      }
    })();
  }, [router, track]);

  const openInfo = useCallback(() => {
    router.push({
      pathname: "/(tabs)/(library)/track/[id]",
      params: { id: track.id },
    });
  }, [router, track.id]);

  // Admin-only: jump to the metadata editor for this track.
  const openEditMetadata = useCallback(() => {
    router.push({
      pathname: "/(tabs)/(library)/track/edit",
      params: { id: track.id },
    });
  }, [router, track.id]);

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
    router.push({
      pathname: "/playlist-picker",
      params: { trackId: track.id },
    });
  }, [router, track.id]);

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
                  error instanceof Error ? error.message : "Please try again.",
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
});

/** expo-file-system rejects with this when the user dismisses the picker. */
function isPickerCancellation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "ERR_FILE_PICKING_CANCELLED"
  );
}
