import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, errorMessage, type TrackListItem } from "../api";
import { dropCache, readCache, writeCache } from "./resourceCache";

export type EntityState<T> = T | null | "notfound";

interface Cached<T> {
  entity: T;
  tracks: TrackListItem[];
}

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
 * A revisit starts from the last load of the same entity and refreshes it.
 */
export function useEntityDetail<T>(
  id: string,
  { get, listTracks, label }: EntityLoaders<T>,
): {
  entity: EntityState<T>;
  tracks: TrackListItem[] | null;
  error: string | null;
  /** Refetch in place, without clearing to the loading state. Failures are ignored. */
  refresh: () => void;
  /** Show (and cache) an entity the caller got back from saving it. */
  replace: (entity: T) => void;
} {
  const key = `${label}:${id}`;
  const [entity, setEntity] = useState<EntityState<T>>(
    () => readCache<Cached<T>>(key)?.entity ?? null,
  );
  const [tracks, setTracks] = useState<TrackListItem[] | null>(
    () => readCache<Cached<T>>(key)?.tracks ?? null,
  );
  const [error, setError] = useState<string | null>(null);
  // Only the newest read may commit: replace() bumps it too, so a save made
  // while the mount or a refresh read is out isn't rolled back by it.
  const genRef = useRef(0);

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    const gen = ++genRef.current;
    // A changed entity id invalidates the previous entity/track snapshot.
    const cached = readCache<Cached<T>>(key);
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEntity(cached?.entity ?? null);
    setTracks(cached?.tracks ?? null);
    setError(null);
    Promise.all([
      get(id, { signal: controller.signal }),
      listTracks(id, { signal: controller.signal }),
    ])
      .then(([e, t]) => {
        if (cancelled || gen !== genRef.current) return;
        writeCache(key, { entity: e, tracks: t ?? [] } satisfies Cached<T>);
        setEntity(e);
        setTracks(t ?? []);
      })
      .catch((err) => {
        if (cancelled || controller.signal.aborted || gen !== genRef.current) return;
        if (err instanceof ApiError && err.status === 404) {
          dropCache(key);
          setEntity("notfound");
          return;
        }
        setError(errorMessage(err, `Failed to load ${label}.`));
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [id, key, get, listTracks, label]);

  const refreshing = useRef<AbortController | null>(null);
  useEffect(() => () => refreshing.current?.abort(), [id]);
  const refresh = useCallback(() => {
    refreshing.current?.abort();
    const controller = new AbortController();
    refreshing.current = controller;
    const gen = ++genRef.current;
    Promise.all([
      get(id, { signal: controller.signal }),
      listTracks(id, { signal: controller.signal }),
    ])
      .then(([e, t]) => {
        if (controller.signal.aborted || gen !== genRef.current) return;
        writeCache(key, { entity: e, tracks: t ?? [] } satisfies Cached<T>);
        setEntity(e);
        setTracks(t ?? []);
        setError(null);
      })
      .catch(() => {});
  }, [id, key, get, listTracks]);

  const replace = useCallback(
    (next: T) => {
      genRef.current += 1;
      setEntity(next);
      setError(null);
      if (tracks) writeCache(key, { entity: next, tracks } satisfies Cached<T>);
    },
    [key, tracks],
  );

  return { entity, tracks, error, refresh, replace };
}
