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
import {
  Stack,
  useLocalSearchParams,
  useRouter,
  useSegments,
} from "expo-router";
import {
  api,
  pluralize,
  trackCoverUrl,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import {
  libraryArtistReleases,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../../components/list-performance";
import {
  ArtistHero,
  ARTIST_AVATAR_SIZE,
} from "../../../../components/artist/artist-hero";
import { ArtistDiscography } from "../../../../components/artist/artist-discography";
import { ArtistPlayControls } from "../../../../components/artist/artist-play-controls";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { Section } from "../../../../components/section";
import { TrackRow } from "../../../../components/track-row";
import { qk } from "../../../../lib/query-keys";
import { usePlayQueue } from "../../../../lib/use-play-queue";
import { useTheme } from "../../../../theme/theme";

export default function ArtistDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  // Also mounted in the Settings stack (for Replay); open albums in whichever
  // stack this screen lives in so back returns here.
  const inSettings = (useSegments() as string[]).includes("(settings)");
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { id } = useLocalSearchParams<{ id: string }>();
  const { me } = useAuth();
  const userId = me?.id;

  const artistQuery = useQuery({
    queryKey: qk.artist(userId, id),
    queryFn: ({ signal }) => api.getArtist(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const tracksQuery = useQuery({
    queryKey: qk.artistTracks(userId, id),
    queryFn: ({ signal }) => api.listArtistTracks(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const tracks = useMemo<TrackListItem[]>(
    () => tracksQuery.data ?? [],
    [tracksQuery.data],
  );
  const releases = useMemo(() => libraryArtistReleases(tracks), [tracks]);
  const onTrackPress = usePlayQueue(tracks);

  const openRelease = useCallback(
    (release: ArtistRelease) =>
      router.push({
        pathname: inSettings
          ? "/(tabs)/(settings)/albums/[id]"
          : "/(tabs)/albums/[id]",
        params: { id: release.id },
      }),
    [router, inSettings],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );

  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);

  const header = useMemo(() => {
    const artist = artistQuery.data;
    if (!artist) return null;
    const cover = tracks[0];
    const imageUri =
      cover && cover.has_cover !== false
        ? trackCoverUrl(
            cover,
            Math.round(ARTIST_AVATAR_SIZE * PixelRatio.get()),
          )
        : null;
    const detail = [
      pluralize(artist.track_count, "track"),
      artist.album_count > 0 && pluralize(artist.album_count, "album"),
    ]
      .filter(Boolean)
      .join(" · ");
    return (
      <View style={{ gap: theme.space.lg, paddingBottom: theme.space.sm }}>
        <ArtistHero name={artist.name} kind="Artist" imageUri={imageUri} />
        <ArtistPlayControls
          name={artist.name}
          tracks={tracks}
          detail={detail}
        />
        {releases.length > 0 && (
          <ArtistDiscography releases={releases} onOpen={openRelease} />
        )}
        {tracks.length > 0 && <Section title="Songs" />}
      </View>
    );
  }, [artistQuery.data, tracks, releases, openRelease, theme]);

  if (artistQuery.isLoading || tracksQuery.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <ActivityIndicator color={theme.color.fgMuted} />
      </View>
    );
  }
  if (artistQuery.isError || !artistQuery.data) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <Text style={{ color: theme.color.fgMuted }}>
          Couldn&apos;t load artist.
        </Text>
      </View>
    );
  }

  return (
    <>
      <Stack.Screen options={{ title: artistQuery.data.name }} />
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
