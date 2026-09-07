import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api, type TrackListItem } from "../api";
import { useAuth } from "../auth/auth-core";
import { withFavoriteId } from "./favorite-toggle";

export interface FavoritesState {
  ids: Set<string>;
  /** Latest fetched rows, shared with Home to avoid a second startup request. */
  tracks: TrackListItem[];
  loading: boolean;
  error: string | null;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<FavoritesState | null>(null);

/**
 * Context-backed favorites provider. Mirrors the server's favorite set in
 * memory and applies optimistic toggles with rollback on API failure.
 *
 * This is the web client's provider. The mobile app deliberately does not use
 * it: it keeps favorites in the React Query cache instead, which lets a single
 * row subscribe to its own boolean rather than re-rendering every row on any
 * toggle. Both share {@link withFavoriteId}/`withFavorite` so the transition
 * and rollback rules stay identical across the two storage strategies.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [ids, setIds] = useState<Set<string>>(new Set());
  const [tracks, setTracks] = useState<TrackListItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  // Mirrors `ids` for the callbacks below, so they can stay referentially
  // stable. Written from an effect (never during render) plus optimistically
  // inside `toggle`.
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  const refresh = useCallback(async () => {
    requestRef.current?.abort();
    const controller = new AbortController();
    requestRef.current = controller;
    setLoading(true);
    setError(null);
    try {
      const rows = await api.listFavorites({ signal: controller.signal });
      if (controller.signal.aborted) return;
      setTracks(rows);
      setIds(new Set(rows.map((t) => t.id)));
    } catch (err) {
      if (controller.signal.aborted) return;
      setError("Could not load favorites.");
      // Non-fatal — the set is re-fetched on the next auth transition and every
      // toggle reconciles against the server — but swallowing it silently made
      // a persistently failing endpoint indistinguishable from "no favorites".
      console.warn("favorites refresh failed", err);
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Auth is an external session source. Refresh intentionally reconciles the
    // local cache when it transitions to authenticated.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (status === "authed") void refresh();
    return () => requestRef.current?.abort();
  }, [status, refresh]);

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback(async (id: string) => {
    // Read through the ref, and write the optimistic result back to it
    // immediately. Closing over `ids` meant (a) `toggle`'s identity changed on
    // every favourite change, invalidating every memoized consumer, and (b) two
    // rapid toggles dispatched before a re-render both saw the same pre-toggle
    // value and issued the same request.
    const had = idsRef.current.has(id);
    const optimistic = withFavoriteId(idsRef.current, id, !had);
    idsRef.current = optimistic;
    setIds(optimistic);
    try {
      if (had) await api.unfavorite(id);
      else await api.favorite(id);
    } catch {
      // Roll back on failure, from whatever the current set is — another
      // toggle may have landed in the meantime.
      const rolledBack = withFavoriteId(idsRef.current, id, had);
      idsRef.current = rolledBack;
      setIds(rolledBack);
    }
  }, []);

  const value = useMemo<FavoritesState>(
    () => ({ ids, tracks, loading, error, isFavorite, toggle, refresh }),
    [ids, tracks, loading, error, isFavorite, toggle, refresh],
  );

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useFavorites() {
  const ctx = useContext(Ctx);
  if (!ctx) throw new Error("useFavorites requires FavoritesProvider");
  return ctx;
}

export function useFavorite(id: string) {
  const { isFavorite } = useFavorites();
  return isFavorite(id);
}

export function useFavoriteActions() {
  const { toggle, refresh } = useFavorites();
  return { toggle, refresh };
}
