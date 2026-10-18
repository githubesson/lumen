import { usePlayer, useRemotePlayback } from "../../context/Player";
import { displayText } from "../../lib/format";

/**
 * Resolves what the player bar shows: the local player, or a remote device
 * being controlled.
 */
export function usePlayerDisplay() {
  // The provider's displayed state already follows a remote target (its
  // track, play state and controlled volume/shuffle/repeat), so the bar
  // agrees with the queue and lyrics views.
  const { current, isPlaying, volume, muted, shuffle, repeat, playbackError } =
    usePlayer();
  const { targetDevice, commandPending } = useRemotePlayback();
  const isRemoteMode = !!targetDevice;
  const displayTitle = displayText(
    current?.title,
    targetDevice ? `Nothing playing on ${targetDevice.deviceName}` : "Nothing playing",
  );
  const displayArtist = current
    ? `${displayText(current.artist, "—")}${
        current.album_title ? ` · ${displayText(current.album_title)}` : ""
      }`
    : (targetDevice?.deviceName ?? "—");
  // Why the current track stopped, shown in place of its artist.
  const displayError =
    current && playbackError?.trackId === current.id
      ? playbackError.message
      : null;

  // Previous, play/pause and next need a track to act on. A pending remote
  // command doesn't disable them: the target applies commands in order, so a
  // quick second "next" should skip again, and disabling would drop keyboard
  // focus mid-use.
  const transportDisabled = !current;

  return {
    commandPending,
    isRemoteMode,
    displayCurrent: current,
    displayHasTrack: !!current,
    displayPlaying: isPlaying,
    displayTitle,
    displayArtist,
    displayError,
    shownVolume: volume,
    shownMuted: muted,
    shownShuffle: shuffle,
    shownRepeat: repeat,
    transportDisabled,
  };
}
