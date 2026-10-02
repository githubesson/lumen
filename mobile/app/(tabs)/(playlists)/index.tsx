import { useCallback } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  RefreshControl,
  StyleSheet,
  Text,
  useWindowDimensions,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import {
  api,
  errorMessage,
  useAuth,
  type PendingInvite,
  type Playlist,
} from "@music-library/core";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { EmptyState } from "../../../components/empty-state";
import { PlaylistTile } from "../../../components/playlist-tile";
import { Card, SectionLabel } from "../../../components/primitives";
import { HeaderIconButton } from "../../../components/header-buttons";
import {
  useBottomDockInset,
  useDockScrollHandler,
} from "../../../components/dock/dock-context";
import { qk } from "../../../lib/query-keys";
import { usePullToRefresh } from "../../../lib/use-pull-to-refresh";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

const GRID_COLUMNS = 2;

export default function PlaylistsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();
  const dockInset = useBottomDockInset();
  const dockScroll = useDockScrollHandler();
  const { me } = useAuth();
  const userId = me?.id;
  const playlistsQueryKey = qk.playlists(userId);
  const invitesQueryKey = qk.playlistInvites(userId);

  const playlistsQuery = useQuery({
    queryKey: playlistsQueryKey,
    queryFn: ({ signal }) => api.listPlaylists({ signal }),
    enabled: !!userId,
  });

  const invitesQuery = useQuery({
    queryKey: invitesQueryKey,
    queryFn: ({ signal }) => api.listPendingInvites({ signal }),
    enabled: !!userId,
  });

  const { refetch: refetchPlaylists } = playlistsQuery;
  const { refetch: refetchInvites } = invitesQuery;
  const refetchAll = useCallback(
    () => Promise.allSettled([refetchPlaylists(), refetchInvites()]),
    [refetchPlaylists, refetchInvites],
  );
  const { refreshing, onRefresh } = usePullToRefresh(refetchAll);

  // A failed answer refreshes the invites too: the usual cause is an invite
  // that was withdrawn meanwhile, which should then leave the list.
  const acceptMutation = useMutation({
    mutationFn: (id: string) => api.acceptInvite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invitesQueryKey });
      void queryClient.invalidateQueries({ queryKey: playlistsQueryKey });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: invitesQueryKey });
      Alert.alert("Couldn't accept invite", errorMessage(error, "Please try again."));
    },
  });

  const declineMutation = useMutation({
    mutationFn: (id: string) => api.declineInvite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: invitesQueryKey });
    },
    onError: (error) => {
      void queryClient.invalidateQueries({ queryKey: invitesQueryKey });
      Alert.alert("Couldn't decline invite", errorMessage(error, "Please try again."));
    },
  });

  const onPress = useCallback(
    (playlist: Playlist) =>
      router.push({
        pathname: "/(tabs)/(playlists)/[id]",
        params: { id: playlist.id },
      }),
    [router],
  );

  const { width: windowWidth } = useWindowDimensions();
  const tileSize = Math.floor(
    (windowWidth - theme.space.lg * (GRID_COLUMNS + 1)) / GRID_COLUMNS,
  );

  const renderItem = useCallback(
    ({ item }: ListRenderItemInfo<Playlist>) => (
      <PlaylistTile playlist={item} size={tileSize} onPress={onPress} />
    ),
    [onPress, tileSize],
  );

  const keyExtractor = useCallback((p: Playlist) => p.id, []);

  const invites = invitesQuery.data ?? [];
  const playlists = playlistsQuery.data ?? [];

  // No header cell at all without invites, so the grid starts right under the
  // title.
  const header =
    invites.length > 0 ? (
      <View style={{ paddingHorizontal: theme.space.lg, gap: 6, marginBottom: theme.space.lg }}>
        <SectionLabel>Invitations</SectionLabel>
        <Card style={{ overflow: "hidden" }}>
          {invites.map((invite, i) => (
            <InviteRow
              key={invite.playlist_id}
              invite={invite}
              theme={theme}
              firstRow={i === 0}
              pending={
                acceptMutation.isPending || declineMutation.isPending
              }
              onAccept={() => acceptMutation.mutate(invite.playlist_id)}
              onDecline={() => declineMutation.mutate(invite.playlist_id)}
            />
          ))}
        </Card>
      </View>
    ) : null;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderIconButton
              icon="plus"
              label="New playlist"
              onPress={() => {
                void Haptics.selectionAsync();
                router.push("/(tabs)/(playlists)/new");
              }}
            />
          ),
        }}
      />
      <FlatList
        {...dockScroll}
        data={playlists}
        renderItem={renderItem}
        keyExtractor={keyExtractor}
        numColumns={GRID_COLUMNS}
        columnWrapperStyle={{
          paddingHorizontal: theme.space.lg,
          gap: theme.space.lg,
        }}
        ItemSeparatorComponent={GridRowGap}
        ListHeaderComponent={header}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{
          paddingTop: invites.length > 0 ? theme.space.md : theme.space.sm,
          paddingBottom: dockInset + 24,
        }}
        refreshControl={
          <RefreshControl
            refreshing={refreshing}
            onRefresh={onRefresh}
            tintColor={theme.color.fgMuted}
          />
        }
        ListEmptyComponent={
          playlistsQuery.isLoading ? (
            <EmptyState loading />
          ) : (
            <EmptyState message="No playlists yet. Tap + to create one." />
          )
        }
      />
    </>
  );
}

/** Vertical space between grid rows; FlatList renders it between rows, not tiles. */
function GridRowGap() {
  const theme = useTheme();
  return <View style={{ height: theme.space.xl }} />;
}

function InviteRow({
  invite,
  theme,
  firstRow,
  pending,
  onAccept,
  onDecline,
}: {
  invite: PendingInvite;
  theme: ThemeTokens;
  firstRow: boolean;
  pending: boolean;
  onAccept: () => void;
  onDecline: () => void;
}) {
  return (
    <View
      style={{
        paddingHorizontal: 14,
        paddingVertical: 10,
        borderTopWidth: firstRow ? 0 : StyleSheet.hairlineWidth,
        borderTopColor: theme.color.separator,
        flexDirection: "row",
        alignItems: "center",
        gap: 10,
      }}
    >
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fg, fontSize: 15, fontWeight: "500" }}
        >
          {invite.playlist_name}
        </Text>
        <Text
          numberOfLines={1}
          style={{ color: theme.color.fgMuted, fontSize: 12 }}
        >
          {invite.owner_name} invited you as {invite.role}
        </Text>
      </View>
      <Pressable
        onPress={onDecline}
        disabled={pending}
        hitSlop={6}
        style={{ paddingVertical: 6, paddingHorizontal: 10 }}
      >
        <Text style={{ color: theme.color.fgMuted, fontSize: 14 }}>
          Decline
        </Text>
      </Pressable>
      <Pressable
        onPress={onAccept}
        disabled={pending}
        hitSlop={6}
        style={{
          paddingVertical: 6,
          paddingHorizontal: 12,
          borderRadius: 6,
          backgroundColor: theme.color.accent,
          borderCurve: "continuous",
        }}
      >
        <Text style={{ color: theme.color.onAccent, fontSize: 14, fontWeight: "600" }}>
          Accept
        </Text>
      </Pressable>
    </View>
  );
}
