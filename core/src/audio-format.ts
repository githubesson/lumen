/**
 * Audio container/extension detection and download filenames.
 *
 * These previously existed as two copies — `frontend/src/lib/download.ts` and
 * `mobile/lib/track-download.ts` — whose overlapping halves were identical
 * character-for-character. Nothing here touches the DOM or a native module:
 * the only I/O is `fetch`, which both runtimes provide. The platform modules
 * keep the parts that genuinely differ (an `<a download>` click on web, an
 * `expo-file-system` write on mobile) and re-export these.
 */

import { downloadStreamUrl } from "./api";
import type { TrackDetail, TrackListItem } from "./api";

/**
 * Strip characters that are illegal in a filename on Windows, macOS, or iOS,
 * collapse whitespace, and cap the length well under the 255-byte limit that
 * every target filesystem shares.
 */
export function sanitizeFilename(name: string): string {
  return (
    name
      // Control characters are exactly what we want to strip from a filename.
      // eslint-disable-next-line no-control-regex
      .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .slice(0, 180)
  );
}

/**
 * "Artist - Title.ext" for a saved file. `detail` is optional and only
 * improves the result: it carries the full credited-artist list and the
 * canonical title, so a track row alone is enough to produce a usable name.
 */
export function downloadFilename(
  track: TrackListItem,
  detail: TrackDetail | null,
  ext?: string,
): string {
  const artists = detail?.artists?.map((artist) => artist.name).filter(Boolean);
  const artist = artists?.length ? artists.join(", ") : track.artist;
  const base = [artist, detail?.title || track.title].filter(Boolean).join(" - ");
  const name = sanitizeFilename(base || "track");
  return ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name;
}

/**
 * File extension for the `format` string the scanner stores on a track. The
 * values are whatever the tagging library reported, so this normalizes
 * punctuation and accepts the several spellings each container shows up under
 * ("ID3v2" and "MPEG audio" both mean MP3).
 */
export function extensionForFormat(format?: string): string | undefined {
  const normalized = format
    ?.toLowerCase()
    .replace(/^\.+/, "")
    .replace(/[_-]+/g, " ")
    .trim();
  if (!normalized) return undefined;
  if (["mp3", "id3", "id3v1", "id3v2", "mpeg", "mpeg audio"].includes(normalized)) {
    return "mp3";
  }
  if (normalized.includes("flac")) return "flac";
  if (["m4a", "mp4", "mp4a", "aac", "alac"].includes(normalized)) return "m4a";
  if (normalized.includes("ogg")) return "ogg";
  if (normalized.includes("opus")) return "opus";
  if (normalized.includes("wav") || normalized.includes("wave")) return "wav";
  if (normalized.includes("webm")) return "webm";
  if (normalized.includes("quicktime") || normalized === "mov") return "mov";
  return undefined;
}

/** File extension for a response `Content-Type` (parameters stripped). */
export function extensionForContentType(
  contentType?: string,
): string | undefined {
  const type = contentType?.split(";")[0]?.toLowerCase().trim();
  switch (type) {
    case "audio/mpeg":
    case "audio/mp3":
      return "mp3";
    case "audio/flac":
    case "audio/x-flac":
      return "flac";
    case "audio/mp4":
    case "audio/aac":
    case "audio/x-m4a":
      return "m4a";
    case "audio/ogg":
    case "application/ogg":
      return "ogg";
    case "audio/opus":
      return "opus";
    case "audio/wav":
    case "audio/wave":
    case "audio/x-wav":
      return "wav";
    case "audio/webm":
      return "webm";
    case "video/quicktime":
      return "mov";
    default:
      return undefined;
  }
}

/**
 * Ask the server what a track's stream actually is, for tracks whose stored
 * `format` is missing or unrecognized. Tries HEAD first and falls back to a
 * single-byte range request, because some routes register GET without HEAD.
 */
export async function extensionFromStream(
  trackId: string,
): Promise<string | undefined> {
  const url = downloadStreamUrl(trackId);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      credentials: "include",
    });
    if (res.ok) {
      return extensionForContentType(res.headers.get("content-type") ?? undefined);
    }
  } catch {
    // Some servers/routes do not support HEAD; fall through to the range probe.
  }

  try {
    const res = await fetch(url, {
      credentials: "include",
      headers: { Range: "bytes=0-0" },
    });
    if (!res.ok) return undefined;
    return extensionForContentType(res.headers.get("content-type") ?? undefined);
  } catch {
    return undefined;
  }
}
