import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Keyboard,
  Pressable,
  StyleSheet,
  View,
  type GestureResponderEvent,
} from "react-native";
import { FlashList, type ListRenderItemInfo } from "@shopify/flash-list";
import { useLocalSearchParams, useRouter } from "expo-router";
import { isLiquidGlassAvailable } from "expo-glass-effect";
import * as Haptics from "expo-haptics";
import { SymbolView } from "expo-symbols";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { api, useAuth, type Playlist } from "@music-library/core";
import { AdaptiveGlass } from "../components/adaptive-glass";
import { EmptyState } from "../components/empty-state";
import { HUD } from "../components/add-confirmation/flight";
import { showAddConfirmation } from "../components/add-confirmation/store";
import { playlistArtUri, trackArtUri } from "../components/playlist-picker/art";
import {
  measureRect,
  offsetRect,
  screenOffsetOfPress,
} from "../components/playlist-picker/measure";
import {
  NewPlaylistRow,
  PICKER_ART_SIZE,
  PlaylistPickerRow,
  type PickHandler,
} from "../components/playlist-picker/picker-row";
import { PickerSearchField } from "../components/playlist-picker/search-field";
import { playlistPickerTrack } from "../components/playlist-picker/subject";
import {
  TRACK_CARD_COVER_SIZE,
  TrackCard,
} from "../components/playlist-picker/track-card";
import { addTrackToPlaylist, type AddTarget } from "../lib/add-to-playlist";
import {
  playlistPickerRows,
  type PlaylistPickerRow as Row,
} from "../lib/playlist-picker";
import { qk } from "../lib/query-keys";
import { loadRecentPlaylistIds } from "../lib/recent-playlists";
import { useTheme } from "../theme/theme";

/** Reopened for the same track soon after, the "Added" marks show at once. */
const PICKER_CACHE_MS = 5 * 60 * 1000;

/**
 * Add to Playlist: a half-height sheet with the track on top, one field that
 * finds a playlist or names a new one, and one list. One tap adds: the sheet
 * closes at once and the root confirmation plays while the request runs.
 */
export default function PlaylistPickerScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { trackId } = useLocalSearchParams<{ trackId?: string }>();
  const { me } = useAuth();
  const userId = me?.id;
  const track = useMemo(() => playlistPickerTrack(trackId), [trackId]);
  const cardCoverUri = track ? trackArtUri(track, TRACK_CARD_COVER_SIZE) : null;
  const coverRef = useRef<View>(null);
  const [search, setSearch] = useState("");
  const [recentIds, setRecentIds] = useState<string[]>([]);
  const [lifted, setLifted] = useState(false);
  // One tap finishes: anything after it is the sheet already closing.
  const picked = useRef(false);

  useEffect(() => {
    if (!userId) return;
    let cancelled = false;
    void loadRecentPlaylistIds(userId)
      .then((ids) => {
        if (!cancelled) setRecentIds(ids);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [userId]);

  const playlistsQuery = useQuery<Playlist[]>({
    queryKey: qk.playlistsWithTrack(userId, trackId),
    queryFn: ({ signal }) => api.listPlaylists({ trackId, signal }),
    enabled: !!userId && !!trackId,
    // The plain list, usually cached, stands in until this answers; it has
    // no "Added" marks, so until then every playlist is pickable.
    placeholderData: () =>
      queryClient.getQueryData<Playlist[]>(qk.playlists(userId)),
    gcTime: PICKER_CACHE_MS,
  });
  const playlists = playlistsQuery.data;

  const rows = useMemo(
    () => (playlists ? playlistPickerRows(playlists, recentIds, search) : []),
    [playlists, recentIds, search],
  );

  const close = useCallback(() => {
    void Haptics.selectionAsync();
    router.back();
  }, [router]);

  const pick = useCallback<PickHandler>(
    (target, row, event: GestureResponderEvent) => {
      if (picked.current || !userId || !trackId) return;
      picked.current = true;
      void Haptics.selectionAsync();
      Keyboard.dismiss();
      const done = addTrackToPlaylist({ queryClient, userId, trackId, target });
      const offset = screenOffsetOfPress(row, event);
      void Promise.all([offset, measureRect(coverRef.current)]).then(
        ([screenOffset, cover]) => {
          showAddConfirmation({
            from: screenOffset && cover ? offsetRect(cover, screenOffset) : null,
            trackArt: {
              uri: track ? trackArtUri(track, HUD.playlistSize) : null,
              placeholder: cardCoverUri,
            },
            ...confirmationTarget(target),
            done,
          });
          setLifted(true);
          router.back();
        },
      );
    },
    [cardCoverUri, queryClient, router, track, trackId, userId],
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Row>) =>
      item.type === "new" ? (
        <NewPlaylistRow name={item.name} onPick={pick} />
      ) : (
        <PlaylistPickerRow playlist={item.playlist} onPick={pick} />
      ),
    [pick],
  );
  const keyExtractor = useCallback((item: Row) => item.id, []);
  const itemType = useCallback((item: Row) => item.type, []);

  return (
    <View
      style={[
        styles.screen,
        // iOS 26 draws the half sheet in Liquid Glass behind a clear screen.
        { backgroundColor: isLiquidGlassAvailable() ? "transparent" : theme.color.bg },
      ]}
    >
      <View style={styles.top}>
        <TrackCard
          track={track}
          coverUri={cardCoverUri}
          coverRef={coverRef}
          lifted={lifted}
        />
        <Pressable
          onPress={close}
          accessibilityRole="button"
          accessibilityLabel="Close"
          hitSlop={4}
        >
          <AdaptiveGlass interactive style={styles.close}>
            <SymbolView name="xmark" size={17} weight="semibold" tintColor={theme.color.fg} />
          </AdaptiveGlass>
        </Pressable>
      </View>
      <PickerSearchField onChangeText={setSearch} />
      <FlashList
        data={rows}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        getItemType={itemType}
        keyboardShouldPersistTaps="handled"
        keyboardDismissMode="on-drag"
        contentInsetAdjustmentBehavior="automatic"
        contentContainerStyle={{ paddingBottom: theme.space.xl }}
        ListEmptyComponent={
          !playlists && playlistsQuery.isError ? (
            <EmptyState selectable message="Couldn't load playlists." />
          ) : !playlists ? (
            <EmptyState loading />
          ) : (
            <EmptyState message="No playlists you can add to." />
          )
        }
      />
    </View>
  );
}

/** What the confirmation shows for the playlist being added to. */
function confirmationTarget(target: AddTarget) {
  if (target.kind === "new") {
    return {
      playlistName: target.name,
      playlistArt: null,
      playlistGlyph: "music.note.list",
      created: true,
    } as const;
  }
  const { playlist } = target;
  const uri = playlistArtUri(playlist, HUD.playlistSize);
  return {
    playlistName: playlist.name,
    playlistArt: uri
      ? { uri, placeholder: playlistArtUri(playlist, PICKER_ART_SIZE) }
      : null,
    playlistGlyph:
      playlist.visibility === "collaborative" ? "person.2.fill" : "music.note.list",
    created: false,
  } as const;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
  },
  // Clears the sheet's grabber.
  top: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    paddingTop: 24,
    paddingHorizontal: 14,
  },
  close: {
    width: 44,
    height: 44,
    borderRadius: 22,
    overflow: "hidden",
    alignItems: "center",
    justifyContent: "center",
  },
});
