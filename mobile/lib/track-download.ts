import { File } from "expo-file-system";
import {
  streamUrl,
  type TrackDetail,
  type TrackListItem,
} from "@music-library/core";

export async function downloadStreamToFile(url: string, destination: File) {
  const response = await fetch(url, { credentials: "include" });
  if (!response.ok) {
    const message = await response.text().catch(() => "");
    throw new Error(message.trim() || response.statusText);
  }

  const contentType = response.headers.get("content-type") ?? undefined;
  if (isRejectedStreamContentType(contentType)) {
    const message = await response.text().catch(() => "");
    throw new Error(
      message.trim() ||
        `Expected an audio stream, got ${contentType ?? "unknown content"}.`,
    );
  }

  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!looksLikeMediaBytes(bytes, contentType)) {
    throw new Error("Downloaded stream was not a valid audio file.");
  }

  destination.create({ intermediates: true, overwrite: true });
  destination.write(bytes);
  return destination;
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
    // Some servers/routes do not support HEAD; fall through to a tiny range probe.
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

function sanitizeFilename(name: string) {
  return name
    .replace(/[<>:"/\\|?*\u0000-\u001F]/g, "_")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .slice(0, 180);
}

function isRejectedStreamContentType(contentType?: string) {
  const type = contentType?.split(";")[0]?.toLowerCase().trim();
  return (
    !!type &&
    (type.startsWith("text/") ||
      type === "application/json" ||
      type === "application/problem+json" ||
      type === "application/xml")
  );
}

function looksLikeMediaBytes(bytes: Uint8Array, contentType?: string) {
  if (bytes.length < 4) return false;
  const type = contentType?.split(";")[0]?.toLowerCase().trim();
  if (type?.startsWith("audio/") || type?.startsWith("video/")) return true;
  if (type === "application/octet-stream" || !type) {
    return hasKnownMediaSignature(bytes);
  }
  return true;
}

function hasKnownMediaSignature(bytes: Uint8Array) {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));

  return (
    ascii(0, 3) === "ID3" ||
    ascii(0, 4) === "fLaC" ||
    ascii(0, 4) === "OggS" ||
    ascii(0, 4) === "RIFF" ||
    ascii(4, 4) === "ftyp" ||
    (bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0)
  );
}
