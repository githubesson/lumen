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
    }))
    .sort((a, b) => (b.release_year ?? 0) - (a.release_year ?? 0));
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

/** "2024 · Single", or "12 tracks" for library albums with no year or kind. */
export function releaseSubtitle(release: ArtistRelease): string {
  return [release.release_year, release.kind ?? pluralize(release.track_count, "track")]
    .filter(Boolean)
    .join(" · ");
}
