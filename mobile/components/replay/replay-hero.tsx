import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ReplayData } from "@music-library/core";
import { useTheme } from "../../theme/theme";
import { formatListeningTime } from "./format";

/**
 * Headline block for the Replay screen: eyebrow with the period title, a
 * huge total-plays figure, and the listening-time subline.
 */
export function ReplayHero({
  periodTitle,
  summary,
  style,
}: {
  periodTitle: string;
  summary: ReplayData["summary"];
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  return (
    <View style={[{ paddingHorizontal: theme.space.lg, gap: 4 }, style]}>
      <Text
        style={{
          color: theme.color.fgMuted,
          fontSize: 12,
          letterSpacing: 0.8,
          textTransform: "uppercase",
          fontVariant: ["tabular-nums"],
        }}
      >
        Replay · {periodTitle}
      </Text>
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 40,
          fontWeight: "700",
          letterSpacing: -1,
          fontVariant: ["tabular-nums"],
        }}
      >
        {summary.total_plays.toLocaleString()}
      </Text>
      <Text style={{ color: theme.color.fgSubtle, fontSize: 15 }}>
        {summary.total_plays === 1 ? "play" : "plays"} ·{" "}
        {formatListeningTime(summary.total_ms)} listened
      </Text>
    </View>
  );
}
