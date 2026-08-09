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
import { api, errorMessage, type Invite } from "@music-library/core";
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
    const rows = invitesQuery.data ?? [];
    const active = rows.filter((i) => !i.revoked_at);
    const inactive = rows.filter((i) => !!i.revoked_at);
    return [...active, ...inactive];
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
  const revoked = !!invite.revoked_at;
  const expired =
    invite.expires_at != null && new Date(invite.expires_at) < new Date();
  const exhausted =
    invite.max_uses > 0 && invite.uses >= invite.max_uses;

  const status = revoked
    ? "Revoked"
    : expired
      ? "Expired"
      : exhausted
        ? "Exhausted"
        : "Active";
  const statusColor =
    revoked || expired || exhausted ? theme.color.fgMuted : theme.color.success;

  return (
    <Card
      style={{
        padding: theme.space.md,
        gap: 8,
        opacity: revoked ? 0.5 : 1,
      }}
    >
      <View style={styles.rowSpaceBetween}>
        <Text
          style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}
        >
          {invite.target_role === "admin" ? "Admin invite" : "User invite"}
        </Text>
        <Text style={{ color: statusColor, fontSize: 13, fontWeight: "500" }}>
          {status}
        </Text>
      </View>
      <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
        Uses: {invite.uses} / {invite.max_uses}
        {invite.expires_at
          ? ` · expires ${new Date(invite.expires_at).toLocaleDateString()}`
          : " · no expiry"}
        {` · created ${new Date(invite.created_at).toLocaleDateString()}`}
      </Text>
      {!revoked ? (
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
