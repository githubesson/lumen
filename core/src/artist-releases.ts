import type { SearchAlbum, TrackListItem, TrackSource } from "./api";
import { pluralize } from "./format";

/** Popular tracks an artist page shows before "See more". */
export const ARTIST_POPULAR_PREVIEW_COUNT = 5;

export type ReleaseKind = "Album" | "EP" | "Single";
export type ReleaseFilter = "all" | "albums" | "singles";
export const RELEASE_FILTER_OPTIONS: { value: ReleaseFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "albums", label: "Albums" },
  { value: "singles", label: "Singles & EPs" },
];

/**
 * One tile in an artist's discography. Field names follow the album payloads
 * so cover helpers that take an album accept a release unchanged.
 */
export interface ArtistRelease {
  id: string;
  title: string;
  track_count: number;
  release_year?: number;
  has_cover?: boolean;
  cover_url?: string;
  /** Unset for library albums; with `source_id`, what the release opens. */
  source?: TrackSource;
  source_id?: string;
  /** Unknown for library albums, which are grouped from the artist's tracks. */
  kind?: ReleaseKind;
  /** TIDAL releases, as on `SearchAlbum`. */
  version?: string;
  explicit?: boolean;
  dolby_atmos?: boolean;
  /**
   * Set by `foldReleaseVersions` on a release TIDAL also lists in other
   * versions: all of them, this one first.
   */
  versions?: ArtistRelease[];
}

/**
 * The artist endpoint doesn't carry TIDAL's release type, so classify the way
 * Spotify documents it: up to 3 tracks is a single and up to 6 an EP, both
 * only when under 30 minutes. An unknown duration falls back to track count.
 */
export function releaseKind(trackCount: number, durationMs: number): ReleaseKind {
  const short = !(durationMs >= 30 * 60_000);
  if (trackCount > 0 && trackCount <= 3 && short) return "Single";
  if (trackCount > 0 && trackCount <= 6 && short) return "EP";
  return "Album";
}

/** Newest first; TIDAL returns albums and singles/EPs as two concatenated runs. */
export function tidalArtistReleases(albums: SearchAlbum[]): ArtistRelease[] {
  return albums
    .map((album) => ({
      id: album.id,
      title: album.title,
      track_count: album.track_count,
      release_year: album.release_year || undefined,
      has_cover: album.has_cover,
      cover_url: album.cover_url,
      // The artist endpoint only lists TIDAL releases.
      source: "tidal" as const,
      source_id: album.source_id,
      kind: releaseKind(album.track_count, album.duration_ms),
      version: album.version,
      explicit: album.explicit,
      dolby_atmos: album.dolby_atmos,
    }))
    .sort(newestFirst);
}

function newestFirst(a: ArtistRelease, b: ArtistRelease): number {
  return (b.release_year ?? 0) - (a.release_year ?? 0);
}

/**
 * Which version a folded tile opens: stereo before Dolby Atmos, then
 * explicit before clean (the release as the artist made it), then TIDAL's
 * order.
 */
function versionRank(release: ArtistRelease): number {
  return (release.dolby_atmos ? 2 : 0) + (release.explicit ? 0 : 1);
}

/**
 * One tile per release. TIDAL lists an album's explicit, clean and Dolby
 * Atmos versions as separate albums under one title. They share the title,
 * TIDAL's version name (so a deluxe edition keeps its own tile) and the
 * release year (so do an artist's self-titled albums, years apart). A
 * single stays apart from an album of the same name, but an album and an
 * EP don't: a clean copy that drops a track can cross that line. TIDAL
 * also lists exact duplicates (the same flags and track count); only the
 * first of those is kept, so they don't pass for versions. A folded tile
 * is its preferred version, with `versions` listing them all.
 */
export function foldReleaseVersions(releases: ArtistRelease[]): ArtistRelease[] {
  const groups = new Map<string, ArtistRelease[]>();
  const copies = new Set<string>();
  for (const release of releases) {
    const copy = copyKey(release);
    if (copies.has(copy)) continue;
    copies.add(copy);
    const key = releaseKey(release);
    const group = groups.get(key);
    if (group) group.push(release);
    else groups.set(key, [release]);
  }
  return [...groups.values()]
    .map((group) => {
      if (group.length === 1) return group[0];
      const versions = [...group].sort((a, b) => versionRank(a) - versionRank(b));
      return { ...versions[0], versions };
    })
    .sort(newestFirst);
}

/** What a release's versions share (see `foldReleaseVersions`). */
function releaseKey(release: ArtistRelease): string {
  return [
    release.kind === "Single",
    release.title.trim().toLowerCase(),
    release.version?.trim().toLowerCase(),
    release.release_year,
  ].join("\n");
}

/** What TIDAL's duplicate copies of one version share. */
function copyKey(release: ArtistRelease): string {
  return [releaseKey(release), !!release.explicit, !!release.dolby_atmos, release.track_count].join("\n");
}

/**
 * The versions of the TIDAL album `sourceId` among an artist's releases, if
 * it has others. A duplicate copy the fold dropped (opened from search,
 * say) stands in for the copy kept, so its page can switch too.
 */
export function releaseVersionsOf(releases: ArtistRelease[], sourceId: string): ArtistRelease[] | null {
  const album = releases.find((release) => release.source_id === sourceId);
  if (!album) return null;
  const versions = foldReleaseVersions(releases).find(
    (release) => releaseKey(release) === releaseKey(album),
  )?.versions;
  return versions?.map((version) => (copyKey(version) === copyKey(album) ? album : version)) ?? null;
}

export interface ReleaseVersionLabel {
  /** Short, for a segmented control: only what differs between the versions. */
  label: string;
  /** Everything, for a tooltip: "Dolby Atmos · Explicit · 7 tracks · 2026". */
  description: string;
}

/**
 * Names for a release's versions (from `foldReleaseVersions`, so no two
 * share their flags and track count). Dolby Atmos versions say so; stereo
 * ones are "Explicit" or "Clean" when that differs between them, and
 * otherwise "Stereo" beside an Atmos version. Versions still alike add
 * their track count.
 */
export function releaseVersionLabels(versions: ArtistRelease[]): ReleaseVersionLabel[] {
  const mixed = (group: ArtistRelease[]) =>
    group.some((v) => v.explicit) && group.some((v) => !v.explicit);
  const content = (v: ArtistRelease) => (v.explicit ? "Explicit" : "Clean");
  const atmos = versions.filter((v) => v.dolby_atmos);
  const stereo = versions.filter((v) => !v.dolby_atmos);
  const labels = versions.map((v) => {
    if (v.dolby_atmos) return mixed(atmos) ? `Dolby Atmos · ${content(v)}` : "Dolby Atmos";
    if (mixed(stereo)) return content(v);
    return atmos.length > 0 ? "Stereo" : "";
  });
  const alike = labels.filter((label, i) => labels.indexOf(label) !== i);
  labels.forEach((label, i) => {
    if (alike.includes(label)) {
      labels[i] = [label, pluralize(versions[i].track_count, "track")].filter(Boolean).join(" · ");
    }
  });
  const anyExplicit = versions.some((v) => v.explicit);
  return versions.map((v, i) => ({
    label: labels[i],
    description: [
      v.dolby_atmos ? "Dolby Atmos" : "Stereo",
      anyExplicit && content(v),
      pluralize(v.track_count, "track"),
      v.release_year,
    ]
      .filter(Boolean)
      .join(" · "),
  }));
}

/** Library albums in the order the artist's tracks list them. */
export function libraryArtistReleases(tracks: TrackListItem[]): ArtistRelease[] {
  const byAlbum = new Map<string, ArtistRelease>();
  for (const track of tracks) {
    if (!track.album_id || !track.album_title) continue;
    const release = byAlbum.get(track.album_id);
    if (release) {
      release.track_count += 1;
    } else {
      byAlbum.set(track.album_id, {
        id: track.album_id,
        title: track.album_title,
        track_count: 1,
        has_cover: track.has_cover,
        cover_url: track.cover_url,
      });
    }
  }
  return [...byAlbum.values()];
}

/** Whether the albums / singles-and-EPs split is worth offering. */
export function hasReleaseFilters(releases: ArtistRelease[]): boolean {
  return (
    releases.some((release) => release.kind === "Album") &&
    releases.some((release) => release.kind === "EP" || release.kind === "Single")
  );
}

/**
 * Releases for a filter. When the split isn't available (a refresh can drop
 * one of the kinds), everything is returned rather than an empty shelf for a
 * filter the user can no longer see or change.
 */
export function filterReleases(
  releases: ArtistRelease[],
  filter: ReleaseFilter,
): ArtistRelease[] {
  if (filter === "all" || !hasReleaseFilters(releases)) return releases;
  return filter === "albums"
    ? releases.filter((release) => release.kind === "Album")
    : releases.filter((release) => release.kind === "EP" || release.kind === "Single");
}

/**
 * "2024 · Single", or "12 tracks" for library albums with no year or kind;
 * a folded release adds "3 versions".
 */
export function releaseSubtitle(release: ArtistRelease): string {
  return [
    release.release_year,
    release.kind ?? pluralize(release.track_count, "track"),
    release.versions && pluralize(release.versions.length, "version"),
  ]
    .filter(Boolean)
    .join(" · ");
}
