import type { TrackListItem } from "../api";
import type { PlayerState, RepeatMode } from "./player-core";

// Must match playbackSocketReadLimit in backend/internal/httpapi/handlers/activity.go.
export const PLAYBACK_SOCKET_MAX_BYTES = 64 * 1024;

/** UTF-8 wire size, without relying on TextEncoder being available on native. */
export function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (const character of text) {
    const code = character.codePointAt(0)!;
    bytes += code <= 0x7f ? 1 : code <= 0x7ff ? 2 : code <= 0xffff ? 3 : 4;
  }
  return bytes;
}

/** A bounded view of the target's actual play order. Indices in commands are absolute. */
export interface PlaybackQueueSnapshot {
  revision: string;
  tracks: TrackListItem[];
  index: number;
  offset: number;
  total: number;
  shuffle: boolean;
  repeat: RepeatMode;
}

/**
 * Keep a contiguous window containing the current queue entry. The publisher
 * supplies the bytes left after serializing the activity message envelope.
 * Null means even the minimal current entry cannot fit; never send a snapshot
 * that silently excludes the playing track.
 */
export function buildPlaybackQueueSnapshot(
  state: PlayerState,
  revision: string,
  maxBytes = 60 * 1024,
): PlaybackQueueSnapshot | null {
  const offset = Math.max(0, Math.min(state.index - 24, state.queue.length - 50));
  const snapshot: PlaybackQueueSnapshot = {
    revision,
    tracks: state.queue.slice(offset, offset + 50).map(compactRemoteTrack),
    index: state.queue.length ? state.index - offset : 0,
    offset,
    total: state.queue.length,
    shuffle: state.shuffle,
    repeat: state.repeat,
  };
  const sizes = snapshot.tracks.map((track) => utf8ByteLength(JSON.stringify(track)));
  let trackBytes = sizes.reduce((sum, size) => sum + size, 0);
  const fits = () => {
    const envelopeBytes = utf8ByteLength(JSON.stringify({ ...snapshot, tracks: [] }));
    return envelopeBytes + trackBytes + Math.max(0, snapshot.tracks.length - 1) <= maxBytes;
  };
  while (!fits() && snapshot.tracks.length > 1) {
    // Remove the farther edge so the current entry remains in the window.
    if (snapshot.index > snapshot.tracks.length - snapshot.index - 1) {
      trackBytes -= sizes.shift()!;
      snapshot.tracks.shift();
      snapshot.index--;
      snapshot.offset++;
    } else {
      trackBytes -= sizes.pop()!;
      snapshot.tracks.pop();
    }
  }
  if (!fits() && snapshot.tracks.length === 1) {
    // Optional metadata on one track can itself exceed the entire budget.
    const { id, title, duration_ms } = snapshot.tracks[0];
    snapshot.tracks = [{ id, title, duration_ms }];
    trackBytes = utf8ByteLength(JSON.stringify(snapshot.tracks[0]));
  }
  return fits() ? snapshot : null;
}

/**
 * Strip a track to the fields the receiving device needs. Track rows can carry
 * large incidental payloads, and a 50-track queue multiplies whatever is left
 * on them by fifty.
 */
export function compactRemoteTrack(track: TrackListItem): TrackListItem {
  return {
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
    artist: track.artist,
    aka: track.aka,
    favorited: track.favorited,
    has_cover: track.has_cover,
    cover_url: track.cover_url,
    owned: track.owned,
  };
}

