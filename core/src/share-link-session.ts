import { useCallback, useRef, useState } from "react";
import { createTrackShareLink } from "./api-media";

/**
 * The share link for the clip window being edited. A link is minted on first
 * use and reused while the window stays put, so copying, sharing and saving
 * the same clip don't each mint a new one; concurrent requests for the same
 * window share one mint. Call `invalidate` when the window moves: a link still
 * being minted for the old window then never lands as `shareUrl`.
 */
export function useShareLinkSession() {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const sessionRef = useRef<{ key: string; promise: Promise<string> } | null>(null);

  const invalidate = useCallback(() => {
    sessionRef.current = null;
    setShareUrl(null);
  }, []);

  /** The link for this window, minting it on first use. */
  const ensureUrl = useCallback(
    (trackId: string, startSec: number, durationSec: number): Promise<string> => {
      const key = `${trackId}:${startSec}:${durationSec}`;
      const current = sessionRef.current;
      if (current?.key === key) return current.promise;
      const promise = createTrackShareLink(trackId, startSec, durationSec).then(
        (res) => {
          if (sessionRef.current?.promise === promise) setShareUrl(res.url);
          return res.url;
        },
        (err: unknown) => {
          // A failed mint isn't kept, so the next attempt tries again.
          if (sessionRef.current?.promise === promise) sessionRef.current = null;
          throw err;
        },
      );
      sessionRef.current = { key, promise };
      return promise;
    },
    [],
  );

  return { shareUrl, ensureUrl, invalidate };
}
