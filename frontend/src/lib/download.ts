// Download + audio-format utilities, extracted from TrackContextMenu so they
// live as pure helpers (and so UploadDialog can share the audio allowlist).
import { streamUrl, type TrackDetail, type TrackListItem } from "../api";

/** Canonical audio file extensions the app accepts/recognizes. */
export const AUDIO_EXTENSIONS = [
  "mp3", "flac", "m4a", "mp4", "aac", "alac", "ogg", "oga", "opus", "wav",
  "aiff", "aif", "wma", "webm",
] as const;

/** True if a filename looks like an audio file we accept. */
export function isAudioFile(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return (AUDIO_EXTENSIONS as readonly string[]).includes(ext);
}

export function triggerDownload(
  track: TrackListItem,
  detail: TrackDetail | null,
  ext?: string,
) {
  const a = document.createElement("a");
  a.href = streamUrl(track.id);
  a.download = downloadFilename(track, detail, ext);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function downloadFilename(
  track: TrackListItem,
  detail: TrackDetail | null,
  ext?: string,
) {
  const artists = detail?.artists?.map((artist) => artist.name).filter(Boolean);
  const artist = artists?.length ? artists.join(", ") : track.artist;
  const base = [artist, detail?.title || track.title].filter(Boolean).join(" - ");
  const name = sanitizeFilename(base || "track");
  return ext && !name.toLowerCase().endsWith(`.${ext}`) ? `${name}.${ext}` : name;
}

export function sanitizeFilename(name: string) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
}

export async function extensionFromStream(trackId: string) {
  const url = streamUrl(trackId);
  try {
    const res = await fetch(url, {
      method: "HEAD",
      credentials: "include",
    });
    if (res.ok) {
      return extensionForContentType(res.headers.get("content-type") ?? undefined);
    }
  } catch {
    // Some servers register GET without HEAD; fall through to a tiny range probe.
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

export function extensionForFormat(format?: string) {
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

export function extensionForContentType(contentType?: string) {
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
