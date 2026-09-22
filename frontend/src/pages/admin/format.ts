function parseDate(value?: string | null): Date | null {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

/** Short, locale-aware timestamp for admin tables. Guards against bad dates. */
export function formatDate(value?: string | null): string {
  return (
    parseDate(value)?.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }) ?? "-"
  );
}

/** Full locale date and time. Guards against bad dates. */
export function formatDateTime(value?: string | null): string {
  return parseDate(value)?.toLocaleString() ?? "-";
}

/** Human scan cadence (e.g. "60 min", "1.5 hr") from a seconds interval. */
export function formatInterval(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "-";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.round((minutes / 60) * 10) / 10;
  return `${hours} hr`;
}
