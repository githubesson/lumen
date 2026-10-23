import { Pressable, StyleSheet, Switch, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { DownloadCoverFan } from "../download-cover-fan";
import { SETTINGS_INSET, SettingsCard, SettingsLinkRow } from "./settings-card";
import {
  useDownloadSummary,
  type DownloadSummary,
} from "../../lib/downloads/download-summary";
import { LOCAL_DEVICE_PHRASE } from "../../lib/device-name";
import { formatBytes, pluralize } from "../../lib/format";
import { offlineStore, useOfflineForced } from "../../lib/offline-mode";
import { useTheme } from "../../theme/theme";

/**
 * "This iPhone" (or iPad): what's downloaded here (a fan of recent covers, the song
 * count and the space they take, opening the list of them), the Offline mode
 * switch that plays only those, and the download log with its problem count.
 */
export function DeviceCard({
  logProblems,
  onOpenDownloads,
  onOpenLog,
}: {
  logProblems: number;
  onOpenDownloads: () => void;
  onOpenLog: () => void;
}) {
  const summary = useDownloadSummary();
  return (
    <SettingsCard>
      <DownloadsStack summary={summary} onOpen={onOpenDownloads} />
      <OfflineModeRow hasDownloads={summary.count > 0} />
      <SettingsLinkRow
        label="Download log"
        icon="doc.text.magnifyingglass"
        border
        badge={logProblems}
        accessibilityLabel={
          logProblems > 0
            ? `Download log, ${pluralize(logProblems, "problem")}`
            : "Download log"
        }
        onPress={onOpenLog}
      />
    </SettingsCard>
  );
}

/** Opens the downloaded songs once there are some; nothing to open before. */
function DownloadsStack({
  summary,
  onOpen,
}: {
  summary: DownloadSummary;
  onOpen: () => void;
}) {
  const theme = useTheme();
  const { ready, count, bytes } = summary;
  const title = !ready
    ? "Downloads"
    : count > 0
      ? pluralize(count, "song", undefined, { locale: true })
      : "No downloads";
  const subtitle = !ready
    ? null
    : count > 0
      ? // Records without a known size add nothing, and formatBytes reads 0
        // as "—".
        bytes > 0
        ? `${formatBytes(bytes)} on ${LOCAL_DEVICE_PHRASE}`
        : `On ${LOCAL_DEVICE_PHRASE}`
      : "Download a playlist to play it offline";
  const accessibilityLabel = subtitle ? `${title}, ${subtitle}` : title;
  // The fan's rings take the row's colour, which a press darkens.
  const content = (background: string) => (
    <>
      <DownloadCoverFan summary={summary} size={48} ringColor={background} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>{subtitle}</Text>
        ) : null}
      </View>
    </>
  );
  if (!ready || count === 0) {
    return (
      <View accessible accessibilityLabel={accessibilityLabel} style={styles.stack}>
        {content(theme.color.bgElev1)}
      </View>
    );
  }
  return (
    <Pressable
      onPress={() => {
        void Haptics.selectionAsync();
        onOpen();
      }}
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityHint="Lists the downloaded songs."
      style={({ pressed }) => [
        styles.stack,
        { backgroundColor: pressed ? theme.color.bgElev2 : "transparent" },
      ]}
    >
      {({ pressed }) => (
        <>
          {content(pressed ? theme.color.bgElev2 : theme.color.bgElev1)}
          <SymbolView name="chevron.right" size={14} tintColor={theme.color.fgMuted} />
        </>
      )}
    </Pressable>
  );
}

function OfflineModeRow({ hasDownloads }: { hasDownloads: boolean }) {
  const theme = useTheme();
  const forced = useOfflineForced();
  return (
    <View
      style={[
        styles.row,
        {
          borderTopWidth: StyleSheet.hairlineWidth,
          borderTopColor: theme.color.separator,
        },
      ]}
    >
      <View style={{ flex: 1, gap: 1 }}>
        <Text style={{ color: theme.color.fg, fontSize: 16 }}>Offline mode</Text>
        <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>
          {hasDownloads ? "Only these play" : "Only downloaded songs play"}
        </Text>
      </View>
      <Switch
        value={forced}
        onValueChange={(value) => {
          void Haptics.selectionAsync();
          offlineStore.setForced(value);
        }}
        trackColor={{ true: theme.color.accent }}
        accessibilityLabel="Offline mode"
        accessibilityHint="Only downloaded music plays, and no network is used until you turn this off."
      />
    </View>
  );
}

const styles = StyleSheet.create({
  stack: {
    flexDirection: "row",
    alignItems: "center",
    gap: SETTINGS_INSET,
    padding: SETTINGS_INSET,
  },
  row: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "center",
    gap: 12,
    paddingHorizontal: SETTINGS_INSET,
    paddingVertical: 11,
  },
});
