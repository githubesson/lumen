import { useCallback, useEffect, useRef, useState } from "react";

export interface CopiedFlag {
  copied: boolean;
  /** Show the "copied" state, restarting the reset timer on repeat copies. */
  flash: () => void;
  /** Clear the "copied" state immediately. */
  reset: () => void;
}

/**
 * Transient "copied!" indicator. The reset timer is tracked so repeat copies
 * restart it instead of being cut short, and unmounting mid-window doesn't
 * leave a setState firing afterwards.
 */
export function useCopiedFlag(durationMs: number): CopiedFlag {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  useEffect(() => clearTimer, [clearTimer]);

  const flash = useCallback(() => {
    clearTimer();
    setCopied(true);
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      setCopied(false);
    }, durationMs);
  }, [clearTimer, durationMs]);

  const reset = useCallback(() => {
    clearTimer();
    setCopied(false);
  }, [clearTimer]);

  return { copied, flash, reset };
}
