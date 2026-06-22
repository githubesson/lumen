export type Role = "user" | "admin";

export interface Me {
  id: string;
  username: string;
  role: Role;
  must_reset_password: boolean;
}

export interface Invite {
  id: string;
  token?: string;
  target_role: Role;
  max_uses: number;
  uses: number;
  expires_at?: string | null;
  revoked_at?: string | null;
  created_at: string;
}

export interface AdminUser {
  id: string;
  username: string;
  role: Role;
  disabled: boolean;
  must_reset_password: boolean;
  created_at: string;
  last_login_at?: string;
}

export interface InviteCheck {
  valid: boolean;
  target_role?: Role;
}

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

/**
 * Narrow an unknown thrown value to a user-facing message. Surfaces the
 * server's message for ApiError; otherwise returns the caller's fallback so
 * raw network/parse errors don't leak into the UI. Centralizes the
 * `err instanceof ApiError ? err.message : fallback` idiom used everywhere.
 */
export function errorMessage(err: unknown, fallback: string): string {
  return err instanceof ApiError ? err.message : fallback;
}

/**
 * Base URL prepended to every request and media URL. Empty on web (same-origin
 * via Vite proxy or Electron). Absolute on mobile (e.g. "https://host.tld").
 * Callers should set this once during app startup via `setBaseUrl`.
 */
let baseUrl = "";

export function setBaseUrl(url: string): void {
  baseUrl = url.replace(/\/+$/, "");
}

export function getBaseUrl(): string {
  return baseUrl;
}

type RequestOptions = Pick<RequestInit, "signal">;

type PageParams = {
  limit?: number;
  offset?: number;
  q?: string;
  signal?: AbortSignal;
};

export type TrackSource = "local" | "tidal";

type SearchParams = PageParams & {
  sources?: TrackSource[];
};

function url(path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${baseUrl}${path}`;
}

function trackPathID(id: string): string {
  return encodeURIComponent(id);
}

/**
 * Build a `?a=1&b=2` query string, skipping undefined/null/empty values but
 * keeping 0 and false. Returns "" when nothing is set.
 */
function buildQuery(
  params: Record<string, string | number | boolean | undefined | null>,
): string {
  const qs = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "") continue;
    qs.set(key, String(value));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

/**
 * Single fetch chokepoint: applies credentials + JSON Accept, omits
 * Content-Type for FormData bodies (so the browser sets the multipart
 * boundary), and throws ApiError on any non-2xx. Returns the raw Response.
 */
async function rawFetch(
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const isForm =
    typeof FormData !== "undefined" && init.body instanceof FormData;
  const res = await fetch(url(path), {
    ...init,
    credentials: "include",
    headers: {
      Accept: "application/json",
      ...(isForm ? {} : { "Content-Type": "application/json" }),
      ...(init.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new ApiError(res.status, text.trim() || res.statusText);
  }
  return res;
}

async function fetchPage<T>(
  path: string,
  params: PageParams = {},
): Promise<Page<T>> {
  const res = await rawFetch(
    `${path}${buildQuery({ limit: params.limit, offset: params.offset, q: params.q })}`,
    { signal: params.signal },
  );
  const items = ((await res.json()) ?? []) as T[];
  const totalHeader = res.headers.get("X-Total-Count");
  const total = totalHeader ? parseInt(totalHeader, 10) : items.length;
  return { items, total: Number.isFinite(total) ? total : items.length };
}

/**
 * Value-returning request: expects a JSON body on success. A 2xx response that
 * is 204 or lacks a JSON content-type throws ApiError instead of silently
 * casting `undefined` to T (which would defer failure to a downstream
 * null-deref). Use `requestVoid` for endpoints that legitimately return no body.
 */
async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await rawFetch(path, init);
  const ct = res.headers.get("content-type") ?? "";
  if (res.status === 204 || !ct.includes("application/json")) {
    throw new ApiError(
      res.status,
      "Unexpected non-JSON response from the server.",
    );
  }
  return (await res.json()) as T;
}

/** Request for endpoints that return no body (204 / empty 2xx). */
async function requestVoid(
  path: string,
  init: RequestInit = {},
): Promise<void> {
  await rawFetch(path, init);
}

type RawArtistGridPin = Partial<ArtistGridPin> & {
  ID?: string;
  Id?: string;
  Pin?: Partial<ArtistGridPin> & {
    ID?: string;
    Id?: string;
  };
};

function stringValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  return String(value);
}

function normalizeArtistGridPin(pin: RawArtistGridPin): ArtistGridPin {
  const nested = pin.Pin ?? {};
  const merged = { ...nested, ...pin };
  delete (merged as RawArtistGridPin).Pin;
  const id = stringValue(merged.id || merged.ID || merged.Id);
  const rootPath = stringValue(merged.root_path);
  const destinationSubdir = stringValue(merged.destination_subdir);
  return {
    id,
    root_id: merged.root_id,
    root_path: rootPath,
    destination_subdir: destinationSubdir,
    destination_path:
      stringValue(merged.destination_path) ||
      [rootPath, destinationSubdir].filter(Boolean).join("/"),
    tracker_id: stringValue(merged.tracker_id),
    tracker_url: stringValue(merged.tracker_url),
    tab: stringValue(merged.tab),
    label: stringValue(merged.label),
    primary_artist: stringValue(merged.primary_artist),
    enabled: Boolean(merged.enabled),
    scan_interval_seconds: Number(merged.scan_interval_seconds) || 0,
    last_scan_at: merged.last_scan_at ?? null,
    last_success_at: merged.last_success_at ?? null,
    last_error: stringValue(merged.last_error),
    created_at: stringValue(merged.created_at),
    updated_at: stringValue(merged.updated_at),
    root_exists: merged.root_exists !== false,
  };
}

/** UUID shape shared by ArtistGrid and Filen pin ids. */
export const pinIDPattern =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/** Source-neutral pin-id validator (replaces per-source / per-screen copies). */
export function isValidPinID(id: string): boolean {
  return pinIDPattern.test(stringValue(id).trim());
}

function pinPathID(id: string, source: string): string {
  const trimmed = stringValue(id).trim();
  if (!pinIDPattern.test(trimmed)) {
    throw new ApiError(
      0,
      `${source} pin id is missing. Refresh sources or restart the backend.`,
    );
  }
  return encodeURIComponent(trimmed);
}

function artistGridPinPathID(id: string): string {
  return pinPathID(id, "Tracker");
}

function filenPinPathID(id: string): string {
  return pinPathID(id, "Filen");
}

function apiTrackerPinPathID(id: string): string {
  return pinPathID(id, "API tracker");
}

export const api = {
  login: (username: string, password: string) =>
    request<Me>("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  logout: () => requestVoid("/api/auth/logout", { method: "POST" }),
  me: () => request<Me>("/api/auth/me"),
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
    requestVoid(`/api/admin/invites/${id}`, { method: "DELETE" }),

  listMusicRoots: (options: RequestOptions = {}) =>
    request<MusicRoot[]>("/api/admin/library/roots", options),
  addMusicRoot: (input: { path: string; label?: string }) =>
    request<MusicRoot>("/api/admin/library/roots", {
      method: "POST",
      body: JSON.stringify(input),
    }),
  setMusicRootEnabled: (id: string, enabled: boolean) =>
    request<MusicRoot>(`/api/admin/library/roots/${id}`, {
      method: "PATCH",
      body: JSON.stringify({ enabled }),
    }),
  deleteMusicRoot: (id: string, opts: { purge?: boolean } = {}) => {
    const qs = opts.purge === false ? "?purge=false" : "";
    return request<{ deleted_tracks: number }>(
      `/api/admin/library/roots/${id}${qs}`,
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
    request<Album>(`/api/albums/${id}`, options),
  listAlbumTracks: (id: string, options: RequestOptions = {}) =>
    request<TrackListItem[]>(`/api/albums/${id}/tracks`, options),
  getTidalAlbum: (id: string, options: RequestOptions = {}) =>
    request<TidalAlbum>(`/api/tidal/albums/${encodeURIComponent(id)}`, options),

  listArtistsPage: (params: PageParams = {}) =>
    fetchPage<Artist>("/api/artists", params),
  getArtist: (id: string, options: RequestOptions = {}) =>
    request<Artist>(`/api/artists/${id}`, options),
  listArtistTracks: (id: string, options: RequestOptions = {}) =>
    request<TrackListItem[]>(`/api/artists/${id}/tracks`, options),
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
    request<Album>(`/api/albums/${id}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),
  // Replace an album's cover art. `file` is a browser File (web) or the
  // RN-style { uri, name, type } part React Native's FormData accepts.
  // Admin-only on the server; returns the updated album.
  setAlbumCover: (id: string, file: CoverUploadFile) => {
    const fd = new FormData();
    fd.append("file", file as unknown as Blob);
    return request<Album>(`/api/albums/${id}/cover`, { method: "PUT", body: fd });
  },
  // Clear an album's cover art, reverting it to the placeholder. Admin only.
  removeAlbumCover: (id: string) =>
    request<Album>(`/api/albums/${id}/cover`, { method: "DELETE" }),
  recordPlay: (id: string, completion: number) =>
    requestVoid(`/api/tracks/${trackPathID(id)}/play`, {
      method: "POST",
      body: JSON.stringify({ completion }),
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
    request<Playlist>(`/api/playlists/${id}`, options),
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
    requestVoid(`/api/playlists/${id}`, {
      method: "PATCH",
      body: JSON.stringify(input),
    }),
  deletePlaylist: (id: string) =>
    requestVoid(`/api/playlists/${id}`, { method: "DELETE" }),

  listPlaylistTracks: (id: string, options: RequestOptions = {}) =>
    request<PlaylistTracks>(`/api/playlists/${id}/tracks`, options),
  addPlaylistTracks: (id: string, trackIds: string[]) =>
    requestVoid(`/api/playlists/${id}/tracks`, {
      method: "POST",
      body: JSON.stringify({ track_ids: trackIds }),
    }),
  removePlaylistTrack: (id: string, position: number) =>
    requestVoid(`/api/playlists/${id}/tracks/${position}`, { method: "DELETE" }),
  reorderPlaylist: (id: string, trackIds: string[]) =>
    requestVoid(`/api/playlists/${id}/order`, {
      method: "PUT",
      body: JSON.stringify({ track_ids: trackIds }),
    }),

  listCollaborators: (id: string, options: RequestOptions = {}) =>
    request<Collaborator[]>(`/api/playlists/${id}/collaborators`, options),
  inviteCollaborator: (
    id: string,
    input: { username: string; role: "viewer" | "editor" },
  ) =>
    requestVoid(`/api/playlists/${id}/collaborators`, {
      method: "POST",
      body: JSON.stringify(input),
    }),
  removeCollaborator: (id: string, userId: string) =>
    requestVoid(`/api/playlists/${id}/collaborators/${userId}`, {
      method: "DELETE",
    }),
  setCollaboratorRole: (id: string, userId: string, role: "viewer" | "editor") =>
    requestVoid(`/api/playlists/${id}/collaborators/${userId}`, {
      method: "PATCH",
      body: JSON.stringify({ role }),
    }),

  listPendingInvites: (options: RequestOptions = {}) =>
    request<PendingInvite[]>(`/api/playlists/invites`, options),
  acceptInvite: (id: string) =>
    requestVoid(`/api/playlists/invites/${id}/accept`, { method: "POST" }),
  declineInvite: (id: string) =>
    requestVoid(`/api/playlists/invites/${id}/decline`, { method: "POST" }),

  tidalStatus: (options: RequestOptions = {}) =>
    request<TidalStatus>("/api/admin/tidal/status", options),
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

export function streamUrl(id: string): string {
  return url(`/api/tracks/${trackPathID(id)}/stream`);
}

/**
 * URL for downloading a track as a single file. Identical to streamUrl for
 * local tracks; for TIDAL tracks it appends ?download=1 so the backend
 * assembles a contiguous file from the HLS playlist instead of returning the
 * rewritten playlist that live playback uses.
 */
export function downloadStreamUrl(id: string): string {
  const base = `/api/tracks/${trackPathID(id)}/stream`;
  if (id.toLowerCase().startsWith("tidal:")) {
    return url(`${base}?download=1`);
  }
  return url(base);
}

function withCoverSize(path: string, size?: number): string {
  if (!size || !Number.isFinite(size) || size <= 0) return url(path);
  const qs = new URLSearchParams({ size: String(Math.round(size)) });
  return url(`${path}?${qs.toString()}`);
}

export function coverUrl(id: string, size?: number): string {
  return withCoverSize(`/api/tracks/${trackPathID(id)}/cover`, size);
}

export function albumCoverUrl(id: string, size?: number): string {
  return withCoverSize(`/api/albums/${id}/cover`, size);
}

/**
 * Prefer the album cover URL when a track belongs to one. Every track in an
 * album shares the same artwork, so a single URL per album means the browser
 * HTTP cache can serve every subsequent track image without a round-trip.
 * Falls back to the per-track URL for orphaned tracks (no album).
 */
export function trackCoverUrl(track: {
  id: string;
  album_id?: string | null;
  cover_url?: string | null;
}, size?: number): string {
  if (track.cover_url) return url(track.cover_url);
  return track.album_id ? albumCoverUrl(track.album_id, size) : coverUrl(track.id, size);
}

export interface SignedCoverUrl {
  url: string;
  expires_at: number;
}

/**
 * Ask the backend to mint a short-lived public cover URL for an album.
 * Used by Discord Rich Presence: Discord's media proxy fetches large_image
 * without cookies, so the normal auth-gated cover endpoints 404 for it.
 */
export function signAlbumCoverUrl(albumId: string): Promise<SignedCoverUrl> {
  const qs = new URLSearchParams({ album_id: albumId });
  return request<SignedCoverUrl>(`/api/covers/sign?${qs.toString()}`);
}

export interface ShareLink {
  url: string;
  start_sec: number;
}

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

/**
 * Mint a signed share URL for a track, starting at `startSec` for 30s.
 * The returned URL unfurls into a video embed in Discord (cover + audio
 * snippet). Long-lived: safe to paste in chat and expect it to keep
 * working. Backend clamps start_sec so the 30s window stays in-bounds.
 */
export function createTrackShareLink(
  trackId: string,
  startSec: number,
): Promise<ShareLink> {
  const qs = new URLSearchParams({ t: String(Math.max(0, Math.floor(startSec))) });
  return request<ShareLink>(`/api/tracks/${trackPathID(trackId)}/share?${qs.toString()}`, {
    method: "POST",
  });
}

// ── Replay (listening stats) ────────────────────────────────────────────────

/**
 * Render a one-off Instagram Story background video from a custom image.
 * The response body is an MP4 stream; callers save it locally and pass that
 * file to the native Instagram Story share sheet.
 */
export function createTrackStoryBackgroundVideo(
  trackId: string,
  startSec: number,
  file: StoryBackgroundUploadFile,
  crop: StoryBackgroundCrop,
): Promise<Response> {
  const fd = new FormData();
  fd.append("start_sec", String(Math.max(0, Math.floor(startSec))));
  fd.append("crop_x", String(crop.x));
  fd.append("crop_y", String(crop.y));
  fd.append("crop_width", String(crop.width));
  fd.append("crop_height", String(crop.height));
  fd.append("file", file as unknown as Blob);
  return rawFetch(
    `/api/tracks/${encodeURIComponent(trackId)}/story-background`,
    { method: "POST", body: fd },
  );
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

/**
 * Load public display metadata and fresh signed media URLs for a share link.
 * Requires no session cookie; the long-lived share signature authorizes it.
 */
export function getPublicTrackShare(
  trackId: string,
  startSec: number,
  sig: string,
): Promise<PublicTrackShare> {
  const qs = new URLSearchParams({
    t: String(Math.max(0, Math.floor(startSec))),
    sig,
  });
  return request<PublicTrackShare>(
    `/api/public/share/track/${encodeURIComponent(trackId)}?${qs.toString()}`,
  );
}

/* ——————————————————— track display helpers ——————————————————— */

/** Adapt a playlist track entry to the TrackListItem shape used by the queue. */
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

/** Comma-joined performing artists (excludes composers). */
export function displayArtists(track: { artists?: TrackArtist[] }): string {
  return (track.artists ?? [])
    .filter((a) => a.role !== "composer")
    .map((a) => a.name)
    .join(", ");
}

/** First performing artist's name (falls back to the first listed artist). */
export function primaryArtistName(track: { artists?: TrackArtist[] }): string {
  const artists = track.artists ?? [];
  const performer = artists.find((a) => a.role !== "composer");
  return (performer ?? artists[0])?.name ?? "";
}
