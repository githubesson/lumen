import { useEffect, useState } from "react";
import { Download as DownloadIcon, X as XIcon } from "lucide-react";
import { api, errorMessage, type TrackListItem } from "../../api";
import { Button } from "../../components/Button";
import { ALBUM_DOWNLOAD_REFRESH_MS, albumDownloadState } from "@music-library/core/track";

/**
 * Admin control that saves a TIDAL release into the library: the whole album
 * when nothing is saved yet, otherwise the tracks still missing. While tracks
 * are queued it shows progress and a cancel button.
 */
export function AlbumDownloadControl({
  tidalAlbumId,
  tracks,
  queuedCount,
  onChanged,
  onError,
}: {
  tidalAlbumId: string;
  tracks: TrackListItem[];
  queuedCount: number;
  onChanged: () => void;
  onError: (message: string) => void;
}) {
  const [busy, setBusy] = useState(false);

  // While tracks are queued, refresh so rows flip to their library copies.
  useEffect(() => {
    if (queuedCount === 0) return;
    const timer = window.setInterval(onChanged, ALBUM_DOWNLOAD_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [queuedCount, onChanged]);

  const state = albumDownloadState(tracks, queuedCount);

  const run = async (action: () => Promise<unknown>, failure: string) => {
    setBusy(true);
    try {
      await action();
      onChanged();
    } catch (err) {
      onError(errorMessage(err, failure));
    } finally {
      setBusy(false);
    }
  };

  if (state.kind === "queued") {
    return (
      <>
        <Button disabled leadingIcon={<DownloadIcon className="size-4" />}>
          {state.label}
        </Button>
        <Button
          variant="ghost"
          disabled={busy}
          onClick={() =>
            void run(() => api.cancelTidalAlbumDownload(tidalAlbumId), "Could not cancel the download.")
          }
          leadingIcon={<XIcon className="size-4" />}
        >
          Cancel
        </Button>
      </>
    );
  }
  if (state.kind === "none") return null;
  return (
    <Button
      disabled={busy}
      onClick={() =>
        void run(() => api.downloadTidalAlbum(tidalAlbumId), "Could not start the album download.")
      }
      title="Save these TIDAL tracks into the server library"
      leadingIcon={<DownloadIcon className="size-4" />}
    >
      {state.label}
    </Button>
  );
}
