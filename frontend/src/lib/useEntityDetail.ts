import { useEffect, useState } from "react";
import { ApiError, errorMessage, type TrackListItem } from "../api";

export type EntityState<T> = T | null | "notfound";

interface EntityLoaders<T> {
  get: (id: string, options: { signal: AbortSignal }) => Promise<T>;
  listTracks: (
    id: string,
    options: { signal: AbortSignal },
  ) => Promise<TrackListItem[]>;
  /** Noun used in the error message, e.g. "album". */
  label: string;
}

/**
 * Load a detail entity + its tracks with a cancellable fetch and 404 ->
 * "notfound" handling. Extracted from the near-identical AlbumDetailView /
 * ArtistDetailView effects (and now actually aborts the in-flight request).
 */
export function useEntityDetail<T>(
  id: string,
  { get, listTracks, label }: EntityLoaders<T>,
): { entity: EntityState<T>; tracks: TrackListItem[] | null; error: string | null } {
  const [entity, setEntity] = useState<EntityState<T>>(null);
  const [tracks, setTracks] = useState<TrackListItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    setEntity(null);
    setTracks(null);
    setError(null);
    Promise.all([
      get(id, { signal: controller.signal }),
      listTracks(id, { signal: controller.signal }),
    ])
      .then(([e, t]) => {
        if (cancelled) return;
        setEntity(e);
        setTracks(t ?? []);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted) return;
        if (err instanceof ApiError && err.status === 404) {
          setEntity("notfound");
          return;
        }
        setError(errorMessage(err, `Failed to load ${label}.`));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, get, listTracks, label]);

  return { entity, tracks, error };
}
