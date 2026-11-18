import { useCallback, useState } from "react";
import { useIsOffline } from "./offline-mode";

/**
 * Remembers that an image failed to load, so the caller can show a fallback.
 * The failure holds only for that URL and connectivity, and only until the
 * URL changes: a new URL, coming back to one that failed earlier, or going
 * offline or back online gets a fresh attempt instead of keeping a fallback
 * that a dropped connection or a slow first load caused.
 */
export function useImageFailure(uri: string | null | undefined): {
  failed: boolean;
  onError: () => void;
} {
  const offline = useIsOffline();
  const [failure, setFailure] = useState<{ uri: string; offline: boolean } | null>(null);
  // The URL this render follows on from. When it changes, the stored failure
  // is dropped now (React re-renders with the cleared state right away).
  const [seenUri, setSeenUri] = useState(uri);
  let current = failure;
  if (seenUri !== uri) {
    setSeenUri(uri);
    if (failure) setFailure(null);
    current = null;
  }
  const failed = uri != null && current?.uri === uri && current.offline === offline;
  const onError = useCallback(() => {
    if (uri != null) setFailure({ uri, offline });
  }, [uri, offline]);
  return { failed, onError };
}
