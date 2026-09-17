import { useCallback, useMemo, useState } from "react";
import { PixelRatio, Pressable, Text, View } from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  api,
  pluralize,
  resolveCoverUrl,
  trackCoverUrl,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import {
  ARTIST_POPULAR_PREVIEW_COUNT,
  tidalArtistReleases,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import {
  ArtistHero,
  ARTIST_AVATAR_SIZE,
} from "../../../../components/artist/artist-hero";
import { ArtistDiscography } from "../../../../components/artist/artist-discography";
import { ArtistPlayControls } from "../../../../components/artist/artist-play-controls";
import { PopularTrackRow } from "../../../../components/artist/popular-track-row";
import { EmptyState } from "../../../../components/empty-state";
import { SecondaryButton } from "../../../../components/buttons";
import { Section } from "../../../../components/section";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { qk } from "../../../../lib/query-keys";
import { usePlayQueue } from "../../../../lib/use-play-queue";
import { useTheme } from "../../../../theme/theme";

export default function TidalArtistScreen() {
  const { id, name } = useLocalSearchParams<{ id: string; name?: string }>();
  const { me } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const [expanded, setExpanded] = useState(false);
  const query = useQuery({
    queryKey: qk.tidalArtist(me?.id, id),
    queryFn: ({ signal }) => api.getTidalArtist(id, { signal }),
    enabled: !!me && !!id,
  });
  const data = query.data;
  const tracks = useMemo(() => data?.tracks ?? [], [data]);
  const releases = useMemo(
    () => (data ? tidalArtistReleases(data.albums) : []),
    [data],
  );
  const shownTracks = useMemo(
    () =>
      expanded ? tracks : tracks.slice(0, ARTIST_POPULAR_PREVIEW_COUNT),
    [expanded, tracks],
  );
  const onTrackPress = usePlayQueue(tracks);
  const warning = data?.warnings?.join(" ");
  const problem = query.isError ? "Couldn't load artist." : warning;
  const artistName = data?.artist?.name || name || "TIDAL artist";
  // Artists without a TIDAL picture borrow their top track's cover.
  const imageUri = data?.artist?.cover_url
    ? resolveCoverUrl(data.artist.cover_url)
    : tracks[0]
      ? trackCoverUrl(
          tracks[0],
          Math.round(ARTIST_AVATAR_SIZE * PixelRatio.get()),
        )
      : null;
  const detail = data
    ? [
        releases.length > 0 && pluralize(releases.length, "release"),
        tracks.length > 0 && pluralize(tracks.length, "popular track"),
      ]
        .filter(Boolean)
        .join(" · ")
    : undefined;

  const openRelease = useCallback(
    (release: ArtistRelease) =>
      router.push({
        pathname: "/(tabs)/tidal-albums/[id]",
        params: { id: release.id.replace(/^tidal:/, "") },
      }),
    [router],
  );
  const renderItem = useCallback(
    ({ item, index }: ListRenderItemInfo<TrackListItem>) => (
      <PopularTrackRow rank={index + 1} track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );

  return (
    <>
      <Stack.Screen
        options={{ title: artistName, headerLargeTitle: false }}
      />
      <FlashList
        {...dockScroll}
        data={shownTracks}
        renderItem={renderItem}
        keyExtractor={(track) => track.id}
        ListHeaderComponent={
          <View style={{ gap: theme.space.lg, paddingBottom: theme.space.sm }}>
            <ArtistHero
              name={artistName}
              kind="Artist · TIDAL"
              imageUri={imageUri}
            />
            <ArtistPlayControls
              name={artistName}
              tracks={tracks}
              detail={detail}
            />
            {!!problem && (
              <View
                style={{
                  paddingHorizontal: theme.space.lg,
                  gap: theme.space.md,
                }}
              >
                <Text
                  accessibilityRole="alert"
                  selectable
                  style={{ color: theme.color.danger }}
                >
                  {problem}
                </Text>
                <SecondaryButton
                  label={query.isFetching ? "Retrying…" : "Retry artist"}
                  disabled={query.isFetching}
                  onPress={() => void query.refetch()}
                />
              </View>
            )}
            {tracks.length > 0 && (
              <Section title="Popular" />
            )}
          </View>
        }
        ListFooterComponent={
          <View style={{ gap: theme.space.xl }}>
            {tracks.length > ARTIST_POPULAR_PREVIEW_COUNT && (
              <Pressable
                onPress={() => setExpanded((value) => !value)}
                accessibilityRole="button"
                accessibilityState={{ expanded }}
                style={({ pressed }) => ({
                  alignSelf: "flex-start",
                  minHeight: 44,
                  justifyContent: "center",
                  paddingHorizontal: theme.space.lg,
                  opacity: pressed ? 0.6 : 1,
                })}
              >
                <Text
                  style={{
                    color: theme.color.fgMuted,
                    fontSize: 15,
                    fontWeight: "600",
                  }}
                >
                  {expanded ? "Show less" : "See more"}
                </Text>
              </Pressable>
            )}
            {releases.length > 0 && (
              <ArtistDiscography releases={releases} onOpen={openRelease} />
            )}
          </View>
        }
        ListEmptyComponent={
          query.isLoading ? (
            <EmptyState loading />
          ) : !problem && releases.length === 0 ? (
            <EmptyState message="No releases found." />
          ) : null
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: dockInset + 24 }}
        style={{ backgroundColor: theme.color.bg }}
      />
    </>
  );
}
