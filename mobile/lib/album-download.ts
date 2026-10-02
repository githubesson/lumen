import { useCallback, useMemo, useState } from "react";
import { Alert } from "react-native";
import {
  albumDownloadState,
  api,
  errorMessage,
  useAuth,
  type TrackListItem,
} from "@music-library/core";

/**
 * Admin action for an album header that saves a TIDAL release into the
 * library: the whole album when nothing is saved yet, otherwise the missing
 * tracks. While tracks are queued it shows progress; tapping offers to
 * cancel. Returns undefined when there is nothing to offer.
 *
 * `onQueuedChanged` gets the album's queued count once a download starts or
 * is cancelled. The screen writes it into its cached album, which the label
 * and the polling read, and refetches. So the button can't flash back to
 * "Download album" while the refetch is out, nor stay that way if it fails.
 */
export function useAlbumDownloadAction(
  tidalAlbumId: string | undefined,
  tracks: TrackListItem[],
  queuedCount: number,
  onQueuedChanged: (queuedCount: number) => void,
): { label: string; onPress: () => void; disabled?: boolean } | undefined {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<number>, failure: string) => {
      setBusy(true);
      try {
        onQueuedChanged(await action());
      } catch (err) {
        Alert.alert(failure, errorMessage(err, "Please try again."));
      } finally {
        setBusy(false);
      }
    },
    [onQueuedChanged],
  );

  // Memoized because album headers list it as a dependency.
  return useMemo(() => {
    if (!isAdmin || !tidalAlbumId) return undefined;
    const state = albumDownloadState(tracks, queuedCount);
    if (state.kind === "queued") {
      return {
        label: state.label,
        disabled: busy,
        onPress: () =>
          Alert.alert("Cancel album download?", "Tracks already saved stay in the library.", [
            { text: "Keep downloading", style: "cancel" },
            {
              text: "Cancel download",
              style: "destructive",
              onPress: () =>
                void run(async () => {
                  await api.cancelTidalAlbumDownload(tidalAlbumId);
                  return 0;
                }, "Couldn't cancel the download"),
            },
          ]),
      };
    }
    if (state.kind === "none") return undefined;
    return {
      label: state.label,
      disabled: busy,
      onPress: () =>
        void run(
          // `queued` counts newly queued tracks, on top of any already queued.
          async () => queuedCount + (await api.downloadTidalAlbum(tidalAlbumId)).queued,
          "Couldn't start the album download",
        ),
    };
  }, [isAdmin, tidalAlbumId, tracks, queuedCount, busy, run]);
}
