import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ReplayData } from "@music-library/core";
import { useTheme } from "../../theme/theme";
import { formatListeningTime, pluralize } from "./format";

/**
 * Headline block for the Replay screen: a huge total-plays figure and the
 * listening-time subline. The period is on the picker right above it.
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
  const plays = pluralize(summary.total_plays, "play", undefined, { locale: true });
  const listened = `${formatListeningTime(summary.total_ms)} listened`;
  // The figure and its noun are styled apart, so they're split back out of
  // the one label; VoiceOver reads the whole line as a single element.
  const figure = summary.total_plays.toLocaleString();
  const noun = plays.slice(figure.length + 1);
  return (
    <View
      accessible
      accessibilityLabel={`Replay, ${periodTitle}: ${plays}, ${listened}`}
      style={[{ paddingHorizontal: theme.space.lg, gap: 4 }, style]}
    >
      <Text
        style={{
          color: theme.color.fg,
          fontSize: 40,
          fontWeight: "600",
          letterSpacing: -0.8,
          fontVariant: ["tabular-nums"],
        }}
      >
        {figure}
      </Text>
      <Text style={{ color: theme.color.fgSubtle, fontSize: 15 }}>
        {noun} · {listened}
      </Text>
    </View>
  );
}
