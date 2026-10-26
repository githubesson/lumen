/** The search params that open an album or artist page over the library list. */
const DRILL_PARAMS = ["album", "artist", "tidalAlbum", "tidalArtist"] as const;

export function hasLibraryDrill(params: URLSearchParams): boolean {
  return DRILL_PARAMS.some((key) => params.has(key));
}

/** The library list (tab and search) the album or artist page was opened from. */
export function withoutLibraryDrill(params: URLSearchParams): URLSearchParams {
  const next = new URLSearchParams(params);
  for (const key of [...DRILL_PARAMS, "artistName"]) next.delete(key);
  return next;
}
