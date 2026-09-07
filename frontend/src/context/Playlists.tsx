import { createContext, useContext, type ReactNode } from "react";
import { api, type Playlist } from "../api";
import { useAuth } from "./Auth";
import { useApiResource, type ApiResource } from "../lib/useApiResource";
import { useRefreshOnHome } from "../lib/useRefreshOnHome";

const PlaylistsContext = createContext<ApiResource<Playlist[]> | null>(null);

/** Shell and Home share one request for the lifetime of the authenticated shell. */
export function PlaylistsProvider({ children }: { children: ReactNode }) {
  const { me } = useAuth();
  const resource = useApiResource(
    (signal) => me?.must_reset_password ? Promise.resolve([]) : api.listPlaylists({ signal }),
    "Could not load playlists.",
  );
  useRefreshOnHome(resource.reload);
  return <PlaylistsContext.Provider value={resource}>{children}</PlaylistsContext.Provider>;
}

export function usePlaylists() {
  const resource = useContext(PlaylistsContext);
  if (!resource) throw new Error("usePlaylists requires PlaylistsProvider");
  return resource;
}
