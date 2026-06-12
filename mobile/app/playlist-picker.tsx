import { useCallback, useEffect, useMemo, useState } from "react";
import {
  ActivityIndicator,
  Alert,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  View,
} from "react-native";
import AsyncStorage from "@react-native-async-storage/async-storage";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useAuth, type Playlist } from "@music-library/core";
import { EmptyState } from "../components/empty-state";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../components/list-performance";
import { qk } from "../lib/query-keys";
import { useTheme } from "../theme/theme";

type SortMode = "recent" | "name" | "created";
type RowItem =
  | { type: "section"; id: string; title: string }
  | { type: "playlist"; id: string; playlist: Playlist };

const RECENT_PLAYLISTS_KEY = "mlib-recent-add-playlists";
const MAX_RECENT_PLAYLISTS = 6;

export default function PlaylistPickerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { trackId } = useLocalSearchParams<{
    trackId?: string;
    trackTitle?: string;
  }>();
  const { me } = useAuth();
  const userId = me?.id;
  const playlistsQueryKey = qk.playlists(userId);
  const [search, setSearch] = useState("");
  const [sortMode, setSortMode] = useState<SortMode>("recent");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const recentPlaylistsKey = `${RECENT_PLAYLISTS_KEY}:${userId ?? "guest"}`;

  useEffect(() => {
    let cancelled = false;
    if (!userId) {
      setRecentIds([]);
      return;
    }
    setRecentIds([]);
    void AsyncStorage.getItem(recentPlaylistsKey).then((raw) => {
      if (cancelled || !raw) return;
      try {
        const ids = JSON.parse(raw);
        if (Array.isArray(ids)) {
          setRecentIds(ids.filter((id): id is string => typeof id === "string"));
        }
      } catch {
        // Ignore malformed old state.
      }
    });
    return () => {
      cancelled = true;
    };
  }, [recentPlaylistsKey, userId]);

  const playlistsQuery = useQuery({
    queryKey: playlistsQueryKey,
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    enabled: !!userId,
  });

  const addMutation = useMutation({
    mutationFn: (playlist: Playlist) => {
      if (!trackId) throw new Error("Missing track id.");
      return api.addPlaylistTracks(playlist.id, [trackId]);
    },
    onSuccess: async (_data, playlist) => {
      const nextRecent = [
        playlist.id,
        ...recentIds.filter((id) => id !== playlist.id),
      ].slice(0, MAX_RECENT_PLAYLISTS);
      setRecentIds(nextRecent);
      await AsyncStorage.setItem(
        recentPlaylistsKey,
        JSON.stringify(nextRecent),
      );
      void queryClient.invalidateQueries({
        queryKey: qk.playlistTracks(userId, playlist.id),
      });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    },
    onError: (error) => {
      Alert.alert(
        "Couldn't add track",
        error instanceof Error ? error.message : "Please try again.",
      );
    },
  });

  const editablePlaylists = useMemo(
    () =>
      (playlistsQuery.data ?? []).filter(
        (playlist) =>
          !playlist.effective_role || playlist.effective_role !== "viewer",
      ),
    [playlistsQuery.data],
  );

  const filteredPlaylists = useMemo(() => {
    const query = search.trim().toLocaleLowerCase();
    const filtered = query
      ? editablePlaylists.filter((playlist) =>
          playlist.name.toLocaleLowerCase().includes(query),
        )
      : editablePlaylists;
    return sortPlaylists(filtered, sortMode);
  }, [editablePlaylists, search, sortMode]);

  const rows = useMemo<RowItem[]>(() => {
    if (playlistsQuery.isLoading || playlistsQuery.isError) return [];

    const byId = new Map(editablePlaylists.map((playlist) => [playlist.id, playlist]));
    const query = search.trim();
    const recent = query
      ? []
      : recentIds
          .map((id) => byId.get(id))
          .filter((playlist): playlist is Playlist => Boolean(playlist))
          .slice(0, 3);

    if (recent.length === 0 && filteredPlaylists.length === 0) return [];

    const nextRows: RowItem[] = [];
    if (recent.length > 0) {
      nextRows.push({ type: "section", id: "recent", title: "Recent" });
      for (const playlist of recent) {
        nextRows.push({
          type: "playlist",
          id: `recent:${playlist.id}`,
          playlist,
        });
      }
    }

    nextRows.push({
      type: "section",
      id: "all",
      title: query ? "Results" : "All Playlists",
    });
    for (const playlist of filteredPlaylists) {
      nextRows.push({
        type: "playlist",
        id: `all:${playlist.id}`,
        playlist,
      });
    }
    return nextRows;
  }, [
    editablePlaylists,
    filteredPlaylists,
    playlistsQuery.isError,
    playlistsQuery.isLoading,
    recentIds,
    search,
  ]);

  const close = useCallback(() => {
    void Haptics.selectionAsync();
    router.back();
  }, [router]);

  const selectPlaylist = useCallback(
    (playlist: Playlist) => {
      void Haptics.selectionAsync();
      addMutation.mutate(playlist);
    },
    [addMutation],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<RowItem>) => {
      if (item.type === "section") {
        return <SectionHeader title={item.title} />;
      }
      return (
        <PlaylistPickerRow
          playlist={item.playlist}
          disabled={addMutation.isPending}
          selected={addMutation.variables?.id === item.playlist.id}
          onPress={selectPlaylist}
        />
      );
    },
    [addMutation.isPending, addMutation.variables?.id, selectPlaylist],
  );

  const keyExtractor = useCallback((item: RowItem) => item.id, []);
  const itemType = useCallback((item: RowItem) => item.type, []);

  return (
    <>
      <FlashList
        {...TRACK_FLASH_LIST_PERFORMANCE_PROPS}
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={itemType}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{
          paddingTop: theme.space.sm,
          paddingBottom: theme.space.xl,
        }}
        refreshControl={
          <RefreshControl
            refreshing={playlistsQuery.isRefetching}
            onRefresh={() => void playlistsQuery.refetch()}
            tintColor={theme.color.fgMuted}
          />
        }
        ListEmptyComponent={
          playlistsQuery.isLoading ? (
            <EmptyState loading />
          ) : playlistsQuery.isError ? (
            <EmptyState selectable message="Couldn't load playlists." />
          ) : (
            <EmptyState
              message={
                search.trim()
                  ? "No matching playlists."
                  : "No editable playlists found."
              }
            />
          )
        }
      />

      <Stack.Screen.Title>Add to Playlist</Stack.Screen.Title>
      <Stack.SearchBar
        placeholder="Find Playlists"
        autoCapitalize="none"
        placement="stacked"
        hideWhenScrolling={false}
        hideNavigationBar={false}
        obscureBackground={false}
        onChangeText={(event) => setSearch(event.nativeEvent.text)}
        onCancelButtonPress={() => setSearch("")}
      />
      <Stack.Toolbar placement="left">
        <Stack.Toolbar.Button
          icon="xmark"
          accessibilityLabel="Close"
          onPress={close}
          separateBackground
        />
      </Stack.Toolbar>
      <Stack.Toolbar placement="right">
        <Stack.Toolbar.Menu
          icon="arrow.up.arrow.down"
          accessibilityLabel="Sort playlists"
          separateBackground
        >
          <Stack.Toolbar.MenuAction
            isOn={sortMode === "recent"}
            onPress={() => setSortMode("recent")}
          >
            Recently Updated
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            isOn={sortMode === "name"}
            onPress={() => setSortMode("name")}
          >
            Name
          </Stack.Toolbar.MenuAction>
          <Stack.Toolbar.MenuAction
            isOn={sortMode === "created"}
            onPress={() => setSortMode("created")}
          >
            Newest
          </Stack.Toolbar.MenuAction>
        </Stack.Toolbar.Menu>
      </Stack.Toolbar>
    </>
  );
}

function SectionHeader({ title }: { title: string }) {
  const theme = useTheme();
  return (
    <Text
      style={{
        color: theme.color.fg,
        fontSize: 20,
        fontWeight: "700",
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.lg,
        paddingBottom: theme.space.xs,
      }}
    >
      {title}
    </Text>
  );
}

function PlaylistPickerRow({
  playlist,
  disabled,
  selected,
  onPress,
}: {
  playlist: Playlist;
  disabled: boolean;
  selected: boolean;
  onPress: (playlist: Playlist) => void;
}) {
  const theme = useTheme();
  const collaborative = playlist.visibility === "collaborative";

  return (
    <Pressable
      disabled={disabled}
      onPress={() => onPress(playlist)}
      accessibilityRole="button"
      accessibilityLabel={`Add to ${playlist.name}`}
      style={({ pressed }) => [
        styles.row,
        {
          opacity: disabled && !selected ? 0.55 : 1,
          paddingHorizontal: theme.space.lg,
          gap: theme.space.md,
          backgroundColor: pressed ? theme.color.bgElev1 : "transparent",
        },
      ]}
    >
      <View
        style={[
          styles.art,
          {
            borderRadius: theme.radius.md,
            backgroundColor: collaborative
              ? theme.color.bgElev2
              : theme.color.bgElev1,
          },
        ]}
      >
        <SymbolView
          name={collaborative ? "person.2.fill" : "music.note.list"}
          size={24}
          tintColor={theme.color.fgMuted}
        />
      </View>
      <View
        style={[
          styles.rowBody,
          { borderBottomColor: theme.color.separator },
        ]}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ color: theme.color.fg, fontSize: 18, fontWeight: "500" }}
          >
            {playlist.name}
          </Text>
          {collaborative || playlist.effective_role ? (
            <Text
              numberOfLines={1}
              style={{ color: theme.color.fgMuted, fontSize: 13 }}
            >
              {collaborative ? "Collaborative" : "Private"}
              {playlist.effective_role && playlist.effective_role !== "owner"
                ? ` - ${playlist.effective_role}`
                : ""}
            </Text>
          ) : null}
        </View>
        {selected ? (
          <ActivityIndicator color={theme.color.fgMuted} />
        ) : collaborative ? (
          <SymbolView
            name="person.2.fill"
            size={18}
            tintColor={theme.color.fgMuted}
          />
        ) : null}
      </View>
    </Pressable>
  );
}

function sortPlaylists(playlists: Playlist[], sortMode: SortMode) {
  return [...playlists].sort((a, b) => {
    if (sortMode === "name") {
      return a.name.localeCompare(b.name, undefined, { sensitivity: "base" });
    }
    if (sortMode === "created") {
      return dateValue(b.created_at) - dateValue(a.created_at);
    }
    return dateValue(b.updated_at) - dateValue(a.updated_at);
  });
}

function dateValue(value?: string) {
  if (!value) return 0;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : 0;
}

const styles = StyleSheet.create({
  row: {
    minHeight: 74,
    flexDirection: "row",
    alignItems: "center",
  },
  art: {
    width: 56,
    height: 56,
    alignItems: "center",
    justifyContent: "center",
    borderCurve: "continuous",
    overflow: "hidden",
  },
  rowBody: {
    minHeight: 74,
    flex: 1,
    minWidth: 0,
    flexDirection: "row",
    alignItems: "center",
    borderBottomWidth: StyleSheet.hairlineWidth,
    gap: 12,
  },
});
