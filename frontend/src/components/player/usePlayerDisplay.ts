import { useLocation } from "react-router-dom";
import { usePlayer, useRemotePlayback } from "../../context/Player";
import { displayText } from "../../lib/format";
import {
  fh6Transport as sendFH6Transport,
  useFH6Snapshot,
} from "../../lib/fh6";
import type { ProgressOverride } from "./ProgressBar";

/**
 * Resolves what the player bar shows: the local player, a remote device being
 * controlled, or Lumen Radio (FH6) while on its page.
 */
export function usePlayerDisplay() {
  const location = useLocation();
  // The provider's displayed state already follows a remote target (its
  // track, play state and controlled volume/shuffle/repeat), so the bar
  // agrees with the queue and lyrics views.
  const { current, isPlaying, volume, muted, shuffle, repeat, seek } =
    usePlayer();
  const { targetDevice, commandPending } = useRemotePlayback();
  const fh6Snapshot = useFH6Snapshot();
  const isFH6Page = location.pathname.startsWith("/fh6-radio");
  const isRemoteMode = !!targetDevice;
  const isFH6Mode = isFH6Page && !isRemoteMode;
  const fh6Source = fh6Snapshot?.state?.sources?.available?.find(
    (s) => s.name === "lumen",
  );
  const fh6Track = fh6Snapshot?.state?.track;
  const fh6HasTrack = !!fh6Track?.title;
  const fh6Playing = fh6Source?.playback_state === "playing";
  const displayCurrent = isFH6Mode ? null : current;
  const displayHasTrack = isFH6Mode ? fh6HasTrack : !!current;
  const displayPlaying = isFH6Mode ? fh6Playing : isPlaying;
  const displayTitle = isFH6Mode
    ? displayText(fh6Track?.title, "Waiting for FH6")
    : displayText(
        current?.title,
        targetDevice ? `Nothing playing on ${targetDevice.deviceName}` : "Nothing playing",
      );
  const displayArtist = isFH6Mode
    ? [fh6Track?.artist, fh6Track?.album].filter(Boolean).join(" · ") ||
      "Lumen Radio"
    : current
      ? `${displayText(current.artist, "—")}${
          current.album_title ? ` · ${displayText(current.album_title)}` : ""
        }`
      : (targetDevice?.deviceName ?? "—");

  // Previous, play/pause and next need something to act on in the active
  // mode. A pending remote command doesn't disable them: the target applies
  // commands in order, so a quick second "next" should skip again, and
  // disabling would drop keyboard focus mid-use.
  const transportDisabled = isFH6Mode ? !fh6Snapshot?.state : !current;

  const progressOverride: ProgressOverride | undefined =
    isRemoteMode && current
      ? // The player clock already follows the target device.
        { onSeek: seek }
      : isFH6Mode
      ? {
          currentTime: (fh6Track?.position_ms ?? 0) / 1000,
          duration: (fh6Track?.duration_ms ?? 0) / 1000,
          // The bridge is polled every 2.5 s; advance between polls.
          sampledAt: fh6Playing ? fh6Snapshot?.receivedAt : undefined,
          onSeek: (seconds) =>
            void fh6Transport("seek", {
              position_ms: Math.round(seconds * 1000),
            }),
        }
      : undefined;

  return {
    commandPending,
    isRemoteMode,
    isFH6Mode,
    fh6Snapshot,
    displayCurrent,
    displayHasTrack,
    displayPlaying,
    displayTitle,
    displayArtist,
    shownVolume: volume,
    shownMuted: muted,
    shownShuffle: shuffle,
    shownRepeat: repeat,
    transportDisabled,
    progressOverride,
    fh6Transport,
  };

  function fh6Transport(action: string, body?: unknown) {
    return sendFH6Transport(fh6Snapshot?.bridgeUrl, action, body);
  }
}
