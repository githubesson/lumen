import { useCallback, useMemo } from "react";
import { PixelRatio } from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import {
  api,
  playableTracks,
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
import {
  ALBUM_DOWNLOAD_REFRESH_MS,
  useAlbumDownloadAction,
} from "../../../../lib/album-download";
import { useTheme } from "../../../../theme/theme";
import { AlbumHeader, ALBUM_ART_SIZE } from "../../../../components/album-header";
import { EmptyState, retryAction } from "../../../../components/empty-state";

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
    // While an album download runs, refetch so saved tracks show up.
    refetchInterval: (query) =>
      query.state.data?.queued_count ? ALBUM_DOWNLOAD_REFRESH_MS : false,
  });

  const tracks = useMemo<TrackListItem[]>(
    () => albumQuery.data?.tracks ?? [],
    [albumQuery.data?.tracks],
  );
  const onTrackPress = usePlayQueue(tracks);
  const { refetch } = albumQuery;
  const refetchAlbum = useCallback(() => void refetch(), [refetch]);
  const downloadAction = useAlbumDownloadAction(
    albumQuery.data?.id,
    tracks,
    albumQuery.data?.queued_count ?? 0,
    refetchAlbum,
  );

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
        artist={album.artists?.join(", ") || album.artist}
        coverUri={coverUri}
        coverKey={`${album.id}:${requestSize}`}
        metadata={`${album.track_count} ${album.track_count === 1 ? "track" : "tracks"}${
          album.saved_count ? ` - ${album.saved_count} saved` : ""
        }${album.release_year ? ` - ${album.release_year}` : ""}`}
        onPlay={(() => {
          const first = playableTracks(tracks)[0];
          return first ? () => onTrackPress(first) : undefined;
        })()}
        secondaryAction={downloadAction}
      />
    );
  }, [albumQuery.data, onTrackPress, tracks, downloadAction]);

  if (albumQuery.isLoading) return <EmptyState fill loading />;
  if (albumQuery.isError || !albumQuery.data) {
    return (
      <EmptyState
        fill
        selectable
        message="Couldn't load TIDAL album."
        action={retryAction(albumQuery)}
      />
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
