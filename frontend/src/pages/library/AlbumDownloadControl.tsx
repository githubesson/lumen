import { useEffect, useState } from "react";
import { Download as DownloadIcon, X as XIcon } from "lucide-react";
import { api, errorMessage, type TrackListItem } from "../../api";
import { Button } from "../../components/Button";
import { downloadableAlbumTracks } from "../../lib/track";

// While tracks are queued, refresh so rows flip to their library copies.
const QUEUED_REFRESH_MS = 15_000;

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

  useEffect(() => {
    if (queuedCount === 0) return;
    const timer = window.setInterval(onChanged, QUEUED_REFRESH_MS);
    return () => window.clearInterval(timer);
  }, [queuedCount, onChanged]);

  const remaining = downloadableAlbumTracks(tracks).length;
  const anySaved = tracks.some((t) => t.source !== "tidal");

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

  if (queuedCount > 0) {
    return (
      <>
        <Button disabled leadingIcon={<DownloadIcon className="size-4" />}>
          Downloading · {queuedCount} left
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
  if (remaining === 0) return null;
  return (
    <Button
      disabled={busy}
      onClick={() =>
        void run(() => api.downloadTidalAlbum(tidalAlbumId), "Could not start the album download.")
      }
      title="Save these TIDAL tracks into the server library"
      leadingIcon={<DownloadIcon className="size-4" />}
    >
      {anySaved ? `Download ${remaining} remaining` : "Download album"}
    </Button>
  );
}
