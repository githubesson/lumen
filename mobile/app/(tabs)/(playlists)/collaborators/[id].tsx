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
  type Collaborator,
  type CollaboratorRole,
} from "@music-library/core";
import { EmptyState } from "../../../../components/empty-state";
import { HeaderIconButton } from "../../../../components/header-buttons";
import { Card } from "../../../../components/primitives";
import { SegmentedControl } from "../../../../components/segmented-control";
import { qk } from "../../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../../theme/theme";

export default function CollaboratorsScreen() {
  const theme = useTheme();
  const router = useRouter();
  const { id } = useLocalSearchParams<{ id: string }>();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: qk.playlistCollaborators(id),
    queryFn: ({ signal }) => api.listCollaborators(id!, { signal }),
    enabled: !!id,
  });

  const removeMutation = useMutation({
    mutationFn: (userId: string) => api.removeCollaborator(id!, userId),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: qk.playlistCollaborators(id),
      }),
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
  });

  const onRemove = useCallback(
    (c: Collaborator) => {
      Alert.alert(
        `Remove ${c.username}?`,
        "They'll lose access to this playlist.",
        [
          { text: "Cancel", style: "cancel" },
          {
            text: "Remove",
            style: "destructive",
            onPress: () => removeMutation.mutate(c.user_id),
          },
        ],
      );
    },
    [removeMutation],
  );

  const renderItem = ({ item }: ListRenderItemInfo<Collaborator>) => (
    <CollaboratorCard
      collaborator={item}
      theme={theme}
      onRoleChange={(r) =>
        roleMutation.mutate({ userId: item.user_id, role: r })
      }
      onRemove={() => onRemove(item)}
    />
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
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
          ),
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
              message="No collaborators yet. Tap the invite icon in the top-right to add someone."
            />
          )
        }
      />
    </>
  );
}

function CollaboratorCard({
  collaborator,
  theme,
  onRoleChange,
  onRemove,
}: {
  collaborator: Collaborator;
  theme: ThemeTokens;
  onRoleChange: (r: CollaboratorRole) => void;
  onRemove: () => void;
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
          </Text>
        </View>
        <Pressable
          onPress={onRemove}
          hitSlop={6}
          style={({ pressed }) => ({
            paddingVertical: 4,
            paddingHorizontal: 6,
            opacity: pressed ? 0.6 : 1,
          })}
          accessibilityRole="button"
          accessibilityLabel={`Remove ${collaborator.username}`}
        >
          <Text style={{ color: theme.color.danger, fontSize: 13 }}>Remove</Text>
        </Pressable>
      </View>
      <SegmentedControl<CollaboratorRole>
        options={[
          { label: "Viewer", value: "viewer" },
          { label: "Editor", value: "editor" },
        ]}
        value={collaborator.role}
        onChange={onRoleChange}
      />
    </Card>
  );
}

