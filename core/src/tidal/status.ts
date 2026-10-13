import type { TidalAccount, TidalAutoDownloadStatus, TidalStatus } from "../api";

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

export type TidalProxyState = "checking" | "online" | "offline";

/**
 * The proxy badge: "checking" while the status loads, then whether the
 * hifi-api proxy answered. Each client words the three states its own way.
 */
export function tidalProxyState(
  status: TidalStatus | null | undefined,
  loading: boolean,
): TidalProxyState {
  if (loading) return "checking";
  return status?.connected ? "online" : "offline";
}

/**
 * Whether to explain that account controls need the Lumen hifi-api
 * extension: only when a loaded status says so. A status that failed to load
 * says nothing about it, and its error is shown already.
 */
export function tidalManagementUnsupported(
  status: TidalStatus | null | undefined,
): boolean {
  return !!status && !status.management_supported;
}

/**
 * Whether "Link account" is available: the proxy is online with account
 * controls, and no sign-in or unlink (from `useTidalDeviceLogin`) is under way.
 */
export function canLinkTidalAccount(
  status: TidalStatus | null | undefined,
  login: { starting: boolean; unlinkingId: string | null; flow: unknown },
): boolean {
  return (
    !!status?.connected &&
    !!status.management_supported &&
    !login.starting &&
    login.unlinkingId === null &&
    !login.flow
  );
}

/** A linked account's title: "Account 12345". */
export function tidalAccountLabel(account: Pick<TidalAccount, "user_id">): string {
  return `Account ${account.user_id || "unknown"}`;
}

/** Where a linked account comes from: Lumen can unlink only its own. */
export function tidalAccountSource(account: Pick<TidalAccount, "removable">): string {
  return account.removable ? "Managed by Lumen" : "Configured by environment";
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
