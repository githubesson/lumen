// Fixture data for the rendered-UI lint run (`npm run lint:ui`). Everything is
// typed against core's API types so a payload change shows up in typecheck.
import type {
  AdminUser,
  Album,
  APITrackerPin,
  Artist,
  ArtistGridPin,
  Collaborator,
  FilenPin,
  IngestErrors,
  Invite,
  LastFMStatus,
  LyricsResult,
  Me,
  MusicRoot,
  MusicRootUsage,
  PendingInvite,
  Playlist,
  PlaylistTrackEntry,
  PublicTrackShare,
  ReplayBucket,
  ReplayData,
  RescanStatus,
  SearchAlbum,
  SearchArtist,
  SearchResponse,
  TidalAutoDownloadStatus,
  TidalAlbum,
  TidalStatus,
  TrackDetail,
  TrackListItem,
} from "@music-library/core/api";

export const me: Me = { id: "u-maya", username: "maya", role: "admin", must_reset_password: false };

const created = "2025-03-14T09:26:53Z";
const updated = "2026-10-02T21:04:11Z";

const artistRows = [
  { id: "ar-halden", name: "Halden Marsh", genre: "Indie Folk" },
  { id: "ar-okoro", name: "Hana Okoro", genre: "Neo-Soul" },
  { id: "ar-velvet", name: "The Velvet Meridian", genre: "Dream Pop" },
  { id: "ar-lucien", name: "Saint Lucien & The Harbour Lights", genre: "Chamber Pop" },
  { id: "ar-brandt", name: "Ola Brandt Quartet", genre: "Jazz" },
  { id: "ar-kestrel", name: "Kestrel Bay", genre: "Electronic" },
] as const;

type ArtistId = (typeof artistRows)[number]["id"];

const albumRows: {
  id: string;
  title: string;
  artist: ArtistId;
  year: number;
  tracks: [title: string, seconds: number, featuring?: ArtistId][];
}[] = [
  {
    id: "al-weather",
    title: "Weather Over Low Country",
    artist: "ar-halden",
    year: 2024,
    tracks: [
      ["Weather Over Low Country", 252],
      ["Everything You Left in the Glovebox", 214],
      ["Paper Moons", 198, "ar-okoro"],
      ["The Lighthouse Keeper's Daughter Never Learned to Swim", 341],
      ["Fenland", 187],
      ["Interlude — Rain on the Skylight", 74],
    ],
  },
  {
    id: "al-small-hours",
    title: "Small Hours, Golden Rooms",
    artist: "ar-okoro",
    year: 2023,
    tracks: [
      ["Honey in the Static", 233],
      ["Small Hours", 276],
      ["Call Me When the Trains Stop Running", 305],
      ["Gold Leaf", 221],
      ["Velvet Telephone", 248, "ar-kestrel"],
    ],
  },
  {
    id: "al-postcard",
    title: "A Postcard From the Edge of the Continental Shelf",
    artist: "ar-velvet",
    year: 2025,
    tracks: [
      ["Undertow Hymn", 289],
      ["Saltwater Cathedral", 317],
      ["We Were Never Here, We Were Always Here", 402],
      ["Bioluminescence", 266],
      ["Continental Shelf", 518],
    ],
  },
  {
    id: "al-lanterns",
    title: "Lanterns for the Night Ferry (Deluxe Edition)",
    artist: "ar-lucien",
    year: 2022,
    tracks: [
      ["Night Ferry", 239],
      ["Harbour Lights", 205],
      ["A Coat Too Thin for November", 262],
      ["The Cartographer's Lament", 296],
      ["Night Ferry (Reprise) [Bonus Track]", 131],
    ],
  },
  {
    id: "al-nordlys",
    title: "Nordlys Sessions, Vol. 2",
    artist: "ar-brandt",
    year: 2021,
    tracks: [
      ["Polar Night Blues", 412],
      ["Tromsø, 4 A.M.", 377],
      ["Waltz for a Frozen Fjord", 455],
      ["Aurora (Take 3)", 391],
    ],
  },
  {
    id: "al-signal",
    title: "Signal / Noise",
    artist: "ar-kestrel",
    year: 2026,
    tracks: [
      ["Carrier Wave", 268],
      ["Low Orbit", 301],
      ["Interference Pattern", 244, "ar-velvet"],
      ["Static Bloom", 283],
      ["Signal / Noise", 356],
    ],
  },
];

const artistName = (id: ArtistId) => artistRows.find((a) => a.id === id)!.name;
export const genreOf = (artistId: string) => artistRows.find((a) => a.id === artistId)?.genre ?? "";

/** Favorite track ids; the Favorites page lists them in this order. */
const favoriteIds = new Set([
  "t-al-weather-2",
  "t-al-small-hours-1",
  "t-al-small-hours-3",
  "t-al-postcard-3",
  "t-al-lanterns-1",
  "t-al-nordlys-2",
  "t-al-signal-2",
  "t-al-signal-5",
]);

type TrackRow = TrackListItem & { artist_id: string; featured_id?: string };

export const tracks: TrackRow[] = albumRows.flatMap((album) =>
  album.tracks.map(([title, seconds, featuring], index) => ({
    id: `t-${album.id}-${index + 1}`,
    source: "local" as const,
    title: featuring ? `${title} (feat. ${artistName(featuring)})` : title,
    album_id: album.id,
    album_title: album.title,
    track_no: index + 1,
    duration_ms: seconds * 1000 + 412,
    artist: featuring ? `${artistName(album.artist)}, ${artistName(featuring)}` : artistName(album.artist),
    artist_id: album.artist,
    featured_id: featuring,
    favorited: favoriteIds.has(`t-${album.id}-${index + 1}`),
    has_cover: true,
  })),
);
// One track was imported twice with different tags, so its row shows "(+1)".
tracks[0].aka = "Low Country Weather (Demo)";

/** Strips the fixture-only fields so payloads match `TrackListItem`. */
export function listItem({ artist_id: _artist, featured_id: _featured, ...track }: TrackRow): TrackListItem {
  return track;
}

export const tidalTrack: TrackListItem = {
  id: "tidal:381245570",
  source: "tidal",
  source_id: "381245570",
  source_album_id: "381245566",
  title: "Night Ferry (Live From the Union Chapel, Islington)",
  album_title: "Live From the Union Chapel",
  duration_ms: 276_000,
  artist: "Saint Lucien & The Harbour Lights",
  cover_url: "/api/covers/remote?url=https%3A%2F%2Fresources.tidal.com%2Fimages%2Fd7a1%2F640x640.jpg",
};

/**
 * A TIDAL track by an artist the library has nothing of. In Replay's top
 * tracks, its artist is a top artist without a page: their tile plays.
 */
export const streamedTrack: TrackListItem = {
  id: "tidal:402177310",
  source: "tidal",
  source_id: "402177310",
  source_album_id: "402177301",
  title: "Tidewater",
  album_title: "Low Tide Radio",
  duration_ms: 241_000,
  artist: "Marisol Vey",
  cover_url: "/api/covers/remote?url=https%3A%2F%2Fresources.tidal.com%2Fimages%2Fb3c9%2F640x640.jpg",
};

/** The TIDAL release `tidalTrack` is from. Nothing of it is in the library, so its page offers the download. */
export const tidalAlbum: TidalAlbum = (() => {
  const rows: [title: string, seconds: number][] = [
    ["Harbour Lights (Live From the Union Chapel, Islington)", 231],
    ["Night Ferry (Live From the Union Chapel, Islington)", 276],
    ["A Coat Too Thin for November (Live From the Union Chapel, Islington)", 284],
    ["The Cartographer's Lament (Live From the Union Chapel, Islington)", 318],
  ];
  const albumTracks = rows.map(([title, seconds], index): TrackListItem =>
    title === tidalTrack.title
      ? tidalTrack
      : {
          ...tidalTrack,
          id: `tidal:3812455${71 + index}`,
          source_id: `3812455${71 + index}`,
          title,
          duration_ms: seconds * 1000,
        },
  );
  return {
    id: tidalTrack.source_album_id!,
    title: tidalTrack.album_title!,
    artist: tidalTrack.artist,
    artists: [tidalTrack.artist!],
    release_year: 2023,
    track_count: albumTracks.length,
    duration_ms: albumTracks.reduce((sum, t) => sum + t.duration_ms, 0),
    cover_url: tidalTrack.cover_url,
    tracks: albumTracks,
  };
})();

/**
 * A TIDAL release the library holds part or all of: the server lists the
 * library's copies in place of its tracks, and links the library album.
 */
function savedTidalAlbum(
  id: string,
  albumId: string,
  more: [title: string, seconds: number][],
): TidalAlbum {
  const album = albumRows.find((a) => a.id === albumId)!;
  const saved = tracks.filter((t) => t.album_id === albumId).map(listItem);
  const remote = more.map(([title, seconds], index): TrackListItem => ({
    id: `tidal:${id}${index + 1}`,
    source: "tidal",
    source_id: `${id}${index + 1}`,
    source_album_id: id,
    title,
    album_title: album.title,
    duration_ms: seconds * 1000,
    artist: artistName(album.artist),
    cover_url: `/api/covers/remote?url=https%3A%2F%2Fresources.tidal.com%2Fimages%2F${id}%2F640x640.jpg`,
  }));
  const albumTracks = [...saved, ...remote];
  return {
    id,
    title: album.title,
    artist: artistName(album.artist),
    artists: [artistName(album.artist)],
    release_year: album.year,
    saved_count: saved.length,
    library_album_id: albumId,
    track_count: albumTracks.length,
    duration_ms: albumTracks.reduce((sum, t) => sum + t.duration_ms, 0),
    cover_url: remote[0]?.cover_url ?? `/api/covers/remote?url=https%3A%2F%2Fresources.tidal.com%2Fimages%2F${id}%2F640x640.jpg`,
    tracks: albumTracks,
  };
}

/** Partly saved: an admin gets the download, and the library copy as a link in Details. */
export const tidalAlbumPartlySaved = savedTidalAlbum("310077120", "al-lanterns", [
  ["Lantern Song (Demo)", 214],
  ["Harbour Lights (Strings Version)", 247],
]);

/** All saved: an admin's actions row opens the library copy instead. */
export const tidalAlbumSaved = savedTidalAlbum("298114503", "al-nordlys", []);

export const tidalAlbums: TidalAlbum[] = [tidalAlbum, tidalAlbumPartlySaved, tidalAlbumSaved];

export const albums: Album[] = albumRows.map((album) => ({
  id: album.id,
  title: album.title,
  artist_id: album.artist,
  artist_name: artistName(album.artist),
  is_compilation: false,
  release_year: album.year,
  track_count: album.tracks.length,
  duration_ms: tracks.filter((t) => t.album_id === album.id).reduce((sum, t) => sum + t.duration_ms, 0),
  has_cover: true,
}));

export const artists: Artist[] = artistRows.map((artist) => ({
  id: artist.id,
  name: artist.name,
  track_count: tracks.filter((t) => t.artist_id === artist.id || t.featured_id === artist.id).length,
  album_count: albums.filter((a) => a.artist_id === artist.id).length,
}));

export function artistTracks(id: string): TrackRow[] {
  return tracks.filter((t) => t.artist_id === id || t.featured_id === id);
}

export function trackDetail(track: TrackRow): TrackDetail {
  const album = albums.find((a) => a.id === track.album_id)!;
  const base = track.title.replace(/[/:?]/g, "-");
  return {
    id: track.id,
    source: "local",
    title: track.title,
    album_id: track.album_id,
    album_title: track.album_title,
    track_no: track.track_no,
    disc_no: 1,
    duration_ms: track.duration_ms,
    genre: genreOf(track.artist_id),
    year: album.release_year,
    composer: "M. Lindqvist, A. Okafor",
    format: "flac",
    bitrate: 1_024_000,
    sample_rate: 44_100,
    channels: 2,
    file_size: Math.round((track.duration_ms / 1000) * 128_000),
    artists: [
      { id: track.artist_id, name: artistName(track.artist_id as ArtistId), role: "primary" },
      ...(track.featured_id ? [{ id: track.featured_id, name: artistName(track.featured_id as ArtistId), role: "featured" }] : []),
    ],
    has_cover: true,
    favorited: Boolean(track.favorited),
    file_name: `/music/${album.artist_name}/${album.title}/${String(track.track_no).padStart(2, "0")} - ${base}.flac`,
    ...(track.aka
      ? {
          aliases: [{ file_name: "/mnt/nas/uploads/lossless/Halden Marsh - Low Country Weather (Demo).flac", title: track.aka, artist_names: "Halden Marsh", album_title: "Demos 2022" }],
          alias_count: 1,
        }
      : {}),
  };
}

const byId = (id: string) => tracks.find((t) => t.id === id)!;

export const favorites: TrackListItem[] = [...favoriteIds].map((id) => listItem(byId(id)));

export const recent: TrackListItem[] = [
  "t-al-postcard-3",
  "t-al-weather-1",
  "t-al-small-hours-3",
  "t-al-signal-2",
  "t-al-lanterns-4",
  "t-al-nordlys-1",
  "t-al-weather-4",
  "t-al-small-hours-5",
  "t-al-postcard-5",
  "t-al-lanterns-1",
  "t-al-signal-3",
  "t-al-weather-2",
].map((id) => listItem(byId(id)));

export const playlists: Playlist[] = [
  {
    id: "pl-night-drives",
    owner_id: me.id,
    name: "Late Night Drives Through the Rain-Soaked City",
    description: "Slow-burning songs for empty motorways after midnight. No skipping the long ones.",
    visibility: "private",
    is_smart: false,
    effective_role: "owner",
    created_at: created,
    updated_at: updated,
    cover: { track_id: "t-al-postcard-1", album_id: "al-postcard" },
    owner_name: me.username,
  },
  {
    id: "pl-sunday-coffee",
    owner_id: me.id,
    name: "Sunday Morning Coffee & Vinyl",
    description: "Warm, unhurried records. Jonas and Priya add to this one too.",
    visibility: "collaborative",
    is_smart: false,
    effective_role: "owner",
    created_at: "2025-11-30T10:12:00Z",
    updated_at: "2026-10-05T08:41:27Z",
    cover: { track_id: "t-al-small-hours-1", album_id: "al-small-hours" },
    owner_name: me.username,
  },
  {
    id: "pl-road-trip",
    owner_id: "u-jonas",
    name: "Road Trip: Lisbon to Porto, Summer '26",
    visibility: "collaborative",
    is_smart: false,
    effective_role: "editor",
    created_at: "2026-06-02T17:30:00Z",
    updated_at: "2026-08-19T12:05:44Z",
    cover: { track_id: "t-al-signal-1", album_id: "al-signal" },
    owner_name: "jonas",
  },
];

const playlistTrackIds: Record<string, string[]> = {
  "pl-night-drives": [
    "t-al-postcard-1",
    "t-al-signal-2",
    "t-al-lanterns-1",
    "t-al-small-hours-3",
    "t-al-postcard-3",
    "t-al-signal-4",
    "t-al-weather-4",
    "t-al-nordlys-2",
    "t-al-postcard-5",
  ],
  "pl-sunday-coffee": [
    "t-al-small-hours-1",
    "t-al-weather-2",
    "t-al-nordlys-3",
    "t-al-lanterns-2",
    "t-al-small-hours-4",
    "t-al-weather-5",
    "t-al-nordlys-4",
  ],
  "pl-road-trip": ["t-al-signal-1", "t-al-weather-1", "t-al-lanterns-3", "t-al-signal-5", "t-al-small-hours-2"],
};

const adders = [
  { id: me.id, name: me.username },
  { id: "u-jonas", name: "jonas" },
  { id: "u-priya", name: "priya" },
];

export function playlistTracks(id: string): PlaylistTrackEntry[] {
  return (playlistTrackIds[id] ?? []).map((trackId, index) => {
    const { id: track_id, favorited: _f, owned: _o, aka: _a, ...rest } = listItem(byId(trackId));
    const adder = id === "pl-night-drives" ? adders[0] : adders[index % adders.length];
    return {
      ...rest,
      position: index,
      track_id,
      added_by_id: adder.id,
      added_by: adder.name,
      added_at: new Date(Date.UTC(2026, 8, 1 + index * 3, 20, 15)).toISOString(),
      play_count: (index * 7 + 3) % 23,
    };
  });
}

export const collaborators: Record<string, Collaborator[]> = {
  "pl-sunday-coffee": [
    { user_id: "u-jonas", username: "jonas", role: "editor", status: "accepted", invited_at: "2025-12-01T09:00:00Z", accepted_at: "2025-12-01T11:24:00Z" },
    { user_id: "u-priya", username: "priya", role: "viewer", status: "accepted", invited_at: "2026-01-14T18:40:00Z", accepted_at: "2026-01-15T07:02:00Z" },
    { user_id: "u-theo", username: "theo", role: "editor", status: "pending", invited_at: "2026-10-04T16:12:00Z" },
  ],
  "pl-road-trip": [
    { user_id: me.id, username: me.username, role: "editor", status: "accepted", invited_at: "2026-06-02T17:31:00Z", accepted_at: "2026-06-02T19:00:00Z" },
    { user_id: "u-priya", username: "priya", role: "viewer", status: "accepted", invited_at: "2026-06-03T08:00:00Z", accepted_at: "2026-06-03T09:15:00Z" },
  ],
};

export const pendingInvites: PendingInvite[] = [
  { playlist_id: "pl-jonas-running", playlist_name: "Jonas's Running Mix — 170 BPM and Up", owner_id: "u-jonas", owner_name: "jonas", role: "editor", invited_at: "2026-10-08T06:45:00Z" },
  { playlist_id: "pl-priya-wedding", playlist_name: "Wedding Reception (Do Not Play Before 9pm)", owner_id: "u-priya", owner_name: "priya", role: "viewer", invited_at: "2026-10-10T19:20:00Z" },
];

export const adminUsers: AdminUser[] = [
  { id: me.id, username: me.username, role: "admin", disabled: false, must_reset_password: false, created_at: "2025-02-01T12:00:00Z", last_login_at: "2026-10-11T08:12:00Z" },
  { id: "u-jonas", username: "jonas", role: "user", disabled: false, must_reset_password: false, created_at: "2025-03-14T09:26:53Z", last_login_at: "2026-10-09T22:41:00Z" },
  { id: "u-priya", username: "priya", role: "user", disabled: false, must_reset_password: false, created_at: "2025-06-21T15:03:10Z", last_login_at: "2026-10-10T19:18:00Z" },
  { id: "u-theo", username: "theo", role: "user", disabled: false, must_reset_password: true, created_at: "2026-10-04T16:00:00Z" },
  { id: "u-oskar", username: "oskar.lindqvist", role: "user", disabled: true, must_reset_password: false, created_at: "2025-04-02T10:10:00Z", last_login_at: "2026-02-11T13:37:00Z" },
];

export const invites: Invite[] = [
  { id: "inv-1", token: "lmn_7QxV2pKc9RfT4wZb", target_role: "user", max_uses: 5, uses: 2, expires_at: "2026-11-01T00:00:00Z", created_at: "2026-10-01T12:00:00Z" },
  { id: "inv-2", token: "lmn_Hd83LwQe1NvY6sAa", target_role: "admin", max_uses: 1, uses: 0, expires_at: "2026-10-18T00:00:00Z", created_at: "2026-10-09T08:30:00Z" },
  { id: "inv-3", token: "lmn_Zp4mKt7BcXr2Ue9J", target_role: "user", max_uses: 10, uses: 10, expires_at: null, created_at: "2026-05-20T17:45:00Z" },
];

export const musicRoots: MusicRoot[] = [
  { id: "root-1", path: "/music", label: "Library", enabled: true, primary: true, exists: true, created_at: "2025-02-01T12:00:00Z" },
  { id: "root-2", path: "/mnt/nas/uploads/lossless", label: "NAS uploads", enabled: true, primary: false, exists: true, created_at: "2025-08-10T09:00:00Z" },
  { id: "root-3", path: "/mnt/usb-backup/old-itunes-library", label: "Old iTunes", enabled: false, primary: false, exists: false, created_at: "2025-09-01T09:00:00Z" },
];

export const musicRootUsage: MusicRootUsage = {
  roots: [
    { path: "/music", files: 18_442, bytes: 612_884_201_472 },
    { path: "/mnt/nas/uploads/lossless", files: 1_207, bytes: 41_983_442_944 },
  ],
  measured_at: "2026-10-11T07:58:00Z",
};

export const ingestErrors: IngestErrors = {
  total: 3,
  errors: [
    { id: 41, file_path: "/mnt/nas/uploads/lossless/Unknown Artist/Track 07.flac", error: "flac: invalid STREAMINFO block", created_at: "2026-10-10T03:12:00Z", attempts: 4 },
    { id: 38, file_path: "/music/Various Artists/Late Night Tales/12 - Untitled.m4a", error: "mp4: no audio track", created_at: "2026-10-08T03:12:00Z", attempts: 2 },
  ],
};

export const rescanStatus: RescanStatus = { running: false, total: 19_649, processed: 19_649, inserted: 14, dedup: 3, errored: 2, pruned: 1 };

export const tidalStatus: TidalStatus = {
  connected: true,
  proxy_url: "http://hifi-api:8000",
  country_code: "NO",
  quality: "LOSSLESS",
  version: "2.4.1",
  management_supported: true,
  accounts: [{ id: "acct-1", user_id: "198273645", removable: true }],
};

export const tidalAutoDownload: TidalAutoDownloadStatus = {
  root_id: "root-1",
  subdir: "tidal",
  destination: "/music/tidal",
  ffmpeg: true,
  summary: { playlists: 1, queued: 3, failed: 1, saved: 42 },
  recent: [
    { tidal_id: "381245570", status: "downloaded", title: "Night Ferry (Live From the Union Chapel, Islington)", artist: "Saint Lucien & The Harbour Lights", file_path: "/music/tidal/Saint Lucien & The Harbour Lights/Night Ferry (Live).flac", attempts: 1, updated_at: "2026-10-10T21:00:00Z" },
    { tidal_id: "290011873", status: "failed", title: "Undertow Hymn (Radio Edit)", artist: "The Velvet Meridian", error: "stream unavailable in region", attempts: 3, next_attempt_at: "2026-10-12T00:00:00Z", updated_at: "2026-10-11T06:00:00Z" },
  ],
};

export const apiTrackerPins: APITrackerPin[] = [
  {
    id: "atp-1",
    root_id: "root-1",
    root_path: "/music",
    destination_subdir: "trackers/kestrel-bay",
    destination_path: "/music/trackers/kestrel-bay",
    api_base_url: "https://tracker.example.org/api",
    tracker_id: 1182,
    tracker_name: "Kestrel Bay — Unreleased",
    tracker_url: "https://tracker.example.org/t/1182",
    tab: "Unreleased",
    label: "Kestrel Bay unreleased",
    primary_artist: "Kestrel Bay",
    enabled: true,
    scan_interval_seconds: 21_600,
    last_scan_at: "2026-10-11T06:00:00Z",
    last_success_at: "2026-10-11T06:00:00Z",
    created_at: "2026-04-01T10:00:00Z",
    updated_at: "2026-10-11T06:00:00Z",
    root_exists: true,
  },
];

export const artistGridPins: ArtistGridPin[] = [
  {
    id: "agp-1",
    root_id: "root-1",
    root_path: "/music",
    destination_subdir: "artistgrid/velvet-meridian",
    destination_path: "/music/artistgrid/velvet-meridian",
    tracker_id: "velvet-meridian",
    tracker_url: "https://artistgrid.example.org/velvet-meridian",
    tab: "Demos",
    label: "Velvet Meridian demos",
    primary_artist: "The Velvet Meridian",
    enabled: true,
    scan_interval_seconds: 43_200,
    last_scan_at: "2026-10-10T18:00:00Z",
    last_success_at: "2026-10-09T18:00:00Z",
    last_error: "tracker returned 503 Service Unavailable",
    created_at: "2026-05-12T10:00:00Z",
    updated_at: "2026-10-10T18:00:00Z",
    root_exists: true,
  },
];

export const filenPins: FilenPin[] = [
  {
    id: "fp-1",
    root_id: "root-2",
    root_path: "/mnt/nas/uploads/lossless",
    destination_subdir: "filen/okoro-stems",
    destination_path: "/mnt/nas/uploads/lossless/filen/okoro-stems",
    share_url: "https://app.filen.io/#/d/3f1c9a2e-77b4-4c1e-9d0a-5be1f2c8a901",
    password_set: true,
    label: "Hana Okoro session files",
    enabled: false,
    scan_interval_seconds: 86_400,
    last_scan_at: "2026-09-30T12:00:00Z",
    last_success_at: "2026-09-30T12:00:00Z",
    created_at: "2026-07-01T10:00:00Z",
    updated_at: "2026-09-30T12:00:00Z",
    root_exists: true,
  },
];

export const lastfm: LastFMStatus = { configured: true, connected: true, pending: false, username: "maya_listens" };

export function lyrics(track: TrackListItem): LyricsResult {
  return {
    id: 90210,
    trackName: track.title,
    artistName: track.artist ?? "",
    albumName: track.album_title,
    duration: Math.round(track.duration_ms / 1000),
    instrumental: false,
    plainLyrics: "Rain on the skylight, the kettle's still warm\nYou left the radio humming through the storm",
    syncedLyrics: "[00:12.40] Rain on the skylight, the kettle's still warm\n[00:18.90] You left the radio humming through the storm",
  };
}

const matches = (q: string, ...values: (string | undefined)[]) =>
  values.some((v) => v?.toLowerCase().includes(q.toLowerCase()));

export function search(q: string, type: string): SearchResponse {
  const want = (t: string) => type === "all" || type === t;
  const albumHits: SearchAlbum[] = want("album")
    ? albums.filter((a) => matches(q, a.title, a.artist_name)).map((a) => ({ ...a, source: "local" }))
    : [];
  const artistHits: SearchArtist[] = want("artist")
    ? artists.filter((a) => matches(q, a.name)).map((a) => ({ ...a, source: "local" }))
    : [];
  const trackHits = want("track")
    ? [...tracks.filter((t) => matches(q, t.title, t.artist, t.album_title)).map(listItem), ...(matches(q, tidalTrack.title, tidalTrack.artist) ? [tidalTrack] : [])]
    : [];
  return { albums: albumHits, artists: artistHits, tracks: trackHits, sources: ["local", "tidal"], next_offsets: {} };
}

const DAY_MS = 24 * 60 * 60 * 1000;
// Plays per day: a three-week rhythm with a quiet day most weeks.
const dailyRhythm = [4, 9, 0, 13, 7, 21, 16, 5, 11, 2, 18, 8, 0, 6, 12, 3, 15, 9, 0, 14, 10];

/**
 * The Replay answer for a window, like the server's: plays per bucket for
 * the days with plays from `from` (or 420 days back, for all time) to `to`
 * or now, and every count scaled to the window's plays.
 */
export function replay(bucket: ReplayBucket = "day", from?: string | null, to?: string | null): ReplayData {
  // More than the eight the panel lists, so "Show all" has more to show.
  const top = ["t-al-postcard-3", "t-al-small-hours-3", "t-al-weather-1", streamedTrack.id, "t-al-signal-2", "t-al-lanterns-1", "t-al-nordlys-2", "t-al-weather-4", "t-al-postcard-1", "t-al-signal-4", "t-al-small-hours-1", "t-al-lanterns-3"];
  // As the server sends them: each track's primary artists by id, and
  // whether each has a page (every library artist does; Marisol Vey, only
  // ever streamed, doesn't).
  const topTrack = (id: string) => {
    if (id === streamedTrack.id) {
      return { ...streamedTrack, primary_artists: [{ id: "ar-marisol", name: "Marisol Vey", has_page: false }] };
    }
    const row = byId(id);
    const credited = [row.artist_id, row.featured_id].filter((a): a is ArtistId => !!a);
    return { ...listItem(row), primary_artists: credited.map((a) => ({ id: a, name: artistName(a), has_page: true })) };
  };
  const now = Date.now();
  const first = Math.floor((from ? Date.parse(from) : now - 420 * DAY_MS) / DAY_MS) * DAY_MS;
  const end = Math.min(to ? Date.parse(to) : now, now);
  const activity: ReplayData["activity"] = [];
  for (let day = first; day < end; day += DAY_MS) {
    const plays = dailyRhythm[Math.round(day / DAY_MS) % dailyRhythm.length];
    if (plays === 0) continue;
    const date = new Date(day);
    const start = bucket === "day" ? day : Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1);
    const iso = new Date(start).toISOString();
    const last = activity[activity.length - 1];
    if (last?.bucket_start === iso) last.plays += plays;
    else activity.push({ bucket_start: iso, plays });
  }
  const total = activity.reduce((sum, b) => sum + b.plays, 0);
  const share = (weights: number[]) => weights.map((w) => Math.max(1, Math.round(total * w)));
  const trackPlays = share([0.06, 0.052, 0.045, 0.04, 0.034, 0.03, 0.026, 0.022, 0.019, 0.017, 0.015, 0.013]);
  const artistPlays = share([0.23, 0.21, 0.18, 0.15, 0.13, 0.1]);
  const albumPlays = share([0.22, 0.19, 0.16, 0.13, 0.1]);
  const genrePlays = share([0.23, 0.21, 0.18, 0.15, 0.13, 0.09]);
  return {
    summary: {
      total_plays: total,
      total_ms: total * 262_000,
      unique_tracks: 27,
      unique_artists: 7,
      headline_artist: { id: "ar-velvet", name: "The Velvet Meridian", plays: artistPlays[0] },
    },
    top_tracks: total > 0 ? top.map((id, i) => ({ ...topTrack(id), plays: trackPlays[i] })) : [],
    top_artists: total > 0
      ? [
          { id: "ar-velvet", name: "The Velvet Meridian", has_page: true },
          { id: "ar-marisol", name: "Marisol Vey", has_page: false },
          { id: "ar-okoro", name: "Hana Okoro", has_page: true },
          { id: "ar-halden", name: "Halden Marsh", has_page: true },
          { id: "ar-lucien", name: "Saint Lucien & The Harbour Lights", has_page: true },
          { id: "ar-kestrel", name: "Kestrel Bay", has_page: true },
        ].map((a, i) => ({ ...a, plays: artistPlays[i] }))
      : [],
    top_albums: total > 0
      ? albums.slice(0, 5).map((a, i) => ({ id: a.id, title: a.title, artist: a.artist_name, source: "local", plays: albumPlays[i] }))
      : [],
    top_genres: total > 0
      ? ["Dream Pop", "Neo-Soul", "Indie Folk", "Chamber Pop", "Electronic", "Jazz"].map((genre, i) => ({ genre, plays: genrePlays[i] }))
      : [],
    activity,
    bucket,
    available_years: [2025, 2026],
  };
}

export function publicShare(origin: string, trackId: string, startSec: number): PublicTrackShare | null {
  const track = tracks.find((t) => t.id === trackId);
  if (!track) return null;
  const signed = `t=${startSec}&d=30&exp=1792540800&sig=4b1d9e`;
  return {
    track_id: track.id,
    title: track.title,
    artist: track.artist,
    album: track.album_title,
    album_id: track.album_id,
    start_sec: startSec,
    duration_ms: track.duration_ms,
    preview_duration_sec: 30,
    preview_url: `${origin}/api/public/previews/${track.id}.mp4?${signed}`,
    audio_url: `${origin}/api/public/preview-audio/${track.id}.m4a?${signed}`,
    story_url: `${origin}/api/public/stories/${track.id}.mp4?${signed}`,
    story_background_url: `${origin}/api/public/story-backgrounds/${track.id}.mp4?${signed}`,
    embed_url: `${origin}/embed/track/${track.id}?t=${startSec}&d=30&sig=4b1d9e`,
    cover_url: `${origin}/api/public/covers/album/${track.album_id}?exp=1792540800&sig=4b1d9e`,
    accent_color: "#3b5b7a",
    canonical_url: `${origin}/share/track/${track.id}?t=${startSec}&d=30&sig=4b1d9e`,
    open_url: `${origin}/library?album=${track.album_id}`,
  };
}
