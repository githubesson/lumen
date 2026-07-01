import type { ReplayBucket } from "@music-library/core";

/**
 * Time window the Replay screen aggregates over. Each variant maps to a
 * stable cache key, a chip label, a hero title, and a from/to/bucket range
 * for the API.
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

/** API date range and activity bucket size for a period. */
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
