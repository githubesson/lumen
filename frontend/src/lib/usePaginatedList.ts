import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type Page } from "../api";
import { libraryChanged } from "./events";

interface Options {
  /** Page size to request. Defaults to 100. */
  pageSize?: number;
  /** rootMargin for the bottom-sentinel IntersectionObserver. */
  rootMargin?: string;
  /** Poll the server every N ms. Off when undefined or 0. */
  pollIntervalMs?: number;
  /** When true, keep requesting pages until everything is loaded. Used for
   *  aggregation views where the user shouldn't need to scroll to get a
   *  complete picture. */
  loadAll?: boolean;
}

/**
 * Paginated list loader with infinite scroll, race-safe resets, and
 * library-change awareness. Every fetch that resolves after a newer reset
 * started is dropped on the floor, so stale results never overwrite newer
 * state.
 *
 * The returned `sentinelRef` should be attached to a thin div at the bottom
 * of the list — the observer triggers the next page when it comes near the
 * viewport.
 */
export function usePaginatedList<T>(
  fetcher: (params: { limit: number; offset: number; q?: string }) => Promise<Page<T>>,
  query: string,
  opts: Options = {},
) {
  const pageSize = opts.pageSize ?? 100;
  const rootMargin = opts.rootMargin ?? "600px 0px";

  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const tokenRef = useRef(0);
  const loadingRef = useRef(false);
  const fetcherRef = useRef(fetcher);
  fetcherRef.current = fetcher;

  const loadPage = useCallback(
    async (offset: number, reset: boolean) => {
      if (reset) {
        tokenRef.current += 1;
      } else {
        if (loadingRef.current) return;
        loadingRef.current = true;
        setLoadingMore(true);
      }
      const token = tokenRef.current;
      try {
        const page = await fetcherRef.current({
          limit: pageSize,
          offset,
          q: query.trim() || undefined,
        });
        if (token !== tokenRef.current) return;
        setTotal(page.total);
        setItems((prev) =>
          reset || !prev ? page.items : [...prev, ...page.items],
        );
        setError(null);
      } catch (err) {
        if (token !== tokenRef.current) return;
        setError(errorMessage(err, "Failed to load."));
        if (reset) setItems([]);
      } finally {
        if (!reset) {
          loadingRef.current = false;
          setLoadingMore(false);
        }
      }
    },
    [query, pageSize],
  );

  // Initial + query-change reload.
  useEffect(() => {
    setItems(null);
    setTotal(null);
    void loadPage(0, true);
  }, [loadPage]);

  // Bulk library updates and periodic polling both reset pagination.
  useEffect(() => {
    const unsub = libraryChanged.on(() => void loadPage(0, true));
    let poll: number | null = null;
    if (opts.pollIntervalMs && opts.pollIntervalMs > 0) {
      poll = window.setInterval(() => void loadPage(0, true), opts.pollIntervalMs);
    }
    return () => {
      unsub();
      if (poll !== null) window.clearInterval(poll);
    };
  }, [loadPage, opts.pollIntervalMs]);

  // Scroll-driven pagination via bottom sentinel.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (loadingRef.current) return;
        if (items === null || total === null) return;
        if (items.length >= total) return;
        void loadPage(items.length, false);
      },
      { rootMargin, root: null },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadPage, items, total, rootMargin]);

  // Optional: keep pulling pages until the whole set is loaded, regardless of
  // scroll. Used by aggregation views.
  useEffect(() => {
    if (!opts.loadAll) return;
    if (items === null || total === null) return;
    if (items.length >= total) return;
    if (loadingRef.current) return;
    void loadPage(items.length, false);
  }, [opts.loadAll, items, total, loadPage]);

  const reload = useCallback(() => void loadPage(0, true), [loadPage]);

  return { items, total, loadingMore, error, sentinelRef, reload };
}
