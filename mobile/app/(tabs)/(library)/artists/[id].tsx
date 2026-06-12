import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { SymbolView } from "expo-symbols";
import { api, useAuth, type TrackListItem } from "@music-library/core";
import { TRACK_FLASH_LIST_PERFORMANCE_PROPS } from "../../../../components/list-performance";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../../components/dock/dock-context";
import { TrackRow } from "../../../../components/track-row";
import { qk } from "../../../../lib/query-keys";
import { usePlayQueue } from "../../../../lib/use-play-queue";
import { useTheme } from "../../../../theme/theme";

export default function ArtistDetailScreen() {
  const theme = useTheme();
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
  const onTrackPress = usePlayQueue(tracks);

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
    return (
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          paddingTop: theme.space.xl,
          paddingBottom: theme.space.md,
          alignItems: "center",
          gap: theme.space.md,
        }}
      >
        <View
          style={{
            width: 128,
            height: 128,
            borderRadius: 64,
            alignItems: "center",
            justifyContent: "center",
            backgroundColor: theme.color.bgElev2,
          }}
        >
          <SymbolView
            name="person.fill"
            size={56}
            tintColor={theme.color.fgMuted}
          />
        </View>
        <View style={{ alignItems: "center", gap: 2 }}>
          <Text
            style={{
              fontSize: 22,
              fontWeight: "700",
              color: theme.color.fg,
              letterSpacing: -0.2,
              textAlign: "center",
            }}
            numberOfLines={2}
          >
            {artist.name}
          </Text>
          <Text style={{ fontSize: 13, color: theme.color.fgMuted }}>
            {artist.track_count} {artist.track_count === 1 ? "track" : "tracks"}
            {artist.album_count
              ? ` · ${artist.album_count} ${artist.album_count === 1 ? "album" : "albums"}`
              : ""}
          </Text>
        </View>
      </View>
    );
  }, [artistQuery.data, theme]);

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
