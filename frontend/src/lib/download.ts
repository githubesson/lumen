// Download + audio-format utilities, extracted from TrackContextMenu so they
// live as pure helpers (and so UploadDialog can share the audio allowlist).
import { api, downloadStreamUrl, type TrackDetail, type TrackListItem } from "../api";
import {
  exportTrackFiles,
  canExportTrackFiles,
} from "./platform";

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
  a.href = downloadStreamUrl(track.id);
  a.download = downloadFilename(track, detail, ext);
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export interface BatchExportResult {
  canceled: boolean;
  exported: number;
  failed: number;
  skipped: number;
  folder?: string;
  errors: string[];
  usedFolderPicker: boolean;
}

export async function exportTracksAsFiles(
  tracks: TrackListItem[],
): Promise<BatchExportResult> {
  // The backend /stream endpoint now serves a full, contiguous file for
  // every supported source (local files on disk, and TIDAL tracks via HLS
  // segment assembly), so all tracks are exportable.
  const exportable = tracks;
  const skipped = tracks.length - exportable.length;
  if (exportable.length === 0) {
    return {
      canceled: false,
      exported: 0,
      failed: 0,
      skipped,
      errors: [],
      usedFolderPicker: false,
    };
  }

  const prepared: Array<{
    track: TrackListItem;
    detail: TrackDetail | null;
    ext?: string;
  }> = [];
  let failed = 0;
  const errors: string[] = [];
  for (const track of exportable) {
    try {
      let detail: TrackDetail | null = null;
      try {
        detail = await api.getTrack(track.id);
      } catch {
        // Stream URL is enough; detail only improves the filename.
      }
      const ext =
        extensionForFormat(detail?.format) ?? (await extensionFromStream(track.id));
      prepared.push({ track, detail, ext });
    } catch (e) {
      failed += 1;
      if (errors.length < 5) {
        errors.push(`${track.title}: ${(e as Error).message}`);
      }
    }
  }

  if (canExportTrackFiles) {
    const res = await exportTrackFiles(
      prepared.map(({ track, detail, ext }) => ({
        url: downloadStreamUrl(track.id),
        filename: downloadFilename(track, detail, ext),
      })),
    );
    if (res?.canceled) {
      return {
        canceled: true,
        exported: 0,
        failed,
        skipped,
        folder: res.folder,
        errors,
        usedFolderPicker: true,
      };
    }
    if (!res) {
      return {
        canceled: false,
        exported: 0,
        failed: failed + prepared.length,
        skipped,
        errors: [...errors, "Desktop export is unavailable."],
        usedFolderPicker: true,
      };
    }
    return {
      canceled: false,
      exported: res.saved ?? 0,
      failed: failed + (res.failed ?? 0),
      skipped,
      folder: res.folder,
      errors: [...errors, ...(res.errors ?? []), ...(res.error ? [res.error] : [])],
      usedFolderPicker: true,
    };
  }

  for (const { track, detail, ext } of prepared) {
    triggerDownload(track, detail, ext);
    await sleep(150);
  }
  return {
    canceled: false,
    exported: prepared.length,
    failed,
    skipped,
    errors,
    usedFolderPicker: false,
  };
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
