import { useEffect, useState } from "react";
import { api, type TidalTrackInfo } from "../api";

/** TIDAL can be slow; past this the view shows what the server stores. */
const TIDAL_INFO_TIMEOUT_MS = 10000;

/**
 * Fetch TIDAL's details for a TIDAL track while its info view is open. Like
 * useTrackDetail, a changed id or nonce drops the previous answer and
 * cancels its request. `failed` covers errors and the timeout alike: the
 * view then falls back to the track's stored fields.
 */
export function useTidalTrackInfo(
  open: boolean,
  tidalId: string | null,
  requestNonce = 0,
): { info: TidalTrackInfo | null; loading: boolean; failed: boolean } {
  const [result, setResult] = useState<{
    tidalId: string;
    info: TidalTrackInfo | null;
  } | null>(null);

  useEffect(() => {
    if (!open || !tidalId) return;
    let cancelled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), TIDAL_INFO_TIMEOUT_MS);
    // A changed id or nonce invalidates the previous answer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult(null);
    api
      .getTidalTrack(tidalId, { signal: controller.signal })
      .then((info) => {
        if (!cancelled) setResult({ tidalId, info: info.id === tidalId ? info : null });
      })
      .catch(() => {
        if (!cancelled) setResult({ tidalId, info: null });
      })
      .finally(() => window.clearTimeout(timeout));
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, tidalId, requestNonce]);

  if (!open || !tidalId) return { info: null, loading: false, failed: false };
  if (result?.tidalId !== tidalId) return { info: null, loading: true, failed: false };
  return { info: result.info, loading: false, failed: !result.info };
}
