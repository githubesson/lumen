import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage, type Page, type SearchOffsets } from "../api";
import { libraryChanged } from "./events";
import { readCache, writeCache } from "./resourceCache";
import { reconcileItems } from "./reconcileItems";
import { findScrollParent } from "./useWindowedSlice";

interface Options {
  resourceKey?: string;
  /** Page size to request. Defaults to 100. */
  pageSize?: number;
  /** rootMargin for the bottom-sentinel IntersectionObserver. */
  rootMargin?: string;
  /** Poll the server every N ms. Off when undefined or 0. */
  pollIntervalMs?: number;
  /**
   * Keep the current items up when the query or resource key changes, until
   * the new first page lands (`stale` is true meanwhile), instead of dropping
   * back to the loading state.
   */
  keepPrevious?: boolean;
  /**
   * Remember the first page under this key (per query and resource key), so
   * a remount shows it at once and refreshes behind it.
   */
  cacheKey?: string;
}

interface CachedPage<T> {
  items: T[];
  total: number | null;
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
  const keepPrevious = opts.keepPrevious ?? false;

  // Which query + resource the items on screen came from, for `stale`.
  const requestKey = `${opts.resourceKey ?? ""}\u0000${query}`;
  const pageCacheKey =
    opts.cacheKey === undefined ? undefined : `${opts.cacheKey}\u0000${requestKey}`;
  const [items, setItems] = useState<T[] | null>(
    () => readCache<CachedPage<T>>(pageCacheKey)?.items ?? null,
  );
  const [total, setTotal] = useState<number | null>(
    () => readCache<CachedPage<T>>(pageCacheKey)?.total ?? null,
  );
  const [loadingMore, setLoadingMore] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [hasMore, setHasMore] = useState(false);
  const nextOffsets = useRef<SearchOffsets | undefined>(undefined);
  const tokenRef = useRef(0);
  const loadingRef = useRef(false);
  const activeRequestRef = useRef<AbortController | null>(null);
  const fetcherRef = useRef(fetcher);
  const requestKeyRef = useRef(requestKey);
  const pageCacheKeyRef = useRef(pageCacheKey);
  // For the failure path, which runs after the render that last set items.
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);
  const [loadedKey, setLoadedKey] = useState<string | null>(() =>
    readCache(pageCacheKey) === undefined ? null : requestKey,
  );
  // Keep the ref current from an effect: writing refs during render is illegal
  // under concurrent React (a render that is thrown away still mutates it) and
  // is rejected by the React Compiler. Declared before the loader effects so
  // it commits first.
  useEffect(() => {
    fetcherRef.current = fetcher;
    requestKeyRef.current = requestKey;
    pageCacheKeyRef.current = pageCacheKey;
  }, [fetcher, requestKey, pageCacheKey]);

  const loadPage = useCallback(
    async (offset: number, reset: boolean, preserve = false, force = false) => {
      if (preserve && loadingRef.current && !force) return;
      if (reset) {
        tokenRef.current += 1;
        activeRequestRef.current?.abort();
        setLoadingMore(false);
        if (!preserve) setHasMore(false);
        if (!preserve) nextOffsets.current = undefined;
      } else {
        if (loadingRef.current) return;
        setLoadingMore(true);
      }
      loadingRef.current = true;
      const token = tokenRef.current;
      const key = requestKeyRef.current;
      const cacheKey = pageCacheKeyRef.current;
      const controller = new AbortController();
      activeRequestRef.current = controller;
      try {
        const target = preserve ? itemsRef.current?.length ?? 0 : 0;
        // Revalidate long lists in larger batches. Fetchers/server caps still
        // control source-specific limits (and cursors for mixed search).
        const limit = preserve ? Math.max(pageSize, Math.min(target, 1000)) : pageSize;
        let page = await fetcherRef.current({
          searchOffsets: reset ? undefined : nextOffsets.current,
          limit,
          offset,
          q: query.trim() || undefined,
          signal: controller.signal,
        });
        const firstPageItems = limit > pageSize ? page.items.slice(0, pageSize) : page.items;
        const collected = [...page.items];
        while (collected.length < target && !controller.signal.aborted) {
          const more = page.nextOffsets !== undefined
            ? Object.keys(page.nextOffsets).length > 0
            : collected.length < page.total;
          if (!more || page.items.length === 0) break;
          page = await fetcherRef.current({
            searchOffsets: page.nextOffsets,
            limit,
            offset: collected.length,
            q: query.trim() || undefined,
            signal: controller.signal,
          });
          collected.push(...page.items);
        }
        if (controller.signal.aborted || token !== tokenRef.current) return;
        nextOffsets.current = page.nextOffsets;
        const more = page.nextOffsets !== undefined
          ? Object.keys(page.nextOffsets).length > 0
          : offset + collected.length < page.total;
        setHasMore(more);
        const nextTotal = page.nextOffsets !== undefined && more ? null : page.total;
        setTotal(nextTotal);
        if (reset) writeCache(cacheKey, { items: firstPageItems, total: nextTotal } satisfies CachedPage<T>);
        setItems((prev) =>
          reset || !prev ? reconcileItems(prev ?? [], collected) : [...prev, ...page.items],
        );
        setLoadedKey(key);
        setError(null);
      } catch (err) {
        if (controller.signal.aborted || token !== tokenRef.current) return;
        setError(errorMessage(err, "Failed to load."));
        // Rows already on screen (cached, or kept from the previous query)
        // stay up under the error, still marked stale if they belong to
        // another query. Only a load with nothing to show settles on empty.
        if (reset && !itemsRef.current?.length) {
          setItems([]);
          setLoadedKey(key);
        }
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
    // Query inputs define a new paginated resource and reset accumulated pages
    // (to its cached first page, if there is one).
    // An error belongs to the request that failed, not the new one.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setError(null);
    const cached = readCache<CachedPage<T>>(pageCacheKeyRef.current);
    if (cached) {
      setItems(cached.items);
      setTotal(cached.total);
      setLoadedKey(requestKeyRef.current);
    } else if (!keepPrevious) {
      setItems(null);
      setTotal(null);
    }
    void loadPage(0, true);
  }, [loadPage, opts.resourceKey, keepPrevious]);

  useEffect(
    () => () => {
      const activeRequest = activeRequestRef.current;
      activeRequestRef.current = null;
      activeRequest?.abort();
    },
    [],
  );

  // Revalidate the loaded range without dropping later pages or scroll position.
  useEffect(() => {
    const refresh = () => {
      if (!document.hidden) void loadPage(0, true, true);
    };
    const unsub = libraryChanged.on(() => void loadPage(0, true, true, true));
    let poll: number | null = null;
    if (opts.pollIntervalMs && opts.pollIntervalMs > 0) {
      poll = window.setInterval(refresh, opts.pollIntervalMs);
      document.addEventListener("visibilitychange", refresh);
    }
    return () => {
      unsub();
      if (poll !== null) window.clearInterval(poll);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [loadPage, opts.pollIntervalMs]);

  // Scroll-driven pagination via bottom sentinel.
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sentinelRef.current;
    if (!el) return;
    // The page scrolls inside `.content`, so rootMargin must apply to that
    // scroller; an explicit root that isn't height-constrained (e.g. `.view`,
    // whose overflow-x makes overflow-y compute to auto) would contain the
    // sentinel at any scroll position and load every page.
    const root = findScrollParent(el);
    const obs = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        if (loadingRef.current) return;
        if (items === null || !hasMore) return;
        void loadPage(items.length, false);
      },
      { rootMargin, root },
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, [loadPage, items, hasMore, rootMargin]);

  const stale = items !== null && loadedKey !== requestKey;
  return { items, total, hasMore, loadingMore, error, stale, sentinelRef, reload: () => loadPage(0, true, true, true) };
}
