import { File } from "expo-file-system";

// The filename and audio-format helpers this module used to define now live in
// `core/src/audio-format.ts` — they were identical to
// `frontend/src/lib/download.ts` character-for-character. They are re-exported
// here because the download store and the "save to Files" export import them
// from this module. What stays is the byte-level validation, which only the
// mobile client does: it persists streams to disk, so it must never write an
// error page out as a .mp3.
export {
  downloadFilename,
  extensionForContentType,
  extensionForFormat,
  extensionFromStream,
} from "@music-library/core/audio-format";

/**
 * Fetch a track stream and return its validated bytes plus the server's
 * content type. Throws on a non-2xx response, a non-audio content type, or
 * bytes that do not look like a media file — so callers never persist an
 * error page as audio. Shared by the "save to Files" export and offline
 * downloads so both apply identical validation in a single request.
 */
export async function fetchStreamBytes(
  url: string,
): Promise<{ bytes: Uint8Array; contentType?: string }> {
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

  return { bytes, contentType };
}

export async function downloadStreamToFile(url: string, destination: File) {
  const { bytes } = await fetchStreamBytes(url);
  destination.create({ intermediates: true, overwrite: true });
  destination.write(bytes);
  return destination;
}

export function isRejectedStreamContentType(contentType?: string) {
  const type = contentType?.split(";")[0]?.toLowerCase().trim();
  return (
    !!type &&
    (type.startsWith("text/") ||
      type === "application/json" ||
      type === "application/problem+json" ||
      type === "application/xml")
  );
}

export function looksLikeMediaBytes(bytes: Uint8Array, contentType?: string) {
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

/** Sniff the audio container from magic bytes (the first 16 are enough).
 *  Mirrors {@link hasKnownMediaSignature}; used when the transport gives no
 *  usable content type (e.g. background downloads finalized after restart). */
export function extensionForMediaBytes(
  bytes: Uint8Array,
): "mp3" | "flac" | "ogg" | "wav" | "m4a" | undefined {
  const ascii = (offset: number, length: number) =>
    String.fromCharCode(...bytes.slice(offset, offset + length));

  if (ascii(0, 3) === "ID3") return "mp3";
  if (bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0) {
    return "mp3";
  }
  if (ascii(0, 4) === "fLaC") return "flac";
  if (ascii(0, 4) === "OggS") return "ogg";
  if (ascii(0, 4) === "RIFF") return "wav";
  if (ascii(4, 4) === "ftyp") return "m4a";
  return undefined;
}
