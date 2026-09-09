import { useMemo } from "react";
import { Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import {
  api,
  searchEntityID,
  useAuth,
  type SearchResult,
} from "@music-library/core";
import { TrackRow } from "../../../../components/track-row";
import { AlbumRow } from "../../../../components/album-row";
import { EmptyState } from "../../../../components/empty-state";
import { SecondaryButton } from "../../../../components/buttons";
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
  const warning = query.data?.warnings?.join(" ");
  const problem = query.isError ? "Couldn't load artist." : warning;
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
                  params: { id: searchEntityID(result.item) },
                })
              }
            />
          ) : null
        }
        ListHeaderComponent={
          <View style={{ padding: theme.space.lg, gap: theme.space.md }}>
            <Text selectable style={{ color: theme.color.fgMuted }}>
              Top songs and releases
            </Text>
            {!!problem && (
              <>
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
              </>
            )}
          </View>
        }
        ListEmptyComponent={
          query.isLoading ? (
            <EmptyState loading />
          ) : !problem ? (
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
