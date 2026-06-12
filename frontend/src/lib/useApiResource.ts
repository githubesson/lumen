import { useCallback, useEffect, useState, type DependencyList } from "react";
import { errorMessage } from "../api";

export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /** Re-run the fetcher (e.g. after a mutation). */
  reload: () => void;
}

/**
 * Fetch a single resource with loading/error state and automatic cancellation.
 * Owns the AbortController and an aborted-guard so a dependency change or
 * unmount can't set state on a stale resolve. Replaces the hand-rolled
 * useState + useEffect + AbortController + ApiError boilerplate that was
 * copy-pasted across the list pages.
 *
 * `deps` are the values that should trigger a refetch (same contract as
 * useEffect's dependency array).
 */
export function useApiResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  deps: DependencyList,
  fallbackMessage = "Something went wrong.",
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const reload = useCallback(() => setNonce((n) => n + 1), []);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    setLoading(true);
    setError(null);
    fetcher(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        setError(errorMessage(err, fallbackMessage));
        setLoading(false);
      });
    return () => {
      active = false;
      controller.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);

  return { data, error, loading, reload };
}
