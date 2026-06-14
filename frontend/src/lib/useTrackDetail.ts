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
  requestNonce = 0,
): { track: TrackDetail | null; error: string | null } {
  const [track, setTrack] = useState<TrackDetail | null>(null);
  const [error, setError] = useState<{
    trackId: string;
    message: string;
  } | null>(null);

  useEffect(() => {
    if (!open || !trackId) return;
    let cancelled = false;
    let settled = false;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => {
      if (cancelled || settled) return;
      controller.abort();
      setError({
        trackId,
        message: "Track info request timed out.",
      });
    }, 15000);
    setTrack(null);
    setError(null);
    api
      .getTrack(trackId, { signal: controller.signal })
      .then((t) => {
        settled = true;
        window.clearTimeout(timeout);
        if (!cancelled) setTrack(t);
      })
      .catch((err) => {
        settled = true;
        window.clearTimeout(timeout);
        if (!cancelled && !controller.signal.aborted) {
          setError({
            trackId,
            message: errorMessage(err, "Failed to load track."),
          });
        }
      });
    return () => {
      cancelled = true;
      window.clearTimeout(timeout);
      controller.abort();
    };
  }, [open, trackId, requestNonce]);

  return {
    track: open && track && trackMatchesRequest(track, trackId) ? track : null,
    error:
      open && error?.trackId === trackId
        ? error.message
        : open && track && !trackMatchesRequest(track, trackId)
          ? "Loaded a different track than requested."
          : null,
  };
}

function trackMatchesRequest(track: TrackDetail, trackId: string | null): boolean {
  if (!trackId) return false;
  const ids = new Set<string>([track.id]);
  if (track.db_track_id) {
    ids.add(track.db_track_id);
    ids.add(`local:${track.db_track_id}`);
  }
  if (track.source_id) {
    ids.add(track.source_id);
    ids.add(`${track.source}:${track.source_id}`);
  }
  return ids.has(trackId);
}
