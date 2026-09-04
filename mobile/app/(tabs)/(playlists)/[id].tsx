import { memo, useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Pressable,
  StyleSheet,
  Text,
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
  PlaylistHero,
  PlaylistMoreMenu,
  PlaylistStatusGlyphs,
  PLAYLIST_CONTROL_SIZE as CONTROL_SIZE,
  SortMenuButton,
} from "../../../components/playlists/playlist-detail-header";
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
  useDownloadedPlaylistTracks,
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
      // Query data is the authoritative external playlist snapshot.
      // eslint-disable-next-line react-hooks/set-state-in-effect
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
    // Permission changes from the external playlist snapshot terminate a local
    // reorder session that is no longer authorized.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
  if (playlistQuery.isError || tracksQuery.isError || !playlist) {
    return <EmptyState fill selectable message="Couldn't load playlist."
      action={{ label: playlistQuery.isFetching || tracksQuery.isFetching ? "Retrying…" : "Try again", disabled: playlistQuery.isFetching || tracksQuery.isFetching,
        onPress: () => { void playlistQuery.refetch(); void tracksQuery.refetch(); } }} />;
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
