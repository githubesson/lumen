import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, useAuth } from "@music-library/core";
import {
  releaseVersionsOf,
  tidalArtistReleases,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import { qk } from "./query-keys";

/**
 * The versions of TIDAL album `id` (explicit, clean, Dolby Atmos), found
 * among the releases of TIDAL artist `artistId`. Coming from the artist's
 * page they're already cached, so the switcher is there on the first frame.
 * Null when there's no artist to ask or the album has no other version.
 */
export function useReleaseVersions(
  artistId: string | undefined,
  id: string | undefined,
): ArtistRelease[] | null {
  const { me } = useAuth();
  // Only the switcher depends on it, so a failure shows nothing.
  const { data } = useQuery({
    queryKey: qk.tidalArtist(me?.id, artistId),
    queryFn: ({ signal }) => api.getTidalArtist(artistId!, { signal }),
    enabled: !!me && !!artistId,
  });
  return useMemo(
    () =>
      data && id
        ? releaseVersionsOf(tidalArtistReleases(data.albums), id)
        : null,
    [data, id],
  );
}
