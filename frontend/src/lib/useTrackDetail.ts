import { useEffect, useState } from "react";
import { api, errorMessage, type TrackDetail } from "../api";

/**
 * Fetch a TrackDetail whenever (open, trackId) becomes truthy, cancelling any
 * in-flight request so a fast reopen with a different id can't resolve stale.
 * Shared by EditDialog / ShareDialog / TrackInfoDialog, which each hand-rolled
 * this effect (none cancelled — a latent stale-resolve race).
 */
export function useTrackDetail(
  open: boolean,
  trackId: string | null,
): { track: TrackDetail | null; error: string | null } {
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [error, setError] = useState<{
    trackId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!open || !trackId) return;
    let cancelled = false;
    const controller = new AbortController();
    setTrack(null);
    setError(null);
    api
      .getTrack(trackId, { signal: controller.signal })
      .then((t) => {
        if (!cancelled) setTrack(t);
      })
      .catch((err) => {
        if (!cancelled && !controller.signal.aborted) {
          setError({
            trackId,
            message: errorMessage(err, "Failed to load track."),
          });
        }
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [open, trackId]);

  return {
    track: open && track?.id === trackId ? track : null,
    error: open && error?.trackId === trackId ? error.message : null,
  };
}
