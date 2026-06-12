import { useMemo, useState } from "react";
import {
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import * as Clipboard from "expo-clipboard";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, type Invite } from "@music-library/core";
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
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: qk.adminInvites }),
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
    <InviteCard invite={item} theme={theme} onRevoke={() => onRevoke(item)} />
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
  onRevoke,
}: {
  invite: Invite;
  theme: ThemeTokens;
  onRevoke: () => void;
}) {
  const [copied, setCopied] = useState(false);
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

  const tokenString = invite.token ?? invite.id;
  const onCopy = async () => {
    try {
      await Clipboard.setStringAsync(tokenString);
      void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* ignored */
    }
  };

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
      <Pressable
        onPress={onCopy}
        accessibilityRole="button"
        accessibilityLabel="Copy invite token"
        style={({ pressed }) => ({
          flexDirection: "row",
          alignItems: "center",
          gap: 6,
          backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
          marginHorizontal: -4,
          paddingHorizontal: 4,
          paddingVertical: 2,
          borderRadius: 4,
          borderCurve: "continuous",
        })}
      >
        <Text
          selectable
          numberOfLines={1}
          ellipsizeMode="middle"
          style={{
            flex: 1,
            color: theme.color.fgMuted,
            fontSize: 12,
            fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
          }}
        >
          {tokenString}
        </Text>
        <SymbolView
          name={copied ? "checkmark" : "doc.on.doc"}
          size={14}
          tintColor={copied ? theme.color.success : theme.color.fgMuted}
        />
      </Pressable>
      <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
        Uses: {invite.uses}
        {invite.max_uses > 0 ? ` / ${invite.max_uses}` : " / ∞"}
        {invite.expires_at
          ? ` · expires ${new Date(invite.expires_at).toLocaleDateString()}`
          : ""}
      </Text>
      {!revoked ? (
        <Pressable
          onPress={onRevoke}
          style={({ pressed }) => ({
            alignSelf: "flex-start",
            paddingVertical: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: theme.color.danger, fontSize: 13 }}>Revoke</Text>
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
