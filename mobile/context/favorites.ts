import { useCallback } from "react";
import {
  queryOptions,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  api,
  useAuth,
  type TrackListItem,
} from "@music-library/core";
import { qk } from "../lib/query-keys";

const pendingToggles = new Set<string>();

function favoritesQueryOptions(userId: string | undefined) {
  return queryOptions({
    queryKey: qk.favorites(userId),
    queryFn: ({ signal }) => api.listFavorites({ signal }),
  });
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
 * Select one boolean from the shared query. React Query only notifies this
 * observer when that track's result changes, rather than rerendering every row
 * after any favorite toggle.
 */
export function useFavorite(id: string): boolean {
  const { status, me } = useAuth();
  const selectFavorite = useCallback(
    (tracks: TrackListItem[]) => tracks.some((track) => track.id === id),
    [id],
  );
  const query = useQuery({
    ...favoritesQueryOptions(me?.id),
    enabled: status === "authed" && !!me?.id && !!id,
    select: selectFavorite,
  });
  return query.data ?? false;
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
      const pendingKey = `${userId}:${track.id}`;
      if (pendingToggles.has(pendingKey)) return;
      pendingToggles.add(pendingKey);

      const queryKey = qk.favorites(userId);
      await queryClient.cancelQueries({ queryKey, exact: true });
      const current = queryClient.getQueryData<TrackListItem[]>(queryKey) ?? [];
      const wasFavorite = current.some((item) => item.id === track.id);

      queryClient.setQueryData<TrackListItem[]>(queryKey, (rows = []) =>
        wasFavorite
          ? rows.filter((item) => item.id !== track.id)
          : rows.some((item) => item.id === track.id)
            ? rows
            : [track, ...rows],
      );

      try {
        if (wasFavorite) await api.unfavorite(track.id);
        else await api.favorite(track.id);
      } catch {
        // Roll back only this track so concurrent toggles for other tracks are
        // preserved instead of restoring an entire stale array snapshot.
        queryClient.setQueryData<TrackListItem[]>(queryKey, (rows = []) =>
          wasFavorite
            ? rows.some((item) => item.id === track.id)
              ? rows
              : [track, ...rows]
            : rows.filter((item) => item.id !== track.id),
        );
      } finally {
        pendingToggles.delete(pendingKey);
        await queryClient.invalidateQueries({ queryKey, exact: true });
      }
    },
    [queryClient, userId],
  );

  return { refresh, toggle };
}
