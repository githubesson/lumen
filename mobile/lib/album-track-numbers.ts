import type { TrackListItem } from "@music-library/core";

/**
 * The numbers an album page's rows lead with. The tracks' own numbers when
 * every track has one and they climb down the list: one disc, or one partly
 * saved (2, 5, 9), keeps its real numbers as tracks arrive. Otherwise the
 * place in the list, so a second disc restarting at 1, untagged tracks or
 * unmatched library copies mixed in never show a number twice.
 */
export function albumTrackNumbers(
  tracks: readonly Pick<TrackListItem, "track_no">[],
): number[] {
  let last = 0;
  const climbing = tracks.every(({ track_no: n }) => {
    if (!n || !Number.isInteger(n) || n <= last) return false;
    last = n;
    return true;
  });
  return tracks.map((track, index) => (climbing ? track.track_no! : index + 1));
}
