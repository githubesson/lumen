import type { TrackDetail, TrackListItem } from '@music-library/core';

/**
 * Filename helpers for "Download File…", mirroring the iOS client
 * (`mobile/lib/track-download.ts`) so both apps save identically-named files.
 */

export function extensionForFormat(format?: string): string | undefined {
  const normalized = format
    ?.toLowerCase()
    .replace(/^\.+/, '')
    .replace(/[_-]+/g, ' ')
    .trim();
  if (!normalized) return undefined;
  if (['mp3', 'id3', 'id3v1', 'id3v2', 'mpeg', 'mpeg audio'].includes(normalized)) {
    return 'mp3';
  }
  if (normalized.includes('flac')) return 'flac';
  if (['m4a', 'mp4', 'mp4a', 'aac', 'alac'].includes(normalized)) return 'm4a';
  if (normalized.includes('ogg')) return 'ogg';
  if (normalized.includes('opus')) return 'opus';
  if (normalized.includes('wav') || normalized.includes('wave')) return 'wav';
  if (normalized.includes('webm')) return 'webm';
  if (normalized.includes('quicktime') || normalized === 'mov') return 'mov';
  return undefined;
}

export function downloadFilename(
  track: TrackListItem,
  detail: TrackDetail | null,
  ext?: string,
): string {
  const artists = detail?.artists?.map(artist => artist.name).filter(Boolean);
  const artist = artists?.length ? artists.join(', ') : track.artist;
  const base = [artist, detail?.title || track.title].filter(Boolean).join(' - ');
  const name = sanitizeFilename(base || 'track');
  return ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name;
}

function sanitizeFilename(name: string): string {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
    .replace(/\s+/g, ' ')
    .replace(/[. ]+$/g, '')
    .slice(0, 180);
}
