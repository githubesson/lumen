import { useCallback, useMemo } from "react";
import { PixelRatio, View } from "react-native";
import { useHeaderHeight } from "expo-router/react-navigation";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import {
  keepPreviousData,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  ALBUM_DOWNLOAD_REFRESH_MS,
  albumArtists,
  albumArtUrl,
  api,
  displayText,
  formatTotalMs,
  metaLine,
  playableTracks,
  startListPlayback,
  startShuffledListPlayback,
  tidalAlbumCredits,
  tidalAlbumMetaParts,
  useAuth,
  type TidalAlbum,
  type TrackListItem,
} from "@music-library/core";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../../components/list-performance";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { ReleaseVersionPicker } from "../../../../components/library/release-version-picker";
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
import { useReleaseVersions } from "../../../../lib/release-versions";
import { useTheme } from "../../../../theme/theme";
import {
  AlbumHeader,
  AlbumStatusBar,
  useAlbumCoverSize,
  useAlbumHeroScroll,
} from "../../../../components/album-header";
import { EmptyState, retryAction } from "../../../../components/empty-state";

export default function TidalAlbumDetailScreen() {
  const theme = useTheme();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const hero = useAlbumHeroScroll(dockScroll.onScroll);
  const coverSize = useAlbumCoverSize();
  const headerHeight = useHeaderHeight();
  const router = useRouter();
  // `artist`: the TIDAL artist the album was opened from, whose releases list
  // its versions. Without one, the album's own artist is asked once it loads.
  const { id, artist } = useLocalSearchParams<{ id: string; artist?: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const albumQuery = useQuery({
    queryKey: qk.tidalAlbum(userId, id),
    queryFn: ({ signal }) => api.getTidalAlbum(id!, { signal }),
    enabled: !!userId && !!id,
    // A version swaps the id in place, and the page stays up until the next
    // version has loaded.
    placeholderData: keepPreviousData,
    // While an album download runs, refetch so saved tracks show up.
    refetchInterval: (query) =>
      query.state.data?.queued_count ? ALBUM_DOWNLOAD_REFRESH_MS : false,
  });

  const tracks = useMemo<TrackListItem[]>(
    () => albumQuery.data?.tracks ?? [],
    [albumQuery.data?.tracks],
  );
  const onTrackPress = usePlayQueue(tracks);
  const switching = albumQuery.isPlaceholderData;
  const versionsArtist = artist || albumQuery.data?.artist_id || undefined;
  const versions = useReleaseVersions(versionsArtist, id);
  const queryClient = useQueryClient();
  // Like a tab: picking a version replaces this page rather than pushing one.
  // The artist listing the versions goes along, so the next version's page
  // has them from its first frame even when this one only learned it on load.
  // A version that failed earlier starts over, so its load isn't taken for a
  // retry of the failure (see `failed`).
  const versionPicker = useMemo(
    () =>
      versions && id && versionsArtist ? (
        <ReleaseVersionPicker
          versions={versions}
          current={id}
          onPick={(version) => {
            const queryKey = qk.tidalAlbum(userId, version);
            const state = queryClient.getQueryState(queryKey);
            if (state?.status === "error" && state.data === undefined) {
              queryClient.removeQueries({ queryKey, exact: true });
            }
            router.setParams({ id: version, artist: versionsArtist });
          }}
        />
      ) : undefined,
    [versions, id, versionsArtist, router, queryClient, userId],
  );
  const play = usePlayTrack();
  const { shuffle } = usePlayerPlayback();
  const currentId = useCurrentTrack()?.id;
  const isPlaying = useIsPlaying();
  const { refetch } = albumQuery;
  const onQueuedChanged = useCallback(
    (queued: number) => {
      queryClient.setQueryData<TidalAlbum>(qk.tidalAlbum(userId, id), (album) =>
        album ? { ...album, queued_count: queued } : album,
      );
      void refetch();
    },
    [queryClient, userId, id, refetch],
  );
  const downloadAction = useAlbumDownloadAction(
    albumQuery.data?.id,
    tracks,
    albumQuery.data?.queued_count ?? 0,
    onQueuedChanged,
  );

  const credits = useMemo(
    () => (albumQuery.data ? tidalAlbumCredits(albumQuery.data) : []),
    [albumQuery.data],
  );
  const creditNames = useMemo(() => credits.map((credit) => credit.name), [credits]);
  const linkedArtistId = credits.find((credit) => credit.tidalArtistId)?.tidalArtistId;

  // The previous version's tracks stay dimmed, out of reach of touch and
  // VoiceOver, until the picked one loads.
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TrackListItem>) => (
      <View
        pointerEvents={switching ? "none" : "auto"}
        accessibilityElementsHidden={switching}
        importantForAccessibility={switching ? "no-hide-descendants" : "auto"}
        style={switching ? { opacity: 0.4 } : undefined}
      >
        <AlbumTrackRow
          track={item}
          number={index + 1}
          albumArtists={creditNames}
          current={item.id === currentId}
          playing={isPlaying}
          onPress={onTrackPress}
        />
      </View>
    ),
    [onTrackPress, switching, creditNames, currentId, isPlaying],
  );

  const keyExtractor = useCallback((track: TrackListItem) => track.id, []);
  const rowState = useMemo(
    () => ({ switching, currentId, isPlaying }),
    [switching, currentId, isPlaying],
  );

  const header = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    const requestSize = Math.max(1, Math.round(coverSize * PixelRatio.get()));
    const coverUri = albumArtUrl({ ...album, source: "tidal" }, requestSize);
    const playable = playableTracks(tracks).length;
    return (
      <AlbumHeader
        title={album.title}
        artist={albumArtists(album)}
        onOpenArtist={
          linkedArtistId
            ? () =>
                router.push({
                  pathname: "/(tabs)/tidal-artists/[id]",
                  params: { id: linkedArtistId },
                })
            : undefined
        }
        coverUri={coverUri}
        coverKey={`${album.id}:${requestSize}`}
        metadata={metaLine([
          ...tidalAlbumMetaParts(album),
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
        versions={versionPicker}
        pending={switching}
        onTitleBottom={hero.onTitleBottom}
      />
    );
  }, [
    albumQuery.data,
    coverSize,
    play,
    shuffle,
    tracks,
    downloadAction,
    versionPicker,
    switching,
    linkedArtistId,
    router,
    hero.onTitleBottom,
  ]);

  if (albumQuery.isLoading) return <EmptyState fill loading />;
  // A version that can't load (failed, or waiting offline) shows the error,
  // with the picker kept above it so the other versions stay a tap away.
  // Retrying one that failed stays on the error rather than flashing the
  // previous version back up: its query keeps the error count, which a pick
  // clears.
  const failed =
    albumQuery.isError ||
    !albumQuery.data ||
    (switching && (albumQuery.isPaused || albumQuery.errorUpdateCount > 0));
  const failure = (
    <EmptyState
      fill={!versionPicker}
      selectable
      message="Couldn't load TIDAL album"
      action={retryAction(albumQuery)}
    />
  );
  if (failed && !versionPicker) return failure;

  return (
    <>
      <Stack.Screen
        options={{
          title: failed
            ? "TIDAL album"
            : displayText(albumQuery.data?.title ?? ""),
          headerLargeTitle: false,
          // The hero carries the title until it scrolls under the bar.
          headerTitleStyle: {
            color: failed || hero.titleShown ? theme.color.fg : "transparent",
          },
        }}
      />
      {failed ? null : <AlbumStatusBar overCover={hero.overCover} />}
      <FlashList
        {...TRACK_FLASH_LIST_PERFORMANCE_PROPS}
        onScroll={hero.onScroll}
        scrollEventThrottle={hero.scrollEventThrottle}
        data={failed ? [] : tracks}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        extraData={rowState}
        ListHeaderComponent={
          failed ? (
            <View
              style={{
                paddingHorizontal: theme.space.lg,
                paddingTop: headerHeight + theme.space.md,
              }}
            >
              {versionPicker}
            </View>
          ) : (
            header
          )
        }
        ListEmptyComponent={failed ? failure : undefined}
        // The cover runs up under the status bar and the nav bar.
        contentInsetAdjustmentBehavior="never"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{ paddingBottom: dockInset + 24 }}
      />
    </>
  );
}
