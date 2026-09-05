import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  albumCoverUrl,
  api,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../../components/list-performance";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { TrackRow } from "../../../../components/track-row";
import { usePlayTrack } from "../../../../context/player";
import { qk } from "../../../../lib/query-keys";
import { usePlayQueue } from "../../../../lib/use-play-queue";
import { useTheme } from "../../../../theme/theme";
import { AlbumHeader, ALBUM_ART_SIZE } from "../../../../components/album-header";

export default function AlbumDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { id } = useLocalSearchParams<{ id: string }>();
  const play = usePlayTrack();
  const { me } = useAuth();
  const userId = me?.id;
  const isAdmin = me?.role === "admin";

  const albumQuery = useQuery({
    queryKey: qk.album(userId, id),
    queryFn: ({ signal }) => api.getAlbum(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const tracksQuery = useQuery({
    queryKey: qk.albumTracks(userId, id),
    queryFn: ({ signal }) => api.listAlbumTracks(id!, { signal }),
    enabled: !!userId && !!id,
  });

  // Local cache-bust for the cover <Image>. The album-edit screen bumps this
  // (via setQueryData) after replacing the artwork; the cover URL is otherwise
  // stable so expo-image would keep serving the old cached image.
  const coverBust =
    useQuery({
      queryKey: qk.albumCoverBust(id),
      queryFn: () => 0,
      enabled: !!id,
      staleTime: Infinity,
      gcTime: Infinity,
      initialData: 0,
    }).data ?? 0;

  const tracks = useMemo<TrackListItem[]>(
    () => tracksQuery.data ?? [],
    [tracksQuery.data],
  );
  const onTrackPress = usePlayQueue(tracks);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );

  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);

  const header = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    const requestSize = Math.max(
      1,
      Math.round(ALBUM_ART_SIZE * PixelRatio.get()),
    );
    const coverUri = album.has_cover
      ? `${albumCoverUrl(album.id, requestSize)}${coverBust ? `&v=${coverBust}` : ""}`
      : null;
    return (
      <AlbumHeader
        title={album.title}
        artist={album.artist_name}
        coverUri={coverUri}
        coverKey={coverUri ?? undefined}
        metadata={`${album.track_count} ${album.track_count === 1 ? "track" : "tracks"}${album.release_year ? ` · ${album.release_year}` : ""}`}
        onPlay={tracks.length > 0 ? () => play(tracks[0], tracks) : undefined}
      />
    );
  }, [albumQuery.data, coverBust, tracks, play]);

  const openEdit = useCallback(() => {
    if (!id) return;
    void Haptics.selectionAsync();
    router.push({
      pathname: "/(tabs)/(library)/albums/edit",
      params: { id },
    });
  }, [router, id]);

  if (albumQuery.isLoading || tracksQuery.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <ActivityIndicator color={theme.color.fgMuted} />
      </View>
    );
  }
  if (albumQuery.isError || !albumQuery.data) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <Text style={{ color: theme.color.fgMuted }}>
          Couldn&apos;t load album.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: albumQuery.data.title,
          headerLargeTitle: false,
          headerRight: isAdmin
            ? () => (
                <Pressable
                  onPress={openEdit}
                  accessibilityRole="button"
                  accessibilityLabel="Edit album"
                  hitSlop={8}
                  style={({ pressed }) => ({ opacity: pressed ? 0.5 : 1 })}
                >
                  <SymbolView
                    name="pencil"
                    size={20}
                    weight="semibold"
                    tintColor={theme.color.accent}
                  />
                </Pressable>
              )
            : undefined,
        }}
      />
      <FlashList
        {...TRACK_FLASH_LIST_PERFORMANCE_PROPS}
        {...dockScroll}
        data={tracks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        ListHeaderComponent={header}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{ paddingBottom: dockInset + 24 }}
      />
    </>
  );
}

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
