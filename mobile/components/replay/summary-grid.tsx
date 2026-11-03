import {
  StyleSheet,
  Text,
  View,
  type StyleProp,
  type ViewStyle,
} from "react-native";
import { displayText, type ReplayData } from "@music-library/core";
import { Card } from "../primitives";
import { useTheme } from "../../theme/theme";

/**
 * Stat card (unique tracks and artists side by side, the top artist below)
 * with hairline dividers between the cells. Listening time is in the hero.
 */
export function SummaryGrid({
  summary,
  style,
}: {
  summary: ReplayData["summary"];
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const items: { label: string; value: string }[] = [
    {
      label: "Tracks",
      value: summary.unique_tracks.toLocaleString(),
    },
    {
      label: "Artists",
      value: summary.unique_artists.toLocaleString(),
    },
    {
      label: "Top artist",
      value: displayText(summary.headline_artist?.name) || "—",
    },
  ];
  return (
    <Card
      style={[
        {
          overflow: "hidden",
          flexDirection: "row",
          flexWrap: "wrap",
        },
        style,
      ]}
    >
      {items.map((item, i) => {
        const isRight = i === 1;
        const isBottom = i === 2;
        return (
          <View
            key={item.label}
            style={{
              width: isBottom ? "100%" : "50%",
              padding: 16,
              borderLeftWidth: isRight ? StyleSheet.hairlineWidth : 0,
              borderTopWidth: isBottom ? StyleSheet.hairlineWidth : 0,
              borderColor: theme.color.separator,
            }}
          >
            <Text
              numberOfLines={1}
              style={{
                color: theme.color.fgMuted,
                fontSize: 13,
              }}
            >
              {item.label}
            </Text>
            <Text
              numberOfLines={1}
              style={{
                color: theme.color.fg,
                fontSize: 20,
                fontWeight: "600",
                marginTop: 4,
                fontVariant: ["tabular-nums"],
              }}
            >
              {item.value}
            </Text>
          </View>
        );
      })}
    </Card>
  );
}
