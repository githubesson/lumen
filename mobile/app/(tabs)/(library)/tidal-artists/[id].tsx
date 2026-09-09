import { useMemo } from "react";
import { Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { api, useAuth, type SearchResult } from "@music-library/core";
import { TrackRow } from "../../../../components/track-row";
import { AlbumRow } from "../../../../components/album-row";
import { EmptyState } from "../../../../components/empty-state";
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
  const query = useQuery({
    queryKey: qk.tidalArtist(me?.id, id),
    queryFn: ({ signal }) => api.getTidalArtist(id, { signal }),
    enabled: !!me && !!id,
  });
  const tracks = useMemo(() => query.data?.tracks ?? [], [query.data]);
  const onTrackPress = usePlayQueue(tracks);
  const results = useMemo<SearchResult[]>(
    () => [
      ...tracks.map((item): SearchResult => ({ type: "track", item })),
      ...(query.data?.albums ?? []).map(
        (item): SearchResult => ({ type: "album", item }),
      ),
    ],
    [query.data, tracks],
  );
  return (
    <>
      <Stack.Screen
        options={{ title: name || "TIDAL artist", headerLargeTitle: false }}
      />
      <FlashList
        {...dockScroll}
        data={results}
        keyExtractor={(result) => `${result.type}:${result.item.id}`}
        getItemType={(result) => result.type}
        renderItem={({ item: result }) =>
          result.type === "track" ? (
            <TrackRow track={result.item} onPress={onTrackPress} />
          ) : result.type === "album" ? (
            <AlbumRow
              album={result.item}
              onPress={() =>
                router.push({
                  pathname: "/(tabs)/(library)/tidal-albums/[id]",
                  params: { id: result.item.source_id! },
                })
              }
            />
          ) : null
        }
        ListHeaderComponent={
          <View style={{ padding: theme.space.lg }}>
            <Text selectable style={{ color: theme.color.fgMuted }}>
              Top songs and releases
            </Text>
          </View>
        }
        ListEmptyComponent={
          query.isLoading ? (
            <EmptyState loading />
          ) : (
            <EmptyState
              message={
                query.isError ? "Couldn't load artist." : "No releases found."
              }
            />
          )
        }
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: dockInset + 24 }}
        style={{ backgroundColor: theme.color.bg }}
      />
    </>
  );
}
