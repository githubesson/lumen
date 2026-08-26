import {
  api,
  displayArtists,
  toQueueItem,
  type Album,
  type Artist,
  type Playlist,
  type TrackListItem,
} from "@music-library/core";

import type {
  SiriMediaItem,
  SiriMediaKind,
  SiriPlayMediaRequest,
} from "../modules/siri-media";

type SiriCatalogApi = Pick<
  typeof api,
  | "getTrack"
  | "listAlbumsPage"
  | "listAlbumTracks"
  | "listArtistsPage"
  | "listArtistTracks"
  | "listPlaylists"
  | "listPlaylistTracks"
  | "listRecent"
  | "searchTracks"
>;

const ENTITY_PREFIX = "lumen";
const MAX_SIRI_RESULTS = 5;

export type LumenSiriEntity = SiriMediaItem & {
  lumenId: string;
  type: Exclude<SiriMediaKind, "music" | "unknown">;
};

export function siriMediaIdentifier(
  type: LumenSiriEntity["type"],
  id: string,
) {
  return `${ENTITY_PREFIX}:${type}:${encodeURIComponent(id)}`;
}

export function decodeSiriMediaIdentifier(
  identifier: string | undefined,
): Pick<LumenSiriEntity, "lumenId" | "type"> | null {
  if (!identifier) return null;
  const match = /^lumen:(album|artist|playlist|song):(.+)$/.exec(identifier);
  if (!match) return null;
  try {
    return {
      type: match[1] as LumenSiriEntity["type"],
      lumenId: decodeURIComponent(match[2]),
    };
  } catch {
    return null;
  }
}

function normalizeName(value: string) {
  return value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** Rank spoken names deterministically while excluding unrelated catalog rows. */
export function rankNamedSiriItems<T>(
  items: T[],
  query: string,
  nameFor: (item: T) => string,
  limit = MAX_SIRI_RESULTS,
): T[] {
  const needle = normalizeName(query);
  if (!needle) return [];
  const needleWords = needle.split(" ");

  return items
    .map((item, index) => {
      const name = normalizeName(nameFor(item));
      let score = Number.POSITIVE_INFINITY;
      if (name === needle) score = 0;
      else if (name.startsWith(needle)) score = 1;
      else if (name.includes(needle)) score = 2;
      else if (needleWords.every((word) => name.split(" ").includes(word))) {
        score = 3;
      }
      return { item, index, score };
    })
    .filter(({ score }) => Number.isFinite(score))
    .sort((a, b) => a.score - b.score || a.index - b.index)
    .slice(0, limit)
    .map(({ item }) => item);
}

function requestName(request: SiriPlayMediaRequest) {
  return (
    request.mediaName ??
    request.mediaContainer?.title ??
    request.mediaItems[0]?.title ??
    ""
  );
}

function entityFromMediaItem(item: SiriMediaItem): LumenSiriEntity | null {
  const decoded = decodeSiriMediaIdentifier(item.identifier);
  if (!decoded) return null;
  return {
    ...item,
    ...decoded,
  };
}

function playlistEntity(playlist: Playlist): LumenSiriEntity {
  return {
    identifier: siriMediaIdentifier("playlist", playlist.id),
    lumenId: playlist.id,
    title: playlist.name,
    type: "playlist",
  };
}

function albumEntity(album: Album): LumenSiriEntity {
  return {
    identifier: siriMediaIdentifier("album", album.id),
    lumenId: album.id,
    title: album.title,
    type: "album",
    artist: album.artist_name,
  };
}

function artistEntity(artist: Artist): LumenSiriEntity {
  return {
    identifier: siriMediaIdentifier("artist", artist.id),
    lumenId: artist.id,
    title: artist.name,
    type: "artist",
  };
}

function songEntity(track: TrackListItem): LumenSiriEntity {
  return {
    identifier: siriMediaIdentifier("song", track.id),
    lumenId: track.id,
    title: track.title,
    type: "song",
    artist: track.artist,
  };
}

/** Resolve Siri's structured media search into stable, app-owned identifiers. */
export async function resolveSiriMediaRequest(
  request: SiriPlayMediaRequest,
  signal?: AbortSignal,
  client: SiriCatalogApi = api,
): Promise<LumenSiriEntity[]> {
  const donatedItems = request.mediaItems
    .map(entityFromMediaItem)
    .filter((item): item is LumenSiriEntity => item !== null);
  if (donatedItems.length) return donatedItems.slice(0, MAX_SIRI_RESULTS);

  const donatedContainer = request.mediaContainer
    ? entityFromMediaItem(request.mediaContainer)
    : null;
  if (donatedContainer) return [donatedContainer];

  const donatedIdentifier = decodeSiriMediaIdentifier(request.mediaIdentifier);
  if (donatedIdentifier) {
    return [
      {
        ...donatedIdentifier,
        identifier: request.mediaIdentifier!,
        title: requestName(request),
      },
    ];
  }

  const name = requestName(request);
  if (!name) return [];

  switch (request.mediaType) {
    case "playlist": {
      const playlists = await client.listPlaylists({ signal });
      return rankNamedSiriItems(playlists, name, (item) => item.name).map(
        playlistEntity,
      );
    }
    case "album": {
      const { items } = await client.listAlbumsPage({
        q: name,
        limit: MAX_SIRI_RESULTS,
        signal,
      });
      return rankNamedSiriItems(items, name, (item) => item.title).map(
        albumEntity,
      );
    }
    case "artist": {
      const { items } = await client.listArtistsPage({
        q: name,
        limit: MAX_SIRI_RESULTS,
        signal,
      });
      return rankNamedSiriItems(items, name, (item) => item.name).map(
        artistEntity,
      );
    }
    default: {
      const query = [name, request.artistName, request.albumName]
        .filter(Boolean)
        .join(" ");
      const result = await client.searchTracks({
        q: query,
        limit: MAX_SIRI_RESULTS,
        sources: ["local", "tidal"],
        signal,
      });
      return result.tracks.slice(0, MAX_SIRI_RESULTS).map(songEntity);
    }
  }
}

/** Load the queue represented by a resolved Siri entity. */
export async function loadSiriMediaQueue(
  entity: LumenSiriEntity,
  signal?: AbortSignal,
  client: SiriCatalogApi = api,
): Promise<TrackListItem[]> {
  switch (entity.type) {
    case "playlist": {
      const response = await client.listPlaylistTracks(entity.lumenId, {
        signal,
      });
      return response.tracks.map(toQueueItem);
    }
    case "album":
      return client.listAlbumTracks(entity.lumenId, { signal });
    case "artist":
      return client.listArtistTracks(entity.lumenId, { signal });
    case "song": {
      const track = await client.getTrack(entity.lumenId, { signal });
      return [
        {
          id: track.id,
          db_track_id: track.db_track_id,
          source: track.source,
          source_id: track.source_id,
          source_album_id: track.source_album_id,
          title: track.title,
          album_id: track.album_id,
          album_title: track.album_title,
          track_no: track.track_no,
          duration_ms: track.duration_ms,
          artist: displayArtists(track),
          has_cover: track.has_cover,
          cover_url: track.cover_url,
          favorited: track.favorited,
        },
      ];
    }
  }
}

/** Queue used for generic requests such as "play music" or "shuffle something". */
export function loadDefaultSiriMediaQueue(
  signal?: AbortSignal,
  client: SiriCatalogApi = api,
): Promise<TrackListItem[]> {
  return client.listRecent(100, { signal });
}

export function trackSiriMediaItem(track: TrackListItem): SiriMediaItem {
  return songEntity(track);
}
