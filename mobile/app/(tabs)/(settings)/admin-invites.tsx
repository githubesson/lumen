import { useMemo } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  INVITE_STATUS_LABELS,
  api,
  errorMessage,
  inviteExpiryLabel,
  inviteRoleLabel,
  inviteStatus,
  inviteUsage,
  partitionInvites,
  type Invite,
} from "@music-library/core";
import { SecondaryButton } from "../../../components/buttons";
import { EmptyState } from "../../../components/empty-state";
import { HeaderIconButton } from "../../../components/header-buttons";
import { Card } from "../../../components/primitives";
import { qk } from "../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

export default function AdminInvitesScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  const invitesQuery = useQuery({
    queryKey: qk.adminInvites,
    queryFn: ({ signal }) => api.listInvites({ signal }),
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => api.revokeInvite(id),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: qk.adminInvites });
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
    },
    onError: (err) => {
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      Alert.alert(
        "Couldn't revoke invitation",
        errorMessage(err, "Check your connection and try again."),
      );
    },
  });

  const sorted = useMemo(() => {
    const { active, past } = partitionInvites(invitesQuery.data ?? []);
    return [...active, ...past];
  }, [invitesQuery.data]);

  const onRevoke = (invite: Invite) => {
    Alert.alert(
      "Revoke invite?",
      "Anyone holding this link will no longer be able to register.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Revoke",
          style: "destructive",
          onPress: () => revokeMutation.mutate(invite.id),
        },
      ],
    );
  };

  const renderItem = ({ item }: ListRenderItemInfo<Invite>) => (
    <InviteCard
      invite={item}
      theme={theme}
      revoking={
        revokeMutation.isPending && revokeMutation.variables === item.id
      }
      onRevoke={() => onRevoke(item)}
    />
  );

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderIconButton
              icon="plus"
              label="New invitation"
              onPress={() => {
                void Haptics.selectionAsync();
                router.push("/(tabs)/(settings)/admin-new-invite");
              }}
            />
          ),
        }}
      />
      <FlatList
        data={sorted}
        renderItem={renderItem}
        keyExtractor={(i) => i.id}
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
          invitesQuery.isLoading ? (
            <EmptyState loading />
          ) : invitesQuery.isError ? (
            <View style={{ paddingVertical: 96, gap: theme.space.md }}>
              <EmptyState
                selectable
                style={{ paddingVertical: 0 }}
                message={errorMessage(
                  invitesQuery.error,
                  "Couldn't load invitations.",
                )}
              />
              <SecondaryButton
                label="Try again"
                onPress={() => void invitesQuery.refetch()}
              />
            </View>
          ) : (
            <EmptyState
              selectable
              message="No invitations yet. Tap + to create one."
            />
          )
        }
      />
    </>
  );
}

function InviteCard({
  invite,
  theme,
  revoking,
  onRevoke,
}: {
  invite: Invite;
  theme: ThemeTokens;
  revoking: boolean;
  onRevoke: () => void;
}) {
  const status = inviteStatus(invite);
  // Revoking an expired or used-up invite would change nothing.
  const active = status === "active";
  const formatDate = (iso: string) => new Date(iso).toLocaleDateString();

  return (
    <Card
      style={{
        padding: theme.space.md,
        gap: 8,
        opacity: active ? 1 : 0.5,
      }}
    >
      <View style={styles.rowSpaceBetween}>
        <Text
          style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}
        >
          {inviteRoleLabel(invite.target_role)} invite
        </Text>
        <Text
          style={{
            color: active ? theme.color.success : theme.color.fgMuted,
            fontSize: 13,
            fontWeight: "500",
          }}
        >
          {INVITE_STATUS_LABELS[status]}
        </Text>
      </View>
      <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
        {`Uses: ${inviteUsage(invite)} · ${inviteExpiryLabel(invite, formatDate)}`}
        {` · created ${formatDate(invite.created_at)}`}
      </Text>
      {active ? (
        <Pressable
          onPress={onRevoke}
          disabled={revoking}
          accessibilityRole="button"
          accessibilityLabel={`Revoke ${invite.target_role} invite`}
          accessibilityState={{ disabled: revoking, busy: revoking }}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            paddingVertical: 4,
            opacity: revoking ? 0.45 : pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: theme.color.danger, fontSize: 13 }}>
            {revoking ? "Revoking…" : "Revoke"}
          </Text>
        </Pressable>
      ) : null}
    </Card>
  );
}

const styles = StyleSheet.create({
  rowSpaceBetween: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
  },
});
