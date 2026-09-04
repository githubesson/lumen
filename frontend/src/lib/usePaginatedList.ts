import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type Page, type SearchOffsets } from "../api";
import { libraryChanged } from "./events";

interface Options {
  resourceKey?: string;
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

export interface PageRequest {
  searchOffsets?: SearchOffsets;
  limit: number;
  offset: number;
  q?: string;
  signal: AbortSignal;
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
  fetcher: (params: PageRequest) => Promise<Page<T>>,
  query: string,
  opts: Options = {},
) {
  const pageSize = opts.pageSize ?? 100;
  const rootMargin = opts.rootMargin ?? "600px 0px";

  const [items, setItems] = useState<T[] | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hasMore, setHasMore] = useState(false);
  const nextOffsets = useRef<SearchOffsets | undefined>(undefined);
  const tokenRef = useRef(0);
  const loadingRef = useRef(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  // Keep the ref current from an effect: writing refs during render is illegal
  // under concurrent React (a render that is thrown away still mutates it) and
  // is rejected by the React Compiler. Declared before the loader effects so
  // it commits first.
  useEffect(() => {
    fetcherRef.current = fetcher;
  }, [fetcher]);

  const loadPage = useCallback(
    async (offset: number, reset: boolean) => {
      if (reset) {
        tokenRef.current += 1;
        activeRequestRef.current?.abort();
        setLoadingMore(false);
        setHasMore(false);
        nextOffsets.current = undefined;
      } else {
        if (loadingRef.current) return;
        setLoadingMore(true);
      }
      loadingRef.current = true;
      const token = tokenRef.current;
      const controller = new AbortController();
      activeRequestRef.current = controller;
      try {
        const page = await fetcherRef.current({
          searchOffsets: reset ? undefined : nextOffsets.current,
          limit: pageSize,
          offset,
          q: query.trim() || undefined,
          signal: controller.signal,
        });
        if (controller.signal.aborted || token !== tokenRef.current) return;
        nextOffsets.current = page.nextOffsets;
        const more = page.nextOffsets !== undefined
          ? Object.keys(page.nextOffsets).length > 0
          : offset + page.items.length < page.total;
        setHasMore(more);
        setTotal(page.nextOffsets !== undefined && more ? null : page.total);
        setItems((prev) =>
          reset || !prev ? page.items : [...prev, ...page.items],
        );
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || token !== tokenRef.current) return;
        setError(errorMessage(err, "Failed to load."));
        if (reset) setItems([]);
      } finally {
        if (activeRequestRef.current === controller) {
          activeRequestRef.current = null;
          loadingRef.current = false;
          if (!reset) setLoadingMore(false);
        }
      }
    },
    [query, pageSize],
  );

  // Initial + query-change reload.
  useEffect(() => {
    // Query inputs define a new paginated resource and reset accumulated pages.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setItems(null);
    setTotal(null);
    void loadPage(0, true);
  }, [loadPage, opts.resourceKey]);

  useEffect(
    () => () => {
      const activeRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      activeRequest?.abort();
    },
    [],
  );

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
        if (items === null || !hasMore) return;
        void loadPage(items.length, false);
      },
      { rootMargin, root: null },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadPage, items, hasMore, rootMargin]);

  // Optional: keep pulling pages until the whole set is loaded, regardless of
  // scroll. Used by aggregation views.
  useEffect(() => {
    if (!opts.loadAll) return;
    if (items === null || !hasMore) return;
    if (loadingRef.current) return;
    void loadPage(items.length, false);
  }, [opts.loadAll, items, hasMore, loadPage]);

  const reload = useCallback(() => void loadPage(0, true), [loadPage]);

  return { items, total, hasMore, loadingMore, error, sentinelRef, reload };
}
