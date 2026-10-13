import { useEffect, useState } from "react";
import {
  tidalTrackInfoResult,
  type TidalTrackInfoResult,
} from "@music-library/core/tidal/track-info";
import { api, type TidalTrackInfo } from "../api";

/**
 * Fetch TIDAL's details for a TIDAL track while its info view is open. Like
 * useTrackDetail, a changed id or nonce drops the previous answer and
 * cancels its request. `failed` covers errors and the request's timeout
 * alike: the view then falls back to the track's stored fields. `refusal` is
 * the server's reason when TIDAL refused the track.
 */
export function useTidalTrackInfo(
  open: boolean,
  tidalId: string | null,
  requestNonce = 0,
): TidalTrackInfoResult & { loading: boolean } {
  const [result, setResult] = useState<{
    tidalId: string;
    data: TidalTrackInfo | null;
    error?: unknown;
  } | null>(null);

  useEffect(() => {
    if (!open || !tidalId) return;
    let cancelled = false;
    const controller = new AbortController();
    // A changed id or nonce invalidates the previous answer.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setResult(null);
    api
      .getTidalTrack(tidalId, { signal: controller.signal })
      .then((data) => {
        if (!cancelled) setResult({ tidalId, data });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ tidalId, data: null, error });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, tidalId, requestNonce]);

  if (!open || !tidalId) return { ...tidalTrackInfoResult(null, null), loading: false };
  if (result?.tidalId !== tidalId) return { info: null, loading: true, failed: false, refusal: null };
  return { ...tidalTrackInfoResult(tidalId, result.data, result.error), loading: false };
}
