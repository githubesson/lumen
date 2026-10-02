import { useCallback, useState } from "react";
import { useIsOffline } from "./offline-mode";

/**
 * Remembers that an image failed to load, so the caller can show a fallback.
 * The failure holds only for that URL and connectivity: a new URL, or going
 * offline or back online, gets a fresh attempt instead of keeping a fallback
 * that a dropped connection caused.
 */
export function useImageFailure(uri: string | null | undefined): {
  failed: boolean;
  onError: () => void;
} {
  const offline = useIsOffline();
  const [failure, setFailure] = useState<{ uri: string; offline: boolean } | null>(null);
  const failed = uri != null && failure?.uri === uri && failure.offline === offline;
  const onError = useCallback(() => {
    if (uri != null) setFailure({ uri, offline });
  }, [uri, offline]);
  return { failed, onError };
}
