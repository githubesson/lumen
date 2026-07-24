import {
  albumCoverUrl,
  trackCoverUrl,
  type Album,
  type Artist,
  type Playlist,
  type TrackListItem,
} from "@music-library/core";

import type {
  CarPlayImage,
  CarPlayListItem,
  CarPlayListLimits,
  CarPlayListSection,
  CarPlayListTemplate,
  CarPlayNavButton,
} from "../../modules/carplay";

/**
 * Pure builders for the CarPlay template tree.
 *
 * Kept free of React and of the native module so the row shapes, the
 * destination encoding and the head-unit item cap can be unit tested; the
 * bridge component only fetches data and pushes what these return.
 *
 * Two rules shape the layout. Everything the driver browses is one tap from
 * the tab bar, and every row carries an image — artwork where there is any, an
 * SF Symbol where there isn't — because a glanceable list is a row of pictures
 * with words attached, not a wall of text.
 */

export const CARPLAY_ROOT_ID = "root";

/** Ids of the five root tabs. Stable, because `updateList` finds them again. */
export const CARPLAY_TAB = {
  home: "tab:home",
  recent: "tab:recent",
  favorites: "tab:favorites",
  playlists: "tab:playlists",
  albums: "tab:albums",
} as const;

/**
 * Cover pixels requested per row. CarPlay draws list artwork at roughly 60pt,
 * so this covers a 2x car screen with room to spare, and one size for every
 * row means the app and the car share cache entries.
 */
const COVER_PIXELS = 160;

/** SF Symbols. Browse rows wear one instead of artwork; track rows hold one
 *  until their cover loads, so the list never reflows under the driver. */
const SYMBOL = {
  track: "music.note",
  home: "house.fill",
  nowPlaying: "waveform",
  recent: "clock.arrow.circlepath",
  favorites: "heart.fill",
  playlists: "music.note.list",
  playlist: "music.note.list",
  smartPlaylist: "sparkles",
  albums: "square.stack",
  album: "square.stack",
  artists: "music.mic",
  artist: "music.mic",
  play: "play.fill",
  shuffle: "shuffle",
} as const;

/**
 * Where a row leads. Encoded into the row id because that string is all the
 * native `onSelect` event carries back — CarPlay owns the rendered list, so
 * there is no row object on this side to attach state to.
 */
export type CarPlayDestination =
  | { kind: "now-playing" }
  | { kind: "recent" }
  | { kind: "favorites" }
  | { kind: "playlists" }
  | { kind: "albums" }
  | { kind: "artists" }
  | { kind: "queue" }
  /** Acts on the list the row sits in: `onSelect` carries the template id. */
  | { kind: "play-list" }
  | { kind: "shuffle-list" }
  | { kind: "playlist"; id: string }
  | { kind: "album"; id: string }
  | { kind: "artist"; id: string }
  | { kind: "track"; id: string }
  /** A position in the live queue, not a track id: a queue can hold the same
   *  track twice, and Up Next rows jump rather than restart. */
  | { kind: "queued"; id: string };

type DestinationKind = CarPlayDestination["kind"];

const KEYED_KINDS = new Set<DestinationKind>([
  "playlist",
  "album",
  "artist",
  "track",
  "queued",
]);
const BARE_KINDS = new Set<DestinationKind>([
  "now-playing",
  "recent",
  "favorites",
  "playlists",
  "albums",
  "artists",
  "queue",
  "play-list",
  "shuffle-list",
]);

/** `"favorites"`, `"playlist:<id>"`. */
export function encodeDestination(destination: CarPlayDestination): string {
  return "id" in destination
    ? `${destination.kind}:${destination.id}`
    : destination.kind;
}

/** Inverse of {@link encodeDestination}; `null` for anything unrecognised. */
export function decodeDestination(itemId: string): CarPlayDestination | null {
  const separator = itemId.indexOf(":");
  if (separator === -1) {
    return BARE_KINDS.has(itemId as DestinationKind)
      ? ({ kind: itemId } as CarPlayDestination)
      : null;
  }

  const kind = itemId.slice(0, separator) as DestinationKind;
  // Ids can themselves contain colons (`tidal:1234`), so everything after the
  // first separator is the id.
  const id = itemId.slice(separator + 1);
  if (!id || !KEYED_KINDS.has(kind)) return null;
  return { kind, id } as CarPlayDestination;
}

/** Template id for a pushed screen. Distinct from the tab ids so that pushing
 *  a list which also exists as a tab doesn't steal the tab's updates. */
export function pushedTemplateId(destination: CarPlayDestination): string {
  return `push:${encodeDestination(destination)}`;
}

/** One line under the title: the artist, or the album when unattributed. */
export function trackSubtitle(track: TrackListItem): string | undefined {
  return track.artist || track.album_title || undefined;
}

/** Cover URL for a track row, or nothing when the track has no artwork. */
export function trackArtwork(track: TrackListItem): string | undefined {
  if (track.has_cover === false) return undefined;
  return trackCoverUrl(track, COVER_PIXELS);
}

function albumArtwork(album: Album): string | undefined {
  return album.has_cover ? albumCoverUrl(album.id, COVER_PIXELS) : undefined;
}

/** Resolves a track's artwork. The bridge substitutes downloaded covers so
 *  rows still have images with no network. */
export type CoverResolver = (track: TrackListItem) => string | undefined;

type Limits = CarPlayListLimits;

/** State the car has to distinguish: still loading, failed to load, or loaded
 *  and genuinely empty. All three are a blank list without this. */
type LoadState = {
  /** `undefined` items mean the list could not be loaded, which reads
   *  differently in the car than a list that is genuinely empty. */
  loading?: boolean;
  /** Shown when the list loaded with nothing in it. */
  emptyText?: string;
};

function emptyState(
  loaded: boolean,
  { loading, emptyText }: LoadState,
): Pick<CarPlayListTemplate, "emptyTitle" | "emptyText" | "loading"> {
  if (loaded) return { emptyText };
  if (loading) return { emptyText: "Loading…", loading: true };
  return { emptyTitle: "Not available offline", emptyText: "Reconnect to browse this list." };
}

/**
 * CarPlay renders the first `maximumSectionCount` sections and drops the rest
 * without telling the user, so every template is assembled through here.
 */
function listTemplate(
  template: CarPlayListTemplate,
  limits: Limits,
): CarPlayListTemplate {
  return {
    ...template,
    sections: template.sections
      .filter((section) => section.items.length > 0)
      .slice(0, limits.maximumSectionCount),
  };
}

/**
 * The head unit renders only the first `maximumItemCount` rows of a list and
 * silently drops the rest. Take what fits, and let the caller say so in the
 * section header rather than leaving the driver to wonder where the rest went.
 */
function take<T>(items: T[], budget: number): T[] {
  return items.slice(0, Math.max(0, budget));
}

const PLURALS: Record<string, string> = {
  song: "songs",
  album: "albums",
  playlist: "playlists",
  artist: "artists",
};

function countLabel(shown: number, total: number, noun: string): string {
  const plural = total === 1 ? noun : PLURALS[noun];
  return shown < total
    ? `First ${shown} of ${total} ${plural}`
    : `${total} ${plural}`;
}

/** "47 min", "3 hr 12 min" — a rough sense of length, not a stopwatch. */
function durationLabel(tracks: TrackListItem[]): string | undefined {
  const totalMs = tracks.reduce((sum, track) => sum + (track.duration_ms || 0), 0);
  const minutes = Math.round(totalMs / 60_000);
  if (minutes < 1) return undefined;
  if (minutes < 60) return `${minutes} min`;
  const remainder = minutes % 60;
  const hours = Math.floor(minutes / 60);
  return remainder ? `${hours} hr ${remainder} min` : `${hours} hr`;
}

function trackSectionHeader(shown: TrackListItem[], total: number): string {
  const count = countLabel(shown.length, total, "song");
  const duration = durationLabel(shown);
  return duration ? `${count} · ${duration}` : count;
}

function trackRow(
  track: TrackListItem,
  options: {
    currentTrackId?: string | null;
    isPlayable?: (trackId: string) => boolean;
    coverFor: CoverResolver;
    id?: string;
  },
): CarPlayListItem {
  return {
    id: options.id ?? encodeDestination({ kind: "track", id: track.id }),
    text: track.title,
    detailText: trackSubtitle(track),
    isPlaying: track.id === options.currentTrackId,
    enabled: options.isPlayable ? options.isPlayable(track.id) : true,
    imageUrl: options.coverFor(track),
    symbol: SYMBOL.track,
  };
}

function browseRow(
  destination: CarPlayDestination,
  text: string,
  options: { detailText?: string; symbol?: string; imageUrl?: string } = {},
): CarPlayListItem {
  return {
    id: encodeDestination(destination),
    text,
    detailText: options.detailText,
    symbol: options.symbol,
    imageUrl: options.imageUrl,
    showsDisclosureIndicator: true,
  };
}

/**
 * Play and Shuffle above the tracks. Two of the three things anyone does with
 * a list in a car, promoted out of the rows so neither needs aim.
 */
function actionSection(): CarPlayListSection {
  return {
    items: [
      {
        id: encodeDestination({ kind: "play-list" }),
        text: "Play",
        symbol: SYMBOL.play,
      },
      {
        id: encodeDestination({ kind: "shuffle-list" }),
        text: "Shuffle",
        symbol: SYMBOL.shuffle,
      },
    ],
  };
}

/**
 * The jump back to now playing, in the navigation bar of every screen.
 *
 * A bar button rather than a tab: it's needed from wherever the driver has
 * browsed to, and tabs are the scarcer resource — the head unit shows five.
 */
export function nowPlayingNavButton(
  currentTrack?: TrackListItem | null,
): CarPlayNavButton {
  return {
    id: encodeDestination({ kind: "now-playing" }),
    symbol: SYMBOL.nowPlaying,
    enabled: !!currentTrack,
  };
}

/** A row of covers, each opening what it shows. */
function shelfRow(
  destination: CarPlayDestination,
  tiles: CarPlayImage[],
): CarPlayListItem {
  return {
    // Tapping the row beside the covers goes where "see all" goes.
    id: encodeDestination(destination),
    text: "",
    images: tiles,
  };
}

function trackTile(track: TrackListItem, coverFor: CoverResolver): CarPlayImage {
  return {
    id: encodeDestination({ kind: "track", id: track.id }),
    imageUrl: coverFor(track) ?? "",
  };
}

function albumTile(album: Album): CarPlayImage {
  return {
    id: encodeDestination({ kind: "album", id: album.id }),
    imageUrl: albumArtwork(album) ?? "",
  };
}

/**
 * The albums behind a run of recently played tracks, newest first and each
 * counted once — a play history is mostly the same few records repeating.
 */
export function recentAlbumTiles(
  tracks: TrackListItem[],
  limit: number,
  coverFor: CoverResolver,
): CarPlayImage[] {
  const seen = new Set<string>();
  const tiles: CarPlayImage[] = [];

  for (const track of tracks) {
    const albumId = track.album_id;
    if (!albumId || seen.has(albumId)) continue;
    seen.add(albumId);
    tiles.push({
      id: encodeDestination({ kind: "album", id: albumId }),
      imageUrl: coverFor(track) ?? "",
    });
    if (tiles.length >= limit) break;
  }

  return tiles;
}

/** Time-of-day greeting, the way a home screen opens. */
export function greetingFor(date: Date): string {
  const hour = date.getHours();
  if (hour < 12) return "Good morning";
  if (hour < 18) return "Good afternoon";
  return "Good evening";
}

export type TrackListTemplateOptions = {
  id: string;
  title: string;
  limits: Limits;
  tracks: TrackListItem[] | undefined;
  /** Draws the playing indicator on the matching row. */
  currentTrackId?: string | null;
  /** Rows that fail this are dimmed — offline and not downloaded. */
  isPlayable?: (trackId: string) => boolean;
  coverFor?: CoverResolver;
  /** Suppresses the Play/Shuffle rows; used where they'd be nonsense. */
  showActions?: boolean;
  tab?: { title: string; symbol: string };
  navButton?: CarPlayNavButton;
} & LoadState;

export function buildTrackListTemplate({
  id,
  title,
  limits,
  tracks,
  currentTrackId,
  isPlayable,
  coverFor = trackArtwork,
  showActions = true,
  emptyText = "No songs here yet.",
  loading,
  tab,
  navButton,
}: TrackListTemplateOptions): CarPlayListTemplate {
  const actions = showActions && tracks && tracks.length > 1 ? actionSection() : null;
  const shown = take(tracks ?? [], limits.maximumItemCount - (actions ? 2 : 0));

  return listTemplate(
    {
      id,
      title,
      sections: [
        ...(actions ? [actions] : []),
        {
          header: tracks?.length
            ? trackSectionHeader(shown, tracks.length)
            : undefined,
          items: shown.map((track) =>
            trackRow(track, { currentTrackId, isPlayable, coverFor }),
          ),
        },
      ],
      ...emptyState(tracks !== undefined, { loading, emptyText }),
      ...(tab ? { tabTitle: tab.title, tabSymbol: tab.symbol } : {}),
      navButton,
    },
    limits,
  );
}

/**
 * What follows the current track. Rows address a queue position rather than a
 * track id: a queue can hold the same track twice, and selecting one should
 * jump there rather than start the list over.
 */
function upNextRows(
  queue: TrackListItem[],
  index: number,
  budget: number,
  coverFor: CoverResolver,
): CarPlayListItem[] {
  return take(queue.slice(index + 1), budget).map((track, offset) =>
    trackRow(track, {
      coverFor,
      id: encodeDestination({ kind: "queued", id: String(index + 1 + offset) }),
    }),
  );
}

/** Rows of a shelf's worth of playlists, before the full list is worth a tap. */
const HOME_ROW_LIMIT = 4;

export type HomeTabOptions = {
  limits: Limits;
  /** Passed in rather than read from the clock, so the builder stays pure. */
  greeting: string;
  currentTrack?: TrackListItem | null;
  recent: TrackListItem[] | undefined;
  favorites: TrackListItem[] | undefined;
  playlists: Playlist[] | undefined;
  albums: Album[] | undefined;
  loading?: boolean;
  coverFor?: CoverResolver;
  navButton?: CarPlayNavButton;
};

/**
 * The Home tab: what's playing, then a shelf per way back into the library.
 *
 * Artwork carries this screen. A driver recognises a record by its cover long
 * before they can read its name, so the top of the app is rows of covers with
 * a chevron beside each heading — one glance to know what's there, one tap to
 * see all of it.
 */
export function buildHomeTab({
  limits,
  greeting,
  currentTrack,
  recent,
  favorites,
  playlists,
  albums,
  loading,
  coverFor = trackArtwork,
  navButton,
}: HomeTabOptions): CarPlayListTemplate {
  const shelfSize = limits.maximumImageRowCount;
  const recentTiles = recentAlbumTiles(recent ?? [], shelfSize, coverFor);
  const favoriteTiles = take(favorites ?? [], shelfSize).map((track) =>
    trackTile(track, coverFor),
  );
  const albumTiles = take(albums ?? [], shelfSize).map(albumTile);
  const playlistRows = take(playlists ?? [], HOME_ROW_LIMIT).map(playlistRow);

  return listTemplate(
    {
      id: CARPLAY_TAB.home,
      title: "Lumen",
      tabTitle: "Home",
      tabSymbol: SYMBOL.home,
      navButton,
      sections: [
        {
          items: currentTrack
            ? [
                {
                  ...trackRow(currentTrack, {
                    currentTrackId: currentTrack.id,
                    coverFor,
                    id: encodeDestination({ kind: "now-playing" }),
                  }),
                  showsDisclosureIndicator: true,
                },
              ]
            : [],
        },
        {
          header: greeting,
          headerSubtitle: recentTiles.length ? "Pick up where you left off" : undefined,
          headerButtonId: encodeDestination({ kind: "recent" }),
          items: recentTiles.length
            ? [shelfRow({ kind: "recent" }, recentTiles)]
            : [],
        },
        {
          header: "Favorites",
          headerButtonId: encodeDestination({ kind: "favorites" }),
          items: favoriteTiles.length
            ? [shelfRow({ kind: "favorites" }, favoriteTiles)]
            : [],
        },
        {
          header: "Playlists",
          headerButtonId: encodeDestination({ kind: "playlists" }),
          items: playlistRows,
        },
        {
          header: "Albums",
          headerButtonId: encodeDestination({ kind: "albums" }),
          items: albumTiles.length
            ? [shelfRow({ kind: "albums" }, albumTiles)]
            : [],
        },
      ],
      ...(loading
        ? { emptyText: "Loading…", loading: true }
        : {
            emptyTitle: "Nothing here yet",
            emptyText: "Add music on your iPhone and it shows up here.",
          }),
    },
    limits,
  );
}

/** The whole queue, pushed from the now-playing screen's Up Next button. */
export function buildQueueTemplate({
  limits,
  queue,
  index,
  coverFor = trackArtwork,
}: {
  limits: Limits;
  queue: TrackListItem[];
  index: number;
  coverFor?: CoverResolver;
}): CarPlayListTemplate {
  const rows = upNextRows(queue, index, limits.maximumItemCount, coverFor);
  const remaining = Math.max(0, queue.length - index - 1);

  return listTemplate(
    {
      id: pushedTemplateId({ kind: "queue" }),
      title: "Up Next",
      sections: [
        { header: countLabel(rows.length, remaining, "song"), items: rows },
      ],
      emptyTitle: "Nothing queued",
      emptyText: "This is the last song.",
    },
    limits,
  );
}

function playlistRow(playlist: Playlist): CarPlayListItem {
  return browseRow({ kind: "playlist", id: playlist.id }, playlist.name, {
    detailText: playlist.is_smart ? "Smart playlist" : undefined,
    symbol: playlist.is_smart ? SYMBOL.smartPlaylist : SYMBOL.playlist,
  });
}

export function buildPlaylistsTemplate({
  limits,
  playlists,
  loading,
  navButton,
}: {
  limits: Limits;
  playlists: Playlist[] | undefined;
  navButton?: CarPlayNavButton;
} & LoadState): CarPlayListTemplate {
  const shown = take(playlists ?? [], limits.maximumItemCount);

  return listTemplate(
    {
      id: CARPLAY_TAB.playlists,
      title: "Playlists",
      tabTitle: "Playlists",
      tabSymbol: SYMBOL.playlists,
      navButton,
      sections: [
        {
          header: playlists?.length
            ? countLabel(shown.length, playlists.length, "playlist")
            : undefined,
          items: shown.map(playlistRow),
        },
      ],
      ...emptyState(playlists !== undefined, {
        loading,
        emptyText: "No playlists yet.",
      }),
    },
    limits,
  );
}

/**
 * The Albums tab, with the way into artists sitting above it: five tabs is the
 * system limit, and artists is the browse axis that loses least by being one
 * tap deeper.
 */
export function buildAlbumsTemplate({
  limits,
  albums,
  loading,
  navButton,
}: {
  limits: Limits;
  albums: Album[] | undefined;
  navButton?: CarPlayNavButton;
} & LoadState): CarPlayListTemplate {
  const shown = take(albums ?? [], limits.maximumItemCount - 1);

  return listTemplate(
    {
      id: CARPLAY_TAB.albums,
      title: "Albums",
      tabTitle: "Albums",
      tabSymbol: SYMBOL.albums,
      navButton,
      sections: [
        {
          items: [
            browseRow({ kind: "artists" }, "Artists", {
              symbol: SYMBOL.artists,
            }),
          ],
        },
        {
          header: albums?.length
            ? countLabel(shown.length, albums.length, "album")
            : undefined,
          items: shown.map((album) =>
            browseRow({ kind: "album", id: album.id }, album.title, {
              detailText: album.artist_name || undefined,
              imageUrl: albumArtwork(album),
              symbol: SYMBOL.album,
            }),
          ),
        },
      ],
      ...emptyState(albums !== undefined, {
        loading,
        emptyText: "No albums yet.",
      }),
    },
    limits,
  );
}

/**
 * Artists, grouped into A–Z sections so the head unit can draw its index strip
 * — but only while the letters fit under the section cap, since a dropped
 * section is dropped artists.
 */
export function buildArtistsTemplate({
  limits,
  artists,
  loading,
  navButton,
}: {
  limits: Limits;
  artists: Artist[] | undefined;
  navButton?: CarPlayNavButton;
} & LoadState): CarPlayListTemplate {
  const shown = take(artists ?? [], limits.maximumItemCount);
  const rows = shown.map((artist) =>
    browseRow({ kind: "artist", id: artist.id }, artist.name, {
      detailText: countLabel(artist.track_count, artist.track_count, "song"),
      symbol: SYMBOL.artist,
    }),
  );

  // A trimmed list says so in its header instead, since a letter header has
  // nowhere to put "and 200 more".
  const complete = shown.length === (artists?.length ?? 0);

  return listTemplate(
    {
      id: pushedTemplateId({ kind: "artists" }),
      title: "Artists",
      navButton,
      sections: (complete && alphabetize(shown, rows, limits)) || [
        {
          header: artists?.length
            ? countLabel(shown.length, artists.length, "artist")
            : undefined,
          items: rows,
        },
      ],
      ...emptyState(artists !== undefined, {
        loading,
        emptyText: "No artists yet.",
      }),
    },
    limits,
  );
}

/** One section per initial, or `null` when that wouldn't fit. */
function alphabetize(
  artists: Artist[],
  rows: CarPlayListItem[],
  limits: Limits,
): CarPlayListSection[] | null {
  if (!artists.length) return null;

  const sections: CarPlayListSection[] = [];
  artists.forEach((artist, position) => {
    const initial = indexTitleFor(artist.name);
    const current = sections[sections.length - 1];
    if (current?.indexTitle === initial) {
      current.items.push(rows[position]);
      return;
    }
    sections.push({ header: initial, indexTitle: initial, items: [rows[position]] });
  });

  return sections.length <= limits.maximumSectionCount ? sections : null;
}

function indexTitleFor(name: string): string {
  const initial = name.trim().charAt(0).toUpperCase();
  return /[A-Z]/.test(initial) ? initial : "#";
}

/**
 * The five tabs across the top of the car screen: Home first, then the lists
 * its shelves lead into, so the chevron beside a heading and the tab under it
 * arrive at the same place.
 */
export function buildLibraryTabs(options: {
  limits: Limits;
  greeting: string;
  currentTrack?: TrackListItem | null;
  currentTrackId?: string | null;
  isPlayable?: (trackId: string) => boolean;
  coverFor?: CoverResolver;
  recent: { tracks: TrackListItem[] | undefined; loading?: boolean };
  favorites: { tracks: TrackListItem[] | undefined; loading?: boolean };
  playlists: { playlists: Playlist[] | undefined; loading?: boolean };
  albums: { albums: Album[] | undefined; loading?: boolean };
}): CarPlayListTemplate[] {
  const { limits, currentTrack, currentTrackId, isPlayable, coverFor } = options;
  const navButton = nowPlayingNavButton(currentTrack);
  const shared = { limits, currentTrackId, isPlayable, coverFor, navButton };

  return [
    buildHomeTab({
      limits,
      coverFor,
      navButton,
      greeting: options.greeting,
      currentTrack,
      recent: options.recent.tracks,
      favorites: options.favorites.tracks,
      playlists: options.playlists.playlists,
      albums: options.albums.albums,
      loading:
        options.recent.loading ||
        options.favorites.loading ||
        options.albums.loading,
    }),
    buildTrackListTemplate({
      ...shared,
      id: CARPLAY_TAB.recent,
      title: "Recent",
      tab: { title: "Recent", symbol: SYMBOL.recent },
      tracks: options.recent.tracks,
      loading: options.recent.loading,
      emptyText: "Songs you play show up here.",
    }),
    buildTrackListTemplate({
      ...shared,
      id: CARPLAY_TAB.favorites,
      title: "Favorites",
      tab: { title: "Favorites", symbol: SYMBOL.favorites },
      tracks: options.favorites.tracks,
      loading: options.favorites.loading,
      emptyText: "Tap the heart on a song to keep it here.",
    }),
    buildPlaylistsTemplate({ limits, navButton, ...options.playlists }),
    buildAlbumsTemplate({ limits, navButton, ...options.albums }),
  ].slice(0, limits.maximumTabCount);
}

/** Before sign-in the car shows a prompt instead of an empty library. */
export function buildSignedOutTemplate(): CarPlayListTemplate {
  return {
    id: CARPLAY_ROOT_ID,
    title: "Lumen",
    sections: [],
    emptyTitle: "Not signed in",
    emptyText: "Sign in on your iPhone to browse your library here.",
  };
}
