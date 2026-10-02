import { useCallback } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack, useLocalSearchParams, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  collaboratorPermissions,
  errorMessage,
  playlistPermissions,
  useAuth,
  type Collaborator,
  type CollaboratorRole,
} from "@music-library/core";
import { EmptyState } from "../../../../components/empty-state";
import { HeaderIconButton } from "../../../../components/header-buttons";
import { Card } from "../../../../components/primitives";
import { SegmentedControl } from "../../../../components/segmented-control";
import { autoDownloadStore } from "../../../../lib/downloads";
import { qk } from "../../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../../theme/theme";

/**
 * A playlist's collaborators. What each row offers follows the server: the
 * owner invites (on a collaborative playlist), changes roles and removes
 * anyone; everyone else can only leave.
 */
export default function CollaboratorsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();
  const { me } = useAuth();
  const userId = me?.id;

  // The detail screen's key, so this reuses the playlist it already loaded.
  const playlistQuery = useQuery({
    queryKey: qk.playlist(userId, id),
    queryFn: ({ signal }) => api.getPlaylist(id!, { signal }),
    enabled: !!userId && !!id,
  });
  const permissions = playlistPermissions(playlistQuery.data, me);

  const query = useQuery({
    queryKey: qk.playlistCollaborators(id),
    queryFn: ({ signal }) => api.listCollaborators(id!, { signal }),
    enabled: !!id,
  });

  const removeMutation = useMutation({
    mutationFn: (memberId: string) => api.removeCollaborator(id!, memberId),
    onSuccess: async (_data, removedId) => {
      if (removedId !== userId) {
        void queryClient.invalidateQueries({
          queryKey: qk.playlistCollaborators(id),
        });
        return;
      }
      // Leaving ends access, so the playlist's screens would only 404 now.
      await autoDownloadStore.removePlaylist(id!);
      queryClient.removeQueries({ queryKey: qk.playlist(userId, id) });
      queryClient.removeQueries({ queryKey: qk.playlistTracks(userId, id) });
      queryClient.removeQueries({ queryKey: qk.playlistCollaborators(id) });
      void queryClient.invalidateQueries({ queryKey: qk.playlists(userId) });
      router.dismissTo("/(tabs)/(playlists)");
    },
    onError: (error, removedId) =>
      Alert.alert(
        removedId === userId ? "Couldn't leave playlist" : "Couldn't remove collaborator",
        errorMessage(error, "Please try again."),
      ),
  });

  const roleMutation = useMutation({
    mutationFn: ({
      userId,
      role,
    }: {
      userId: string;
      role: CollaboratorRole;
    }) => api.setCollaboratorRole(id!, userId, role),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: qk.playlistCollaborators(id),
      }),
    onError: (error) =>
      Alert.alert("Couldn't change role", errorMessage(error, "Please try again.")),
  });

  const { mutate: removeCollaborator } = removeMutation;
  const onRemove = useCallback(
    (c: Collaborator, isSelf: boolean) => {
      Alert.alert(
        isSelf ? "Leave this playlist?" : `Remove ${c.username}?`,
        isSelf
          ? "You'll lose access to it."
          : "They'll lose access to this playlist.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: isSelf ? "Leave" : "Remove",
            style: "destructive",
            onPress: () => removeCollaborator(c.user_id),
          },
        ],
      );
    },
    [removeCollaborator],
  );

  const renderItem = ({ item }: ListRenderItemInfo<Collaborator>) => {
    const row = collaboratorPermissions(permissions, item, me);
    return (
      <CollaboratorCard
        collaborator={item}
        theme={theme}
        isSelf={row.isSelf}
        onRoleChange={
          row.canChangeRole
            ? (r) => roleMutation.mutate({ userId: item.user_id, role: r })
            : undefined
        }
        onRemove={row.canRemove ? () => onRemove(item, row.isSelf) : undefined}
      />
    );
  };

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: permissions.canInvite
            ? () => (
                <HeaderIconButton
                  icon="person.badge.plus"
                  label="Invite collaborator"
                  onPress={() => {
                    void Haptics.selectionAsync();
                    router.push({
                      pathname: "/(tabs)/(playlists)/invite-collaborator",
                      params: { id },
                    });
                  }}
                />
              )
            : undefined,
        }}
      />
      <FlatList
        data={query.data ?? []}
        renderItem={renderItem}
        keyExtractor={(c) => c.user_id}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.md,
        }}
        ItemSeparatorComponent={() => (
          <View style={{ height: theme.space.md }} />
        )}
        ListEmptyComponent={
          query.isLoading ? (
            <EmptyState loading />
          ) : (
            <EmptyState
              selectable
              message={
                permissions.canInvite
                  ? "No collaborators yet. Tap the invite icon in the top-right to add someone."
                  : permissions.isOwner
                    ? "No collaborators. Make the playlist collaborative to invite people."
                    : "No collaborators yet."
              }
            />
          )
        }
      />
    </>
  );
}

/** One collaborator; the role picker and Remove/Leave show only when allowed. */
function CollaboratorCard({
  collaborator,
  theme,
  isSelf,
  onRoleChange,
  onRemove,
}: {
  collaborator: Collaborator;
  theme: ThemeTokens;
  isSelf: boolean;
  onRoleChange?: (r: CollaboratorRole) => void;
  onRemove?: () => void;
}) {
  return (
    <Card
      style={{
        padding: theme.space.md,
        gap: 10,
      }}
    >
      <View
        style={{
          flexDirection: "row",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{ color: theme.color.fg, fontSize: 16, fontWeight: "600" }}
          >
            {collaborator.username}
          </Text>
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
            {collaborator.status === "pending" ? "Pending" : "Accepted"}
            {onRoleChange ? "" : ` · ${ROLE_LABELS[collaborator.role]}`}
          </Text>
        </View>
        {onRemove ? (
          <Pressable
            onPress={onRemove}
            hitSlop={6}
            style={({ pressed }) => ({
              paddingVertical: 4,
              paddingHorizontal: 6,
              opacity: pressed ? 0.6 : 1,
            })}
            accessibilityRole="button"
            accessibilityLabel={
              isSelf ? "Leave this playlist" : `Remove ${collaborator.username}`
            }
          >
            <Text style={{ color: theme.color.danger, fontSize: 13 }}>
              {isSelf ? "Leave" : "Remove"}
            </Text>
          </Pressable>
        ) : null}
      </View>
      {onRoleChange ? (
        <SegmentedControl<CollaboratorRole>
          options={[
            { label: ROLE_LABELS.viewer, value: "viewer" },
            { label: ROLE_LABELS.editor, value: "editor" },
          ]}
          value={collaborator.role}
          onChange={onRoleChange}
        />
      ) : null}
    </Card>
  );
}

const ROLE_LABELS: Record<CollaboratorRole, string> = {
  viewer: "Viewer",
  editor: "Editor",
};
