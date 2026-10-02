import { memo, useMemo } from "react";
import {
  activityBucketLabel,
  activityChartScale,
} from "@music-library/core/replay/replay";
import { type ReplayActivityBucket, type ReplayBucket } from "../api";
import { pluralize } from "../lib/format";

interface Props {
  buckets: ReplayActivityBucket[];
  bucket: ReplayBucket;
}

// Built once: `toLocaleDateString` sets up a new formatter on every call, and
// every bar needs a tooltip.
const monthDay = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" });
const monthDayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});
const weekdayDate = new Intl.DateTimeFormat(undefined, {
  weekday: "short",
  month: "short",
  day: "numeric",
  year: "numeric",
});
const longMonthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function tooltipFor(date: Date, bucket: ReplayBucket): string {
  switch (bucket) {
    case "day":
      return weekdayDate.format(date);
    case "week": {
      const end = new Date(date);
      end.setDate(end.getDate() + 6);
      return `Week of ${monthDay.format(date)} – ${monthDayYear.format(end)}`;
    }
    case "month":
      return longMonthYear.format(date);
  }
}

/** Memoized: Replay re-renders for player and button state it doesn't show. */
const ActivityChart = memo(function ActivityChart({ buckets, bucket }: Props) {
  const { max, labelStep } = useMemo(() => activityChartScale(buckets), [buckets]);

  if (buckets.length === 0) {
    return (
      <div className="activity-empty">No listening activity in this window.</div>
    );
  }

  return (
    <div className="activity-chart">
      <div className="activity-bars" role="img" aria-label="Listening activity">
        {buckets.map((b, i) => {
          const d = new Date(b.bucket_start);
          const pct = max > 0 ? (b.plays / max) * 100 : 0;
          return (
            <div
              key={b.bucket_start}
              className="activity-col"
              title={`${tooltipFor(d, bucket)} · ${pluralize(b.plays, "play")}`}
            >
              <div className="activity-bar" style={{ height: `${pct}%` }} />
              {i % labelStep === 0 && (
                <div className="activity-tick">
                  {activityBucketLabel(d, bucket, "verbose")}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default ActivityChart;
