import { useCallback, useState } from "react";

/**
 * Local `refreshing` state for a scrollable's RefreshControl.
 *
 * Binding `refreshing` to React Query's `isRefetching` shows the spinner for
 * every background refetch — including the automatic stale-data refetch right
 * after the persisted cache restores on a cold launch. On iOS a
 * RefreshControl that is already refreshing when it mounts gets its spinner
 * revealed programmatically (the native side shifts contentOffset by the
 * spinner height), and under a large-title header with
 * `contentInsetAdjustmentBehavior="automatic"` the offset never returns
 * exactly to rest when that refetch settles — every cold boot landed slightly
 * scrolled down. The spinner must reflect only a user-initiated pull, which
 * is what this hook tracks.
 *
 * `refetch` should be referentially stable (React Query's `refetch` is; wrap
 * multi-query combinations in `useCallback`). Rejections are swallowed —
 * query errors surface through the queries themselves.
 */
export function usePullToRefresh(refetch: () => Promise<unknown>): {
  refreshing: boolean;
  onRefresh: () => void;
} {
  const [refreshing, setRefreshing] = useState(false);

  const onRefresh = useCallback(() => {
    setRefreshing(true);
    void refetch()
      .catch(() => undefined)
      .finally(() => setRefreshing(false));
  }, [refetch]);

  return { refreshing, onRefresh };
}
