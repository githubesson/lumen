import {
  Pressable,
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { SymbolView } from "expo-symbols";
import { formatDurationSec } from "../../lib/format";
import { useTheme } from "../../theme/theme";
import { SharePanel } from "./share-panel";
import { WaveformRegionSelector } from "./waveform-region-selector";

/**
 * "Snippet" section of the share sheet: the waveform region selector with the
 * selected time range in the header, a 0:00/total scale row, a play/pause
 * preview button, and a hint line. Purely presentational — the preview player
 * and selection state live in the screen.
 */
export function SnippetPanel({
  durationSec,
  startSec,
  endSec,
  currentSec,
  maxStartSec,
  picked,
  playing,
  onStartChange,
  onTogglePreview,
  style,
}: {
  durationSec: number;
  startSec: number;
  endSec: number;
  currentSec: number;
  maxStartSec: number;
  picked: boolean;
  playing: boolean;
  onStartChange: (seconds: number) => void;
  onTogglePreview: () => void;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();

  return (
    <SharePanel
      title="Snippet"
      accessory={
        <Text
          style={{
            color: theme.color.fgMuted,
            fontSize: 13,
            fontVariant: ["tabular-nums"],
          }}
        >
          {formatDurationSec(startSec)} - {formatDurationSec(endSec)}
        </Text>
      }
      style={style}
    >
      <WaveformRegionSelector
        durationSec={durationSec}
        startSec={startSec}
        endSec={endSec}
        currentSec={currentSec}
        maxStartSec={maxStartSec}
        onStartChange={onStartChange}
      />

      <View style={styles.timeRow}>
        <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
          0:00
        </Text>
        <Text style={{ color: theme.color.fgMuted, fontSize: 12 }}>
          {formatDurationSec(durationSec)}
        </Text>
      </View>

      <Pressable
        onPress={onTogglePreview}
        disabled={durationSec <= 0}
        accessibilityRole="button"
        accessibilityLabel={
          playing ? "Pause snippet preview" : "Preview snippet"
        }
        style={({ pressed }) => [
          styles.previewButton,
          {
            opacity: durationSec <= 0 ? 0.45 : pressed ? 0.65 : 1,
            backgroundColor: theme.color.bgElev2,
          },
        ]}
      >
        <SymbolView
          name={playing ? "pause.fill" : "play.fill"}
          size={16}
          weight="semibold"
          tintColor={theme.color.fg}
        />
        <Text style={{ color: theme.color.fg, fontWeight: "700" }}>
          {playing ? "Pause Preview" : "Preview Snippet"}
        </Text>
      </Pressable>

      <Text style={{ color: theme.color.fgMuted }}>
        {picked
          ? "Drag the highlighted region to tune the share clip."
          : "Drag across the waveform to choose the 30-second clip friends will hear."}
      </Text>
    </SharePanel>
  );
}

const styles = StyleSheet.create({
  timeRow: {
    flexDirection: "row",
    justifyContent: "space-between",
  },
  previewButton: {
    minHeight: 44,
    borderRadius: 12,
    borderCurve: "continuous",
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
  },
});
