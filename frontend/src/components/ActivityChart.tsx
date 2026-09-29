import { memo, useMemo } from "react";
import { type ReplayActivityBucket, type ReplayBucket } from "../api";

interface Props {
  buckets: ReplayActivityBucket[];
  bucket: ReplayBucket;
}

// Built once: `toLocaleDateString` sets up a new formatter on every call, and
// every bar needs a tooltip (and some a label).
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
const shortMonthYear = new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" });
const longMonthYear = new Intl.DateTimeFormat(undefined, { month: "long", year: "numeric" });

function labelFor(date: Date, bucket: ReplayBucket): string {
  switch (bucket) {
    case "day":
    case "week":
      return monthDay.format(date);
    case "month":
      return shortMonthYear.format(date);
  }
}

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
  const max = useMemo(
    () => buckets.reduce((m, b) => Math.max(m, b.plays), 0),
    [buckets],
  );

  if (buckets.length === 0) {
    return (
      <div className="activity-empty">No listening activity in this window.</div>
    );
  }

  // Show ~6 labels along the x-axis so they don't overlap.
  const labelStep = Math.max(1, Math.ceil(buckets.length / 6));

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
              title={`${tooltipFor(d, bucket)} · ${b.plays} ${
                b.plays === 1 ? "play" : "plays"
              }`}
            >
              <div className="activity-bar" style={{ height: `${pct}%` }} />
              {i % labelStep === 0 && (
                <div className="activity-tick">{labelFor(d, bucket)}</div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
});

export default ActivityChart;
