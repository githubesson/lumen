import {
  ApiError,
  buildQuery,
  fetchPage,
  rawFetch,
  request,
  requestVoid,
} from "./api-transport";
import type { PageParams, RequestOptions } from "./api-transport";
import type { LyricsResult, ReplayBucket, ReplayData } from "./api-media";
import type {
  AdminUser,
  Invite,
  InviteCheck,
  LastFMConnectResponse,
  LastFMStatus,
  Me,
  Role,
} from "./api-auth-types";
import {
  apiTrackerPinPathID,
  artistGridPinPathID,
  filenPinPathID,
  normalizeArtistGridPin,
  waitForLastFMAuthorization,
  waitForTidalAuthorization,
  type RawArtistGridPin,
} from "./api-integration-helpers";

export {
  ApiError,
  getBaseUrl,
  isApiOrigin,
  setBaseUrl,
  setUnauthorizedHandler,
} from "./api-transport";
export * from "./api-media";
export { isValidPinID, pinIDPattern } from "./api-integration-helpers";
export type * from "./api-auth-types";

/**
 * Narrow an unknown thrown value to a user-facing message. Surfaces the
 * server's message for ApiError; otherwise returns the caller's fallback so
 * raw network/parse errors don't leak into the UI. Centralizes the
 * `err instanceof ApiError ? err.message : fallback` idiom used everywhere.
 */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

export type TrackSource = "local" | "tidal";

type SearchParams = PageParams & {
  sources?: TrackSource[];
};

/**
 * Percent-encode a value destined for a URL *path* segment.
 *
 * Track ids went through this while album, playlist, invite, collaborator and
 * position ids were raw-interpolated. `pathID` is the one helper; `trackPathID`
 * remains as its original name.
 */
function pathID(value: string | number): string {
  return encodeURIComponent(String(value));
}

const trackPathID = pathID;

export const api = {
  login: (username: string, password: string) =>
    request<Me>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => requestVoid("/api/auth/logout", { method: "POST" }),
  // AuthProvider applies its refresh generation check before treating /me's 401
  // as a logout. An older pre-registration request must not clear a new session.
  me: () =>
    request<Me>("/api/auth/me", {}, { notifyUnauthorized: false }),
  register: (token: string, username: string, password: string) =>
    request<Me>("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ token, username, password }),
    }),
  checkInvite: (token: string) =>
    request<InviteCheck>(`/api/auth/invite?token=${encodeURIComponent(token)}`),
  resetPassword: (current_password: string, new_password: string) =>
    requestVoid("/api/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ current_password, new_password }),
    }),

  listAdminUsers: (options: RequestOptions = {}) =>
    request<AdminUser[]>("/api/admin/users", options),

  listInvites: (options: RequestOptions = {}) =>
    request<Invite[]>("/api/admin/invites", options),
  createInvite: (input: {
    target_role?: Role;
    max_uses?: number;
    expires_at?: string;
  }) =>
    request<Invite>("/api/admin/invites", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  revokeInvite: (id: string) =>
    requestVoid(`/api/admin/invites/${pathID(id)}`, { method: "DELETE" }),

  listMusicRoots: (options: RequestOptions = {}) =>
    request<MusicRoot[]>("/api/admin/library/roots", options),
  addMusicRoot: (input: { path: string; label?: string }) =>
    request<MusicRoot>("/api/admin/library/roots", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setMusicRootEnabled: (id: string, enabled: boolean) =>
    request<MusicRoot>(`/api/admin/library/roots/${pathID(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  deleteMusicRoot: (id: string, opts: { purge?: boolean } = {}) => {
    const qs = opts.purge === false ? "?purge=false" : "";
    return request<{ deleted_tracks: number }>(
      `/api/admin/library/roots/${pathID(id)}${qs}`,
      { method: "DELETE" },
    );
  },

  startRescan: () =>
    requestVoid("/api/admin/library/rescan", { method: "POST" }),
  rescanStatus: (options: RequestOptions = {}) =>
    request<RescanStatus>("/api/admin/library/rescan", options),

  listArtistGridPins: async () =>
    (await request<RawArtistGridPin[]>("/api/admin/library/artistgrid/pins")).map(
      normalizeArtistGridPin,
    ),
  createArtistGridPin: async (input: ArtistGridPinCreate) =>
    normalizeArtistGridPin(
      await request<RawArtistGridPin>("/api/admin/library/artistgrid/pins", {
        method: "POST",
        body: JSON.stringify(input),
      }),
    ),
  updateArtistGridPin: async (id: string, input: ArtistGridPinPatch) =>
    normalizeArtistGridPin(
      await request<RawArtistGridPin>(
        `/api/admin/library/artistgrid/pins/${artistGridPinPathID(id)}`,
        {
          method: "PATCH",
          body: JSON.stringify(input),
        },
      ),
    ),
  deleteArtistGridPin: (id: string) =>
    requestVoid(
      `/api/admin/library/artistgrid/pins/${artistGridPinPathID(id)}`,
      { method: "DELETE" },
    ),
  scanArtistGridPin: (id: string) =>
    requestVoid(
      `/api/admin/library/artistgrid/pins/${artistGridPinPathID(id)}/scan`,
      { method: "POST" },
    ),
  listArtistGridDownloads: (id: string, limit = 50) => {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
    return request<ArtistGridDownload[]>(
      `/api/admin/library/artistgrid/pins/${artistGridPinPathID(id)}/downloads?limit=${safeLimit}`,
    );
  },
  listFilenPins: () => request<FilenPin[]>("/api/admin/library/filen/pins"),
  createFilenPin: (input: FilenPinCreate) =>
    request<FilenPin>("/api/admin/library/filen/pins", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateFilenPin: (id: string, input: FilenPinPatch) =>
    request<FilenPin>(`/api/admin/library/filen/pins/${filenPinPathID(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deleteFilenPin: (id: string) =>
    requestVoid(`/api/admin/library/filen/pins/${filenPinPathID(id)}`, {
      method: "DELETE",
    }),
  scanFilenPin: (id: string) =>
    requestVoid(`/api/admin/library/filen/pins/${filenPinPathID(id)}/scan`, {
      method: "POST",
    }),
  listFilenDownloads: (id: string, limit = 50) => {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
    return request<FilenDownload[]>(
      `/api/admin/library/filen/pins/${filenPinPathID(id)}/downloads?limit=${safeLimit}`,
    );
  },
  listAPITrackerPins: () =>
    request<APITrackerPin[]>("/api/admin/library/api-trackers/pins"),
  createAPITrackerPin: (input: APITrackerPinCreate) =>
    request<APITrackerPin>("/api/admin/library/api-trackers/pins", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updateAPITrackerPin: (id: string, input: APITrackerPinPatch) =>
    request<APITrackerPin>(
      `/api/admin/library/api-trackers/pins/${apiTrackerPinPathID(id)}`,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    ),
  deleteAPITrackerPin: (id: string) =>
    requestVoid(
      `/api/admin/library/api-trackers/pins/${apiTrackerPinPathID(id)}`,
      { method: "DELETE" },
    ),
  scanAPITrackerPin: (id: string) =>
    requestVoid(
      `/api/admin/library/api-trackers/pins/${apiTrackerPinPathID(id)}/scan`,
      { method: "POST" },
    ),
  listAPITrackerDownloads: (id: string, limit = 50) => {
    const safeLimit = Math.max(1, Math.min(500, Math.trunc(limit) || 50));
    return request<APITrackerDownload[]>(
      `/api/admin/library/api-trackers/pins/${apiTrackerPinPathID(id)}/downloads?limit=${safeLimit}`,
    );
  },

  listTracks: (params: PageParams = {}) =>
    request<TrackListItem[]>(
      `/api/tracks${buildQuery({ limit: params.limit, offset: params.offset, q: params.q })}`,
      { signal: params.signal },
    ),
  listTracksPage: (params: PageParams = {}) =>
    fetchPage<TrackListItem>("/api/tracks", params),
  searchTracks: (params: SearchParams = {}) =>
    request<SearchResponse>(
      `/api/search${buildQuery({
        limit: params.limit,
        offset: params.offset,
        q: params.q,
        sources: params.sources?.join(","),
      })}`,
      { signal: params.signal },
    ),

  listAlbumsPage: (params: PageParams = {}) =>
    fetchPage<Album>("/api/albums", params),
  getAlbum: (id: string, options: RequestOptions = {}) =>
    request<Album>(`/api/albums/${pathID(id)}`, options),
  listAlbumTracks: (id: string, options: RequestOptions = {}) =>
    request<TrackListItem[]>(`/api/albums/${pathID(id)}/tracks`, options),
  getTidalAlbum: (id: string, options: RequestOptions = {}) =>
    request<TidalAlbum>(`/api/tidal/albums/${encodeURIComponent(id)}`, options),

  listArtistsPage: (params: PageParams = {}) =>
    fetchPage<Artist>("/api/artists", params),
  getArtist: (id: string, options: RequestOptions = {}) =>
    request<Artist>(`/api/artists/${pathID(id)}`, options),
  listArtistTracks: (id: string, options: RequestOptions = {}) =>
    request<TrackListItem[]>(`/api/artists/${pathID(id)}/tracks`, options),
  getTrack: (id: string, options: RequestOptions = {}) =>
    request<TrackDetail>(`/api/tracks/${trackPathID(id)}`, options),
  updateTrack: (id: string, patch: TrackPatch) =>
    request<TrackDetail>(`/api/tracks/${trackPathID(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // Delete a track from the caller's personal library. Owner-scoped on the
  // server: only the user's own personal uploads can be removed (others 404).
  deleteTrack: (id: string) =>
    requestVoid(`/api/tracks/${trackPathID(id)}`, { method: "DELETE" }),
  // Remove a global (shared-library) track. Admin-only on the server: it
  // hard-deletes the track and unlinks its file(s) from disk so a rescan
  // won't re-add it. Personal uploads aren't global and 404 here — use
  // `deleteTrack` for those.
  deleteGlobalTrack: (id: string) =>
    requestVoid(`/api/admin/tracks/${trackPathID(id)}`, { method: "DELETE" }),
  updateAlbum: (id: string, patch: AlbumPatch) =>
    request<Album>(`/api/albums/${pathID(id)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // Replace an album's cover art. `file` is a browser File (web) or the
  // RN-style { uri, name, type } part React Native's FormData accepts.
  // Admin-only on the server; returns the updated album.
  setAlbumCover: (id: string, file: CoverUploadFile) => {
    const fd = new FormData();
    fd.append("file", file as unknown as Blob);
    return request<Album>(`/api/albums/${pathID(id)}/cover`, { method: "PUT", body: fd });
  },
  // Clear an album's cover art, reverting it to the placeholder. Admin only.
  removeAlbumCover: (id: string) =>
    request<Album>(`/api/albums/${pathID(id)}/cover`, { method: "DELETE" }),
  recordPlay: (id: string, completion: number) =>
    requestVoid(`/api/tracks/${trackPathID(id)}/play`, {
      method: "POST",
      body: JSON.stringify({ completion }),
    }),
  scrobbleTrack: (id: string, startedAt: number, listenedSeconds: number) =>
    requestVoid(`/api/tracks/${trackPathID(id)}/scrobble`, {
      method: "POST",
      body: JSON.stringify({
        started_at: startedAt,
        listened_seconds: listenedSeconds,
      }),
    }),
  updateNowPlaying: (id: string) =>
    requestVoid(`/api/tracks/${trackPathID(id)}/now-playing`, {
      method: "POST",
    }),
  getLastFMStatus: () => request<LastFMStatus>("/api/integrations/lastfm"),
  connectLastFM: () =>
    request<LastFMConnectResponse>("/api/integrations/lastfm/connect", {
      method: "POST",
    }),
  completeLastFM: (options: RequestOptions = {}) =>
    request<{ username: string }>("/api/integrations/lastfm/complete", {
      method: "POST",
      signal: options.signal,
    }),
  waitForLastFMAuthorization,
  disconnectLastFM: () =>
    requestVoid("/api/integrations/lastfm", { method: "DELETE" }),
  upsertPlaybackActivity: (input: PlaybackActivityInput) =>
    request<PlaybackActivity>("/api/activity", {
      method: "PUT",
      body: JSON.stringify(input),
    }),
  getCurrentPlaybackActivity: (excludeDeviceId?: string) =>
    request<CurrentPlaybackActivityResponse>(
      `/api/activity/current${buildQuery({ exclude_device_id: excludeDeviceId })}`,
    ),
  clearPlaybackActivity: (deviceId: string) =>
    requestVoid(`/api/activity/${encodeURIComponent(deviceId)}`, {
      method: "DELETE",
    }),

  uploadMusic: (files: File[], scope: "personal" | "global") => {
    const fd = new FormData();
    fd.set("scope", scope);
    for (const f of files) fd.append("files", f);
    return request<UploadResult[]>("/api/library/upload", {
      method: "POST",
      body: fd,
    });
  },

  favorite: (id: string) =>
    requestVoid(`/api/tracks/${trackPathID(id)}/favorite`, { method: "POST" }),
  unfavorite: (id: string) =>
    requestVoid(`/api/tracks/${trackPathID(id)}/favorite`, { method: "DELETE" }),
  listFavorites: (options: RequestOptions = {}) =>
    request<TrackListItem[]>(`/api/favorites`, options),
  listRecent: (limit = 100, options: RequestOptions = {}) =>
    request<TrackListItem[]>(`/api/recent?limit=${limit}`, options),

  getReplay: (
    params: { from?: string; to?: string; bucket?: ReplayBucket } = {},
    options: RequestOptions = {},
  ) =>
    request<ReplayData>(
      `/api/stats/replay${buildQuery({ from: params.from, to: params.to, bucket: params.bucket })}`,
      options,
    ),
  generateReplayPlaylist: (input: {
    from?: string;
    to?: string;
    name: string;
    limit?: number;
  }) =>
    request<Playlist>(`/api/stats/replay/playlist`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  /**
   * Fetches the Replay top-songs share card as a 1080×1920 PNG. Returns the
   * raw Response; callers read the body as bytes and hand it to the platform
   * share sheet.
   */
  getReplayImage: (
    params: { from?: string; to?: string; title?: string } = {},
    options: RequestOptions = {},
  ) =>
    rawFetch(
      `/api/stats/replay/image${buildQuery({ from: params.from, to: params.to, title: params.title })}`,
      { ...options, headers: { Accept: "image/png" } },
    ),

  listPlaylists: (options: RequestOptions = {}) =>
    request<Playlist[]>(`/api/playlists`, options),
  getPlaylist: (id: string, options: RequestOptions = {}) =>
    request<Playlist>(`/api/playlists/${pathID(id)}`, options),
  createPlaylist: (input: {
    name: string;
    description?: string;
    visibility?: "private" | "collaborative";
  }) =>
    request<Playlist>(`/api/playlists`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  updatePlaylist: (
    id: string,
    input: { name: string; description: string; visibility: "private" | "collaborative" },
  ) =>
    requestVoid(`/api/playlists/${pathID(id)}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deletePlaylist: (id: string) =>
    requestVoid(`/api/playlists/${pathID(id)}`, { method: "DELETE" }),

  listPlaylistTracks: (id: string, options: RequestOptions = {}) =>
    request<PlaylistTracks>(`/api/playlists/${pathID(id)}/tracks`, options),
  addPlaylistTracks: (id: string, trackIds: string[]) =>
    requestVoid(`/api/playlists/${pathID(id)}/tracks`, {
      method: "POST",
      body: JSON.stringify({ track_ids: trackIds }),
    }),
  removePlaylistTrack: (id: string, position: number) =>
    requestVoid(`/api/playlists/${pathID(id)}/tracks/${pathID(position)}`, { method: "DELETE" }),
  reorderPlaylist: (id: string, trackIds: string[]) =>
    requestVoid(`/api/playlists/${pathID(id)}/order`, {
      method: "PUT",
      body: JSON.stringify({ track_ids: trackIds }),
    }),

  listCollaborators: (id: string, options: RequestOptions = {}) =>
    request<Collaborator[]>(`/api/playlists/${pathID(id)}/collaborators`, options),
  inviteCollaborator: (
    id: string,
    input: { username: string; role: "viewer" | "editor" },
  ) =>
    requestVoid(`/api/playlists/${pathID(id)}/collaborators`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeCollaborator: (id: string, userId: string) =>
    requestVoid(`/api/playlists/${pathID(id)}/collaborators/${pathID(userId)}`, {
      method: "DELETE",
    }),
  setCollaboratorRole: (id: string, userId: string, role: "viewer" | "editor") =>
    requestVoid(`/api/playlists/${pathID(id)}/collaborators/${pathID(userId)}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  listPendingInvites: (options: RequestOptions = {}) =>
    request<PendingInvite[]>(`/api/playlists/invites`, options),
  acceptInvite: (id: string) =>
    requestVoid(`/api/playlists/invites/${pathID(id)}/accept`, { method: "POST" }),
  declineInvite: (id: string) =>
    requestVoid(`/api/playlists/invites/${pathID(id)}/decline`, { method: "POST" }),

  tidalStatus: (options: RequestOptions = {}) =>
    request<TidalStatus>("/api/admin/tidal/status", options),
  startTidalAuth: (options: RequestOptions = {}) =>
    request<TidalAuthStart>("/api/admin/tidal/auth", {
      method: "POST",
      signal: options.signal,
    }),
  pollTidalAuth: (flowId: string, options: RequestOptions = {}) =>
    request<TidalAuthPoll>(
      `/api/admin/tidal/auth/${pathID(flowId)}`,
      options,
    ),
  waitForTidalAuthorization,
  removeTidalAccount: (accountId: string, options: RequestOptions = {}) =>
    requestVoid(`/api/admin/tidal/accounts/${pathID(accountId)}`, {
      method: "DELETE",
      signal: options.signal,
    }),

  // Lyrics API (fastest valid result from the configured providers)
  searchLyrics: (query: string, options: RequestOptions = {}) =>
    request<LyricsResult[]>(
      `/api/lyrics?q=${encodeURIComponent(query)}`,
      options,
    ),
  getLyrics: (params: {
    track_name: string;
    artist_name?: string;
    album_name?: string;
    duration?: number;
  }, options: RequestOptions = {}) =>
    request<LyricsResult>(
      `/api/lyrics${buildQuery({
        track_name: params.track_name,
        artist_name: params.artist_name,
        album_name: params.album_name,
        duration: params.duration,
      })}`,
      options,
    ),
};

export interface TrackListItem {
  id: string;
  db_track_id?: string;
  source?: TrackSource;
  source_id?: string;
  source_album_id?: string;
  title: string;
  album_id?: string;
  album_title?: string;
  track_no?: number;
  duration_ms: number;
  artist?: string;
  aka?: string;
  favorited?: boolean;
  has_cover?: boolean;
  cover_url?: string;
  /** True when the track is the current user's own personal upload — only
   *  these can be deleted via `deleteTrack`. */
  owned?: boolean;
}

export interface PlaybackActivityInput {
  device_id: string;
  device_name: string;
  track_id: string;
  title: string;
  artist?: string;
  album?: string;
  album_id?: string;
  cover_url?: string;
  duration_sec?: number;
  position_sec: number;
  is_playing: boolean;
  volume?: number;
  muted?: boolean;
}

export interface PlaybackActivity extends PlaybackActivityInput {
  updated_at: string;
}

export interface CurrentPlaybackActivityResponse {
  activity: PlaybackActivity | null;
}

export interface SearchResponse {
  tracks: TrackListItem[];
  sources: TrackSource[];
  warnings?: string[];
}

export interface TrackArtist {
  id: string;
  name: string;
  role: string;
}

export interface TrackAlias {
  file_path: string;
  title?: string;
  artist_names?: string;
  album_title?: string;
}

export interface TrackDetail {
  id: string;
  db_track_id?: string;
  source: TrackSource;
  source_id?: string;
  source_album_id?: string;
  title: string;
  album_id?: string;
  album_title?: string;
  track_no?: number;
  disc_no?: number;
  duration_ms: number;
  genre?: string;
  year?: number;
  composer?: string;
  comments?: string;
  format: string;
  bitrate?: number;
  sample_rate?: number;
  channels?: number;
  file_size: number;
  artists: TrackArtist[];
  aliases?: TrackAlias[];
  has_cover: boolean;
  cover_url?: string;
  favorited: boolean;
}

export type Visibility = "private" | "collaborative";
export type EffectiveRole = "owner" | "editor" | "viewer" | "";
export type CollaboratorRole = "viewer" | "editor";
export type CollaboratorStatus = "pending" | "accepted";

export interface Playlist {
  id: string;
  owner_id: string;
  name: string;
  description?: string;
  visibility: Visibility;
  is_smart: boolean;
  effective_role?: EffectiveRole;
  created_at: string;
  updated_at: string;
}

export interface PlaylistTrackEntry {
  position: number;
  track_id: string;
  db_track_id?: string;
  source?: TrackSource;
  source_id?: string;
  source_album_id?: string;
  title: string;
  album_id?: string;
  album_title?: string;
  track_no?: number;
  duration_ms: number;
  artist?: string;
  has_cover?: boolean;
  cover_url?: string;
  added_by_id?: string;
  added_by?: string;
  added_at: string;
  /** Viewer's all-time play count for this track. */
  play_count?: number;
}

export interface PlaylistTracks {
  tracks: PlaylistTrackEntry[];
}

export interface TidalStatus {
  connected: boolean;
  proxy_url?: string;
  country_code?: string;
  quality?: string;
  version?: string;
  repo?: string;
  error?: string;
  management_supported: boolean;
  management_error?: string;
  accounts: TidalAccount[];
}

export interface TidalAccount {
  id: string;
  user_id: string;
  removable: boolean;
}

export interface TidalAuthStart {
  flow_id: string;
  verification_url: string;
  user_code?: string;
  expires_at: string;
}

export interface TidalAuthPoll {
  state: "pending" | "linked" | "denied" | "expired";
  message?: string;
  account?: TidalAccount;
}

export interface TidalAuthorizationPollOptions {
  signal?: AbortSignal;
  intervalMs?: number;
  timeoutMs?: number;
}

export interface TidalAlbum {
  id: string;
  title: string;
  artist?: string;
  release_year?: number;
  track_count: number;
  duration_ms: number;
  cover_url?: string;
  tracks: TrackListItem[];
}

export interface Collaborator {
  user_id: string;
  username: string;
  role: CollaboratorRole;
  status: CollaboratorStatus;
  invited_at: string;
  accepted_at?: string;
  playlist_id?: string;
}

export interface PendingInvite {
  playlist_id: string;
  playlist_name: string;
  owner_id: string;
  owner_name: string;
  role: CollaboratorRole;
  invited_at: string;
}

export interface Page<T> {
  items: T[];
  total: number;
}

/** @deprecated use Page<TrackListItem> */
export type TracksPage = Page<TrackListItem>;

export interface TrackPatch {
  title?: string;
  year?: number;
  genre?: string;
  disc_no?: number;
  track_no?: number;
  artists?: string[];
  /** Move the track into an existing album by id. Takes precedence over
   *  album_title (which upserts/detaches by name). */
  album_id?: string;
  album_title?: string;
  album_artist?: string;
}

export interface AlbumPatch {
  title?: string;
  album_artist?: string;
  release_year?: number;
  is_compilation?: boolean;
}

/**
 * A cover image to upload. On web this is a `File` from an `<input type=file>`;
 * on React Native it's the `{ uri, name, type }` shape `FormData` accepts for
 * multipart file parts (there is no `File` constructor on RN).
 */
export type CoverUploadFile =
  | File
  | { uri: string; name: string; type: string };

export type StoryBackgroundUploadFile = CoverUploadFile;

export interface StoryBackgroundCrop {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface Album {
  id: string;
  title: string;
  artist_id?: string;
  artist_name?: string;
  is_compilation: boolean;
  release_year?: number;
  track_count: number;
  duration_ms: number;
  has_cover: boolean;
}

export interface Artist {
  id: string;
  name: string;
  track_count: number;
  album_count: number;
}

export interface UploadResult {
  file: string;
  inserted: boolean;
  dedup?: boolean;
  skipped?: boolean;
  error?: string;
  track_id?: string;
}

export interface MusicRoot {
  id: string;
  path: string;
  label: string;
  enabled: boolean;
  primary: boolean;
  exists: boolean;
  created_at?: string;
}

export interface RescanStatus {
  running: boolean;
  total?: number;
  processed?: number;
  inserted?: number;
  dedup?: number;
  errored?: number;
  pruned?: number;
}

export interface ArtistGridPin {
  id: string;
  root_id?: string;
  root_path: string;
  destination_subdir: string;
  destination_path: string;
  tracker_id: string;
  tracker_url: string;
  tab: string;
  label: string;
  primary_artist: string;
  enabled: boolean;
  scan_interval_seconds: number;
  last_scan_at?: string | null;
  last_success_at?: string | null;
  last_error?: string;
  created_at: string;
  updated_at: string;
  root_exists: boolean;
}

export interface ArtistGridPinCreate {
  root_id?: string;
  root_path?: string;
  destination_subdir?: string;
  tracker?: string;
  tracker_id?: string;
  tracker_url?: string;
  tab?: string;
  label?: string;
  primary_artist?: string;
  enabled?: boolean;
  scan_interval_seconds?: number;
}

export interface ArtistGridPinPatch {
  destination_subdir?: string;
  tab?: string;
  label?: string;
  primary_artist?: string;
  enabled?: boolean;
  scan_interval_seconds?: number;
}

export type ArtistGridDownloadStatus =
  | "downloaded"
  | "existing"
  | "skipped"
  | "failed";

export interface ArtistGridDownload {
  id: number;
  pin_id: string;
  source_url: string;
  resolved_url?: string;
  file_path?: string;
  status: ArtistGridDownloadStatus;
  error?: string;
  track_id?: string;
  metadata?: unknown;
  first_seen_at: string;
  downloaded_at?: string | null;
  updated_at: string;
}

export interface FilenPin {
  id: string;
  root_id?: string;
  root_path: string;
  destination_subdir: string;
  destination_path: string;
  share_url: string;
  password_set: boolean;
  label: string;
  enabled: boolean;
  scan_interval_seconds: number;
  last_scan_at?: string | null;
  last_success_at?: string | null;
  last_error?: string;
  created_at: string;
  updated_at: string;
  root_exists: boolean;
}

export interface FilenPinCreate {
  root_id?: string;
  root_path?: string;
  destination_subdir?: string;
  share_url?: string;
  url?: string;
  password?: string;
  label?: string;
  enabled?: boolean;
  scan_interval_seconds?: number;
}

export interface FilenPinPatch {
  destination_subdir?: string;
  password?: string;
  label?: string;
  enabled?: boolean;
  scan_interval_seconds?: number;
}

export type FilenDownloadStatus =
  | "downloaded"
  | "existing"
  | "skipped"
  | "failed";

export interface FilenDownload {
  id: number;
  pin_id: string;
  source_path: string;
  file_path?: string;
  size_bytes: number;
  status: FilenDownloadStatus;
  error?: string;
  track_id?: string;
  metadata?: Record<string, unknown>;
  first_seen_at: string;
  downloaded_at?: string | null;
  updated_at: string;
}

export interface APITrackerPin {
  id: string;
  root_id?: string;
  root_path: string;
  destination_subdir: string;
  destination_path: string;
  api_base_url: string;
  tracker_id: number;
  tracker_name: string;
  tracker_url: string;
  tab: string;
  label: string;
  primary_artist: string;
  enabled: boolean;
  scan_interval_seconds: number;
  last_scan_at?: string | null;
  last_success_at?: string | null;
  last_error?: string;
  created_at: string;
  updated_at: string;
  root_exists: boolean;
}

export interface APITrackerPinCreate {
  root_id?: string;
  root_path?: string;
  destination_subdir?: string;
  api_base_url?: string;
  tracker?: string;
  tracker_id?: string | number;
  tracker_url?: string;
  tracker_name?: string;
  tab?: string;
  label?: string;
  primary_artist?: string;
  enabled?: boolean;
  scan_interval_seconds?: number;
}

export interface APITrackerPinPatch {
  destination_subdir?: string;
  tab?: string;
  label?: string;
  primary_artist?: string;
  enabled?: boolean;
  scan_interval_seconds?: number;
}

export type APITrackerDownloadStatus =
  | "downloaded"
  | "existing"
  | "skipped"
  | "failed";

export interface APITrackerDownload {
  id: number;
  pin_id: string;
  entry_id?: number;
  source_url: string;
  resolved_url?: string;
  file_path?: string;
  status: APITrackerDownloadStatus;
  error?: string;
  track_id?: string;
  metadata?: Record<string, unknown>;
  first_seen_at: string;
  downloaded_at?: string | null;
  updated_at: string;
}
