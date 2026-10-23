import {
  ApiError,
  trackCredits,
  type TidalAlbum,
  type TidalStreamQuality,
  type TidalTrackInfo,
  type TrackArtist,
  type TrackDetail,
} from "../api";
import { trackAlbumTarget } from "../entity-target";
import {
  displayText,
  formatBitrate,
  formatBytes,
  formatCalendarDate,
  formatDurationMs,
  formatSampleRate,
} from "../format";
import { isTidalTrack } from "../track";

/**
 * The server's explanation when TIDAL refused a request ("TIDAL refused …:
 * <reason>", always a 502), or null for any other failure, whose text isn't
 * written for users.
 */
export function tidalRefusalMessage(error: unknown): string | null {
  return error instanceof ApiError && error.status === 502 && error.message.startsWith("TIDAL refused")
    ? error.message
    : null;
}

/**
 * A name in a track's info view that opens a page: an artist's or an
 * album's, in the library (`id` is the library id) or on TIDAL (`id` is
 * TIDAL's).
 */
export interface TrackInfoLink {
  name: string;
  kind: "artist" | "album";
  source: "local" | "tidal";
  id: string;
}

/** A name in a track's info view: a link when it has a page, else just the name. */
export type TrackInfoName =
  | TrackInfoLink
  | { name: string; kind?: undefined; source?: undefined; id?: undefined };

/** Whether a name in the view opens a page. */
export function isTrackInfoLink(name: TrackInfoName): name is TrackInfoLink {
  return name.kind !== undefined;
}

/** A credit row before the view cleans it: see `TrackInfoRow.names`. */
export interface TrackInfoCredit {
  label: string;
  value: string;
  names?: TrackInfoName[];
}

const tidalArtistName = (name: string, id: string | undefined): TrackInfoName =>
  id ? { name, kind: "artist", source: "tidal", id } : { name };

/** Names as one credit value, "—" for none. */
const creditOf = (label: string, names: TrackInfoName[]): TrackInfoCredit =>
  names.length > 0 ? { label, value: names.map((n) => n.name).join(", "), names } : { label, value: "—" };

/**
 * The track's own credit rows (`trackCredits`), with Primary artist and
 * Featured name by name, `linked` to their library pages. Only a library
 * track's artists have pages: a TIDAL track's stored artist ids are for the
 * hidden rows behind it. Producers stay one plain value, since the server
 * stores a composer tag ("A, B") as one credit.
 */
function ownTrackCredits(
  track: { artists?: TrackArtist[]; composer?: string },
  linked: boolean,
): TrackInfoCredit[] {
  const names = (role: string): TrackInfoName[] =>
    (track.artists ?? [])
      .filter((artist) => artist.role === role)
      .map((artist): TrackInfoName =>
        linked && artist.id
          ? { name: artist.name, kind: "artist", source: "local", id: artist.id }
          : { name: artist.name },
      );
  const [primary, featured, producers] = trackCredits(track);
  return [creditOf(primary.label, names("primary")), creditOf(featured.label, names("featured")), producers];
}

/**
 * The credit rows of a TIDAL track's info view: Primary artist, Featured and
 * Producers as for any track, then each other role TIDAL credits, in its
 * order. TIDAL's values win; the track's own fill in what TIDAL lacks. Each
 * name TIDAL gives an artist id links to its TIDAL artist page.
 */
export function tidalTrackCredits(
  track: { artists?: TrackArtist[]; composer?: string },
  info: TidalTrackInfo,
): TrackInfoCredit[] {
  const artists = (role: "main" | "featured") =>
    info.artists
      .filter((artist) => artist.role === role)
      .map((artist) => tidalArtistName(artist.name, artist.id));
  const roles = new Map<string, { label: string; names: TrackInfoName[] }>();
  for (const credit of info.credits) {
    const key = credit.role.trim().toLowerCase();
    if (!key) continue;
    const entry = roles.get(key) ?? { label: roleLabel(credit.role), names: [] };
    // An older server sends names alone.
    const people: { id?: string; name: string }[] = credit.contributors ?? credit.names.map((name) => ({ name }));
    for (const person of people) {
      const name = tidalArtistName(person.name, person.id);
      const seen = entry.names.findIndex((n) => n.name === name.name);
      if (seen < 0) entry.names.push(name);
      // The same person credited twice, with their id only the second time.
      else if (!isTrackInfoLink(entry.names[seen]) && isTrackInfoLink(name)) entry.names[seen] = name;
    }
    roles.set(key, entry);
  }
  const producers = roles.get("producer")?.names ?? [];
  roles.delete("producer");
  const [primary, featured, ownProducers] = ownTrackCredits(track, false);
  const main = artists("main");
  const guests = artists("featured");
  return [
    main.length > 0 ? creditOf(primary.label, main) : primary,
    // TIDAL's split is authoritative once it names a main artist.
    guests.length > 0 || main.length > 0 ? creditOf(featured.label, guests) : featured,
    producers.length > 0 ? creditOf(ownProducers.label, producers) : ownProducers,
    ...[...roles.values()]
      .filter((role) => role.names.length > 0)
      .map((role) => creditOf(role.label, role.names)),
  ];
}

/**
 * TIDAL's "Mixing Engineer" as "Mixing engineer", the way the view writes
 * its own labels. Acronyms ("A&R") keep their case.
 */
function roleLabel(role: string): string {
  return role
    .trim()
    .split(/\s+/)
    .map((word, i) => (i > 0 && /^[A-Z][a-z]+$/.test(word) ? word.toLowerCase() : word))
    .join(" ");
}

interface TierAudio {
  format: string;
  quality: string;
  /** Empty when the tier doesn't fix it. */
  bitDepth: string;
  sampleRate: string;
  bitrate: string;
  /** The tier in one phrase, for when it's only a ceiling. */
  summary: string;
}

/** What a stream at `tier` is, as TIDAL defines its tiers. */
function tierAudio(tier: TidalStreamQuality | string | undefined): TierAudio | null {
  switch (tier) {
    case "HI_RES_LOSSLESS":
      return { format: "FLAC", quality: "Hi-Res Lossless", bitDepth: "24-bit", sampleRate: "Up to 192 kHz", bitrate: "", summary: "Hi-Res Lossless (24-bit FLAC)" };
    case "LOSSLESS":
      return { format: "FLAC", quality: "Lossless", bitDepth: "16-bit", sampleRate: "44.1 kHz", bitrate: "", summary: "Lossless (16-bit / 44.1 kHz FLAC)" };
    case "HIGH":
      return { format: "AAC", quality: "Lossy", bitDepth: "", sampleRate: "", bitrate: "320 kbps", summary: "AAC 320 kbps" };
    case "LOW":
      return { format: "AAC", quality: "Lossy", bitDepth: "", sampleRate: "", bitrate: "96 kbps", summary: "AAC 96 kbps" };
    default:
      return null;
  }
}

/**
 * The stream rows of a TIDAL track's info view. The stream this server is
 * serving right now fixes them; without one, only the best tier it would
 * ask for is known, since playback can fall back lower, so that shows as a
 * ceiling.
 */
export function tidalAudioRows(
  info: TidalTrackInfo | null,
): { label: string; value: string; wide?: boolean }[] {
  const streamed = tierAudio(info?.streamed_quality);
  if (streamed) {
    return [
      { label: "Format", value: streamed.format },
      { label: "Quality", value: streamed.quality },
      { label: "Bit depth", value: streamed.bitDepth },
      { label: "Sample rate", value: streamed.sampleRate },
      { label: "Bitrate", value: streamed.bitrate },
    ].filter((row) => row.value);
  }
  const ceiling = tierAudio(info?.max_quality);
  return [{ label: "Quality", value: ceiling ? `Up to ${ceiling.summary}` : "—", wide: !!ceiling }];
}

/** The TIDAL id to ask for a track's TIDAL details, or null for a library track. */
export function trackInfoTidalId(
  track: Pick<TrackDetail, "source" | "source_id"> | null | undefined,
): string | null {
  return track?.source === "tidal" ? (track.source_id ?? null) : null;
}

/** What a track's info view got from TIDAL. */
export interface TidalTrackInfoResult {
  /** TIDAL's details, when they came for this track. */
  info: TidalTrackInfo | null;
  /** A TIDAL track whose details didn't come: an error, a timeout, no answer offline. */
  failed: boolean;
  /** The server's reason when TIDAL refused the track. */
  refusal: string | null;
}

/**
 * Read a settled `getTidalTrack` for the track's `tidalId` (see
 * `trackInfoTidalId`): its details only when they're for that id, and a
 * failure for anything else. A library track (no id) has nothing to miss.
 */
export function tidalTrackInfoResult(
  tidalId: string | null | undefined,
  data: TidalTrackInfo | null | undefined,
  error?: unknown,
): TidalTrackInfoResult {
  if (!tidalId) return { info: null, failed: false, refusal: null };
  const info = !error && data?.id === tidalId ? data : null;
  return { info, failed: !info, refusal: error ? tidalRefusalMessage(error) : null };
}

export interface TrackInfoRow {
  label: string;
  /** What to show; "—" only in a row kept while empty (see `empty`). */
  value: string;
  /** The value is "—": nothing to show, faded by a client that can. */
  empty?: boolean;
  /** Long text (comments, copyright, a file name, a quality ceiling): give it the full width or more lines. */
  wide?: boolean;
  /**
   * A list of artists or credited people name by name, each a link when it
   * has a page; joined with ", " they read as `value`. Absent from other
   * rows, and from Producers taken from a file's composer tag, which the
   * server stores as one name.
   */
  names?: TrackInfoName[];
}

export interface TrackInfoSection {
  key: "credits" | "release" | "audio";
  label: string;
  rows: TrackInfoRow[];
  /** Under the section: why part of it couldn't load from TIDAL. */
  note: string | null;
}

export interface TrackInfoView {
  /** Above the sections: why a TIDAL track's details are missing. */
  note: string | null;
  sections: TrackInfoSection[];
  /** The track's artists for a header line, main ones first: Primary artist, then Featured. */
  artists: TrackInfoName[];
  /** The album for a header line, a link when it has a page; null without one. */
  album: TrackInfoName | null;
  /** The release year for the album line ("" when unknown): TIDAL's, else the track's. */
  year: string;
}

/**
 * The TIDAL album whose primary artist id can link a TIDAL track's primary
 * artist (see `trackInfoRows`), when TIDAL's details gave no artist ids: an
 * older server, or no details at all. Null when there's nothing to ask.
 */
export function trackInfoArtistAlbumId(
  track: Pick<TrackDetail, "source" | "source_album_id"> | null | undefined,
  tidal: TidalTrackInfoResult | null,
): string | null {
  if (!track || !isTidalTrack(track) || !track.source_album_id) return null;
  return tidal?.info?.artists.some((artist) => artist.id) ? null : track.source_album_id;
}

const isBlank = (value: string | null | undefined) => !value?.trim() || value === "—";

/**
 * A track's info view, the same on both clients: Credits, Release and Audio,
 * with notes for what TIDAL couldn't supply, and the artists, album and year
 * for a header.
 *
 * - Credits: TIDAL's for a TIDAL track that has them (`tidalTrackCredits`),
 *   else the track's own (`trackCredits`). Primary artist, Featured and
 *   Producers always show, "—" saying nobody is credited.
 * - Release: Released (TIDAL's date) or else Year, Genre, Track, Disc, BPM,
 *   Key, ISRC, Comments and Copyright.
 * - Audio: for a TIDAL track its stream (Source, then `tidalAudioRows`, whose
 *   Quality shows "—" while nothing is known), Channels and Duration; for a
 *   file its Format, Bitrate, Sample rate, Channels, Duration, File size and
 *   File name.
 *
 * Any other row shows only when the track has a value, Genre included (TIDAL
 * has no genres, and an empty one on a file says nothing either). A section
 * with no rows and no note is left out. Tag text is cleaned with `displayText`.
 *
 * Names link where a page exists: a library track's artists and album to
 * their library pages; a TIDAL track's album, and the artists and credited
 * people TIDAL gives ids for, to their TIDAL pages. When TIDAL gave no artist
 * ids, `tidalAlbum` (see `trackInfoArtistAlbumId`) can still link the
 * primary artist, when it's the album's.
 */
export function trackInfoRows(
  track: TrackDetail,
  tidal: TidalTrackInfoResult | null,
  tidalAlbum?: Pick<TidalAlbum, "id" | "artist" | "artist_id"> | null,
): TrackInfoView {
  const info = tidal?.info ?? null;
  const row = (label: string, value: string | null | undefined, wide?: boolean): TrackInfoRow | null =>
    isBlank(value) ? null : { label, value: value!.trim(), ...(wide ? { wide } : {}) };
  const kept = (label: string, value: string, wide?: boolean): TrackInfoRow =>
    isBlank(value) ? { label, value: "—", empty: true, ...(wide ? { wide } : {}) } : row(label, value, wide)!;
  const count = (n: number | null | undefined) => (n ? String(n) : "");

  const ownCredits = info ? tidalTrackCredits(track, info) : ownTrackCredits(track, !isTidalTrack(track));
  const albumArtist = tidalAlbumArtist(track, tidalAlbum);
  if (albumArtist) ownCredits[0] = linkAlbumArtist(ownCredits[0], albumArtist);
  const clean = (names: TrackInfoName[] | undefined) =>
    names?.map((name) => ({ ...name, name: displayText(name.name) }));
  const credits = ownCredits.map((credit) => {
    const cleaned = kept(credit.label, displayText(credit.value));
    const names = clean(credit.names);
    return names && !cleaned.empty ? { ...cleaned, names } : cleaned;
  });

  const released = info?.release_date ? formatCalendarDate(info.release_date) : "";
  const release = [
    isBlank(released) ? row("Year", count(track.year)) : row("Released", released),
    row("Genre", displayText(track.genre)),
    row("Track", count(track.track_no)),
    row("Disc", count(track.disc_no)),
    row("BPM", count(info?.bpm)),
    row("Key", info?.key),
    row("ISRC", info?.isrc),
    row("Comments", displayText(track.comments), true),
    row("Copyright", displayText(info?.copyright), true),
  ];

  const duration = row("Duration", formatDurationMs(track.duration_ms, ""));
  const audio =
    track.source === "tidal"
      ? [
          row("Source", "TIDAL"),
          ...tidalAudioRows(info).map((r) => kept(r.label, r.value, r.wide)),
          row("Channels", count(info?.channels)),
          duration,
        ]
      : [
          row("Format", track.format),
          row("Bitrate", formatBitrate(track.bitrate)),
          row("Sample rate", formatSampleRate(track.sample_rate)),
          row("Channels", count(track.channels)),
          duration,
          row("File size", formatBytes(track.file_size)),
          row("File", track.file_name, true),
        ];

  const sections: TrackInfoSection[] = [
    {
      key: "credits",
      label: "Credits",
      rows: credits,
      note: info?.credits_failed ? (info.credits_failure ?? "Couldn't load credits from TIDAL.") : null,
    },
    { key: "release", label: "Release", rows: release.filter((r) => r !== null), note: info?.release_failure || null },
    { key: "audio", label: "Audio", rows: audio.filter((r) => r !== null), note: null },
  ];
  const albumTarget = trackAlbumTarget(track);
  const albumTitle = displayText(track.album_title);
  return {
    note: tidal?.failed
      ? (tidal.refusal ?? "Couldn't load more from TIDAL, so some fields are missing.")
      : null,
    sections: sections.filter((section) => section.rows.length > 0 || section.note),
    artists: [...(credits[0]?.names ?? []), ...(credits[1]?.names ?? [])],
    album: albumTitle
      ? albumTarget
        ? { name: albumTitle, kind: "album", source: albumTarget.kind, id: albumTarget.id }
        : { name: albumTitle }
      : null,
    year: info?.release_date?.match(/^(\d{4})-/)?.[1] ?? (track.year ? String(track.year) : ""),
  };
}

/** The TIDAL album's primary artist, when the album is this TIDAL track's and says who that is. */
function tidalAlbumArtist(
  track: TrackDetail,
  album: Pick<TidalAlbum, "id" | "artist" | "artist_id"> | null | undefined,
): { name: string; id: string } | null {
  if (!isTidalTrack(track) || !album || album.id !== track.source_album_id) return null;
  const name = album.artist?.trim();
  return name && album.artist_id ? { name, id: album.artist_id } : null;
}

/** The Primary artist row, its plain name that's the album's primary artist linked to their TIDAL page. */
function linkAlbumArtist(credit: TrackInfoCredit, artist: { name: string; id: string }): TrackInfoCredit {
  if (!credit.names) return credit;
  const names = credit.names.map((name) =>
    !isTrackInfoLink(name) && name.name.trim().toLowerCase() === artist.name.toLowerCase()
      ? tidalArtistName(name.name, artist.id)
      : name,
  );
  return { ...credit, names };
}
