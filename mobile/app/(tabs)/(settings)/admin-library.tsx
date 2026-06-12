import { useEffect } from "react";
import {
  ActivityIndicator,
  Alert,
  FlatList,
  Platform,
  Pressable,
  StyleSheet,
  Switch,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack, useRouter } from "expo-router";
import * as Haptics from "expo-haptics";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  libraryChanged,
  type MusicRoot,
  type RescanStatus,
} from "@music-library/core";
import { EmptyState } from "../../../components/empty-state";
import { HeaderIconButton } from "../../../components/header-buttons";
import { Card } from "../../../components/primitives";
import { qk } from "../../../lib/query-keys";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

export default function AdminLibraryScreen() {
  const theme = useTheme();
  const router = useRouter();
  const queryClient = useQueryClient();

  const rootsQuery = useQuery({
    queryKey: qk.adminMusicRoots,
    queryFn: ({ signal }) => api.listMusicRoots({ signal }),
  });

  const rescanQuery = useQuery({
    queryKey: qk.adminRescanStatus,
    queryFn: ({ signal }) => api.rescanStatus({ signal }),
    // Poll every 2s while rescanning so progress updates live.
    refetchInterval: (q) =>
      (q.state.data as RescanStatus | undefined)?.running ? 2000 : false,
    refetchIntervalInBackground: false,
  });

  // Fire library-wide refresh events when a rescan finishes so other screens
  // pull updated lists.
  useEffect(() => {
    if (!rescanQuery.data?.running && rescanQuery.dataUpdatedAt > 0) {
      libraryChanged.emit();
    }
  }, [rescanQuery.data?.running, rescanQuery.dataUpdatedAt]);

  const startRescan = useMutation({
    mutationFn: () => api.startRescan(),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: qk.adminRescanStatus,
      }),
  });

  const toggleEnabled = useMutation({
    mutationFn: ({ id, enabled }: { id: string; enabled: boolean }) =>
      api.setMusicRootEnabled(id, enabled),
    onSuccess: () =>
      void queryClient.invalidateQueries({
        queryKey: qk.adminMusicRoots,
      }),
  });

  const deleteRoot = useMutation({
    mutationFn: ({ id, purge }: { id: string; purge: boolean }) =>
      api.deleteMusicRoot(id, { purge }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: qk.adminMusicRoots,
      });
      libraryChanged.emit();
    },
  });

  const onDelete = (root: MusicRoot) => {
    Alert.alert(
      `Remove "${root.label || root.path}"?`,
      "You can remove just the root, or also purge tracks that came from it.",
      [
        { text: "Cancel", style: "cancel" },
        {
          text: "Keep tracks",
          onPress: () => deleteRoot.mutate({ id: root.id, purge: false }),
        },
        {
          text: "Remove and purge",
          style: "destructive",
          onPress: () => deleteRoot.mutate({ id: root.id, purge: true }),
        },
      ],
    );
  };

  const renderItem = ({ item }: ListRenderItemInfo<MusicRoot>) => (
    <RootCard
      root={item}
      theme={theme}
      onToggle={(enabled) => toggleEnabled.mutate({ id: item.id, enabled })}
      onDelete={() => onDelete(item)}
    />
  );

  const status = rescanQuery.data;

  return (
    <>
      <Stack.Screen
        options={{
          headerRight: () => (
            <HeaderIconButton
              icon="plus"
              label="Add music root"
              onPress={() => {
                void Haptics.selectionAsync();
                router.push("/(tabs)/(settings)/admin-add-root");
              }}
            />
          ),
        }}
      />
      <FlatList
        data={rootsQuery.data ?? []}
        renderItem={renderItem}
        keyExtractor={(r) => r.id}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.md,
          paddingBottom: theme.space.xl * 2,
        }}
        ItemSeparatorComponent={() => (
          <View style={{ height: theme.space.md }} />
        )}
        ListHeaderComponent={
          <RescanHeader
            status={status}
            theme={theme}
            pending={startRescan.isPending}
            onStart={() => {
              void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
              startRescan.mutate();
            }}
          />
        }
        ListEmptyComponent={
          rootsQuery.isLoading ? (
            <EmptyState loading />
          ) : (
            <EmptyState
              selectable
              message="No music roots yet. Tap + to add one."
            />
          )
        }
      />
    </>
  );
}

function RescanHeader({
  status,
  theme,
  pending,
  onStart,
}: {
  status: RescanStatus | undefined;
  theme: ThemeTokens;
  pending: boolean;
  onStart: () => void;
}) {
  const running = !!status?.running;
  return (
    <Card
      style={{
        padding: theme.space.md,
        gap: 8,
        marginBottom: theme.space.md,
      }}
    >
      <View style={styles.rowSpaceBetween}>
        <Text
          style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}
        >
          Rescan
        </Text>
        {running ? (
          <ActivityIndicator color={theme.color.fgMuted} />
        ) : (
          <Pressable
            onPress={onStart}
            disabled={pending}
            style={({ pressed }) => ({
              paddingVertical: 6,
              paddingHorizontal: 12,
              backgroundColor: theme.color.accent,
              borderRadius: 6,
              opacity: pressed || pending ? 0.8 : 1,
              borderCurve: "continuous",
            })}
          >
            <Text
              style={{ color: theme.color.onAccent, fontSize: 13, fontWeight: "600" }}
            >
              Start
            </Text>
          </Pressable>
        )}
      </View>
      {status && running ? (
        <Text
          selectable
          style={{ color: theme.color.fgMuted, fontSize: 12, fontVariant: ["tabular-nums"] }}
        >
          {status.processed ?? 0}/{status.total ?? "?"} processed ·{" "}
          {status.inserted ?? 0} inserted · {status.dedup ?? 0} deduped ·{" "}
          {status.errored ?? 0} errors
        </Text>
      ) : (
        <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
          Scan all enabled roots for new or changed tracks.
        </Text>
      )}
    </Card>
  );
}

function RootCard({
  root,
  theme,
  onToggle,
  onDelete,
}: {
  root: MusicRoot;
  theme: ThemeTokens;
  onToggle: (enabled: boolean) => void;
  onDelete: () => void;
}) {
  return (
    <Card
      style={{
        padding: theme.space.md,
        gap: 8,
        opacity: root.exists ? 1 : 0.6,
      }}
    >
      <View style={styles.rowSpaceBetween}>
        <Text
          style={{ color: theme.color.fg, fontSize: 15, fontWeight: "600" }}
          numberOfLines={1}
        >
          {root.label || root.path}
        </Text>
        <Switch
          value={root.enabled}
          onValueChange={onToggle}
          trackColor={{ true: theme.color.accent, false: theme.color.bgElev2 }}
        />
      </View>
      {root.label ? (
        <Text
          style={{
            color: theme.color.fgMuted,
            fontSize: 12,
            fontFamily: Platform.select({ ios: "Menlo", default: "monospace" }),
          }}
          numberOfLines={2}
          selectable
        >
          {root.path}
        </Text>
      ) : null}
      <View style={styles.rowSpaceBetween}>
        <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
          {root.primary ? "Primary · " : ""}
          {root.exists ? "Available" : "Missing"}
        </Text>
        <Pressable
          onPress={onDelete}
          style={({ pressed }) => ({
            paddingVertical: 4,
            opacity: pressed ? 0.6 : 1,
          })}
        >
          <Text style={{ color: theme.color.danger, fontSize: 13 }}>Remove</Text>
        </Pressable>
      </View>
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
