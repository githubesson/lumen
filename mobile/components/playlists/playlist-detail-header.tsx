import { useCallback, useMemo, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import type { SortKey, TrackListItem } from "@music-library/core";

import { CoverArt } from "../cover-art";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
} from "../optional-swift-ui";
import {
  autoDownloadStore,
  downloadStore,
  useAutoDownload,
  usePlaylistDownload,
} from "../../lib/downloads";
import { useIsOffline } from "../../lib/offline-mode";
import type { ThemeTokens } from "../../theme/theme";

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "custom", label: "Custom" },
  { key: "title", label: "Title" },
  { key: "duration", label: "Length" },
  { key: "plays", label: "Plays" },
];

const SORT_MENU_SYMBOLS: Record<SortKey, string> = {
  custom: "line.3.horizontal",
  title: "textformat",
  duration: "clock",
  plays: "play.circle",
};

/** Diameter of the header's circular controls and the Play capsule height. */
export const PLAYLIST_CONTROL_SIZE = 50;

/** Artwork collage for the playlist hero. */
export function PlaylistHero({
  theme,
  tracks,
}: {
  theme: ThemeTokens;
  tracks: TrackListItem[];
}) {
  const { width } = useWindowDimensions();
  const size = Math.min(Math.round(width * 0.62), 300);
  const covers = useMemo(() => {
    const seen = new Set<string>();
    const unique: TrackListItem[] = [];
    for (const track of tracks) {
      if (track.has_cover === false) continue;
      const key = track.album_id ?? track.id;
      if (seen.has(key)) continue;
      seen.add(key);
      unique.push(track);
      if (unique.length === 4) break;
    }
    return unique;
  }, [tracks]);

  const cells = useMemo(() => {
    if (covers.length <= 1) return covers;
    const filled = [...covers];
    while (filled.length < 4) filled.push(covers[filled.length % covers.length]);
    return filled;
  }, [covers]);

  return (
    <View
      style={{
        alignSelf: "center",
        borderRadius: theme.radius.lg,
        shadowColor: "#000",
        shadowOpacity: 0.35,
        shadowRadius: 18,
        shadowOffset: { width: 0, height: 10 },
      }}
    >
      <View
        style={{
          width: size,
          height: size,
          borderRadius: theme.radius.lg,
          overflow: "hidden",
          backgroundColor: theme.color.bgElev1,
          borderCurve: "continuous",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {cells.length === 0 ? (
          <SymbolView
            name="music.note"
            size={Math.round(size * 0.28)}
            tintColor={theme.color.fgMuted}
          />
        ) : cells.length === 1 ? (
          <CoverArt
            track={cells[0]}
            size={size}
            radius={theme.radius.lg}
            transitionMs={0}
            priority="high"
          />
        ) : (
          <View
            style={{
              flexDirection: "row",
              flexWrap: "wrap",
              width: size,
              height: size,
            }}
          >
            {cells.map((track, index) => (
              <CoverArt
                key={`${track.id}:${index}`}
                track={track}
                size={size / 2}
                radius={0}
                transitionMs={0}
                priority="high"
              />
            ))}
          </View>
        )}
      </View>
    </View>
  );
}

/** Local playlist sort menu and direction toggle. */
export function SortMenuButton({
  theme,
  sortKey,
  sortAsc,
  onSelect,
  onToggleDirection,
}: {
  theme: ThemeTokens;
  sortKey: SortKey;
  sortAsc: boolean;
  onSelect: (key: SortKey) => void;
  onToggleDirection: () => void;
}) {
  const swiftUI = getOptionalSwiftUI();

  const label = (
    <View
      style={{
        height: PLAYLIST_CONTROL_SIZE,
        width: PLAYLIST_CONTROL_SIZE,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.color.bgElev1,
        borderRadius: PLAYLIST_CONTROL_SIZE / 2,
        borderCurve: "continuous",
      }}
    >
      <SymbolView
        name="arrow.up.arrow.down"
        size={15}
        weight="semibold"
        tintColor={sortKey === "custom" ? theme.color.fg : theme.color.accent}
      />
    </View>
  );

  const trigger = swiftUI ? (
    <swiftUI.Host matchContents colorScheme={theme.scheme}>
      <swiftUI.Menu
        label={<swiftUI.RNHostView matchContents>{label}</swiftUI.RNHostView>}
        modifiers={[
          swiftAccessibilityLabel("Sort playlist"),
          swiftButtonStyle("plain"),
          swiftControlSize("regular"),
        ]}
      >
        {SORT_OPTIONS.map((option) => (
          <swiftUI.Button
            key={option.key}
            label={option.label}
            systemImage={
              option.key === sortKey ? "checkmark" : SORT_MENU_SYMBOLS[option.key]
            }
            onPress={() => onSelect(option.key)}
          />
        ))}
      </swiftUI.Menu>
    </swiftUI.Host>
  ) : (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Sort playlist"
      onPress={() =>
        Alert.alert("Sort by", undefined, [
          ...SORT_OPTIONS.map((option) => ({
            text: option.label,
            onPress: () => onSelect(option.key),
          })),
          { text: "Cancel", style: "cancel" as const },
        ])
      }
      style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
    >
      {label}
    </Pressable>
  );

  return (
    <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
      {trigger}
      {sortKey !== "custom" ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            sortAsc
              ? "Sorted ascending, switch to descending"
              : "Sorted descending, switch to ascending"
          }
          onPress={() => {
            void Haptics.selectionAsync();
            onToggleDirection();
          }}
          style={({ pressed }) => ({
            height: PLAYLIST_CONTROL_SIZE,
            width: PLAYLIST_CONTROL_SIZE,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.color.bgElev1,
            borderRadius: PLAYLIST_CONTROL_SIZE / 2,
            borderCurve: "continuous",
            opacity: pressed ? 0.7 : 1,
          })}
        >
          <SymbolView
            name={sortAsc ? "arrow.up" : "arrow.down"}
            size={13}
            weight="semibold"
            tintColor={theme.color.fg}
          />
        </Pressable>
      ) : null}
    </View>
  );
}

/** Download and auto-download state folded into the playlist metadata row. */
export function PlaylistStatusGlyphs({
  theme,
  playlistId,
  tracks,
}: {
  theme: ThemeTokens;
  playlistId: string;
  tracks: TrackListItem[];
}) {
  const { status, downloaded, total } = usePlaylistDownload(tracks);
  const auto = useAutoDownload(playlistId);

  if (status !== "downloading" && status !== "downloaded" && !auto) {
    return null;
  }

  const a11y = [
    status === "downloaded"
      ? "Downloaded"
      : status === "downloading"
        ? `Downloading ${downloaded} of ${total}`
        : null,
    auto ? "Auto-download on" : null,
  ]
    .filter(Boolean)
    .join(", ");

  return (
    <View
      accessible
      accessibilityLabel={a11y}
      style={{ flexDirection: "row", alignItems: "center", gap: 5 }}
    >
      {status === "downloading" ? (
        <>
          <ActivityIndicator size="small" color={theme.color.fgMuted} />
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
            {downloaded}/{total}
          </Text>
        </>
      ) : status === "downloaded" ? (
        <SymbolView
          name="checkmark.circle.fill"
          size={12}
          tintColor={theme.color.accent}
        />
      ) : null}
      {auto ? (
        <SymbolView
          name="arrow.clockwise"
          size={11}
          weight="semibold"
          tintColor={theme.color.accent}
        />
      ) : null}
    </View>
  );
}

/** Secondary playlist actions grouped behind the overflow menu. */
export function PlaylistMoreMenu({
  theme,
  playlistId,
  playlistName,
  tracks,
  collaborative,
  canEdit,
  reorderActive,
  onEdit,
  onToggleReorder,
  canDelete,
  deletePending,
  onOpenCollaborators,
  onDelete,
  trigger,
}: {
  theme: ThemeTokens;
  playlistId: string;
  playlistName: string;
  tracks: TrackListItem[];
  collaborative: boolean;
  canEdit: boolean;
  reorderActive: boolean;
  onEdit: () => void;
  onToggleReorder: () => void;
  canDelete: boolean;
  deletePending: boolean;
  onOpenCollaborators: () => void;
  onDelete: () => void;
  trigger: ReactNode;
}) {
  const swiftUI = getOptionalSwiftUI();
  const { status, total, downloaded } = usePlaylistDownload(tracks);
  const autoEnabled = useAutoDownload(playlistId);
  const offline = useIsOffline();
  const hasTracks = tracks.length > 0;
  const isDownloaded = status === "downloaded";
  const isDownloading = status === "downloading";

  const onDownloadPress = useCallback(() => {
    if (isDownloading) return;
    if (offline && !isDownloaded) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert("You're offline", "Reconnect to download this playlist.");
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    if (isDownloaded) {
      Alert.alert(
        "Remove download?",
        "The offline copies for this playlist will be deleted from this device.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () =>
              void downloadStore.removePlaylist(
                playlistId,
                tracks.map((track) => track.id),
              ),
          },
        ],
      );
      return;
    }
    void downloadStore.downloadPlaylist(playlistId, tracks, { playlistName });
  }, [isDownloaded, isDownloading, offline, playlistId, playlistName, tracks]);

  const onAutoPress = useCallback(() => {
    if (offline && !autoEnabled) {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
      Alert.alert(
        "You're offline",
        "Reconnect to keep this playlist downloaded automatically.",
      );
      return;
    }
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    void autoDownloadStore.setEnabled(playlistId, !autoEnabled, {
      tracks,
      playlistName,
    });
  }, [autoEnabled, offline, playlistId, playlistName, tracks]);

  const downloadLabel = isDownloading
    ? `Downloading ${downloaded}/${total}…`
    : isDownloaded
      ? "Remove Download…"
      : "Download Playlist";
  const downloadDisabled =
    !hasTracks || isDownloading || (offline && !isDownloaded);
  const autoDisabled = !hasTracks || (offline && !autoEnabled);

  if (!swiftUI) {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="More playlist actions"
        hitSlop={10}
        onPress={() =>
          Alert.alert(playlistName, undefined, [
            ...(canEdit
              ? [
                  { text: "Edit Playlist", onPress: onEdit },
                  {
                    text: reorderActive ? "Done Reordering" : "Reorder Tracks",
                    onPress: onToggleReorder,
                  },
                ]
              : []),
            ...(hasTracks
              ? [{ text: downloadLabel, onPress: onDownloadPress }]
              : []),
            ...(hasTracks
              ? [
                  {
                    text: autoEnabled
                      ? "Turn Off Auto-Download"
                      : "Auto-Download New Tracks",
                    onPress: onAutoPress,
                  },
                ]
              : []),
            ...(collaborative
              ? [{ text: "Collaborators", onPress: onOpenCollaborators }]
              : []),
            ...(canDelete
              ? [
                  {
                    text: "Delete Playlist",
                    style: "destructive" as const,
                    onPress: onDelete,
                  },
                ]
              : []),
            { text: "Cancel", style: "cancel" as const },
          ])
        }
        style={({ pressed }) => ({ opacity: pressed ? 0.8 : 1 })}
      >
        {trigger}
      </Pressable>
    );
  }

  return (
    <swiftUI.Host matchContents colorScheme={theme.scheme}>
      <swiftUI.Menu
        label={<swiftUI.RNHostView matchContents>{trigger}</swiftUI.RNHostView>}
        modifiers={[
          swiftAccessibilityLabel("More playlist actions"),
          swiftButtonStyle("plain"),
          swiftControlSize("regular"),
        ]}
      >
        {canEdit ? (
          <>
            <swiftUI.Button
              label="Edit Playlist"
              systemImage="pencil"
              onPress={onEdit}
            />
            <swiftUI.Button
              label={reorderActive ? "Done Reordering" : "Reorder Tracks"}
              systemImage={reorderActive ? "checkmark" : "line.3.horizontal"}
              onPress={onToggleReorder}
            />
            <swiftUI.Divider />
          </>
        ) : null}
        <swiftUI.Button
          label={downloadLabel}
          systemImage={isDownloaded ? "minus.circle" : "arrow.down.circle"}
          modifiers={[swiftDisabled(downloadDisabled)]}
          onPress={onDownloadPress}
        />
        <swiftUI.Button
          label="Auto-Download New Tracks"
          systemImage={autoEnabled ? "checkmark" : "arrow.clockwise"}
          modifiers={[swiftDisabled(autoDisabled)]}
          onPress={onAutoPress}
        />
        {collaborative ? (
          <swiftUI.Button
            label="Collaborators"
            systemImage="person.2"
            onPress={onOpenCollaborators}
          />
        ) : null}
        {canDelete ? (
          <>
            <swiftUI.Divider />
            <swiftUI.Button
              label="Delete Playlist"
              systemImage="trash"
              role="destructive"
              modifiers={[swiftDisabled(deletePending)]}
              onPress={onDelete}
            />
          </>
        ) : null}
      </swiftUI.Menu>
    </swiftUI.Host>
  );
}
