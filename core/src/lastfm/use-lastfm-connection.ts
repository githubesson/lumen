import { useEffect, useState } from "react";
import { api, errorMessage, type LastFMStatus } from "../api";

interface Options {
  enabled?: boolean;
  openAuthorization: (url: string) => Promise<unknown>;
  // Native browser sheets resolve when dismissed, so polling starts before
  // awaiting them. Desktop launchers can first confirm that opening succeeded.
  pendingBeforeOpen?: boolean;
}

export function useLastFMConnection({
  enabled = true,
  openAuthorization,
  pendingBeforeOpen = false,
}: Options) {
  const [status, setStatus] = useState<LastFMStatus | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    void api.getLastFMStatus().then(
      (next) => {
        if (!cancelled) setStatus(next);
      },
      () => {
        if (!cancelled) setStatus(null);
      },
    );
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled || !status?.configured || status.connected || !status.pending)
      return;
    const controller = new AbortController();
    // Each new authorization wait owns a fresh error state.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    void api.waitForLastFMAuthorization({ signal: controller.signal }).then(
      ({ username }) => {
        if (controller.signal.aborted) return;
        setStatus((current) => ({
          configured: current?.configured ?? true,
          connected: true,
          pending: false,
          username,
        }));
      },
      (err) => {
        if (
          controller.signal.aborted ||
          (err instanceof Error && err.name === "AbortError")
        )
          return;
        setError(
          errorMessage(err, "Could not complete Last.fm authorization."),
        );
      },
    );
    return () => controller.abort();
  }, [enabled, status?.configured, status?.connected, status?.pending]);

  const markPending = () =>
    setStatus((current) =>
      current ? { ...current, pending: true, last_error: undefined } : current,
    );

  const connect = async () => {
    setBusy(true);
    setError(null);
    try {
      const { authorization_url } = await api.connectLastFM();
      if (pendingBeforeOpen) markPending();
      await openAuthorization(authorization_url);
      if (!pendingBeforeOpen) markPending();
    } catch (err) {
      setError(errorMessage(err, "Could not connect Last.fm."));
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.disconnectLastFM();
      setStatus((current) => ({
        configured: current?.configured ?? true,
        connected: false,
        pending: false,
      }));
    } catch (err) {
      setError(errorMessage(err, "Could not disconnect Last.fm."));
    } finally {
      setBusy(false);
    }
  };

  return { status, busy, error, connect, disconnect };
}

export type LastFMConnectionKind =
  | "checking"
  | "unavailable"
  | "connected"
  | "pending"
  | "disconnected";

/**
 * Where the Last.fm connection stands, described for a settings row. The
 * hook's own error (a failed connect, say) wins over the server's last one.
 */
export function lastFMConnectionState(
  status: LastFMStatus | null,
  error?: string | null,
): { kind: LastFMConnectionKind; description: string; error: string | null } {
  const shownError = error || status?.last_error || null;
  if (!status) {
    return { kind: "checking", description: "Checking…", error: shownError };
  }
  if (!status.configured) {
    return {
      kind: "unavailable",
      description: "Not set up on this server.",
      error: shownError,
    };
  }
  if (status.connected) {
    return {
      kind: "connected",
      description: `Scrobbling as ${status.username || "your account"}.`,
      error: shownError,
    };
  }
  if (status.pending) {
    return {
      kind: "pending",
      description: "Waiting for you to approve Lumen on Last.fm.",
      error: shownError,
    };
  }
  return {
    kind: "disconnected",
    description: "Send what you play to your Last.fm profile.",
    error: shownError,
  };
}
