/**
 * Choosing, batching and reading the per-file results of a music upload, for
 * the web dialog and the phone's upload screen.
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

/** The scope to send: an admin's choice, else personal (only admins choose). */
export function uploadScope(isAdmin: boolean, chosen: UploadScope): UploadScope {
  return isAdmin ? chosen : "personal";
}

/**
 * The extensions the server ingests; it skips any other file. Mirrors
 * `supportedExt` in backend/internal/ingest/parse.go.
 */
export const UPLOAD_EXTENSIONS = [
  "mp3", "flac", "m4a", "mp4", "ogg", "opus", "wav", "aac", "webm",
] as const;

/** Whether the server would ingest a file by this name: by extension, as it judges. */
export function isUploadableFile(name: string): boolean {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  if (dot < 0) return false;
  const ext = base.slice(dot + 1).toLowerCase();
  return (UPLOAD_EXTENSIONS as readonly string[]).includes(ext);
}

/**
 * The server's cap on one upload request, every file and the form around them
 * together (`maxUploadBytes` in backend/internal/httpapi/handlers/library.go).
 */
export const UPLOAD_REQUEST_MAX_BYTES = 512 << 20;

// Room for the scope field and the closing boundary, and for each file's part
// headers (its name included), so a planned batch never meets the cap.
const UPLOAD_FORM_OVERHEAD_BYTES = 64 << 10;
const UPLOAD_PART_OVERHEAD_BYTES = 4 << 10;

export interface UploadBatchPlan<T> {
  /** Requests to send one after another, in the files' order. */
  batches: T[][];
  /** Files too large to upload even alone; reject them before sending. */
  tooLarge: T[];
}

/**
 * Split files into upload requests that each stay under the server's cap
 * (one request over it fails whole), keeping their order. A file whose size
 * isn't known gets a request of its own, so if it's too big it fails alone.
 * Send the batches in turn and concatenate their results:
 * `summarizeUploadResults` and `uploadAddedAny` read the combined list.
 */
export function planUploadBatches<T>(
  files: readonly T[],
  sizeOf: (file: T) => number | null | undefined,
  maxRequestBytes: number = UPLOAD_REQUEST_MAX_BYTES,
): UploadBatchPlan<T> {
  const budget = maxRequestBytes - UPLOAD_FORM_OVERHEAD_BYTES;
  const batches: T[][] = [];
  const tooLarge: T[] = [];
  let batch: T[] = [];
  let used = 0;
  const flush = () => {
    if (batch.length) batches.push(batch);
    batch = [];
    used = 0;
  };
  for (const file of files) {
    const size = sizeOf(file);
    if (size == null || !Number.isFinite(size)) {
      flush();
      batches.push([file]);
      continue;
    }
    const cost = Math.max(0, size) + UPLOAD_PART_OVERHEAD_BYTES;
    if (cost > budget) {
      tooLarge.push(file);
      continue;
    }
    if (used + cost > budget) flush();
    batch.push(file);
    used += cost;
  }
  flush();
  return { batches, tooLarge };
}

/** The result row for a file refused before sending, worded as the server words it. */
export function tooLargeUploadResult(file: string): UploadResult {
  return { file, inserted: false, error: "file too large" };
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
