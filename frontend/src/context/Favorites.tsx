import { FavoritesProvider as SharedFavoritesProvider, useAuth, useFavorites } from "@music-library/core";
import type { ReactNode } from "react";
import { useRefreshOnHome } from "../lib/useRefreshOnHome";

export {
  useFavorites,
  type FavoritesState,
} from "@music-library/core";

export function FavoritesProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  // A session change must discard the previous account's shared rows/IDs.
  return (
    <SharedFavoritesProvider key={me?.id ?? "guest"}>
      <RefreshOnHome />
      {children}
    </SharedFavoritesProvider>
  );
}

function RefreshOnHome() {
  const { refresh } = useFavorites();
  const { status } = useAuth();
  useRefreshOnHome(() => { if (status === "authed") void refresh(); });
  return null;
}
