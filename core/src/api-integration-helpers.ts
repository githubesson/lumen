import { ApiError, request } from "./api-transport";
import type {
  ArtistGridPin,
  LastFMAuthorizationPollOptions,
  TidalAuthorizationPollOptions,
  TidalAuthPoll,
} from "./api";

const PIN_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function abortError(): Error {
  const error = new Error("Authorization polling was cancelled.");
  error.name = "AbortError";
  return error;
}

function abortableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(abortError());
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(abortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function waitForLastFMAuthorization(
  options: LastFMAuthorizationPollOptions = {},
): Promise<{ username: string }> {
  const intervalMs = Math.max(500, options.intervalMs ?? 3000);
  const timeoutMs = Math.max(intervalMs, options.timeoutMs ?? 10 * 60_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (options.signal?.aborted) throw abortError();
    try {
      return await request<{ username: string }>(
        "/api/integrations/lastfm/complete",
        { method: "POST", signal: options.signal },
      );
    } catch (error) {
      if (!(error instanceof ApiError) || error.status !== 409) throw error;
    }
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ApiError(
        408,
        "Timed out waiting for Last.fm authorization. You can try again.",
      );
    }
    await abortableDelay(Math.min(intervalMs, remainingMs), options.signal);
  }
}

export async function waitForTidalAuthorization(
  flowId: string,
  options: TidalAuthorizationPollOptions = {},
): Promise<TidalAuthPoll> {
  const intervalMs = Math.max(500, options.intervalMs ?? 2500);
  const timeoutMs = Math.max(intervalMs, options.timeoutMs ?? 10 * 60_000);
  const deadline = Date.now() + timeoutMs;
  while (true) {
    if (options.signal?.aborted) throw abortError();
    const result = await request<TidalAuthPoll>(
      `/api/admin/tidal/auth/${encodeURIComponent(flowId)}`,
      { signal: options.signal },
    );
    if (result.state !== "pending") return result;
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      throw new ApiError(
        408,
        "Timed out waiting for TIDAL authorization. You can try again.",
      );
    }
    await abortableDelay(Math.min(intervalMs, remainingMs), options.signal);
  }
}

export type RawArtistGridPin = Partial<ArtistGridPin>;

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

export function normalizeArtistGridPin(merged: RawArtistGridPin): ArtistGridPin {
  const rootPath = stringValue(merged.root_path);
  const destinationSubdir = stringValue(merged.destination_subdir);
  return {
    id: stringValue(merged.id),
    root_id: merged.root_id,
    root_path: rootPath,
    destination_subdir: destinationSubdir,
    destination_path:
      stringValue(merged.destination_path) ||
      [rootPath, destinationSubdir].filter(Boolean).join("/"),
    tracker_id: stringValue(merged.tracker_id),
    tracker_url: stringValue(merged.tracker_url),
    tab: stringValue(merged.tab),
    label: stringValue(merged.label),
    primary_artist: stringValue(merged.primary_artist),
    enabled: Boolean(merged.enabled),
    scan_interval_seconds: Number(merged.scan_interval_seconds) || 0,
    last_scan_at: merged.last_scan_at ?? null,
    last_success_at: merged.last_success_at ?? null,
    last_error: stringValue(merged.last_error),
    created_at: stringValue(merged.created_at),
    updated_at: stringValue(merged.updated_at),
    root_exists: merged.root_exists !== false,
  };
}

export function isValidPinID(id: string): boolean {
  return PIN_ID_PATTERN.test(stringValue(id).trim());
}

function pinPathID(id: string, source: string): string {
  const trimmed = stringValue(id).trim();
  if (!PIN_ID_PATTERN.test(trimmed)) {
    throw new ApiError(
      0,
      `${source} pin id is missing. Refresh sources or restart the backend.`,
    );
  }
  return encodeURIComponent(trimmed);
}

export const artistGridPinPathID = (id: string) => pinPathID(id, "Tracker");
export const filenPinPathID = (id: string) => pinPathID(id, "Filen");
export const apiTrackerPinPathID = (id: string) => pinPathID(id, "API tracker");
