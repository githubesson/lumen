import { useEffect, useRef, useState } from "react";
import {
  api,
  errorMessage,
  type TidalAccount,
  type TidalAuthPoll,
  type TidalAuthStart,
} from "../api";

/**
 * TIDAL can hand out its verification link without a scheme
 * ("link.tidal.com/ABCDE"). Those get https when they point at TIDAL; anything
 * else is passed through for the platform's URL check to reject.
 */
export function normalizeTidalVerificationURL(rawURL: string): string {
  const trimmed = rawURL.trim();
  if (!trimmed || /^[a-z][a-z\d+.-]*:/i.test(trimmed)) return trimmed;

  try {
    const url = new URL(`https://${trimmed.replace(/^\/{2}/, "")}`);
    if (url.hostname === "tidal.com" || url.hostname.endsWith(".tidal.com")) {
      return url.href;
    }
  } catch {
    // Let the platform URL validation return the user-facing error.
  }
  return trimmed;
}

/**
 * Polls until a little after the device code expires, so the server's
 * "expired" answer arrives before the client gives up on its own.
 */
export function tidalAuthorizationTimeoutMs(
  expiresAt: string,
  now = Date.now(),
): number | undefined {
  const expiresIn = Date.parse(expiresAt) - now;
  return Number.isFinite(expiresIn)
    ? Math.max(2500, expiresIn + 5000)
    : undefined;
}

/** How a finished device login turned out, in words. */
export function tidalSignInMessage(result: TidalAuthPoll): string {
  if (result.state === "linked") {
    return result.account?.user_id
      ? `TIDAL account ${result.account.user_id} linked.`
      : "TIDAL account linked.";
  }
  return result.message || `TIDAL sign-in ${result.state}.`;
}

/**
 * Opening the verification page either resolves (with `{ ok: false, error }`
 * when it failed and the platform knows why) or rejects.
 */
export type TidalVerificationOpenResult = void | { ok: boolean; error?: string };

interface Options<Context> {
  /**
   * Opens TIDAL's verification page. `context` is whatever was passed to
   * `start` or `reopen`, e.g. a browser tab reserved during the click.
   */
  openVerification: (
    url: string,
    context?: Context,
  ) => Promise<TidalVerificationOpenResult>;
  /** Refreshes the TIDAL status after an account is linked or unlinked. */
  onAccountsChanged?: () => unknown;
  /** Runs when a sign-in links an account, e.g. to close a browser sheet. */
  onLinked?: () => void;
}

/**
 * Links TIDAL accounts through the device-code flow and unlinks them, with
 * the screen's notice and error messages.
 */
export function useTidalDeviceLogin<Context = undefined>({
  openVerification,
  onAccountsChanged,
  onLinked,
}: Options<Context>) {
  const [flow, setFlow] = useState<TidalAuthStart | null>(null);
  const [starting, setStarting] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const startingRef = useRef(false);
  const unlinkingRef = useRef(false);
  const mountedRef = useRef(true);
  // Callers pass inline callbacks; a re-render mustn't restart the poll.
  const callbacksRef = useRef({ onAccountsChanged, onLinked });

  useEffect(() => {
    callbacksRef.current = { onAccountsChanged, onLinked };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const refreshAccounts = async () => {
    try {
      await callbacksRef.current.onAccountsChanged?.();
    } catch {
      // A failed status reload reports itself where the status is shown.
    }
  };

  useEffect(() => {
    if (!flow) return;
    const controller = new AbortController();
    void api
      .waitForTidalAuthorization(flow.flow_id, {
        signal: controller.signal,
        timeoutMs: tidalAuthorizationTimeoutMs(flow.expires_at),
      })
      .then(
        (result) => {
          if (controller.signal.aborted) return;
          setFlow(null);
          if (result.state !== "linked") {
            setError(tidalSignInMessage(result));
            return;
          }
          setError(null);
          setNotice(tidalSignInMessage(result));
          callbacksRef.current.onLinked?.();
          void refreshAccounts();
        },
        (err) => {
          // Only this effect's own abort is a cancellation. A poll request
          // that hit the transport deadline also rejects with an AbortError,
          // and swallowing that would leave the screen waiting forever.
          if (controller.signal.aborted) return;
          setFlow(null);
          setError(errorMessage(err, "Could not complete TIDAL sign-in."));
        },
      );
    return () => controller.abort();
  }, [flow]);

  const open = async (url: string, context?: Context): Promise<boolean> => {
    let result: TidalVerificationOpenResult;
    try {
      result = await openVerification(
        normalizeTidalVerificationURL(url),
        context,
      );
    } catch {
      result = { ok: false };
    }
    if (!result || result.ok) return true;
    setError(result.error || "Could not open the TIDAL sign-in page.");
    return false;
  };

  /** Starts a device login and opens its page; false if either failed. */
  const start = async (context?: Context): Promise<boolean> => {
    if (startingRef.current || flow) return false;
    startingRef.current = true;
    setStarting(true);
    setError(null);
    setNotice(null);
    let started: TidalAuthStart;
    try {
      started = await api.startTidalAuth();
    } catch (err) {
      setError(errorMessage(err, "Could not start TIDAL sign-in."));
      return false;
    } finally {
      startingRef.current = false;
      setStarting(false);
    }
    // Nothing would wait for a login started from a screen that has closed.
    if (!mountedRef.current) return false;
    setFlow(started);
    return open(started.verification_url, context);
  };

  /** Opens the current login's page again. */
  const reopen = async (context?: Context): Promise<boolean> => {
    if (!flow) return false;
    setError(null);
    return open(flow.verification_url, context);
  };

  const unlink = async (account: TidalAccount): Promise<void> => {
    if (unlinkingRef.current) return;
    unlinkingRef.current = true;
    setUnlinkingId(account.id);
    setError(null);
    setNotice(null);
    try {
      await api.removeTidalAccount(account.id);
      setNotice("TIDAL account unlinked.");
      // The row stays busy until the refreshed list drops the account.
      await refreshAccounts();
    } catch (err) {
      setError(errorMessage(err, "Could not unlink the TIDAL account."));
    } finally {
      unlinkingRef.current = false;
      setUnlinkingId(null);
    }
  };

  const clearError = () => setError(null);

  return {
    flow,
    starting,
    unlinkingId,
    error,
    notice,
    start,
    reopen,
    unlink,
    clearError,
  };
}
