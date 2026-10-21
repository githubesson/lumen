import { useEffect, useMemo, useState } from "react";
import { api, type TidalArtist } from "../../api";
import {
  releaseVersionsOf,
  tidalArtistReleases,
  type ArtistRelease,
} from "@music-library/core/artist-releases";
import { readCache, writeCache } from "../../lib/resourceCache";

/**
 * The versions of TIDAL album `id` (explicit, clean, Dolby Atmos), found
 * among the releases of the artist it was opened from. Coming from that
 * artist's page they're cached, so the switcher is there on the first frame
 * and stays put as each version loads. Null when there's no artist to ask or
 * the album has no other version.
 */
export function useReleaseVersions(artistId: string | null, id: string): ArtistRelease[] | null {
  const key = artistId ? `tidal-artist:${artistId}` : undefined;
  const [artist, setArtist] = useState(() => readCache<TidalArtist>(key) ?? null);
  useEffect(() => {
    if (!artistId || artist) return;
    const controller = new AbortController();
    api
      .getTidalArtist(artistId, { signal: controller.signal })
      .then((result) => {
        writeCache(`tidal-artist:${artistId}`, result);
        setArtist(result);
      })
      // Only the switcher depends on it.
      .catch(() => {});
    return () => controller.abort();
  }, [artistId, artist]);
  return useMemo(
    () => (artist ? releaseVersionsOf(tidalArtistReleases(artist.albums), id) : null),
    [artist, id],
  );
}
