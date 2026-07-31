// Browser-side download plumbing. The filename and audio-format helpers this
// used to define now live in `core/src/audio-format.ts` — they were identical
// to `mobile/lib/track-download.ts` character-for-character — and are
// re-exported here because ~20 call sites import them from this module.
import { api, downloadStreamUrl, type TrackDetail, type TrackListItem } from "../api";
import {
  downloadFilename,
  extensionForFormat,
  extensionFromStream,
} from "@music-library/core/audio-format";
import {
  exportTrackFiles,
  canExportTrackFiles,
} from "./platform";

export {
  downloadFilename,
  extensionForContentType,
  extensionForFormat,
  extensionFromStream,
  sanitizeFilename,
} from "@music-library/core/audio-format";

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

  if (canExportTrackFiles()) {
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

function sleep(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}
