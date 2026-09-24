import { useCallback, useState } from "react";
import { createTrackShareLink, errorMessage } from "../../api";
import { copyText } from "../../lib/clipboard";
import { useCopiedFlag } from "../../lib/useCopiedFlag";

/**
 * Generates a share link for a clip window and copies it. The generated URL
 * is kept so repeat copies of the same window don't mint a new link; call
 * `invalidate` whenever the window changes.
 */
export function useShareLink() {
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { copied, flash: flashCopied, reset: resetCopied } = useCopiedFlag(1800);
  const [copyError, setCopyError] = useState<string | null>(null);

  const invalidate = useCallback(() => {
    setShareUrl(null);
    resetCopied();
  }, [resetCopied]);

  const clearError = useCallback(() => setCopyError(null), []);

  const reset = useCallback(() => {
    setShareUrl(null);
    setBusy(false);
    resetCopied();
    setCopyError(null);
  }, [resetCopied]);

  /** The link for this window, minting it on first use. */
  const ensureUrl = async (trackId: string, startSec: number, durationSec: number) => {
    if (shareUrl) return shareUrl;
    const res = await createTrackShareLink(trackId, startSec, durationSec);
    setShareUrl(res.url);
    return res.url;
  };

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
