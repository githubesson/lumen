import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../api";
import { readCache, writeCache } from "./resourceCache";

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
  /**
   * Apply a change the caller already knows happened (a delete), so it shows
   * before any refetch. Also updates the cached copy.
   */
  update: (fn: (data: T | null) => T | null) => void;
}

/**
 * Load a resource on mount or explicit reload, cancelling superseded requests.
 * Fetchers are read through refs so inline callbacks do not trigger refetches.
 *
 * With a `cacheKey`, a remount starts from the last result for that key and
 * refetches behind it (`loading` is still true meanwhile). The key is read
 * once per mount; a page showing a different resource should remount.
 */
export function useApiResource<T>(
  fetcher: (signal: AbortSignal) => Promise<T>,
  fallbackMessage = "Something went wrong.",
  { cacheKey }: { cacheKey?: string } = {},
): ApiResource<T> {
  const [data, setData] = useState<T | null>(() => readCache<T>(cacheKey) ?? null);
  const cacheKeyRef = useRef(cacheKey);
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

  // Bumped by update(): a read that started before it is older than the
  // change it applied, so its result is dropped (it still settles).
  const updatesRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let active = true;
    const updatesAtStart = updatesRef.current;
    // Mount and explicit reload begin a new request lifecycle.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true);
    setError(null);
    fetcherRef
      .current(controller.signal)
      .then((result) => {
        if (!active) return;
        if (updatesRef.current === updatesAtStart) {
          writeCache(cacheKeyRef.current, result);
          setData(result);
        }
        setLoading(false);
        settle(nonce);
      })
      .catch((err) => {
        if (!active || controller.signal.aborted) return;
        if (updatesRef.current === updatesAtStart) {
          setError(errorMessage(err, fallbackRef.current));
        }
        setLoading(false);
        settle(nonce);
      });
    return () => {
      active = false;
      controller.abort();
    };
  }, [nonce, settle]);

  const update = useCallback((fn: (data: T | null) => T | null) => {
    updatesRef.current += 1;
    setData((prev) => {
      const next = fn(prev);
      writeCache(cacheKeyRef.current, next ?? undefined);
      return next;
    });
  }, []);

  return { data, error, loading, reload, update };
}
