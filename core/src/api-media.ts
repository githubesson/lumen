import { apiUrl, rawFetch, request } from "./api-transport";
import type {
  PlaylistTrackEntry,
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

export function downloadStreamUrl(id: string): string {
  const base = `/api/tracks/${pathID(id)}/stream`;
  return apiUrl(id.toLowerCase().startsWith("tidal:") ? `${base}?download=1` : base);
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

export function resolveCoverUrl(coverURL: string): string {
  return apiUrl(coverURL);
}

export function trackCoverUrl(track: {
  id: string;
  album_id?: string | null;
  cover_url?: string | null;
}, size?: number): string {
  if (track.cover_url) return resolveCoverUrl(track.cover_url);
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
  story_url?: string;
  story_background_url?: string;
  embed_url?: string;
  cover_url?: string;
  accent_color?: string;
  canonical_url: string;
  open_url: string;
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

export function toQueueItem(entry: PlaylistTrackEntry): TrackListItem {
  return {
    id: entry.track_id,
    title: entry.title,
    album_id: entry.album_id,
    album_title: entry.album_title,
    track_no: entry.track_no,
    duration_ms: entry.duration_ms,
    artist: entry.artist,
    source: entry.source,
    source_id: entry.source_id,
    source_album_id: entry.source_album_id,
    cover_url: entry.cover_url,
  };
}

export function displayArtists(track: { artists?: TrackArtist[] }): string {
  return (track.artists ?? [])
    .filter((artist) => artist.role !== "composer")
    .map((artist) => artist.name)
    .join(", ");
}

export function primaryArtistName(track: { artists?: TrackArtist[] }): string {
  const artists = track.artists ?? [];
  const performer = artists.find((artist) => artist.role !== "composer");
  return (performer ?? artists[0])?.name ?? "";
}
