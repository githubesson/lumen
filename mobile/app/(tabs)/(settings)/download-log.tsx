import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from "react";
import {
  Alert,
  FlatList,
  Pressable,
  StyleSheet,
  Text,
  View,
  type ListRenderItemInfo,
} from "react-native";
import { Stack } from "expo-router";
import { SymbolView } from "expo-symbols";
import * as Clipboard from "expo-clipboard";
import * as Haptics from "expo-haptics";
import { EmptyState } from "../../../components/empty-state";
import { Card } from "../../../components/primitives";
import { SegmentedControl } from "../../../components/segmented-control";
import { diagnosticsLog, type LogEntry } from "../../../lib/diagnostics/log";
import { useTheme, type ThemeTokens } from "../../../theme/theme";

/**
 * Viewer for the on-disk diagnostics log — why a download failed, when, and
 * what the server actually said.
 *
 * The file is the source of truth: it is re-read (debounced) whenever the log
 * reports a write, so a sync running in another screen shows up here live.
 */

type Mode = "recent" | "problems" | "grouped";

/** Rendering every line of a full log is pointless — the tail is what matters. */
const MAX_ROWS = 500;
/** Coalesce the burst of writes a playlist sync produces into one re-read. */
const RELOAD_DEBOUNCE_MS = 250;
/** The palette has no warning token; amber matches the iOS system colour. */
const WARN_COLOR = "#FF9500";

interface Row {
  key: string;
  entry: LogEntry;
  /** Lines collapsed into this row (grouped mode); 1 otherwise. */
  count: number;
  /** Attempts represented, including ones the log suppressed as duplicates. */
  attempts: number;
  firstAt?: number;
}

export default function DownloadLogScreen() {
  const theme = useTheme();
  const [mode, setMode] = useState<Mode>("recent");
  const [entries, setEntries] = useState<LogEntry[] | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const version = useSyncExternalStore(
    diagnosticsLog.subscribe,
    diagnosticsLog.getVersion,
    diagnosticsLog.getVersion,
  );

  // Parsing is synchronous and blocks the JS thread, so it stays off the
  // render path and out of the write burst.
  useEffect(() => {
    const timer = setTimeout(
      () => setEntries(diagnosticsLog.read()),
      RELOAD_DEBOUNCE_MS,
    );
    return () => clearTimeout(timer);
  }, [version]);

  const rows = useMemo<Row[]>(() => {
    const all = entries ?? [];
    if (mode === "grouped") return groupRows(all).slice(0, MAX_ROWS);
    const filtered =
      mode === "problems" ? all.filter((e) => e.level !== "info") : all;
    return filtered.slice(0, MAX_ROWS).map((entry, index) => ({
      key: `${entry.at}-${index}`,
      entry,
      count: 1,
      attempts: entry.attempt ?? 1,
    }));
  }, [entries, mode]);

  const problemCount = useMemo(
    () => (entries ?? []).filter((e) => e.level !== "info").length,
    [entries],
  );

  const toggle = useCallback((key: string) => {
    void Haptics.selectionAsync();
    setExpanded((current) => {
      const next = new Set(current);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  }, []);

  const onCopy = useCallback(async () => {
    // Copies the raw file contents, not the current filter — the whole point
    // is to paste the unabridged log somewhere else.
    const text = diagnosticsLog
      .read()
      .map((entry) => JSON.stringify(entry))
      .join("\n");
    await Clipboard.setStringAsync(text || "(empty)");
    void Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, []);

  const onClear = useCallback(() => {
    Alert.alert("Clear the log?", "Recorded download events are deleted.", [
      { text: "Cancel", style: "cancel" },
      {
        text: "Clear",
        style: "destructive",
        onPress: () => {
          diagnosticsLog.clear();
          setExpanded(new Set());
        },
      },
    ]);
  }, []);

  const renderItem = ({ item }: ListRenderItemInfo<Row>) => (
    <EntryRow
      row={item}
      theme={theme}
      expanded={expanded.has(item.key)}
      onPress={() => toggle(item.key)}
    />
  );

  return (
    <>
      <Stack.Screen options={{ title: "Download log" }} />
      <FlatList
        data={rows}
        renderItem={renderItem}
        keyExtractor={(row) => row.key}
        contentInsetAdjustmentBehavior="automatic"
        style={{ backgroundColor: theme.color.bg }}
        contentContainerStyle={{
          padding: theme.space.lg,
          gap: theme.space.sm,
        }}
        ListHeaderComponent={
          <View style={{ gap: theme.space.md, paddingBottom: theme.space.md }}>
            <SegmentedControl<Mode>
              options={[
                { label: "Recent", value: "recent" },
                { label: "Problems", value: "problems" },
                { label: "Grouped", value: "grouped" },
              ]}
              value={mode}
              onChange={setMode}
            />
            <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
              {entries === null
                ? "Reading…"
                : `${entries.length} entr${entries.length === 1 ? "y" : "ies"} · ${problemCount} problem${problemCount === 1 ? "" : "s"} · ${formatBytes(diagnosticsLog.sizeBytes())}`}
            </Text>
            <Card style={{ overflow: "hidden" }}>
              <ActionRow
                label="Copy log"
                icon="doc.on.doc"
                theme={theme}
                onPress={() => void onCopy()}
              />
              <ActionRow
                label="Clear log"
                icon="trash"
                theme={theme}
                tone="danger"
                border
                onPress={onClear}
              />
            </Card>
          </View>
        }
        ListEmptyComponent={
          entries === null ? (
            <EmptyState loading />
          ) : (
            <EmptyState
              selectable
              message={
                mode === "problems"
                  ? "No failures recorded. Downloads that fail will show up here."
                  : "Nothing logged yet."
              }
            />
          )
        }
      />
    </>
  );
}

function EntryRow({
  row,
  theme,
  expanded,
  onPress,
}: {
  row: Row;
  theme: ThemeTokens;
  expanded: boolean;
  onPress: () => void;
}) {
  const { entry } = row;
  const tone =
    entry.level === "error"
      ? theme.color.danger
      : entry.level === "warn"
        ? WARN_COLOR
        : theme.color.fgMuted;
  return (
    <Card style={{ overflow: "hidden" }}>
      <Pressable
        onPress={onPress}
        style={({ pressed }) => ({
          padding: theme.space.md,
          gap: 4,
          backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
        })}
      >
        <View style={styles.row}>
          <View style={{ flexDirection: "row", alignItems: "center", gap: 8 }}>
            <View
              style={{
                width: 8,
                height: 8,
                borderRadius: 4,
                backgroundColor: tone,
              }}
            />
            <Text
              style={{ color: theme.color.fgMuted, fontSize: 12 }}
              numberOfLines={1}
            >
              {formatWhen(entry.at)} · {entry.event}
            </Text>
          </View>
          {row.attempts > 1 ? (
            <Text style={{ color: tone, fontSize: 12, fontWeight: "600" }}>
              ×{row.attempts}
            </Text>
          ) : null}
        </View>
        <Text style={{ color: theme.color.fg, fontSize: 15 }}>
          {entry.message}
        </Text>
        {entry.title ? (
          <Text
            style={{ color: theme.color.fgMuted, fontSize: 13 }}
            numberOfLines={expanded ? undefined : 1}
          >
            {entry.title}
          </Text>
        ) : null}
        {expanded ? <Detail entry={entry} row={row} theme={theme} /> : null}
      </Pressable>
    </Card>
  );
}

function Detail({
  entry,
  row,
  theme,
}: {
  entry: LogEntry;
  row: Row;
  theme: ThemeTokens;
}) {
  const fields: [string, string | undefined][] = [
    ["Track", entry.trackId],
    ["Source", entry.source],
    ["Playlist", entry.playlistId],
    ["Owner", entry.owner],
    ["HTTP", entry.status != null ? String(entry.status) : undefined],
    [
      "Error code",
      entry.errorCode != null ? String(entry.errorCode) : undefined,
    ],
    ["Content type", entry.contentType],
    ["Bytes", entry.bytes != null ? String(entry.bytes) : undefined],
    ["Network", entry.net],
    ["App", entry.appState],
    [
      "First seen",
      row.firstAt && row.firstAt !== entry.at
        ? formatWhen(row.firstAt)
        : undefined,
    ],
    ["URL", entry.url],
  ];
  return (
    <View style={{ gap: 4, paddingTop: theme.space.sm }}>
      {entry.body ? (
        <View
          style={{
            backgroundColor: theme.color.bgElev2,
            borderRadius: theme.radius.sm,
            borderCurve: "continuous",
            padding: theme.space.sm,
            marginBottom: 4,
          }}
        >
          <Text
            selectable
            style={{
              color: theme.color.fg,
              fontSize: 12,
              fontFamily: "Menlo",
            }}
          >
            {entry.body}
          </Text>
        </View>
      ) : null}
      {fields.map(([label, value]) =>
        value ? (
          <View key={label} style={styles.row}>
            <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
              {label}
            </Text>
            <Text
              selectable
              style={{
                color: theme.color.fgMuted,
                fontSize: 12,
                flexShrink: 1,
                textAlign: "right",
              }}
            >
              {value}
            </Text>
          </View>
        ) : null,
      )}
    </View>
  );
}

function ActionRow({
  label,
  icon,
  onPress,
  theme,
  tone,
  border,
}: {
  label: string;
  icon: Parameters<typeof SymbolView>[0]["name"];
  onPress: () => void;
  theme: ThemeTokens;
  tone?: "danger";
  border?: boolean;
}) {
  const color = tone === "danger" ? theme.color.danger : theme.color.accent;
  return (
    <Pressable
      onPress={onPress}
      style={({ pressed }) => ({
        flexDirection: "row",
        alignItems: "center",
        gap: 12,
        paddingHorizontal: theme.space.md,
        paddingVertical: 14,
        borderTopWidth: border ? StyleSheet.hairlineWidth : 0,
        borderTopColor: theme.color.separator,
        backgroundColor: pressed ? theme.color.bgElev2 : "transparent",
      })}
    >
      <SymbolView name={icon} size={18} tintColor={color} />
      <Text style={{ color, fontSize: 16 }}>{label}</Text>
    </Pressable>
  );
}

/**
 * Collapse repeats of the same failure into one row, newest first. The log
 * already suppresses duplicates inside a short window; this covers the same
 * failure recurring across hours of retries.
 */
function groupRows(entries: LogEntry[]): Row[] {
  const groups = new Map<string, Row>();
  for (const entry of entries) {
    const key = `${entry.event}|${entry.trackId ?? ""}|${entry.message}`;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
      existing.attempts += entry.attempt ?? 1;
      // `entries` is newest-first, so anything seen later is older.
      existing.firstAt = entry.at;
      continue;
    }
    groups.set(key, {
      key,
      entry,
      count: 1,
      attempts: entry.attempt ?? 1,
      firstAt: entry.at,
    });
  }
  return [...groups.values()];
}

function formatWhen(at: number): string {
  const date = new Date(at);
  const today = new Date();
  const sameDay =
    date.getDate() === today.getDate() &&
    date.getMonth() === today.getMonth() &&
    date.getFullYear() === today.getFullYear();
  const time = date.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  if (sameDay) return time;
  const day = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
  return `${day} ${time}`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const styles = StyleSheet.create({
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
  },
});
