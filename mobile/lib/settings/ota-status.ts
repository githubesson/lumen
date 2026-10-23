/**
 * The one status the Settings "Lumen <version>" row shows for over-the-air
 * updates, from `expo-updates`' `useUpdates()` state plus the screen's own
 * action error. Everything but "current" is an exception worth a glance.
 */
export type OtaStatus =
  /** Downloaded; a restart applies it. */
  | { kind: "ready" }
  | { kind: "downloading" }
  | { kind: "checking" }
  /** The server has one this build hasn't downloaded yet. */
  | { kind: "available" }
  | { kind: "error" }
  | { kind: "current"; checkedAt: Date }
  /** Nothing checked since launch, so nothing to claim: the row offers a check. */
  | { kind: "unknown" };

export interface OtaState {
  isUpdatePending: boolean;
  isDownloading: boolean;
  isChecking: boolean;
  isUpdateAvailable: boolean;
  /** The check, download or restart error on show, if any. */
  error: string | null;
  lastCheckForUpdateTimeSinceRestart?: Date | null;
}

export function otaStatus(state: OtaState): OtaStatus {
  if (state.isUpdatePending) return { kind: "ready" };
  if (state.isDownloading) return { kind: "downloading" };
  if (state.isChecking) return { kind: "checking" };
  if (state.isUpdateAvailable) return { kind: "available" };
  if (state.error) return { kind: "error" };
  if (state.lastCheckForUpdateTimeSinceRestart) {
    return { kind: "current", checkedAt: state.lastCheckForUpdateTimeSinceRestart };
  }
  return { kind: "unknown" };
}

/** The row's trailing text for a status. */
export function otaStatusLabel(status: OtaStatus): string {
  switch (status.kind) {
    case "ready":
      return "Update ready";
    case "downloading":
      return "Downloading…";
    case "checking":
      return "Checking…";
    case "available":
      return "Update available";
    case "error":
      return "Couldn't update";
    case "current":
      return "Up to date";
    case "unknown":
      return "Check for updates";
  }
}
