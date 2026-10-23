import { useCallback, useSyncExternalStore } from "react";
import { AppState, type NativeEventSubscription } from "react-native";
import {
  queryOptions,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  api,
  createToggleGuard,
  useAuth,
  withFavorite,
  type TrackListItem,
} from "@music-library/core";
import { qk } from "../lib/query-keys";

/**
 * Favorites, backed by the React Query cache rather than core's context
 * provider. The cache is what lets {@link useFavorite} subscribe a single row
 * to its own boolean, so toggling one favorite does not re-render the list.
 *
 * The optimistic transition itself is core's {@link withFavorite}, shared with
 * the web provider — the two had independently written rollback logic, which
 * is precisely the part that must not differ. So is the in-flight guard: a
 * second toggle of a track while its request is out is dropped.
 */

// Module-level, like the query cache it guards; keys carry the user id.
const toggleGuard = createToggleGuard();

/**
 * Id set per favorites snapshot. Every mounted row runs its own `select` when
 * the list changes; building the set once per snapshot makes each of those an
 * O(1) lookup instead of a scan of the whole list.
 */
const favoriteIdSets = new WeakMap<TrackListItem[], Set<string>>();
function favoriteIds(tracks: TrackListItem[]): Set<string> {
  let ids = favoriteIdSets.get(tracks);
  if (!ids) {
    ids = new Set(tracks.map((track) => track.id));
    favoriteIdSets.set(tracks, ids);
  }
  return ids;
}

function favoritesQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: qk.favorites(userId),
    queryFn: ({ signal }) => api.listFavorites({ signal }),
  });
}

/** How long a favorite swiped away in the Favorites list can be undone. */
export const FAVORITE_UNDO_MS = 4000;
/** The Undo strip's closing animation, before the track leaves the list. */
export const FAVORITE_REMOVAL_CLOSE_MS = 320;

/**
 * A favorite removed with Undo: `holding` while the Undo strip shows,
 * `closing` once it folds away and while the DELETE is out.
 */
export type PendingRemovalPhase = "holding" | "closing";

interface PendingRemoval {
  phase: PendingRemovalPhase;
  /** The DELETE has started: Undo is too late, and toggles wait for it. */
  committing: boolean;
  timer: ReturnType<typeof setTimeout> | null;
  commit: () => void;
}

/**
 * Removals waiting out their Undo window, by `${userId}:${trackId}`. The
 * track stays in the favorites cache (and on the server) until the window
 * closes: favoriting it again would move it to the top, and Undo has to put
 * the row back where it was. Module state rather than row state, so a row
 * that scrolls away and is recycled finds its strip again, and the timer
 * outlives it.
 */
const pendingRemovals = new Map<string, PendingRemoval>();
const pendingListeners = new Set<() => void>();
let appStateSubscription: NativeEventSubscription | null = null;

function emitPendingRemovals() {
  for (const listener of pendingListeners) listener();
}

function subscribePendingRemovals(listener: () => void) {
  pendingListeners.add(listener);
  return () => {
    pendingListeners.delete(listener);
  };
}

// The app may be suspended in the background, timers and all: send what's
// waiting before that, rather than on some later launch or never.
function watchAppState() {
  appStateSubscription ??= AppState.addEventListener("change", (status) => {
    if (status !== "background") return;
    for (const removal of [...pendingRemovals.values()]) {
      if (!removal.committing) removal.commit();
    }
  });
}

function settlePendingRemoval(key: string, removal: PendingRemoval) {
  if (removal.timer) clearTimeout(removal.timer);
  if (pendingRemovals.get(key) !== removal) return;
  pendingRemovals.delete(key);
  if (pendingRemovals.size === 0) {
    appStateSubscription?.remove();
    appStateSubscription = null;
  }
  emitPendingRemovals();
}

function favoriteKey(userId: string | undefined, trackId: string | null) {
  return userId && trackId ? `${userId}:${trackId}` : null;
}

/** The canonical favorites list shared by home, the tab and row actions. */
export function useFavoritesQuery(enabled = true) {
  const { status, me } = useAuth();
  return useQuery({
    ...favoritesQueryOptions(me?.id),
    enabled: enabled && status === "authed" && !!me?.id,
  });
}

/**
 * Where a favorite removed with Undo is (see {@link PendingRemovalPhase}),
 * or null. Pass null to skip the lookup.
 */
export function usePendingFavoriteRemoval(
  trackId: string | null,
): PendingRemovalPhase | null {
  const { me } = useAuth();
  const key = favoriteKey(me?.id, trackId);
  return useSyncExternalStore(subscribePendingRemovals, () =>
    key ? (pendingRemovals.get(key)?.phase ?? null) : null,
  );
}

/**
 * Select one boolean from the shared query. React Query only notifies this
 * observer when that track's result changes, rather than rerendering every row
 * after any favorite toggle. A removal waiting out its Undo window already
 * reads as not a favorite.
 */
export function useFavorite(id: string): boolean {
  const { status, me } = useAuth();
  const selectFavorite = useCallback(
    (tracks: TrackListItem[]) => favoriteIds(tracks).has(id),
    [id],
  );
  const query = useQuery({
    ...favoritesQueryOptions(me?.id),
    enabled: status === "authed" && !!me?.id && !!id,
    select: selectFavorite,
  });
  const key = favoriteKey(me?.id, id);
  const removing = useSyncExternalStore(subscribePendingRemovals, () =>
    key ? pendingRemovals.has(key) : false,
  );
  return (query.data ?? false) && !removing;
}

/** Cancels a removal still inside its Undo window. Returns whether it did. */
function cancelPendingRemoval(key: string | null): boolean {
  const removal = key ? pendingRemovals.get(key) : undefined;
  if (!key || !removal || removal.committing) return false;
  settlePendingRemoval(key, removal);
  return true;
}

/**
 * Sends a removal once its Undo window has closed: the track leaves the
 * cache, then the server. It runs in the toggle guard, so a toggle while the
 * DELETE is out is dropped like any in-flight one. A failure puts the row back
 * at its old index; the server never moved it.
 */
async function commitPendingRemoval(
  queryClient: QueryClient,
  userId: string,
  track: TrackListItem,
  key: string,
  removal: PendingRemoval,
) {
  if (removal.committing || pendingRemovals.get(key) !== removal) return;
  removal.committing = true;
  if (removal.timer) clearTimeout(removal.timer);
  removal.timer = null;
  const queryKey = qk.favorites(userId);
  let started = false;
  try {
    await toggleGuard.run(key, async () => {
      started = true;
      await queryClient.cancelQueries({ queryKey, exact: true });
      const rows = queryClient.getQueryData<TrackListItem[]>(queryKey) ?? [];
      const at = rows.findIndex((row) => row.id === track.id);
      // Already gone (a refetch, another device): nothing to send.
      if (at < 0) return;
      queryClient.setQueryData<TrackListItem[]>(queryKey, (current = []) =>
        withFavorite(current, track, false),
      );
      try {
        await api.unfavorite(track.id);
      } catch {
        queryClient.setQueryData<TrackListItem[]>(queryKey, (current = []) =>
          withFavorite(current, track, true, at),
        );
      }
    });
  } finally {
    // Only now, after the cache has dropped the row: settling first would
    // show it again for a moment.
    settlePendingRemoval(key, removal);
    if (started) await queryClient.invalidateQueries({ queryKey, exact: true });
  }
}

/** Optimistic favorites actions that update the same cache all screens read. */
export function useFavoriteActions() {
  const { me } = useAuth();
  const queryClient = useQueryClient();
  const userId = me?.id;

  const refresh = useCallback(async () => {
    if (!userId) return;
    await queryClient.invalidateQueries({
      queryKey: qk.favorites(userId),
      exact: true,
    });
  }, [queryClient, userId]);

  const toggle = useCallback(
    async (track: TrackListItem) => {
      if (!userId) return;
      const queryKey = qk.favorites(userId);
      // A removal still waiting on Undo reads as not a favorite, so this
      // toggle means "keep it": cancel the removal, and it stays in place.
      if (cancelPendingRemoval(favoriteKey(userId, track.id))) return;
      let started = false;
      try {
        await toggleGuard.run(`${userId}:${track.id}`, async () => {
          started = true;
          await queryClient.cancelQueries({ queryKey, exact: true });
          const current = queryClient.getQueryData<TrackListItem[]>(queryKey) ?? [];
          const wasFavorite = current.some((item) => item.id === track.id);

          queryClient.setQueryData<TrackListItem[]>(queryKey, (rows = []) =>
            withFavorite(rows, track, !wasFavorite),
          );

          try {
            if (wasFavorite) await api.unfavorite(track.id);
            else await api.favorite(track.id);
          } catch {
            // Roll back only this track so concurrent toggles for other tracks
            // are preserved instead of restoring an entire stale array snapshot.
            queryClient.setQueryData<TrackListItem[]>(queryKey, (rows = []) =>
              withFavorite(rows, track, wasFavorite),
            );
          }
        });
      } finally {
        // Outside the guard, so a tap during the refetch isn't dropped.
        if (started) await queryClient.invalidateQueries({ queryKey, exact: true });
      }
    },
    [queryClient, userId],
  );

  /**
   * Removes a favorite with Undo (the Favorites list's swipe): it reads as
   * removed at once, holds for {@link FAVORITE_UNDO_MS}, folds away for
   * {@link FAVORITE_REMOVAL_CLOSE_MS}, and only then leaves the cache and the
   * server. Leaving the app sends it straight away.
   */
  const removeWithUndo = useCallback(
    (track: TrackListItem) => {
      const key = favoriteKey(userId, track.id);
      if (!userId || !key || pendingRemovals.has(key)) return;
      const removal: PendingRemoval = {
        phase: "holding",
        committing: false,
        timer: null,
        commit: () => {
          void commitPendingRemoval(queryClient, userId, track, key, removal);
        },
      };
      removal.timer = setTimeout(() => {
        removal.phase = "closing";
        removal.timer = setTimeout(removal.commit, FAVORITE_REMOVAL_CLOSE_MS);
        emitPendingRemovals();
      }, FAVORITE_UNDO_MS);
      pendingRemovals.set(key, removal);
      watchAppState();
      emitPendingRemovals();
    },
    [queryClient, userId],
  );

  /** Undo for {@link removeWithUndo}, while there's still time. */
  const undoRemoval = useCallback(
    (track: TrackListItem) => cancelPendingRemoval(favoriteKey(userId, track.id)),
    [userId],
  );

  return { refresh, toggle, removeWithUndo, undoRemoval };
}
