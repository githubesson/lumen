import { afterAll, describe, expect, it, vi } from "vitest";

// Pinned before anything formats a date: the chart labels must read a bucket
// in UTC, so a viewer west of Greenwich doesn't see every bucket named after
// the day (or month) before. On a UTC host this wouldn't tell the two apart.
// (Through globalThis: core's typecheck has no Node types.)
const zone = vi.hoisted(() => {
  const env = (globalThis as unknown as { process: { env: Record<string, string | undefined> } }).process.env;
  const before = env.TZ;
  env.TZ = "America/New_York";
  return { env, before };
});
afterAll(() => {
  if (zone.before === undefined) delete zone.env.TZ;
  else zone.env.TZ = zone.before;
});

import { activityBucketLabel } from "../src/replay/replay";

describe("activityBucketLabel west of Greenwich", () => {
  it("runs in a zone behind UTC", () => {
    expect(new Date("2026-03-07T00:00:00Z").getDate()).toBe(6);
  });

  it("names a day bucket after its UTC day", () => {
    const utc = (options: Intl.DateTimeFormatOptions) =>
      new Intl.DateTimeFormat(undefined, { ...options, timeZone: "UTC" }).format(new Date("2026-03-07T00:00:00Z"));
    expect(activityBucketLabel(new Date("2026-03-07T00:00:00Z"), "day", "verbose")).toBe(
      utc({ month: "short", day: "numeric" }),
    );
    expect(activityBucketLabel(new Date("2026-03-07T00:00:00Z"), "day", "compact")).toBe(utc({ day: "numeric" }));
  });

  it("names a month bucket after its UTC month", () => {
    const march = new Date("2026-03-01T00:00:00Z");
    expect(activityBucketLabel(march, "month", "verbose")).toBe(
      new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit", timeZone: "UTC" }).format(march),
    );
  });
});
