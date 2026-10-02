import { useCallback, useState } from "react";
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
 */
export function useAlbumDownloadAction(
  tidalAlbumId: string | undefined,
  tracks: TrackListItem[],
  queuedCount: number,
  onChanged: () => void,
): { label: string; onPress: () => void; disabled?: boolean } | undefined {
  const { me } = useAuth();
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, failure: string) => {
      setBusy(true);
      try {
        await action();
        onChanged();
      } catch (err) {
        Alert.alert(failure, errorMessage(err, "Please try again."));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
  );

  if (me?.role !== "admin" || !tidalAlbumId) return undefined;
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
              void run(() => api.cancelTidalAlbumDownload(tidalAlbumId), "Couldn't cancel the download"),
          },
        ]),
    };
  }
  if (state.kind === "none") return undefined;
  return {
    label: state.label,
    disabled: busy,
    onPress: () =>
      void run(() => api.downloadTidalAlbum(tidalAlbumId), "Couldn't start the album download"),
  };
}
