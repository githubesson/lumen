import type { QueryClient } from "@tanstack/react-query";
import {
  api,
  libraryChanged,
  rescanChangedLibrary,
  watchRescan,
} from "@music-library/core";
import { qk } from "./query-keys";

export const rescanStatusQuery = {
  queryKey: qk.adminRescanStatus,
  queryFn: ({ signal }: { signal: AbortSignal }) => api.rescanStatus({ signal }),
  staleTime: 0,
};

let rescanWatch: Promise<void> | null = null;

/**
 * Polls the rescan status through the query cache (which keeps the progress
 * on screen live) until the scan is idle, then fires one library-wide refresh
 * if the scan changed anything, so other screens pull updated lists. It runs
 * outside the screen so leaving Admin → Library mid-scan still refreshes, and
 * it starts from a known scan rather than reacting to idle statuses, since
 * every mount and focus fetch reports idle and would otherwise invalidate the
 * whole library cache. One watcher at a time.
 */
export function followRescan(queryClient: QueryClient): void {
  if (rescanWatch) return;
  rescanWatch = watchRescan({
    fetchStatus: () => queryClient.fetchQuery(rescanStatusQuery),
  })
    .then((status) => {
      if (!status) {
        // Gave up on a status endpoint that kept failing. Dropping the cached
        // "running" status clears the spinner, and a later read that finds the
        // scan still running follows it again.
        void queryClient.resetQueries({ queryKey: rescanStatusQuery.queryKey });
        return;
      }
      if (rescanChangedLibrary(status)) libraryChanged.emit();
    })
    .finally(() => {
      rescanWatch = null;
    });
}
