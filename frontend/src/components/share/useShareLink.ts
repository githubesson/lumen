import { useCallback, useState } from "react";
import { useShareLinkSession } from "@music-library/core/share-link-session";
import { errorMessage } from "../../api";
import { copyText } from "../../lib/clipboard";
import { useCopiedFlag } from "../../lib/useCopiedFlag";

/**
 * Generates a share link for a clip window and copies it. The link session
 * (minting once per window, dropping it when the window moves) is core's;
 * this adds the copy, its busy state and its feedback. Call `invalidate`
 * whenever the window changes.
 */
export function useShareLink() {
  const { shareUrl, ensureUrl, invalidate: invalidateSession } = useShareLinkSession();
  const [busy, setBusy] = useState(false);
  const { copied, flash: flashCopied, reset: resetCopied } = useCopiedFlag(1800);
  const [copyError, setCopyError] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    invalidateSession();
    resetCopied();
  }, [invalidateSession, resetCopied]);

  const clearError = useCallback(() => setCopyError(null), []);

  const reset = useCallback(() => {
    invalidateSession();
    setBusy(false);
    resetCopied();
    setCopyError(null);
  }, [invalidateSession, resetCopied]);

  const copy = async (trackId: string, startSec: number, durationSec: number) => {
    setBusy(true);
    setCopyError(null);
    try {
      const url = await ensureUrl(trackId, startSec, durationSec);
      const copiedOk = await copyText(url);
      if (!copiedOk) throw new Error("copy failed");
      flashCopied();
    } catch (err) {
      setCopyError(
        errorMessage(
          err,
          "Couldn't copy link — try again or copy the URL manually.",
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  return { shareUrl, busy, copied, copyError, copy, clearError, ensureUrl, invalidate, reset };
}
