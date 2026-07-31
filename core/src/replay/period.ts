/**
 * The time window the Replay screen aggregates over.
 *
 * This was duplicated between `frontend/src/pages/Replay.tsx` and
 * `mobile/components/replay/period.ts`. The date arithmetic (`periodRange`)
 * and the cache key were identical; the label strings and the picker order had
 * already drifted. The arithmetic is the part that must never diverge — a
 * wrong `from`/`to` silently returns the wrong numbers — so it is shared
 * outright, while the one label difference that reads as a deliberate platform
 * choice is a parameter rather than two implementations.
 */

import type { ReplayBucket } from "../api";

/**
 * Each variant maps to a stable cache key, a chip label, a hero title, and a
 * from/to/bucket range for the API.
 */
export type Period =
  | { kind: "all" }
  | { kind: "this-year" }
  | { kind: "year"; year: number }
  | { kind: "this-month" }
  | { kind: "last-30" };

/** Stable string key for query caching and picker selection. */
export function periodKey(p: Period): string {
  switch (p.kind) {
    case "all":
      return "all";
    case "this-year":
      return "this-year";
    case "year":
      return `year:${p.year}`;
    case "this-month":
      return "this-month";
    case "last-30":
      return "last-30";
  }
}

/** Short label for the period picker chips. */
export function periodLabel(p: Period): string {
  switch (p.kind) {
    case "all":
      return "All time";
    case "this-year":
      return "This year";
    case "year":
      return String(p.year);
    case "this-month":
      return "This month";
    case "last-30":
      return "Last 30 days";
  }
}

/** Fuller title for the hero, playlist names, and share images. */
export function periodTitle(p: Period): string {
  switch (p.kind) {
    case "all":
      return "All time";
    case "this-year":
      return `This year · ${new Date().getFullYear()}`;
    case "year":
      return String(p.year);
    case "this-month":
      return new Date().toLocaleDateString(undefined, {
        month: "long",
        year: "numeric",
      });
    case "last-30":
      return "Last 30 days";
  }
}

/**
 * API date range and activity bucket size for a period.
 *
 * The boundaries are built in UTC deliberately: the backend stores play
 * timestamps in UTC, so deriving them from local-time components would shift
 * every window by the viewer's offset and move plays between buckets.
 */
export function periodRange(p: Period): {
  from?: string;
  to?: string;
  bucket?: ReplayBucket;
} {
  const now = new Date();
  switch (p.kind) {
    case "all":
      return { bucket: "month" };
    case "this-year": {
      const from = new Date(Date.UTC(now.getFullYear(), 0, 1));
      const to = new Date(Date.UTC(now.getFullYear() + 1, 0, 1));
      return { from: from.toISOString(), to: to.toISOString(), bucket: "month" };
    }
    case "year": {
      const from = new Date(Date.UTC(p.year, 0, 1));
      const to = new Date(Date.UTC(p.year + 1, 0, 1));
      return { from: from.toISOString(), to: to.toISOString(), bucket: "month" };
    }
    case "this-month": {
      const from = new Date(Date.UTC(now.getFullYear(), now.getMonth(), 1));
      const to = new Date(Date.UTC(now.getFullYear(), now.getMonth() + 1, 1));
      return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
    }
    case "last-30": {
      const to = new Date();
      const from = new Date(to.getTime() - 30 * 24 * 60 * 60 * 1000);
      return { from: from.toISOString(), to: to.toISOString(), bucket: "day" };
    }
  }
}

/**
 * Picker options: the evergreen windows first, then any past years the
 * server has plays for, then "All time".
 */
export function buildPeriodOptions(availableYears: number[]): Period[] {
  const currentYear = new Date().getFullYear();
  const out: Period[] = [
    { kind: "this-year" },
    { kind: "last-30" },
    { kind: "this-month" },
  ];
  for (const y of availableYears) {
    if (y === currentYear) continue;
    out.push({ kind: "year", year: y });
  }
  out.push({ kind: "all" });
  return out;
}

/**
 * How verbosely to spell a listening total.
 *
 * The two clients disagreed here and the disagreement is legitimate rather
 * than accidental drift: the phone renders this inside narrow summary tiles
 * where "45m" fits and "45 min" wraps, while the web has room for the fuller
 * wording. Compound values ("2d 4h", "3h 12m") are identical either way — only
 * the single-unit tail differs.
 */
export type ListeningTimeStyle = "compact" | "verbose";

/** Listening total in ms -> "2d 4h" / "3h 12m" / "45m". */
export function formatListeningTime(
  ms: number,
  style: ListeningTimeStyle = "compact",
): string {
  const verbose = style === "verbose";
  if (ms <= 0) return verbose ? "0 min" : "0m";
  const totalMinutes = Math.floor(ms / 60_000);
  const days = Math.floor(totalMinutes / (60 * 24));
  const hours = Math.floor((totalMinutes - days * 60 * 24) / 60);
  const minutes = totalMinutes - days * 60 * 24 - hours * 60;
  if (days >= 1) {
    if (hours > 0) return `${days}d ${hours}h`;
    return verbose ? `${days} ${days === 1 ? "day" : "days"}` : `${days}d`;
  }
  if (hours >= 1) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  return verbose ? `${minutes} min` : `${minutes}m`;
}
