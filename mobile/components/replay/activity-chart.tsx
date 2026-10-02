import { useMemo } from "react";
import { Text, View, type StyleProp, type ViewStyle } from "react-native";
import {
  activityBucketLabel,
  activityChartScale,
  type ReplayBucket,
  type ReplayData,
} from "@music-library/core";
import { Card } from "../primitives";
import { useTheme } from "../../theme/theme";

/**
 * Bar chart card of plays per time bucket, with a sparse axis-label row
 * underneath (~6 ticks max so labels don't overlap).
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
    <Card style={[{ padding: 14 }, style]}>
      <View
        style={{
          flexDirection: "row",
          alignItems: "flex-end",
          height: 120,
          gap: 3,
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
                  backgroundColor: theme.color.accent,
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
          marginTop: 6,
          gap: 3,
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
                    fontSize: 10,
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
