import { useMemo } from "react";
import { type ReplayActivityBucket, type ReplayBucket } from "../api";

interface Props {
  buckets: ReplayActivityBucket[];
  bucket: ReplayBucket;
}

function labelFor(date: Date, bucket: ReplayBucket): string {
  switch (bucket) {
    case "day":
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    case "week":
      return date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      });
    case "month":
      return date.toLocaleDateString(undefined, {
        month: "short",
        year: "2-digit",
      });
  }
}

function tooltipFor(date: Date, bucket: ReplayBucket): string {
  switch (bucket) {
    case "day":
      return date.toLocaleDateString(undefined, {
        weekday: "short",
        month: "short",
        day: "numeric",
        year: "numeric",
      });
    case "week": {
      const end = new Date(date);
      end.setDate(end.getDate() + 6);
      return `Week of ${date.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
      })} – ${end.toLocaleDateString(undefined, {
        month: "short",
        day: "numeric",
        year: "numeric",
      })}`;
    }
    case "month":
      return date.toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
  }
}

export default function ActivityChart({ buckets, bucket }: Props) {
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
}
