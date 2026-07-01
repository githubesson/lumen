import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import type { ReplayData } from "@music-library/core";
import { Card } from "../primitives";
import { useTheme } from "../../theme/theme";
import { HairlineSeparator } from "../hairline-separator";

/**
 * Card of genre rows with a proportional accent bar and percent-of-plays
 * figure per genre.
 */
export function GenreList({
  genres,
  style,
}: {
  genres: ReplayData["top_genres"];
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const total = genres.reduce((acc, g) => acc + g.plays, 0);
  return (
    <Card style={[{ overflow: "hidden" }, style]}>
      {genres.map((g, i) => {
        const pct = total > 0 ? (g.plays / total) * 100 : 0;
        return (
          <View key={g.genre}>
            {i > 0 && <HairlineSeparator inset={14} />}
            <View
              style={{
                paddingHorizontal: 14,
                paddingVertical: 12,
                flexDirection: "row",
                alignItems: "center",
                gap: 12,
              }}
            >
              <Text
                numberOfLines={1}
                style={{
                  color: theme.color.fg,
                  fontSize: 15,
                  flex: 1,
                  minWidth: 0,
                }}
              >
                {g.genre}
              </Text>
              <View
                style={{
                  flex: 1.5,
                  height: 6,
                  borderRadius: 999,
                  backgroundColor: theme.color.bgElev2,
                  overflow: "hidden",
                }}
              >
                <View
                  style={{
                    width: `${pct}%`,
                    height: "100%",
                    backgroundColor: theme.color.accent,
                    borderRadius: 999,
                  }}
                />
              </View>
              <Text
                style={{
                  color: theme.color.fgMuted,
                  fontSize: 12,
                  width: 56,
                  textAlign: "right",
                  fontVariant: ["tabular-nums"],
                }}
              >
                {pct.toFixed(0)}%
              </Text>
            </View>
          </View>
        );
      })}
    </Card>
  );
}
