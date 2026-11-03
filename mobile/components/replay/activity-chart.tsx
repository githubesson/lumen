import { useMemo } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import {
  activityBucketLabel,
  activityChartScale,
  type ReplayBucket,
  type ReplayData,
} from "@music-library/core";
import { Card } from "../primitives";
import { useTheme, withAlpha } from "../../theme/theme";

/**
 * Bar chart card of plays per time bucket, with a sparse axis-label row
 * underneath (~6 ticks max so labels don't overlap). Only the busiest bucket
 * takes the accent; the rest sit back in a neutral.
 */
export function ActivityChart({
  buckets,
  bucket,
  style,
}: {
  buckets: ReplayData["activity"];
  bucket: ReplayBucket;
  style?: StyleProp<ViewStyle>;
}) {
  const theme = useTheme();
  const { max, labelStep } = useMemo(() => activityChartScale(buckets), [buckets]);

  return (
    <Card style={[{ padding: 16 }, style]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          height: 160,
          gap: 2,
        }}
      >
        {buckets.map((b) => {
          const pct = max > 0 ? (b.plays / max) * 100 : 0;
          return (
            <View
              key={b.bucket_start}
              style={{
                flex: 1,
                height: "100%",
                justifyContent: "flex-end",
              }}
            >
              <View
                style={{
                  height: `${pct}%`,
                  minHeight: 2,
                  backgroundColor:
                    max > 0 && b.plays === max
                      ? theme.color.accent
                      : withAlpha(theme.color.fgMuted, 0.45),
                  borderRadius: 2,
                  borderTopLeftRadius: 3,
                  borderTopRightRadius: 3,
                }}
              />
            </View>
          );
        })}
      </View>
      <View
        style={{
          flexDirection: "row",
          marginTop: 8,
          gap: 2,
        }}
      >
        {buckets.map((b, i) => {
          const show = i % labelStep === 0;
          return (
            <View
              key={b.bucket_start}
              style={{ flex: 1, alignItems: "center" }}
            >
              {show ? (
                <Text
                  style={{
                    color: theme.color.fgMuted,
                    fontSize: 11,
                    fontVariant: ["tabular-nums"],
                  }}
                >
                  {activityBucketLabel(new Date(b.bucket_start), bucket, "compact")}
                </Text>
              ) : null}
            </View>
          );
        })}
      </View>
    </Card>
  );
}
