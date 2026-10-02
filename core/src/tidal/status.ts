import type { TidalAutoDownloadStatus, TidalStatus } from "../api";

/** What the hifi-api proxy reports, with the defaults it falls back to. */
export function tidalStatusDetails(status: TidalStatus | null | undefined): {
  proxy: string;
  country: string;
  quality: string;
  version: string;
} {
  return {
    proxy: status?.proxy_url || "not configured",
    country: status?.country_code || "US",
    quality: status?.quality || "LOSSLESS",
    version: status?.version || "unknown",
  };
}

/**
 * Every error to show on the TIDAL admin screen: the screen's own (a failed
 * action, else a failed load), then the proxy's and its account controls'.
 */
export function tidalStatusErrors(
  screenError: string | null | undefined,
  status: TidalStatus | null | undefined,
): string[] {
  const errors = [screenError, status?.error, status?.management_error];
  return errors.filter(
    (error, i): error is string => !!error && errors.indexOf(error) === i,
  );
}

/** Why auto-download can't save files right now, if it can't. */
export function tidalAutoDownloadProblems(
  status: TidalAutoDownloadStatus | null | undefined,
): string[] {
  if (!status) return [];
  const problems: string[] = [];
  if (!status.ffmpeg) {
    problems.push("ffmpeg is not installed on the server, so downloads are paused.");
  }
  if (status.destination_error) {
    problems.push(`Download folder unavailable: ${status.destination_error}`);
  }
  return problems;
}
