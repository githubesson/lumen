import { StyleSheet, Switch, Text, View } from "react-native";
import { SymbolView } from "expo-symbols";
import * as Haptics from "expo-haptics";
import { CoverArt } from "../cover-art";
import { SETTINGS_INSET, SettingsCard, SettingsLinkRow } from "./settings-card";
import {
  useDownloadSummary,
  type DownloadSummary,
} from "../../lib/downloads/download-summary";
import { formatBytes, pluralize } from "../../lib/format";
import { offlineStore, useOfflineForced } from "../../lib/offline-mode";
import { useTheme } from "../../theme/theme";

const COVER = 48;
const FAN_STEP = 14;
const FAN_TILT_DEG = 4;
const FAN_HEIGHT = 54;

/**
 * "This iPhone": what's downloaded here (a fan of recent covers, the song
 * count and the space they take), the Offline mode switch that plays only
 * those, and the download log with its problem count.
 */
export function DeviceCard({
  logProblems,
  onOpenLog,
}: {
  logProblems: number;
  onOpenLog: () => void;
}) {
  const summary = useDownloadSummary();
  return (
    <SettingsCard>
      <DownloadsStack summary={summary} />
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

function DownloadsStack({ summary }: { summary: DownloadSummary }) {
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
      ? `${formatBytes(bytes)} on this iPhone`
      : "Download a playlist to play it offline";
  return (
    <View
      accessible
      accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
      style={styles.stack}
    >
      <CoverFan summary={summary} />
      <View style={{ flex: 1, gap: 2 }}>
        <Text style={{ color: theme.color.fg, fontSize: 17, fontWeight: "600" }}>
          {title}
        </Text>
        {subtitle ? (
          <Text style={{ color: theme.color.fgMuted, fontSize: 13 }}>{subtitle}</Text>
        ) : null}
      </View>
    </View>
  );
}

/** Up to four covers fanned out, the newest on top; a download glyph when empty. */
function CoverFan({ summary }: { summary: DownloadSummary }) {
  const theme = useTheme();
  // Drawn oldest first, so the newest lands on top.
  const covers = [...summary.recent].reverse();
  const count = Math.max(1, covers.length);
  const middle = (count - 1) / 2;
  const shadow =
    theme.scheme === "dark"
      ? "0 4px 10px rgba(0, 0, 0, 0.35)"
      : "0 4px 10px rgba(0, 0, 0, 0.16)";
  return (
    <View style={{ width: COVER + (count - 1) * FAN_STEP, height: FAN_HEIGHT }}>
      {covers.length === 0 ? (
        <View
          style={[
            styles.fanCard,
            styles.placeholder,
            { left: 0, backgroundColor: theme.color.bgElev2 },
          ]}
        >
          <SymbolView
            name="arrow.down.circle"
            size={22}
            tintColor={theme.color.fgMuted}
          />
        </View>
      ) : (
        covers.map((cover, i) => (
          <View
            key={cover.trackId}
            style={[
              styles.fanCard,
              {
                left: i * FAN_STEP,
                zIndex: i,
                transform: [{ rotate: `${(i - middle) * FAN_TILT_DEG}deg` }],
                // A ring in the card's colour parts each cover from the one under it.
                outlineWidth: 1.5,
                outlineColor: theme.color.bgElev1,
                outlineStyle: "solid",
                boxShadow: shadow,
              },
            ]}
          >
            <CoverArt
              track={cover.track ?? { id: cover.trackId }}
              size={COVER}
              radius={8}
              transitionMs={0}
            />
          </View>
        ))
      )}
    </View>
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
  fanCard: {
    position: "absolute",
    top: (FAN_HEIGHT - COVER) / 2,
    width: COVER,
    height: COVER,
    borderRadius: 8,
    borderCurve: "continuous",
  },
  placeholder: {
    alignItems: "center",
    justifyContent: "center",
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
