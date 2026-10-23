import {
  displayArtists,
  type TrackDetail,
  type TrackInfoLink,
  type TrackInfoRow,
  type TrackListItem,
} from "@music-library/core";

/**
 * The page a link in Track Info opens. The hrefs leave out the tab group, so
 * the router pushes them in whichever tab's stack Track Info is in: every
 * tab carries these screens, and back returns to Track Info.
 */
export function trackInfoHref(link: TrackInfoLink) {
  const params = { id: link.id };
  if (link.kind === "album") {
    return link.source === "tidal"
      ? { pathname: "/(tabs)/tidal-albums/[id]" as const, params }
      : { pathname: "/(tabs)/albums/[id]" as const, params };
  }
  return link.source === "tidal"
    ? { pathname: "/(tabs)/tidal-artists/[id]" as const, params }
    : { pathname: "/(tabs)/artists/[id]" as const, params };
}

/** The list item the player and the track menu take, from a track's detail. */
export function trackInfoListItem(track: TrackDetail): TrackListItem {
  return {
    id: track.id,
    db_track_id: track.db_track_id,
    source: track.source,
    source_id: track.source_id,
    source_album_id: track.source_album_id,
    title: track.title,
    album_id: track.album_id,
    album_title: track.album_title,
    track_no: track.track_no,
    duration_ms: track.duration_ms,
    artist: displayArtists(track),
    favorited: track.favorited,
    has_cover: track.has_cover,
    cover_url: track.cover_url,
  };
}

/**
 * One line of a section's two-column grid: two cells side by side, the
 * second null when the first stands alone, or one wide cell across both.
 */
export type TrackInfoGridLine =
  | { wide: false; cells: [TrackInfoRow, TrackInfoRow | null] }
  | { wide: true; cells: [TrackInfoRow] };

/**
 * A section's rows laid out two to a line, in order. A wide row (comments,
 * copyright, a file name) takes a line of its own, leaving the cell beside a
 * row before it empty.
 */
export function trackInfoGridLines(rows: readonly TrackInfoRow[]): TrackInfoGridLine[] {
  const lines: TrackInfoGridLine[] = [];
  let pending: TrackInfoRow | null = null;
  for (const row of rows) {
    if (row.wide) {
      if (pending) lines.push({ wide: false, cells: [pending, null] });
      pending = null;
      lines.push({ wide: true, cells: [row] });
    } else if (pending) {
      lines.push({ wide: false, cells: [pending, row] });
      pending = null;
    } else {
      pending = row;
    }
  }
  if (pending) lines.push({ wide: false, cells: [pending, null] });
  return lines;
}

/** A navigation state, as far as `focusedInTabs` reads it. */
interface NavState {
  index?: number;
  type?: string;
  routes: readonly { name: string; state?: NavState }[];
}

/**
 * Whether the screen in front is in one of the tabs, rather than over them
 * (Now Playing). Read at press time from the root navigation state, so the
 * track menu in every row doesn't re-render on each navigation the way
 * `useSegments` would.
 */
export function focusedInTabs(state: NavState | undefined): boolean {
  for (let node = state; node; ) {
    // A partial state (not rendered yet) without an index focuses the top
    // of a stack, and the first route of anything else.
    const index = node.index ?? (node.type === "stack" ? node.routes.length - 1 : 0);
    const route = node.routes[index];
    if (!route) return false;
    if (route.name === "(tabs)") return true;
    node = route.state;
  }
  return false;
}
