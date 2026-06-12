import { useCallback, useState, type ReactElement } from "react";
import { Alert, Pressable, StyleSheet, View } from "react-native";
import { useRouter } from "expo-router";
import { Directory, File } from "expo-file-system";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import {
  useFavorite,
  useFavoriteActions,
  api,
  libraryChanged,
  streamUrl,
  useAuth,
  type TrackDetail,
  type TrackListItem,
} from "@music-library/core";
import { usePlayTrack } from "../context/player";
import { AdaptiveGlass } from "./adaptive-glass";
import { useTheme } from "../theme/theme";
import {
  downloadFilename,
  downloadStreamToFile,
  extensionForFormat,
  extensionFromStream,
} from "../lib/track-download";
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
      matchContents
      style={{ width: size, height: size }}
    >
      <Menu
        label={
          <RNHostView matchContents>
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
        <Button
          label="Share..."
          systemImage="square.and.arrow.up"
          onPress={actions.openShare}
        />
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
          modifiers={[swiftDisabled(actions.downloading)]}
          onPress={actions.download}
        />
      </Section>
      {actions.hasAlbum ? (
        <>
          <Divider />
          <Section title="Library">
            <Button
              label="Go to Album"
              systemImage="square.stack"
              onPress={actions.openAlbum}
            />
          </Section>
        </>
      ) : null}
      {actions.isAdmin ? (
        <>
          <Divider />
          <Section title="Edit">
            <Button
              label="Edit Metadata"
              systemImage="pencil"
              onPress={actions.openEditMetadata}
            />
            {actions.hasAlbum ? (
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
  const isAdmin = me?.role === "admin";
  const [downloading, setDownloading] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const play = useCallback(() => {
    playTrack(track);
  }, [playTrack, track]);

  const toggleFavorite = useCallback(() => {
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    void toggleFav(track.id);
  }, [toggleFav, track.id]);

  const openAlbum = useCallback(() => {
    if (!track.album_id) return;
    router.push({
      pathname: "/(tabs)/(library)/albums/[id]",
      params: { id: track.album_id },
    });
  }, [router, track.album_id]);

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
      params: { trackId: track.id, trackTitle: track.title },
    });
  }, [router, track.id, track.title]);

  const openShare = useCallback(() => {
    router.push({
      pathname: "/share-track",
      params: { trackId: track.id, trackTitle: track.title },
    });
  }, [router, track.id, track.title]);

  const download = useCallback(async () => {
    if (downloading) return;
    setDownloading(true);
    try {
      let detail: TrackDetail | null = null;
      try {
        detail = await api.getTrack(track.id);
      } catch {
        // The stream can still be downloaded; metadata only improves the name.
      }

      const ext =
        extensionForFormat(detail?.format) ??
        (await extensionFromStream(track.id));
      const filename = downloadFilename(track, detail, ext);
      const selectedDir = await Directory.pickDirectoryAsync();
      const destination = new File(selectedDir, filename);
      const file = await downloadStreamToFile(streamUrl(track.id), destination);

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
      `Delete "${track.title}" from your library? This permanently removes the file you uploaded.`,
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
  }, [track.id, track.title]);

  return {
    deleteTrack,
    deleting,
    download,
    downloading,
    favorite,
    hasAlbum: Boolean(track.album_id),
    isAdmin,
    openAlbum,
    openEditAlbum,
    openEditMetadata,
    openInfo,
    openPlaylistPicker,
    openShare,
    owned: Boolean(track.owned),
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
