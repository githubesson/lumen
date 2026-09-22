import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api";

export interface ApiResource<T> {
  data: T | null;
  error: string | null;
  loading: boolean;
  /**
   * Re-run the fetcher (e.g. after a mutation). Resolves once that load (or a
   * later one that supersedes it) settles; failures surface via `error`, so it
   * never rejects. Await it to keep controls busy until fresh data arrives.
   */
  reload: () => Promise<void>;
}

/**
 * Load a resource on mount or explicit reload, cancelling superseded requests.
 * Fetchers are read through refs so inline callbacks do not trigger refetches.
 */
export function useApiResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  fallbackMessage = "Something went wrong.",
): ApiResource<T> {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [nonce, setNonce] = useState(0);

  const fetcherRef = useRef(fetcher);
  const fallbackRef = useRef(fallbackMessage);
  // Writing refs during render is illegal under concurrent React and rejected
  // by the React Compiler. Declared before the fetch effect so it commits
  // first on renders where both change.
  useEffect(() => {
    fetcherRef.current = fetcher;
    fallbackRef.current = fallbackMessage;
  }, [fetcher, fallbackMessage]);

  // Pending reload() promises, tagged with the nonce whose load they wait for.
  const nonceRef = useRef(0);
  const waitersRef = useRef<{ nonce: number; resolve: () => void }[]>([]);
  const settle = useCallback((upTo: number) => {
    const done = waitersRef.current.filter((w) => w.nonce <= upTo);
    if (done.length === 0) return;
    waitersRef.current = waitersRef.current.filter((w) => w.nonce > upTo);
    for (const w of done) w.resolve();
  }, []);
  // Don't leave awaiting callers hanging if the owner unmounts mid-load.
  useEffect(() => () => settle(Infinity), [settle]);

  const reload = useCallback(
    () =>
      new Promise<void>((resolve) => {
        nonceRef.current += 1;
        waitersRef.current.push({ nonce: nonceRef.current, resolve });
        setNonce(nonceRef.current);
      }),
    [],
  );

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    // Mount and explicit reload begin a new request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        setData(result);
        setLoading(false);
        settle(nonce);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        setError(errorMessage(err, fallbackRef.current));
        setLoading(false);
        settle(nonce);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [nonce, settle]);

  return { data, error, loading, reload };
}
