import { apiUrl, rawFetch, request } from "./api-transport";
import type {
  StoryBackgroundCrop,
  StoryBackgroundUploadFile,
  TrackArtist,
  TrackListItem,
  TrackSource,
} from "./api";

const pathID = (value: string | number) => encodeURIComponent(String(value));

export function streamUrl(id: string): string {
  return apiUrl(`/api/tracks/${pathID(id)}/stream`);
}

/**
 * A track's file to save: tagged by the server with the track's metadata and
 * cover (the library's for local files, TIDAL's for TIDAL tracks).
 */
export function downloadStreamUrl(id: string): string {
  return apiUrl(`/api/tracks/${pathID(id)}/stream?download=1`);
}

/**
 * The URL that tells what a track's file is (its Content-Type) without the
 * server building a download: a local track's stored file, or for a TIDAL
 * track its assembled download, since playback serves an HLS playlist.
 */
export function probeStreamUrl(id: string): string {
  return id.toLowerCase().startsWith("tidal:") ? downloadStreamUrl(id) : streamUrl(id);
}

function withCoverSize(path: string, size?: number): string {
  if (!size || !Number.isFinite(size) || size <= 0) return apiUrl(path);
  const query = new URLSearchParams({ size: String(Math.round(size)) });
  return apiUrl(`${path}?${query.toString()}`);
}

export function coverUrl(id: string, size?: number): string {
  return withCoverSize(`/api/tracks/${pathID(id)}/cover`, size);
}

export function albumCoverUrl(id: string, size?: number): string {
  return withCoverSize(`/api/albums/${pathID(id)}/cover`, size);
}

/** A playlist's uploaded cover; `version` is its `custom_cover`. */
export function playlistCoverUrl(id: string, version: string, size?: number): string {
  const path = `/api/playlists/${pathID(id)}/cover?v=${encodeURIComponent(version)}`;
  if (!size || !Number.isFinite(size) || size <= 0) return apiUrl(path);
  return apiUrl(`${path}&size=${Math.round(size)}`);
}

/**
 * The art that stands for a playlist: the owner's uploaded cover, else its
 * first track's (only known on listed playlists). Null when it has neither.
 */
export function playlistArtUrl(
  playlist: {
    id: string;
    custom_cover?: string;
    cover?: { track_id: string; album_id?: string; cover_url?: string };
  },
  size?: number,
): string | null {
  if (playlist.custom_cover) {
    return playlistCoverUrl(playlist.id, playlist.custom_cover, size);
  }
  const cover = playlist.cover;
  if (!cover) return null;
  return trackCoverUrl(
    { id: cover.track_id, album_id: cover.album_id, cover_url: cover.cover_url },
    size,
  );
}

export function resolveCoverUrl(coverURL: string, size?: number): string {
  // Our cover endpoints support resizing. Leave signed and external URLs intact.
  if (size && Number.isFinite(size) && size > 0 && coverURL.startsWith("/api/") && !coverURL.includes("sig=")) {
    const url = new URL(coverURL, "https://lumen.invalid");
    url.searchParams.set("size", String(Math.round(size)));
    return apiUrl(url.pathname + url.search);
  }
  return apiUrl(coverURL);
}

export function trackCoverUrl(track: {
  id: string;
  album_id?: string | null;
  cover_url?: string | null;
}, size?: number): string {
  if (track.cover_url) return resolveCoverUrl(track.cover_url, size);
  return track.album_id ? albumCoverUrl(track.album_id, size) : coverUrl(track.id, size);
}

export interface SignedCoverUrl {
  url: string;
  expires_at: number;
}

export function signAlbumCoverUrl(albumId: string): Promise<SignedCoverUrl> {
  const query = new URLSearchParams({ album_id: albumId });
  return request<SignedCoverUrl>(`/api/covers/sign?${query.toString()}`);
}

export interface ShareLink {
  url: string;
  start_sec: number;
  duration_sec: number;
}

export const MIN_SHARE_SNIPPET_DURATION_SEC = 5;
export const DEFAULT_SHARE_SNIPPET_DURATION_SEC = 30;
export const MAX_SHARE_SNIPPET_DURATION_SEC = 120;

export interface PublicTrackShare {
  track_id: string;
  title: string;
  artist?: string;
  album?: string;
  album_id?: string;
  start_sec: number;
  duration_ms: number;
  preview_duration_sec: number;
  preview_url: string;
  /** The preview's audio alone, as M4A. Missing from older backends. */
  audio_url?: string;
  story_url?: string;
  story_background_url?: string;
  embed_url?: string;
  cover_url?: string;
  accent_color?: string;
  canonical_url: string;
  open_url: string;
}

/** The parts of a signed share URL (/share/track/{id}?t=…&d=…&sig=…). */
export interface TrackShareRef {
  trackId: string;
  sig: string;
  startSec: number;
  /** Absent on links minted before snippets had a selectable length. */
  durationSec?: number;
}

export function parseTrackShareUrl(raw: string): TrackShareRef | null {
  try {
    const parsed = new URL(raw, "https://lumen.invalid");
    const parts = parsed.pathname.split("/").filter(Boolean);
    const trackIndex = parts.findIndex((part) => part === "track");
    const trackId = trackIndex >= 0 ? parts[trackIndex + 1] : "";
    const sig = parsed.searchParams.get("sig") ?? "";
    const startSec = Number.parseInt(parsed.searchParams.get("t") ?? "0", 10);
    const rawDurationSec = parsed.searchParams.get("d");
    const durationSec = rawDurationSec === null
      ? undefined
      : Number(rawDurationSec);
    if (
      !trackId ||
      !sig ||
      !Number.isFinite(startSec) ||
      startSec < 0 ||
      (durationSec !== undefined && (
        !Number.isInteger(durationSec) ||
        durationSec <= 0 ||
        durationSec > MAX_SHARE_SNIPPET_DURATION_SEC
      ))
    ) {
      return null;
    }
    return { trackId, sig, startSec, durationSec };
  } catch {
    return null;
  }
}

/**
 * The snippet's generated preview MP4 (cover + audio) — the same file chat
 * apps embed. Signed by the share link itself, so it doesn't expire.
 */
export function trackSharePreviewVideoUrl(ref: TrackShareRef): string {
  const query = new URLSearchParams({ t: String(ref.startSec) });
  if (ref.durationSec !== undefined) query.set("d", String(ref.durationSec));
  query.set("sig", ref.sig);
  return apiUrl(
    `/api/public/preview-videos/${pathID(ref.trackId)}.mp4?${query.toString()}`,
  );
}

export function createTrackShareLink(
  trackId: string,
  startSec: number,
  durationSec = DEFAULT_SHARE_SNIPPET_DURATION_SEC,
): Promise<ShareLink> {
  const query = new URLSearchParams({
    t: String(Math.max(0, Math.floor(startSec))),
    d: String(
      Math.max(1, Math.min(MAX_SHARE_SNIPPET_DURATION_SEC, Math.floor(durationSec))),
    ),
  });
  return request<ShareLink>(`/api/tracks/${pathID(trackId)}/share?${query.toString()}`, {
    method: "POST",
  });
}

export function createTrackStoryBackgroundVideo(
  trackId: string,
  startSec: number,
  file: StoryBackgroundUploadFile,
  crop: StoryBackgroundCrop,
  durationSec = DEFAULT_SHARE_SNIPPET_DURATION_SEC,
): Promise<Response> {
  const form = new FormData();
  form.append("start_sec", String(Math.max(0, Math.floor(startSec))));
  form.append(
    "duration_sec",
    String(Math.max(1, Math.min(MAX_SHARE_SNIPPET_DURATION_SEC, Math.floor(durationSec)))),
  );
  form.append("crop_x", String(crop.x));
  form.append("crop_y", String(crop.y));
  form.append("crop_width", String(crop.width));
  form.append("crop_height", String(crop.height));
  form.append("file", file as unknown as Blob);
  return rawFetch(`/api/tracks/${pathID(trackId)}/story-background`, {
    method: "POST",
    body: form,
  });
}

export type ReplayBucket = "day" | "week" | "month";

export interface ReplayHeadlineArtist {
  id: string;
  name: string;
  plays: number;
}

export interface ReplaySummary {
  total_plays: number;
  total_ms: number;
  unique_tracks: number;
  unique_artists: number;
  headline_artist?: ReplayHeadlineArtist;
}

export interface ReplayTrack extends TrackListItem {
  plays: number;
}

export interface ReplayArtist {
  id: string;
  name: string;
  plays: number;
}

export interface ReplayAlbum {
  id: string;
  title: string;
  artist?: string;
  source?: TrackSource;
  source_album_id?: string;
  plays: number;
}

export interface ReplayGenreSlice {
  genre: string;
  plays: number;
}

export interface ReplayActivityBucket {
  bucket_start: string;
  plays: number;
}

export interface ReplayData {
  summary: ReplaySummary;
  top_tracks: ReplayTrack[];
  top_artists: ReplayArtist[];
  top_albums: ReplayAlbum[];
  top_genres: ReplayGenreSlice[];
  activity: ReplayActivityBucket[];
  bucket: ReplayBucket;
  available_years: number[];
}

export interface LyricsResult {
  id: number;
  trackId?: number;
  name?: string;
  syncedLyrics?: string | null;
  plainLyrics?: string | null;
  lang?: string | null;
  isrc?: string | null;
  spotifyId?: string | null;
  releaseDate?: string | null;
  duration?: number | null;
  instrumental?: boolean;
  explicit?: boolean;
  trackName: string;
  artistName: string;
  albumName?: string | null;
  lyricsfile?: string | null;
}

export function getPublicTrackShare(
  trackId: string,
  startSec: number,
  signature: string,
  durationSec?: number,
): Promise<PublicTrackShare> {
  const query = new URLSearchParams({
    t: String(Math.max(0, Math.floor(startSec))),
    sig: signature,
  });
  if (durationSec !== undefined) {
    query.set(
      "d",
      String(Math.max(1, Math.min(MAX_SHARE_SNIPPET_DURATION_SEC, Math.floor(durationSec)))),
    );
  }
  return request<PublicTrackShare>(
    `/api/public/share/track/${pathID(trackId)}?${query.toString()}`,
  );
}

// Backwards-compatible name for the canonical playlist-entry converter.
export { playlistEntryToTrack as toQueueItem } from "./track";

export function displayArtists(track: { artists?: TrackArtist[] }): string {
  return (track.artists ?? [])
    .filter((artist) => artist.role !== "composer")
    .map((artist) => artist.name)
    .join(", ");
}

/**
 * The name to show for "the" artist of a track: its primary credit, else its
 * first credit, else `fallback`.
 */
export function primaryArtistName(
  track: { artists?: TrackArtist[] } | null | undefined,
  fallback = "Unknown artist",
): string {
  const artists = track?.artists ?? [];
  return artists.find((artist) => artist.role === "primary")?.name ?? artists[0]?.name ?? fallback;
}
