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
import { api } from "../api";
import { useAuth } from "../auth/auth-core";

export interface FavoritesState {
  ids: Set<string>;
  isFavorite: (id: string) => boolean;
  toggle: (id: string) => Promise<void>;
  refresh: () => Promise<void>;
}

const Ctx = createContext<FavoritesState | null>(null);

/**
 * Platform-agnostic favorites provider. Mirrors the server's favorite set in
 * memory and applies optimistic toggles with rollback on API failure.
 */
export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { status } = useAuth();
  const [ids, setIds] = useState<Set<string>>(new Set());
  // Mirrors `ids` for the callbacks below, so they can stay referentially
  // stable. Written from an effect (never during render) plus optimistically
  // inside `toggle`.
  const idsRef = useRef(ids);
  useEffect(() => {
    idsRef.current = ids;
  }, [ids]);

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listFavorites();
      setIds(new Set(rows.map((t) => t.id)));
    } catch (err) {
      // Non-fatal — the set is re-fetched on the next auth transition and every
      // toggle reconciles against the server — but swallowing it silently made
      // a persistently failing endpoint indistinguishable from "no favorites".
      console.warn("favorites refresh failed", err);
    }
  }, []);

  useEffect(() => {
    if (status === "authed") void refresh();
  }, [status, refresh]);

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback(async (id: string) => {
    // Read through the ref, and write the optimistic result back to it
    // immediately. Closing over `ids` meant (a) `toggle`'s identity changed on
    // every favourite change, invalidating every memoized consumer, and (b) two
    // rapid toggles dispatched before a re-render both saw the same pre-toggle
    // value and issued the same request.
    const had = idsRef.current.has(id);
    const optimistic = new Set(idsRef.current);
    if (had) optimistic.delete(id);
    else optimistic.add(id);
    idsRef.current = optimistic;
    setIds(optimistic);
    try {
      if (had) await api.unfavorite(id);
      else await api.favorite(id);
    } catch {
      // Roll back on failure, from whatever the current set is — another
      // toggle may have landed in the meantime.
      const rolledBack = new Set(idsRef.current);
      if (had) rolledBack.add(id);
      else rolledBack.delete(id);
      idsRef.current = rolledBack;
      setIds(rolledBack);
    }
  }, []);

  const value = useMemo<FavoritesState>(
    () => ({ ids, isFavorite, toggle, refresh }),
    [ids, isFavorite, toggle, refresh],
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
