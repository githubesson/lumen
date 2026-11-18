import { useCallback, useMemo, useState } from "react";
import {
  PixelRatio,
  Pressable,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  ALBUM_DOWNLOAD_REFRESH_MS,
  albumArtists,
  albumArtUrl,
  albumCredits,
  api,
  displayText,
  formatTotalMs,
  libraryAlbumMetaParts,
  metaLine,
  playableTracks,
  startListPlayback,
  startShuffledListPlayback,
  useAuth,
  type Album,
  type TrackListItem,
} from "@music-library/core";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../../components/list-performance";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { AlbumTrackRow } from "../../../../components/album-track-row";
import {
  useCurrentTrack,
  useIsPlaying,
  usePlayerPlayback,
  usePlayTrack,
} from "../../../../context/player";
import { qk } from "../../../../lib/query-keys";
import { listPlaybackQueue, usePlayQueue } from "../../../../lib/use-play-queue";
import { useAlbumDownloadAction } from "../../../../lib/album-download";
import { albumTrackNumbers } from "../../../../lib/album-track-numbers";
import { useImageFailure } from "../../../../lib/use-image-failure";
import { useTheme } from "../../../../theme/theme";
import {
  AlbumHeader,
  AlbumTopScrim,
  albumScrollEdgeEffects,
  useAlbumCoverInset,
  useAlbumCoverSize,
  useAlbumHeroScroll,
} from "../../../../components/album-header";
import { EmptyState, retryAction } from "../../../../components/empty-state";
import { AlbumFooter } from "../../../../components/album-footer";
import { AlbumMoreBy } from "../../../../components/album-more-by";
import { useLibraryMoreBy } from "../../../../lib/album-more-by";

export default function AlbumDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const hero = useAlbumHeroScroll(dockScroll.onScroll);
  const coverSize = useAlbumCoverSize();
  const coverInset = useAlbumCoverInset();
  const { id } = useLocalSearchParams<{ id: string }>();
  const play = usePlayTrack();
  const { shuffle } = usePlayerPlayback();
  const currentId = useCurrentTrack()?.id;
  const isPlaying = useIsPlaying();
  const { me } = useAuth();
  const userId = me?.id;
  const isAdmin = me?.role === "admin";

  const albumQuery = useQuery({
    queryKey: qk.album(userId, id),
    queryFn: ({ signal }) => api.getAlbum(id!, { signal }),
    enabled: !!userId && !!id,
    // While an album download runs, refetch so saved tracks show up.
    refetchInterval: (query) =>
      query.state.data?.queued_count ? ALBUM_DOWNLOAD_REFRESH_MS : false,
  });
  const downloading = !!albumQuery.data?.queued_count;

  const tracksQuery = useQuery({
    queryKey: qk.albumTracks(userId, id),
    queryFn: ({ signal }) => api.listAlbumTracks(id!, { signal }),
    enabled: !!userId && !!id,
    refetchInterval: downloading ? ALBUM_DOWNLOAD_REFRESH_MS : false,
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
  const { refetch: refetchAlbum } = albumQuery;
  const { refetch: refetchTracks } = tracksQuery;
  const queryClient = useQueryClient();
  const onQueuedChanged = useCallback(
    (queued: number) => {
      queryClient.setQueryData<Album>(qk.album(userId, id), (album) =>
        album ? { ...album, queued_count: queued } : album,
      );
      void refetchAlbum();
      void refetchTracks();
    },
    [queryClient, userId, id, refetchAlbum, refetchTracks],
  );
  const downloadAction = useAlbumDownloadAction(
    albumQuery.data?.tidal_album_id,
    tracks,
    albumQuery.data?.queued_count ?? 0,
    onQueuedChanged,
  );

  const credits = useMemo(
    () => (albumQuery.data ? albumCredits(albumQuery.data) : []),
    [albumQuery.data],
  );
  const numbers = useMemo(() => albumTrackNumbers(tracks), [tracks]);
  const creditNames = useMemo(() => credits.map((credit) => credit.name), [credits]);
  const linkedArtist = credits.find((credit) => credit.artistId);
  const linkedArtistId = linkedArtist?.artistId;
  // "More by" asks the library's album artist, whom the credits leave out
  // when the copied TIDAL release names its artists differently.
  const album = albumQuery.data;
  const shelfArtist =
    linkedArtist ??
    (album?.artist_has_page && album.artist_id && album.artist_name
      ? { name: album.artist_name, artistId: album.artist_id }
      : undefined);
  const [nearEnd, setNearEnd] = useState(false);
  const moreBy = useLibraryMoreBy(shelfArtist?.artistId, id, nearEnd);
  const openArtist = useMemo(
    () =>
      linkedArtistId
        ? () =>
            router.push({
              pathname: "/(tabs)/artists/[id]",
              params: { id: linkedArtistId },
            })
        : undefined,
    [router, linkedArtistId],
  );
  const shelfArtistId = shelfArtist?.artistId;
  const openShelfArtist = useMemo(
    () =>
      shelfArtistId
        ? () =>
            router.push({
              pathname: "/(tabs)/artists/[id]",
              params: { id: shelfArtistId },
            })
        : undefined,
    [router, shelfArtistId],
  );

  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TrackListItem>) => (
      // On an iPad the rows line up with the centred cover.
      <View style={coverInset ? { marginHorizontal: coverInset } : undefined}>
        <AlbumTrackRow
          track={item}
          number={numbers[index] ?? index + 1}
          albumArtists={creditNames}
          current={item.id === currentId}
          playing={item.id === currentId && isPlaying}
          onPress={onTrackPress}
        />
      </View>
    ),
    [onTrackPress, numbers, creditNames, currentId, isPlaying, coverInset],
  );

  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);
  const rowState = useMemo(() => ({ currentId, isPlaying }), [currentId, isPlaying]);

  const coverUri = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    const requestSize = Math.max(1, Math.round(coverSize * PixelRatio.get()));
    return albumArtUrl(album, requestSize, coverBust);
  }, [albumQuery.data, coverSize, coverBust]);
  // A cover that fails to load shows the placeholder, with no scrim over it.
  const coverFailure = useImageFailure(coverUri);
  const shownCover = coverFailure.failed ? null : coverUri;

  const header = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    const playable = playableTracks(tracks).length;
    return (
      <AlbumHeader
        title={album.title}
        artist={albumArtists(album)}
        onOpenArtist={openArtist}
        coverUri={shownCover}
        coverKey={shownCover ?? undefined}
        onCoverError={coverFailure.onError}
        metadata={metaLine([
          ...libraryAlbumMetaParts(album),
          album.duration_ms > 0 ? formatTotalMs(Math.max(album.duration_ms, 60_000)) : "",
        ])}
        onPlay={
          playable > 0
            ? () => startListPlayback(play, listPlaybackQueue(tracks), shuffle)
            : undefined
        }
        onShuffle={
          playable > 1
            ? () => {
                void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
                startShuffledListPlayback(play, listPlaybackQueue(tracks));
              }
            : undefined
        }
        download={downloadAction}
        onTitleBottom={hero.onTitleBottom}
      />
    );
  }, [
    albumQuery.data,
    shownCover,
    coverFailure.onError,
    tracks,
    play,
    shuffle,
    downloadAction,
    openArtist,
    hero.onTitleBottom,
  ]);

  const footer = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    return (
      <View>
        <AlbumFooter
          releaseDate={album.release_date}
          releaseYear={album.release_year}
          trackCount={album.track_count}
          durationMs={album.duration_ms}
          copyright={album.copyright}
          inset={coverInset}
        />
        <AlbumMoreBy
          artist={displayText(shelfArtist?.name ?? "")}
          releases={moreBy}
          onOpenArtist={openShelfArtist}
          onOpenRelease={(release) =>
            router.push({ pathname: "/(tabs)/albums/[id]", params: { id: release.id } })
          }
          inset={coverInset}
        />
      </View>
    );
  }, [albumQuery.data, coverInset, shelfArtist?.name, moreBy, openShelfArtist, router]);

  const openEdit = useCallback(() => {
    if (!id) return;
    void Haptics.selectionAsync();
    router.push({
      pathname: "/(tabs)/albums/edit",
      params: { id },
    });
  }, [router, id]);

  if (albumQuery.isLoading || tracksQuery.isLoading) return <EmptyState fill loading />;
  if (albumQuery.isError || !albumQuery.data) {
    return (
      <EmptyState
        fill
        selectable
        message="Couldn't load album"
        action={retryAction(albumQuery, tracksQuery)}
      />
    );
  }

  return (
    <>
      <Stack.Screen
        options={{
          title: displayText(albumQuery.data.title),
          headerLargeTitle: false,
          // The list sits under the bar from the first point of scroll, so
          // the scrolled-under hairline would cross the cover.
          headerShadowVisible: false,
          scrollEdgeEffects: albumScrollEdgeEffects(hero.titleShown, hero.edgeNudge),
          // The hero carries the title until it scrolls under the bar.
          headerTitleStyle: {
            color: hero.titleShown ? theme.color.fg : "transparent",
          },
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
        onScroll={hero.onScroll}
        scrollEventThrottle={hero.scrollEventThrottle}
        onLayout={hero.onListLayout}
        // "More by" needs the artist's track listing: ask once near the end.
        onEndReached={() => setNearEnd(true)}
        onEndReachedThreshold={1}
        data={tracks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={rowState}
        ListHeaderComponent={header}
        ListFooterComponent={footer}
        // The cover runs up under the status bar and the nav bar.
        contentInsetAdjustmentBehavior="never"
        automaticallyAdjustsScrollIndicatorInsets={false}
        scrollIndicatorInsets={{ top: hero.headerHeight, bottom: hero.bottomInset + dockInset }}
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{ paddingBottom: hero.bottomInset + dockInset + 24 }}
      />
      <AlbumTopScrim overCover={hero.overCover} hasCover={!!shownCover} />
    </>
  );
}
