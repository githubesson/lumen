import { useCallback, useMemo, useState } from "react";
import { RefreshControl, View } from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { api, useAuth, type TrackListItem } from "@music-library/core";
import { EmptyState } from "../../../components/empty-state";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../components/list-performance";
import { SegmentedControl } from "../../../components/segmented-control";
import { TrackRow } from "../../../components/track-row";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { qk } from "../../../lib/query-keys";
import { usePlayQueue } from "../../../lib/use-play-queue";
import { useTheme } from "../../../theme/theme";

type Mode = "favorites" | "recent";

export default function FavoritesScreen() {
  const theme = useTheme();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const [mode, setMode] = useState<Mode>("favorites");
  const { me } = useAuth();
  const userId = me?.id;

  const query = useQuery({
    queryKey: mode === "favorites" ? qk.favorites(userId) : qk.recent(userId),
    queryFn: ({ signal }) =>
      mode === "favorites"
        ? api.listFavorites({ signal })
        : api.listRecent(100, { signal }),
    enabled: !!userId,
  });

  const tracks = useMemo<TrackListItem[]>(
    () => query.data ?? [],
    [query.data],
  );
  const handlePress = usePlayQueue(tracks);

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={handlePress} />
    ),
    [handlePress],
  );

  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);

  // Switcher lives inside the list header so it scrolls with the list and
  // gets pushed below the translucent large-title nav bar by
  // `contentInsetAdjustmentBehavior="automatic"`. As a sibling above the list
  // it was intercepted by the translucent header overlay and untappable.
  const header = (
    <View
      style={{
        paddingHorizontal: theme.space.lg,
        paddingTop: theme.space.sm,
        paddingBottom: theme.space.md,
      }}
    >
      <SegmentedControl<Mode>
        options={[
          { label: "Favorites", value: "favorites" },
          { label: "Recent", value: "recent" },
        ]}
        value={mode}
        onChange={setMode}
      />
    </View>
  );

  return (
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
      refreshControl={
        <RefreshControl
          refreshing={query.isRefetching}
          onRefresh={() => void query.refetch()}
          tintColor={theme.color.fgMuted}
        />
      }
      ListEmptyComponent={
        query.isLoading ? (
          <EmptyState loading />
        ) : query.isError ? (
          <EmptyState
            selectable
            message={`Couldn't load ${mode === "favorites" ? "favorites" : "recent plays"}.`}
          />
        ) : (
          <EmptyState
            message={
              mode === "favorites"
                ? "No favorites yet. Tap the heart on a track to save it here."
                : "No recent plays."
            }
          />
        )
      }
    />
  );
}
