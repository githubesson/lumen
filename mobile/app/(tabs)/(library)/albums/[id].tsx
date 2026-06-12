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
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import { Image } from "expo-image";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import {
  albumCoverUrl,
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
import { usePlayTrack } from "../../../../context/player";
import { qk } from "../../../../lib/query-keys";
import { usePlayQueue } from "../../../../lib/use-play-queue";
import { useTheme } from "../../../../theme/theme";

const ALBUM_ART_SIZE = 220;

export default function AlbumDetailScreen() {
  const theme = useTheme();
  const router = useRouter();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { id } = useLocalSearchParams<{ id: string }>();
  const play = usePlayTrack();
  const { me } = useAuth();
  const userId = me?.id;
  const isAdmin = me?.role === "admin";

  const albumQuery = useQuery({
    queryKey: qk.album(userId, id),
    queryFn: ({ signal }) => api.getAlbum(id!, { signal }),
    enabled: !!userId && !!id,
  });

  const tracksQuery = useQuery({
    queryKey: qk.albumTracks(userId, id),
    queryFn: ({ signal }) => api.listAlbumTracks(id!, { signal }),
    enabled: !!userId && !!id,
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

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<TrackListItem>) => (
      <TrackRow track={item} onPress={onTrackPress} />
    ),
    [onTrackPress],
  );

  const keyExtractor = useCallback((t: TrackListItem) => t.id, []);

  const header = useMemo(() => {
    const album = albumQuery.data;
    if (!album) return null;
    const requestSize = Math.max(
      1,
      Math.round(ALBUM_ART_SIZE * PixelRatio.get()),
    );
    const coverUri = album.has_cover
      ? `${albumCoverUrl(album.id, requestSize)}${coverBust ? `&v=${coverBust}` : ""}`
      : null;
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
                recyclingKey={coverUri}
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
            {album.artist_name ? (
              <Text
                style={{ fontSize: 16, color: theme.color.fgMuted }}
                numberOfLines={1}
              >
                {album.artist_name}
              </Text>
            ) : null}
            <Text style={{ fontSize: 13, color: theme.color.fgMuted, marginTop: 4 }}>
              {album.track_count} {album.track_count === 1 ? "track" : "tracks"}
              {album.release_year ? ` · ${album.release_year}` : ""}
            </Text>
          </View>
        </View>
        {tracks.length > 0 ? (
          <Pressable
            onPress={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              play(tracks[0], tracks);
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
  }, [albumQuery.data, coverBust, tracks, theme, play]);

  const openEdit = useCallback(() => {
    if (!id) return;
    void Haptics.selectionAsync();
    router.push({
      pathname: "/(tabs)/(library)/albums/edit",
      params: { id },
    });
  }, [router, id]);

  if (albumQuery.isLoading || tracksQuery.isLoading) {
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
          Couldn&apos;t load album.
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
