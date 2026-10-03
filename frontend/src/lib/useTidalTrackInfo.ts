import { useEffect, useState } from "react";
import { tidalRefusalMessage } from "@music-library/core/tidal/track-info";
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
): { info: TidalTrackInfo | null; loading: boolean; failed: boolean; refusal: string | null } {
  const [result, setResult] = useState<{
    tidalId: string;
    info: TidalTrackInfo | null;
    refusal: string | null;
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
      .then((info) => {
        if (!cancelled) setResult({ tidalId, info: info.id === tidalId ? info : null, refusal: null });
      })
      .catch((error: unknown) => {
        if (!cancelled) setResult({ tidalId, info: null, refusal: tidalRefusalMessage(error) });
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, tidalId, requestNonce]);

  if (!open || !tidalId) return { info: null, loading: false, failed: false, refusal: null };
  if (result?.tidalId !== tidalId) return { info: null, loading: true, failed: false, refusal: null };
  return { info: result.info, loading: false, failed: !result.info, refusal: result.refusal };
}
