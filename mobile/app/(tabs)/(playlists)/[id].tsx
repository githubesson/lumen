import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import ReorderableList, {
  reorderItems,
  useIsActive,
  useReorderableDrag,
  type ReorderableListReorderEvent,
} from "react-native-reorderable-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  SORT_DEFAULT_ASC,
  api,
  compareSortableTracks,
  playlistEntryToTrack as entryToTrack,
  useAuth,
  type Playlist,
  type PlaylistTrackEntry,
  type SortKey,
  type TrackListItem,
} from "@music-library/core";
import { CoverArt } from "../../../components/cover-art";
import { EmptyState } from "../../../components/empty-state";
import {
  getOptionalSwiftUI,
  swiftAccessibilityLabel,
  swiftButtonStyle,
  swiftControlSize,
  swiftDisabled,
} from "../../../components/optional-swift-ui";
import {
  TRACK_FLASH_LIST_PERFORMANCE_PROPS,
  TRACK_LIST_PERFORMANCE_PROPS,
} from "../../../components/list-performance";
import { usePlayTrack } from "../../../context/player";
import {
  useBottomDockInset,
  useDockControls,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { TrackActionsContextMenu } from "../../../components/track-actions-menu";
import { qk } from "../../../lib/query-keys";
import { usePlayQueue } from "../../../lib/use-play-queue";
import {
  autoDownloadStore,
  downloadStore,
  useAutoDownload,
  useDownloadedPlaylistTracks,
  usePlaylistDownload,
} from "../../../lib/downloads";
import {
  useIsOffline,
  useTrackUnavailableOffline,
} from "../../../lib/offline-mode";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

const TRACK_ART_SIZE = 40;
const noop = () => {};

type PlaylistTrackRowModel = {
  key: string;
  entry: PlaylistTrackEntry;
  track: TrackListItem;
};

// ── Local sorting ────────────────────────────────────────────────────────────
// Display-only: never touches the saved playlist order on the server.
//
// The comparator, the emoji-stripped collation key and the default directions
// live in `core/src/track-sort.ts` — the web playlist screen had an identical
// copy. Only the option list stays here: it is menu-shaped and worded for a
// phone context menu ("Custom" rather than the desktop's "Custom order").

const SORT_OPTIONS: { key: SortKey; label: string }[] = [
  { key: "custom", label: "Custom" },
  { key: "title", label: "Title" },
  { key: "duration", label: "Length" },
  { key: "plays", label: "Plays" },
];

function compareModels(
  a: PlaylistTrackRowModel,
  b: PlaylistTrackRowModel,
  key: SortKey,
): number {
  return compareSortableTracks(a.entry, b.entry, key);
}

export default function PlaylistDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const play = usePlayTrack();
  const headerHeight = useHeaderHeight();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { expand: expandDock } = useDockControls();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const userId = me?.id;
  const playlistQueryKey = qk.playlist(userId, id);
  const playlistTracksQueryKey = qk.playlistTracks(userId, id);
  const playlistsQueryKey = qk.playlists(userId);

  const playlistQuery = useQuery({
    queryKey: playlistQueryKey,
    queryFn: ({ signal }) => api.getPlaylist(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const tracksQuery = useQuery({
    queryKey: playlistTracksQueryKey,
    queryFn: ({ signal }) => api.listPlaylistTracks(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const offline = useIsOffline();
  const downloadedTracks = useDownloadedPlaylistTracks(id ?? "");
  // The playlists list is persisted and is where navigation comes from, so
  // its cache almost always knows this playlist's name/visibility even when
  // the detail query has never resolved (offline with no cached detail).
  const playlistFromList = useMemo(
    () =>
      queryClient
        .getQueryData<Playlist[]>(qk.playlists(userId))
        ?.find((p) => p.id === id),
    [queryClient, userId, id],
  );
  const playlist = playlistQuery.data ?? playlistFromList;

  // Local copy of tracks so drag-reorder updates feel instant; we commit the
  // order via `api.reorderPlaylist` and invalidate on success.
  const [localTracks, setLocalTracks] = useState<PlaylistTrackEntry[]>([]);
  const [reorderMode, setReorderMode] = useState(false);
  const [sortKey, setSortKey] = useState<SortKey>("custom");
  const [sortAsc, setSortAsc] = useState(true);
  useEffect(() => {
    if (tracksQuery.data) {
      setLocalTracks(tracksQuery.data.tracks);
      // Fresh server data is the cheapest moment to backfill offline
      // snapshots onto download records that predate them.
      downloadStore.noteTracks(tracksQuery.data.tracks.map(entryToTrack));
      return;
    }
    // No cached track list (evicted or never fetched while online): fall
    // back to the downloaded subset so stored tracks stay browsable and
    // playable offline — a partially downloaded playlist shows its parts.
    if (offline) {
      setLocalTracks(downloadedTracks.map(trackToEntry));
    }
  }, [tracksQuery.data, offline, downloadedTracks]);

  const reorderMutation = useMutation({
    mutationFn: (trackIds: string[]) => api.reorderPlaylist(id!, trackIds),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: playlistTracksQueryKey,
      }),
  });

  const removeMutation = useMutation({
    mutationFn: (position: number) => api.removePlaylistTrack(id!, position),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: playlistTracksQueryKey,
      }),
  });

  const deleteMutation = useMutation({
    mutationFn: () => api.deletePlaylist(id!),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: playlistsQueryKey });
      router.back();
    },
  });

  const role = playlist?.effective_role;
  // Editing and deleting need the server's own data: reorder positions must
  // match the backend's list, and the offline fallback is a downloaded
  // subset in local order.
  const canEdit =
    (!role || role === "owner" || role === "editor") && !!tracksQuery.data;
  const canDelete = (!role || role === "owner") && !!playlistQuery.data;
  const showReorderMode = canEdit && reorderMode;

  useEffect(() => {
    if (!canEdit && reorderMode) setReorderMode(false);
  }, [canEdit, reorderMode]);

  const rowModels = useMemo<PlaylistTrackRowModel[]>(
    () =>
      localTracks.map((entry) => ({
        key: playlistTrackKey(entry),
        entry,
        track: entryToTrack(entry),
      })),
    [localTracks],
  );
  // What the list actually shows; the play queue follows this order too.
  const displayModels = useMemo<PlaylistTrackRowModel[]>(() => {
    if (sortKey === "custom") return rowModels;
    const sorted = [...rowModels].sort((a, b) => compareModels(a, b, sortKey));
    return sortAsc ? sorted : sorted.reverse();
  }, [rowModels, sortKey, sortAsc]);
  const tracks = useMemo<TrackListItem[]>(
    () => displayModels.map((model) => model.track),
    [displayModels],
  );
  const onTrackPress = usePlayQueue(tracks);

  // Fresh query data is the earliest signal that entries were added, so catch
  // up here too rather than waiting for the next foreground or reconnect.
  // No-ops unless this playlist is opted in and something is actually missing.
  useEffect(() => {
    if (!id || tracks.length === 0) return;
    void autoDownloadStore.syncWithTracks(id, tracks, {
      playlistName: playlist?.name,
    });
  }, [id, tracks, playlist?.name]);

  const onSelectSort = useCallback((key: SortKey) => {
    void Haptics.selectionAsync();
    setSortKey((prevKey) => {
      if (prevKey !== key) setSortAsc(SORT_DEFAULT_ASC[key]);
      return key;
    });
  }, []);

  const onToggleSortDirection = useCallback(() => {
    setSortAsc((asc) => !asc);
  }, []);

  // Shuffle is queue-level: reorder a copy of the visible tracks and start
  // from the new head, leaving the saved playlist order untouched.
  const onShuffle = useCallback(() => {
    if (tracks.length === 0) return;
    void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    const shuffled = [...tracks];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    play(shuffled[0], shuffled);
  }, [tracks, play]);

  const onToggleReorder = useCallback(() => {
    void Haptics.selectionAsync();
    // The drag list isn't wired to the dock, so pin it to the predictable
    // expanded state while reordering.
    expandDock();
    // Drag indices map to the saved order, so a local sort can't stay active
    // while reordering.
    setSortKey("custom");
    setReorderMode((value) => !value);
  }, [expandDock]);

  const onReorder = useCallback(
    ({ from, to }: ReorderableListReorderEvent) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
      const previous = localTracks;
      const next = reorderItems(localTracks, from, to);
      setLocalTracks(next);
      reorderMutation.mutate(
        next.map((t) => t.track_id),
        {
          // Restore the pre-drag order on failure: the sync effect only
          // re-runs when the query data changes, so without this a failed
          // reorder would leave the UI diverged from the server order.
          onError: (error) => {
            setLocalTracks(previous);
            Alert.alert(
              "Couldn't reorder tracks",
              error instanceof Error ? error.message : "Please try again.",
            );
          },
        },
      );
    },
    [localTracks, reorderMutation],
  );

  const onRemove = useCallback(
    (position: number) => {
      void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
      // Optimistic local remove; mutation invalidates on success.
      const previous = localTracks;
      setLocalTracks((prev) => prev.filter((t) => t.position !== position));
      removeMutation.mutate(position, {
        onError: (error) => {
          setLocalTracks(previous);
          Alert.alert(
            "Couldn't remove track",
            error instanceof Error ? error.message : "Please try again.",
          );
        },
      });
    },
    [localTracks, removeMutation],
  );

  const onDelete = () => {
    Alert.alert(
      "Delete playlist?",
      "This can't be undone. Your library tracks won't be affected.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Delete",
          style: "destructive",
          onPress: () => deleteMutation.mutate(),
        },
      ],
    );
  };

  const header = useMemo(() => {
    const p = playlist;
    if (!p) return null;
    return (
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.lg,
          gap: theme.space.md,
        }}
      >
        <PlaylistHero theme={theme} tracks={tracks} />
        <View style={{ gap: 4, alignItems: "center" }}>
          <Text
            selectable
            style={{
              color: theme.color.fg,
              fontSize: 24,
              fontWeight: "700",
              letterSpacing: -0.2,
              textAlign: "center",
            }}
          >
            {p.name}
          </Text>
          {p.description ? (
            <Text
              selectable
              style={{
                color: theme.color.fgMuted,
                fontSize: 15,
                textAlign: "center",
              }}
            >
              {p.description}
            </Text>
          ) : null}
          <View
            style={{
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 6,
            }}
          >
            <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
              {tracks.length} {tracks.length === 1 ? "track" : "tracks"}
              {p.visibility === "collaborative" ? " · Collaborative" : ""}
            </Text>
            <PlaylistStatusGlyphs
              theme={theme}
              playlistId={p.id}
              tracks={tracks}
            />
          </View>
        </View>
        <View
          style={{
            flexDirection: "row",
            alignItems: "center",
            justifyContent: "center",
            gap: 12,
          }}
        >
          {tracks.length > 1 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Shuffle play"
              onPress={onShuffle}
              style={({ pressed }) => ({
                height: CONTROL_SIZE,
                width: CONTROL_SIZE,
                alignItems: "center",
                justifyContent: "center",
                backgroundColor: theme.color.bgElev1,
                borderRadius: CONTROL_SIZE / 2,
                opacity: pressed ? 0.8 : 1,
                borderCurve: "continuous",
              })}
            >
              <SymbolView name="shuffle" size={16} tintColor={theme.color.fg} />
            </Pressable>
          ) : null}
          {tracks.length > 0 ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Play playlist"
              onPress={() => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                play(tracks[0], tracks);
              }}
              style={({ pressed }) => ({
                flex: 1,
                flexDirection: "row",
                alignItems: "center",
                justifyContent: "center",
                gap: 8,
                height: CONTROL_SIZE,
                backgroundColor: theme.color.accent,
                borderRadius: CONTROL_SIZE / 2,
                opacity: pressed ? 0.85 : 1,
                borderCurve: "continuous",
              })}
            >
              <SymbolView
                name="play.fill"
                size={15}
                tintColor={theme.color.onAccent}
              />
              <Text
                style={{
                  color: theme.color.onAccent,
                  fontWeight: "600",
                  fontSize: 16,
                }}
              >
                Play
              </Text>
            </Pressable>
          ) : null}
          {tracks.length > 1 ? (
            <SortMenuButton
              theme={theme}
              sortKey={sortKey}
              sortAsc={sortAsc}
              onSelect={onSelectSort}
              onToggleDirection={onToggleSortDirection}
            />
          ) : null}
        </View>
      </View>
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    playlist,
    tracks,
    theme,
    deleteMutation.isPending,
    canDelete,
    play,
    router,
    sortKey,
    sortAsc,
    onSelectSort,
    onToggleSortDirection,
  ]);

  const keyExtractor = useCallback(
    (item: PlaylistTrackRowModel) => item.key,
    [],
  );

  const renderDraggableItem = useCallback(
    ({ item }: { item: PlaylistTrackRowModel }) => (
      <DraggablePlaylistRow
        model={item}
        canEdit={canEdit}
        theme={theme}
        onPress={onTrackPress}
        onRemove={onRemove}
      />
    ),
    [canEdit, theme, onTrackPress, onRemove],
  );

  const renderReadOnlyItem = useCallback(
    ({ item }: ListRenderItemInfo<PlaylistTrackRowModel>) => (
      <PlaylistTrackRow
        entry={item.entry}
        track={item.track}
        canEdit={false}
        theme={theme}
        onPress={onTrackPress}
        onRemove={noop}
      />
    ),
    [theme, onTrackPress],
  );

  if (playlistQuery.isLoading || tracksQuery.isLoading) {
    return <EmptyState fill loading />;
  }
  if (playlistQuery.isError || !playlist) {
    return <EmptyState fill selectable message="Couldn't load playlist." />;
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: playlist.name,
          headerLargeTitle: false,
          headerRight: () => (
            <PlaylistMoreMenu
              theme={theme}
              playlistId={playlist.id}
              playlistName={playlist.name}
              tracks={tracks}
              collaborative={playlist.visibility === "collaborative"}
              canEdit={canEdit}
              reorderActive={showReorderMode}
              onEdit={() =>
                router.push({
                  pathname: "/(tabs)/(playlists)/edit/[id]",
                  params: { id: playlist.id },
                })
              }
              onToggleReorder={onToggleReorder}
              canDelete={canDelete}
              deletePending={deleteMutation.isPending}
              onOpenCollaborators={() =>
                router.push({
                  pathname: "/(tabs)/(playlists)/collaborators/[id]",
                  params: { id: playlist.id },
                })
              }
              onDelete={onDelete}
              trigger={
                <View style={{ padding: 4 }}>
                  <SymbolView
                    name="ellipsis"
                    size={17}
                    weight="semibold"
                    tintColor={theme.color.fg}
                  />
                </View>
              }
            />
          ),
        }}
      />
      {showReorderMode ? (
        <ReorderableList<PlaylistTrackRowModel>
          {...TRACK_LIST_PERFORMANCE_PROPS}
          data={rowModels}
          onReorder={onReorder}
          keyExtractor={keyExtractor}
          renderItem={renderDraggableItem}
          ListHeaderComponent={header}
          // No automatic inset here: the drag math reads the raw scroll
          // offset, and the nav-bar inset adjustment skews it — grabbing a
          // row then jump-scrolled it to the top and dragged with an offset.
          // Pad the transparent header's height in by hand instead.
          style={{ flex: 1, backgroundColor: theme.color.bg }}
          contentContainerStyle={{
            paddingTop: headerHeight,
            paddingBottom: dockInset + 24,
          }}
          scrollIndicatorInsets={{ top: headerHeight, bottom: dockInset }}
          ListEmptyComponent={<PlaylistEmptyState />}
        />
      ) : (
        <FlashList
          {...TRACK_FLASH_LIST_PERFORMANCE_PROPS}
          {...dockScroll}
          data={displayModels}
          renderItem={renderReadOnlyItem}
          keyExtractor={keyExtractor}
          ListHeaderComponent={header}
          contentInsetAdjustmentBehavior="automatic"
          style={{ backgroundColor: theme.color.bg }}
          contentContainerStyle={{ paddingBottom: dockInset + 24 }}
          ListEmptyComponent={<PlaylistEmptyState />}
        />
      )}
    </>
  );
}

const SORT_MENU_SYMBOLS: Record<SortKey, string> = {
  custom: "line.3.horizontal",
  title: "textformat",
  duration: "clock",
  plays: "play.circle",
};

/** Diameter of the header's circular controls and the Play capsule height. */
const CONTROL_SIZE = 50;

/**
 * Large centered artwork for the playlist hero: a 2×2 collage of the first
 * distinct album covers (Apple Music style), a single cover when only one
 * album is represented, or a placeholder glyph for coverless/empty lists.
 */
function PlaylistHero({
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

/**
 * Dropdown for the local sort plus a standalone direction toggle. The menu is
 * a native SwiftUI one when the ExpoUI binary is present (matching the share
 * screen's menus), a plain alert picker otherwise.
 */
function SortMenuButton({
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
        height: CONTROL_SIZE,
        width: CONTROL_SIZE,
        alignItems: "center",
        justifyContent: "center",
        backgroundColor: theme.color.bgElev1,
        borderRadius: CONTROL_SIZE / 2,
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
        {SORT_OPTIONS.map((o) => (
          <swiftUI.Button
            key={o.key}
            label={o.label}
            systemImage={
              o.key === sortKey ? "checkmark" : SORT_MENU_SYMBOLS[o.key]
            }
            onPress={() => onSelect(o.key)}
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
          ...SORT_OPTIONS.map((o) => ({
            text: o.label,
            onPress: () => onSelect(o.key),
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
            height: CONTROL_SIZE,
            width: CONTROL_SIZE,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.color.bgElev1,
            borderRadius: CONTROL_SIZE / 2,
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

/**
 * Offline state folded into the header meta line: a live progress readout
 * while a batch download runs, a check once every track is stored, and a
 * marker while the playlist is armed for auto-download. Pure status — the
 * actions behind it live in {@link PlaylistMoreMenu}.
 */
function PlaylistStatusGlyphs({
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

/**
 * Overflow menu for the secondary playlist actions (offline download,
 * auto-download, collaborators, delete) so the header can stay at
 * Play + Sort + ⋯. Uses the native SwiftUI menu when the ExpoUI binary is
 * present (matching the sort menu), a stacked alert picker otherwise.
 */
function PlaylistMoreMenu({
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
  /** Menu affordance rendered inside the trigger (nav-bar icon or pill). */
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
    // Starting a download needs the network; removing one is local-only and
    // must keep working offline.
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
    // Turning it on needs the network for the initial catch-up sync; turning
    // it off is a local flag change and stays available offline.
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
  // Menu form of the download toggle's disabled states.
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
          systemImage={
            isDownloaded ? "minus.circle" : "arrow.down.circle"
          }
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

/**
 * Reorder-mode cell. `useReorderableDrag`/`useIsActive` read the cell context
 * that ReorderableList provides per item, so they have to live in a component
 * rendered by `renderItem` rather than in the screen.
 */
function DraggablePlaylistRow({
  model,
  canEdit,
  theme,
  onPress,
  onRemove,
}: {
  model: PlaylistTrackRowModel;
  canEdit: boolean;
  theme: ThemeTokens;
  onPress: (track: TrackListItem) => void;
  onRemove: (position: number) => void;
}) {
  const drag = useReorderableDrag();
  const isActive = useIsActive();
  return (
    <PlaylistTrackRow
      entry={model.entry}
      track={model.track}
      drag={drag}
      isActive={isActive}
      canEdit={canEdit}
      theme={theme}
      onPress={onPress}
      onRemove={onRemove}
    />
  );
}

const PlaylistTrackRow = memo(function PlaylistTrackRow({
  entry,
  track,
  drag,
  isActive,
  canEdit,
  theme,
  onPress,
  onRemove,
}: {
  entry: PlaylistTrackEntry;
  track: TrackListItem;
  drag?: () => void;
  isActive?: boolean;
  canEdit: boolean;
  theme: ThemeTokens;
  onPress: (track: TrackListItem) => void;
  onRemove: (position: number) => void;
}) {
  const canReorder = canEdit && !!drag;
  const unavailable = useTrackUnavailableOffline(track.id);
  const handlePress = useCallback(() => onPress(track), [onPress, track]);
  const handleRemove = useCallback(
    () => onRemove(entry.position),
    [entry.position, onRemove],
  );

  const row = (
    <Pressable
      onPress={handlePress}
      accessibilityRole="button"
      accessibilityLabel={
        track.artist ? `${track.title} by ${track.artist}` : track.title
      }
      style={({ pressed }) => [
        styles.row,
        {
          height: theme.row.height,
          paddingLeft: theme.space.lg,
          paddingRight: theme.space.sm,
          gap: theme.space.md,
          backgroundColor:
            pressed || isActive ? theme.color.bgElev1 : "transparent",
        },
        unavailable ? { opacity: 0.4 } : null,
      ]}
    >
      <CoverArt
        track={track}
        size={TRACK_ART_SIZE}
        transitionMs={0}
        priority="low"
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            fontSize: 16,
            fontWeight: "500",
            color: theme.color.fg,
          }}
        >
          {track.title}
        </Text>
        {track.artist ? (
          <Text
            numberOfLines={1}
            style={{ fontSize: 13, color: theme.color.fgMuted }}
          >
            {track.artist}
          </Text>
        ) : null}
      </View>
      {canEdit ? (
        <>
          <Pressable
            onPress={handleRemove}
            hitSlop={8}
            style={{ padding: 8 }}
            accessibilityRole="button"
            accessibilityLabel={`Remove ${track.title}`}
          >
            <SymbolView
              name="minus.circle.fill"
              size={20}
              tintColor={theme.color.danger}
            />
          </Pressable>
          {canReorder ? (
            <Pressable
              onPressIn={drag}
              hitSlop={8}
              style={{ padding: 8 }}
              accessibilityRole="button"
              accessibilityLabel={`Drag to reorder ${track.title}`}
            >
              <SymbolView
                name="line.3.horizontal"
                size={18}
                tintColor={theme.color.fgMuted}
              />
            </Pressable>
          ) : null}
        </>
      ) : null}
    </Pressable>
  );

  // No context menu while reordering: long-press fights the drag gesture, and
  // the SwiftUI hosting view it wraps rows in corrupts (stale solid-color
  // layers, dropped artwork) when Fabric moves cells around during a reorder.
  if (canReorder) return row;
  return <TrackActionsContextMenu track={track}>{row}</TrackActionsContextMenu>;
});

function PlaylistEmptyState() {
  return (
    <EmptyState
      message="No tracks yet. Add some from the library."
      style={{ paddingVertical: 48 }}
    />
  );
}

/** Inverse of {@link entryToTrack} for offline fallback rows built from
 *  download snapshots; `position` is just the render index. */
function trackToEntry(t: TrackListItem, position: number): PlaylistTrackEntry {
  return {
    position,
    track_id: t.id,
    db_track_id: t.db_track_id,
    source: t.source,
    source_id: t.source_id,
    source_album_id: t.source_album_id,
    title: t.title,
    album_id: t.album_id,
    album_title: t.album_title,
    track_no: t.track_no,
    duration_ms: t.duration_ms,
    artist: t.artist,
    has_cover: t.has_cover,
    cover_url: t.cover_url,
    added_at: "",
  };
}

function playlistTrackKey(e: PlaylistTrackEntry): string {
  return [
    e.track_id,
    e.added_at,
    e.added_by_id ?? "",
    e.added_by ?? "",
  ].join(":");
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    alignItems: "center",
  },
});
