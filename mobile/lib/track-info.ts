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
    // So the menu offers Delete for an upload, and nothing plays a dropped track.
    owned: track.owned,
    unavailable: track.unavailable,
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

/** A navigation state, as far as `trackMenuTab` reads it. */
interface NavState {
  index?: number;
  type?: string;
  routes: readonly { name: string; params?: object; state?: NavState }[];
}

/** The tab groups, each a tab with its own stack. */
export type TabGroup = "(library)" | "(browse)" | "(favorites)" | "(playlists)" | "(settings)";
const TAB_GROUPS: readonly string[] = ["(library)", "(browse)", "(favorites)", "(playlists)", "(settings)"];

/** Where the track menu opens a screen of a tab's stack (see `trackMenuTab`). */
export interface TrackMenuTab {
  /** The tab in front, or the one under the screens covering the tabs. */
  tab: TabGroup;
  /** How many screens cover the tabs (Now Playing), to close first. */
  cover: number;
  /** The screen on top of that tab's stack. */
  top: { name: string; params?: { id?: string } } | null;
}

// A partial state (not rendered yet) without an index focuses the top of a
// stack, and the first route of anything else.
const focusedIndex = (node: NavState) =>
  node.index ?? (node.type === "stack" ? node.routes.length - 1 : 0);

/**
 * Where the track menu opens Track Info or an editor: in the tab in front,
 * so the tab never changes. Over the tabs (Now Playing) it's the tab
 * underneath, once what covers it closes: pushed past the sheet, a tab
 * route would stack a second set of tabs on top of it. Read at press time
 * from the root navigation state, so the menu in every row doesn't
 * re-render on each navigation the way `useSegments` would. Null when no
 * tab is mounted.
 */
export function trackMenuTab(state: NavState | undefined): TrackMenuTab | null {
  for (let node = state; node; ) {
    const index = focusedIndex(node);
    const at = node.routes.findIndex((route) => route.name === "(tabs)");
    if (at >= 0) {
      const tabs = node.routes[at].state;
      const tabRoute = tabs?.routes[focusedIndex(tabs)];
      if (!tabRoute || !TAB_GROUPS.includes(tabRoute.name)) return null;
      let top: TrackMenuTab["top"] = null;
      for (let stack = tabRoute.state; stack; ) {
        const route = stack.routes[focusedIndex(stack)];
        if (!route) break;
        top = { name: route.name, params: route.params as { id?: string } | undefined };
        stack = route.state;
      }
      return { tab: tabRoute.name as TabGroup, cover: Math.max(0, index - at), top };
    }
    node = node.routes[index]?.state;
  }
  return null;
}
