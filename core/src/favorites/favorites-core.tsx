import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
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

  const refresh = useCallback(async () => {
    try {
      const rows = await api.listFavorites();
      setIds(new Set(rows.map((t) => t.id)));
    } catch {
      // silent; called again on interactions
    }
  }, []);

  useEffect(() => {
    if (status === "authed") void refresh();
  }, [status, refresh]);

  const isFavorite = useCallback((id: string) => ids.has(id), [ids]);

  const toggle = useCallback(
    async (id: string) => {
      // Optimistic
      const had = ids.has(id);
      setIds((prev) => {
        const next = new Set(prev);
        if (had) next.delete(id);
        else next.add(id);
        return next;
      });
      try {
        if (had) await api.unfavorite(id);
        else await api.favorite(id);
      } catch {
        // Roll back on failure
        setIds((prev) => {
          const next = new Set(prev);
          if (had) next.add(id);
          else next.delete(id);
          return next;
        });
      }
    },
    [ids],
  );

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
