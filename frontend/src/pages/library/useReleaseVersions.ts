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
 * among the releases of `artistId`: the artist the album was opened from,
 * else its own primary artist once the album has loaded. Coming from the
 * artist's page they're cached, so the switcher is there on the first frame
 * and stays put as each version loads. Null when there's no artist to ask or
 * the album has no other version.
 */
export function useReleaseVersions(artistId: string | null | undefined, id: string): ArtistRelease[] | null {
  const key = artistId ? `tidal-artist:${artistId}` : undefined;
  const cached = useMemo(() => readCache<TidalArtist>(key) ?? null, [key]);
  const [fetched, setFetched] = useState<{ key: string; artist: TidalArtist } | null>(null);
  const artist = cached ?? (fetched && fetched.key === key ? fetched.artist : null);
  useEffect(() => {
    if (!artistId || !key || cached) return;
    const controller = new AbortController();
    api
      .getTidalArtist(artistId, { signal: controller.signal })
      .then((result) => {
        writeCache(key, result);
        setFetched({ key, artist: result });
      })
      // Only the switcher depends on it.
      .catch(() => {});
    return () => controller.abort();
  }, [artistId, key, cached]);
  return useMemo(
    () => (artist ? releaseVersionsOf(tidalArtistReleases(artist.albums), id) : null),
    [artist, id],
  );
}
