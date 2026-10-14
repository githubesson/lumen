import { periodLabel, type Period } from "@music-library/core/replay/period";

/**
 * Every kind of panel Home can show, with what the Add panel dialog says
 * about it and how big a new one starts out.
 *
 * Widths are sixths of the wide board (a third, a half, two thirds or all
 * of it) and heights are board rows. A kind whose panel can say different
 * things (a period's top tracks, one playlist) can go on the board more than
 * once; the rest only once.
 */

export type PanelKind =
  | "resume"
  | "repeat"
  | "recent"
  | "favorites"
  | "albums"
  | "playlists"
  | "artists"
  | "top-albums"
  | "added"
  | "playlist"
  | "stats"
  | "genres"
  | "activity";

export const PANEL_WIDTHS = [2, 3, 4, 6] as const;
export type PanelWidth = (typeof PANEL_WIDTHS)[number];
export const PANEL_HEIGHTS = [1, 2] as const;
export type PanelHeight = (typeof PANEL_HEIGHTS)[number];

export const PANEL_WIDTH_LABELS: Record<PanelWidth, string> = {
  2: "Third",
  3: "Half",
  4: "Two thirds",
  6: "Full",
};
export const PANEL_HEIGHT_LABELS: Record<PanelHeight, string> = {
  1: "Regular",
  2: "Tall",
};

export type PanelGroup = "listening" | "library";

export interface PanelKindInfo {
  /** Its title on the board, unless renamed. */
  title: string;
  /** What the Add panel dialog says it shows. */
  description: string;
  group: PanelGroup;
  w: PanelWidth;
  h: PanelHeight;
  /** It shows a Replay period's numbers, which the user picks. */
  period?: boolean;
  /** It shows one playlist, which the user picks. */
  playlist?: boolean;
}

export const PANEL_KINDS: Record<PanelKind, PanelKindInfo> = {
  resume: {
    title: "Jump back in",
    description: "The album you were last on, with Play to pick up where you left off.",
    group: "library",
    w: 4,
    h: 1,
  },
  repeat: {
    title: "On repeat",
    description: "Your most played tracks, ranked, for the period you pick.",
    group: "listening",
    w: 2,
    h: 2,
    period: true,
  },
  artists: {
    title: "Top artists",
    description: "The artists you've played most in a period.",
    group: "listening",
    w: 6,
    h: 1,
    period: true,
  },
  "top-albums": {
    title: "Top albums",
    description: "The albums you've played most in a period.",
    group: "listening",
    w: 6,
    h: 1,
    period: true,
  },
  stats: {
    title: "Your listening",
    description: "Plays, listening time, tracks and artists in a period.",
    group: "listening",
    w: 2,
    h: 1,
    period: true,
  },
  genres: {
    title: "Top genres",
    description: "The genres you've played most in a period, by share of plays.",
    group: "listening",
    w: 2,
    h: 1,
    period: true,
  },
  activity: {
    title: "Listening activity",
    description: "How much you played across a period, as a chart.",
    group: "listening",
    w: 4,
    h: 1,
    period: true,
  },
  recent: {
    title: "Recently played",
    description: "The last tracks you played.",
    group: "library",
    w: 2,
    h: 1,
  },
  favorites: {
    title: "Your favorites",
    description: "Tracks you've hearted, newest first.",
    group: "library",
    w: 2,
    h: 1,
  },
  added: {
    title: "Recently added",
    description: "The newest tracks in your library.",
    group: "library",
    w: 2,
    h: 1,
  },
  albums: {
    title: "Albums",
    description: "The albums newest to your library.",
    group: "library",
    w: 4,
    h: 1,
  },
  playlists: {
    title: "Playlists",
    description: "Your playlists, to open or play.",
    group: "library",
    w: 2,
    h: 1,
  },
  playlist: {
    title: "Playlist",
    description: "One playlist's tracks, to play from any of them.",
    group: "library",
    w: 2,
    h: 1,
    playlist: true,
  },
};

export const PANEL_KIND_IDS = Object.keys(PANEL_KINDS) as PanelKind[];

/** Kinds that can be on the board more than once. */
export function allowsMany(kind: PanelKind): boolean {
  const info = PANEL_KINDS[kind];
  return !!(info.period || info.playlist);
}

/** The period a new panel shows, and the built-in ones always did. */
export const DEFAULT_PERIOD: Period = { kind: "last-30" };

/** The eyebrow a period panel shows over its title. */
export function periodSub(period: Period | undefined): string {
  return periodLabel(period ?? DEFAULT_PERIOD);
}
