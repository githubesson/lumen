/**
 * Reading the per-file results of a music upload, for the web dialog and the
 * phone's upload screen.
 */

import type { UploadResult } from "./api";

export type UploadScope = "personal" | "global";

/**
 * Admins upload to the shared library unless they choose otherwise; everyone
 * else can only add personal tracks.
 */
export function defaultUploadScope(isAdmin: boolean): UploadScope {
  return isAdmin ? "global" : "personal";
}

export type UploadStatus = "failed" | "skipped" | "added" | "duplicate";

/**
 * What happened to one file, in the server's own order of precedence (its
 * upload log counts results the same way): an error wins, then a skip, then
 * an insert. Anything else matched a track already in the library.
 */
export function uploadResultStatus(result: UploadResult): UploadStatus {
  if (result.error) return "failed";
  if (result.skipped) return "skipped";
  if (result.inserted) return "added";
  return "duplicate";
}

const STATUS_LABELS: Record<UploadStatus, string> = {
  failed: "Failed",
  skipped: "Skipped (unsupported format)",
  added: "Added",
  duplicate: "Already in library",
};

export function uploadStatusLabel(status: UploadStatus): string {
  return STATUS_LABELS[status];
}

/** One line about a file: the server's error when it failed, else its status. */
export function uploadResultDetail(result: UploadResult): string {
  return result.error || uploadStatusLabel(uploadResultStatus(result));
}

export type UploadSummary = Record<UploadStatus, number>;

export function summarizeUploadResults(results: readonly UploadResult[]): UploadSummary {
  const summary: UploadSummary = { added: 0, duplicate: 0, skipped: 0, failed: 0 };
  for (const result of results) summary[uploadResultStatus(result)] += 1;
  return summary;
}

/** "3 added · 1 already in library · 1 failed", leaving out what didn't happen. */
export function uploadSummaryLabel(summary: UploadSummary): string {
  const parts = [
    summary.added > 0 && `${summary.added} added`,
    summary.duplicate > 0 && `${summary.duplicate} already in library`,
    summary.skipped > 0 && `${summary.skipped} skipped`,
    summary.failed > 0 && `${summary.failed} failed`,
  ].filter((part): part is string => !!part);
  return parts.length > 0 ? parts.join(" · ") : "No files uploaded";
}

/**
 * Whether the library changed. Only inserts change it, so the clients refresh
 * their library views after an upload only when this is true.
 */
export function uploadAddedAny(results: readonly UploadResult[]): boolean {
  return results.some((result) => result.inserted);
}
