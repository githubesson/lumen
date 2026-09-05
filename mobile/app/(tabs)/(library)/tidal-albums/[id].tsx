import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  PixelRatio,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  api,
  resolveCoverUrl,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../../components/list-performance";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { TrackRow } from "../../../../components/track-row";
import { qk } from "../../../../lib/query-keys";
import { usePlayQueue } from "../../../../lib/use-play-queue";
import { useTheme } from "../../../../theme/theme";
import { AlbumHeader, ALBUM_ART_SIZE } from "../../../../components/album-header";

export default function TidalAlbumDetailScreen() {
  const theme = useTheme();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const albumQuery = useQuery({
    queryKey: qk.tidalAlbum(userId, id),
    queryFn: ({ signal }) => api.getTidalAlbum(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const tracks = useMemo<TrackListItem[]>(
    () => albumQuery.data?.tracks ?? [],
    [albumQuery.data?.tracks],
  );
  const onTrackPress = usePlayQueue(tracks);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );

  const keyExtractor = useCallback((track: TrackListItem) => track.id, []);

  const header = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    const requestSize = Math.max(
      1,
      Math.round(ALBUM_ART_SIZE * PixelRatio.get()),
    );
    const coverUri = album.cover_url ? resolveCoverUrl(album.cover_url) : null;
    return (
      <AlbumHeader
        title={album.title}
        artist={album.artist}
        coverUri={coverUri}
        coverKey={`${album.id}:${requestSize}`}
        metadata={`${album.track_count} ${album.track_count === 1 ? "track" : "tracks"}${album.release_year ? ` - ${album.release_year}` : ""}`}
        onPlay={tracks.length > 0 ? () => onTrackPress(tracks[0]) : undefined}
      />
    );
  }, [albumQuery.data, onTrackPress, tracks]);

  if (albumQuery.isLoading) {
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
          Couldn&apos;t load TIDAL album.
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
