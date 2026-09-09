import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, Text, View } from "react-native";
import { FlashList } from "@shopify/flash-list";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useRouter } from "expo-router";
import { useHeaderHeight } from "expo-router/react-navigation";
import {
  api,
  searchEntityID,
  SEARCH_TYPE_OPTIONS,
  useAuth,
  type SearchOffsets,
  type SearchResult,
  type SearchType,
} from "@music-library/core";
import { GlassSegmentedControl } from "../glass-segmented-control";
import { EmptyState } from "../empty-state";
import { TrackRow } from "../track-row";
import { AlbumRow } from "../album-row";
import { ArtistRow } from "../artist-row";
import { useBottomDockInset, useDockScrollHandler } from "../dock/dock-context";
import { usePlayQueue } from "../../lib/use-play-queue";
import { qk } from "../../lib/query-keys";
import { QUERY_STALE_TIME } from "../../lib/query-policy";
import { useTheme } from "../../theme/theme";

export function SearchResults({ search }: { search: string }) {
  const [type, setType] = useState<SearchType>("all");
  const { me } = useAuth();
  const router = useRouter();
  const theme = useTheme();
  const headerHeight = useHeaderHeight();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const query = useInfiniteQuery({
    queryKey: qk.search(me?.id, search, type),
    enabled: !!search && !!me,
    staleTime: QUERY_STALE_TIME.libraryList,
    initialPageParam: { offset: 0 } as {
      offset: number;
      searchOffsets?: SearchOffsets;
    },
    queryFn: ({ pageParam, signal }) =>
      api.searchPage({ q: search, type, limit: 25, ...pageParam, signal }),
    getNextPageParam: (last, pages) =>
      Object.keys(last.nextOffsets ?? {}).length
        ? {
            offset: pages.reduce((sum, page) => sum + page.items.length, 0),
            searchOffsets: last.nextOffsets,
          }
        : undefined,
  });
  const results = useMemo(
    () => query.data?.pages.flatMap((page) => page.items) ?? [],
    [query.data],
  );
  const tracks = useMemo(
    () =>
      results.flatMap((result) =>
        result.type === "track" ? [result.item] : [],
      ),
    [results],
  );
  const onTrackPress = usePlayQueue(tracks);
  const warnings = [
    ...new Set(query.data?.pages.flatMap((page) => page.warnings ?? []) ?? []),
  ];
  const renderItem = ({ item: result }: { item: SearchResult }) => {
    switch (result.type) {
      case "track":
        return <TrackRow track={result.item} onPress={onTrackPress} />;
      case "album":
        return (
          <AlbumRow
            album={result.item}
            onPress={() =>
              router.push({
                pathname:
                  result.item.source === "tidal"
                    ? "/(tabs)/(library)/tidal-albums/[id]"
                    : "/(tabs)/(library)/albums/[id]",
                params: { id: searchEntityID(result.item) },
              })
            }
          />
        );
      case "artist":
        return (
          <ArtistRow
            artist={result.item}
            onPress={() =>
              router.push({
                pathname:
                  result.item.source === "tidal"
                    ? "/(tabs)/(library)/tidal-artists/[id]"
                    : "/(tabs)/(library)/artists/[id]",
                params: {
                  id: searchEntityID(result.item),
                  name: result.item.name,
                },
              })
            }
          />
        );
    }
  };
  return (
    <FlashList
      {...dockScroll}
      key={`${type}:${search}`}
      data={results}
      renderItem={renderItem}
      keyExtractor={(result) => `${result.type}:${result.item.id}`}
      getItemType={(result) => result.type}
      keyboardShouldPersistTaps="handled"
      contentInsetAdjustmentBehavior="automatic"
      contentOffset={
        process.env.EXPO_OS === "ios" ? { x: 0, y: -headerHeight } : undefined
      }
      contentContainerStyle={{ paddingBottom: dockInset + 24 }}
      style={{ backgroundColor: theme.color.bg }}
      ListHeaderComponent={
        <View style={{ padding: theme.space.lg, gap: theme.space.md }}>
          <GlassSegmentedControl
            options={SEARCH_TYPE_OPTIONS}
            value={type}
            onChange={setType}
          />
          {(query.isError || warnings.length > 0) && (
            <Pressable
              onPress={() => void query.refetch()}
              accessibilityRole="button"
              style={{ minHeight: 44, justifyContent: "center" }}
            >
              <Text style={{ color: theme.color.fgMuted }}>Retry search</Text>
            </Pressable>
          )}
          {warnings.map((warning) => (
            <Text
              selectable
              key={warning}
              style={{ color: theme.color.fgMuted }}
            >
              {warning}
            </Text>
          ))}
          {query.isError && results.length > 0 && (
            <Text
              selectable
              style={{ color: theme.color.fgMuted }}
              onPress={() => void query.fetchNextPage()}
              accessibilityRole="button"
            >
              Couldn&apos;t load more results. Tap to retry.
            </Text>
          )}
        </View>
      }
      ListEmptyComponent={
        !search ? (
          <EmptyState message="Search for songs, albums, and artists." />
        ) : query.isLoading ? (
          <EmptyState loading />
        ) : query.isError || warnings.length === 0 ? (
          <EmptyState
            message={
              query.isError
                ? "Couldn't search. Try again."
                : "No matching results."
            }
          />
        ) : null
      }
      ListFooterComponent={
        query.isFetchingNextPage ? (
          <ActivityIndicator color={theme.color.fgMuted} />
        ) : null
      }
      onEndReached={() => {
        if (query.hasNextPage && !query.isFetchingNextPage && !query.isError)
          void query.fetchNextPage();
      }}
      onEndReachedThreshold={0.6}
    />
  );
}
