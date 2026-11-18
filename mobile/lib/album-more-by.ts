import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, useAuth } from "@music-library/core";
import {
  libraryArtistReleases,
  releasesBesides,
  tidalArtistReleases,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import { qk } from "./query-keys";

/** At most this many tiles: the artist's page lists the rest. */
const MORE_BY_LIMIT = 12;

/**
 * A TIDAL album page's "More by": the other releases of the TIDAL artist the
 * page lists versions from, one tile per release. It shares that artist's
 * query with the version picker and the artist page, so coming from the
 * artist it's there at once. `name` is that artist's, which a compilation's
 * own artist line ("Various Artists") wouldn't be. Empty until it loads, and
 * on failure: only the shelf depends on it.
 */
export function useTidalMoreBy(
  artistId: string | undefined,
  albumId: string | undefined,
): { name: string; releases: ArtistRelease[] } {
  const { me } = useAuth();
  const { data } = useQuery({
    queryKey: qk.tidalArtist(me?.id, artistId),
    queryFn: ({ signal }) => api.getTidalArtist(artistId!, { signal }),
    enabled: !!me && !!artistId,
  });
  return useMemo(
    () => ({
      name: data?.artist?.name ?? "",
      releases:
        data && albumId
          ? releasesBesides(tidalArtistReleases(data.albums), albumId).slice(0, MORE_BY_LIMIT)
          : [],
    }),
    [data, albumId],
  );
}

/**
 * A library album page's "More by": the album artist's other albums in the
 * library, from the same track listing the artist page loads. Empty without
 * an artist page to ask, until it loads, and on failure.
 */
export function useLibraryMoreBy(
  artistId: string | undefined,
  albumId: string | undefined,
): ArtistRelease[] {
  const { me } = useAuth();
  const { data } = useQuery({
    queryKey: qk.artistTracks(me?.id, artistId),
    queryFn: ({ signal }) => api.listArtistTracks(artistId!, { signal }),
    enabled: !!me && !!artistId,
  });
  return useMemo(
    () =>
      data
        ? libraryArtistReleases(data)
            .filter((release) => release.id !== albumId)
            .slice(0, MORE_BY_LIMIT)
        : [],
    [data, albumId],
  );
}
