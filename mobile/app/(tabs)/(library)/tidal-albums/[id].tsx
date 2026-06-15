import { useCallback, useMemo } from "react";
import {
  ActivityIndicator,
  PixelRatio,
  Pressable,
  StyleSheet,
  Text,
  View,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useQuery } from "@tanstack/react-query";
import { Stack, useLocalSearchParams } from "expo-router";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  api,
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
import { useTheme } from "../../../../theme/theme";

const ALBUM_ART_SIZE = 220;

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
  });

  const tracks = useMemo<TrackListItem[]>(
    () => albumQuery.data?.tracks ?? [],
    [albumQuery.data?.tracks],
  );
  const onTrackPress = usePlayQueue(tracks);

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
    const coverUri = album.cover_url || null;
    return (
      <View
        style={{
          paddingHorizontal: theme.space.lg,
          paddingBottom: theme.space.md,
        }}
      >
        <View
          style={{
            alignItems: "center",
            paddingVertical: theme.space.xl,
            gap: theme.space.md,
          }}
        >
          <View
            style={{
              width: ALBUM_ART_SIZE,
              height: ALBUM_ART_SIZE,
              borderRadius: theme.radius.lg,
              overflow: "hidden",
              borderCurve: "continuous",
              backgroundColor: theme.color.bgElev2,
            }}
          >
            {coverUri ? (
              <Image
                source={{ uri: coverUri }}
                style={{ width: ALBUM_ART_SIZE, height: ALBUM_ART_SIZE }}
                contentFit="cover"
                transition={120}
                cachePolicy="memory-disk"
                allowDownscaling
                decodeFormat="rgb"
                recyclingKey={`${album.id}:${requestSize}`}
              />
            ) : null}
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
              {album.title}
            </Text>
            {album.artist ? (
              <Text
                style={{ fontSize: 16, color: theme.color.fgMuted }}
                numberOfLines={1}
              >
                {album.artist}
              </Text>
            ) : null}
            <Text style={{ fontSize: 13, color: theme.color.fgMuted, marginTop: 4 }}>
              {album.track_count} {album.track_count === 1 ? "track" : "tracks"}
              {album.release_year ? ` - ${album.release_year}` : ""}
            </Text>
          </View>
        </View>
        {tracks.length > 0 ? (
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              onTrackPress(tracks[0]);
            }}
            style={({ pressed }) => ({
              flexDirection: "row",
              alignItems: "center",
              justifyContent: "center",
              gap: 8,
              backgroundColor: theme.color.accent,
              borderRadius: theme.radius.md,
              paddingVertical: 12,
              opacity: pressed ? 0.85 : 1,
              borderCurve: "continuous",
            })}
          >
            <SymbolView name="play.fill" size={14} tintColor={theme.color.onAccent} />
            <Text style={{ color: theme.color.onAccent, fontWeight: "600", fontSize: 15 }}>
              Play
            </Text>
          </Pressable>
        ) : null}
      </View>
    );
  }, [albumQuery.data, onTrackPress, tracks, theme]);

  if (albumQuery.isLoading) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <ActivityIndicator color={theme.color.fgMuted} />
      </View>
    );
  }

  if (albumQuery.isError || !albumQuery.data) {
    return (
      <View style={[styles.center, { backgroundColor: theme.color.bg }]}>
        <Text style={{ color: theme.color.fgMuted }}>
          Couldn&apos;t load TIDAL album.
        </Text>
      </View>
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

const styles = StyleSheet.create({
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
