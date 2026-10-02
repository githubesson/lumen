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
 * `onChanged` refetches the album; the action stays busy until it settles,
 * since the label comes from that data and would otherwise flash back to
 * "Download album" (tappable again) between the request and the refetch.
 */
export function useAlbumDownloadAction(
  tidalAlbumId: string | undefined,
  tracks: TrackListItem[],
  queuedCount: number,
  onChanged: () => Promise<unknown>,
): { label: string; onPress: () => void; disabled?: boolean } | undefined {
  const { me } = useAuth();
  const isAdmin = me?.role === "admin";
  const [busy, setBusy] = useState(false);

  const run = useCallback(
    async (action: () => Promise<unknown>, failure: string) => {
      setBusy(true);
      try {
        await action();
        await onChanged();
      } catch (err) {
        Alert.alert(failure, errorMessage(err, "Please try again."));
      } finally {
        setBusy(false);
      }
    },
    [onChanged],
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
  }, [isAdmin, tidalAlbumId, tracks, queuedCount, busy, run]);
}
