import { useLocation } from "react-router-dom";
import type { TrackListItem } from "@music-library/core";
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
  const { current, isPlaying, volume, muted, shuffle, repeat, seek } =
    usePlayer();
  const {
    targetDevice,
    commandPending,
    controlledVolume,
    controlledMuted,
    controlledShuffle,
    controlledRepeat,
  } = useRemotePlayback();
  const fh6Snapshot = useFH6Snapshot();
  const isFH6Page = location.pathname.startsWith("/fh6-radio");
  const remoteActivity = targetDevice?.activity ?? null;
  const remoteTrack: TrackListItem | null = remoteActivity
    ? {
        id: remoteActivity.track_id,
        title: remoteActivity.title,
        artist: remoteActivity.artist,
        album_id: remoteActivity.album_id,
        album_title: remoteActivity.album,
        cover_url: remoteActivity.cover_url,
        duration_ms: (remoteActivity.duration_sec ?? 0) * 1000,
      }
    : null;
  const isRemoteMode = !!targetDevice;
  const isFH6Mode = isFH6Page && !isRemoteMode;
  const fh6Source = fh6Snapshot?.state?.sources?.available?.find(
    (s) => s.name === "lumen",
  );
  const fh6Track = fh6Snapshot?.state?.track;
  const fh6HasTrack = !!fh6Track?.title;
  const fh6Playing = fh6Source?.playback_state === "playing";
  const displayCurrent = isRemoteMode
    ? remoteTrack
    : isFH6Mode
      ? null
      : current;
  const displayHasTrack = isRemoteMode
    ? !!remoteActivity
    : isFH6Mode
      ? fh6HasTrack
      : !!current;
  const displayPlaying = isRemoteMode
    ? !!remoteActivity?.is_playing
    : isFH6Mode
      ? fh6Playing
      : isPlaying;
  const displayTitle = isRemoteMode
    ? displayText(remoteActivity?.title, `Nothing playing on ${targetDevice.deviceName}`)
    : isFH6Mode
    ? displayText(fh6Track?.title, "Waiting for FH6")
    : displayText(current?.title, "Nothing playing");
  const displayArtist = isRemoteMode
    ? [remoteActivity?.artist, remoteActivity?.album].filter(Boolean).join(" · ") ||
      targetDevice.deviceName
    : isFH6Mode
      ? [fh6Track?.artist, fh6Track?.album].filter(Boolean).join(" · ") ||
        "Lumen Radio"
      : current
        ? `${displayText(current.artist, "—")}${
            current.album_title ? ` · ${displayText(current.album_title)}` : ""
          }`
        : "—";

  const shownVolume = isRemoteMode ? controlledVolume : volume;
  const shownMuted = isRemoteMode ? controlledMuted : muted;
  const shownShuffle = isRemoteMode ? controlledShuffle : shuffle;
  const shownRepeat = isRemoteMode ? controlledRepeat : repeat;

  // Previous, play/pause and next need something to act on in the active mode.
  const transportDisabled =
    commandPending ||
    (isRemoteMode
      ? !remoteActivity
      : isFH6Mode
        ? !fh6Snapshot?.state
        : !current);

  const progressOverride: ProgressOverride | undefined =
    isRemoteMode && remoteActivity
      ? {
          currentTime: remoteActivity.position_sec,
          duration: remoteActivity.duration_sec ?? 0,
          isPlaying: remoteActivity.is_playing,
          updatedAt: remoteActivity.updated_at,
          onSeek: seek,
        }
      : isFH6Mode
      ? {
          currentTime: (fh6Track?.position_ms ?? 0) / 1000,
          duration: (fh6Track?.duration_ms ?? 0) / 1000,
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
    shownVolume,
    shownMuted,
    shownShuffle,
    shownRepeat,
    transportDisabled,
    progressOverride,
    fh6Transport,
  };

  function fh6Transport(action: string, body?: unknown) {
    return sendFH6Transport(fh6Snapshot?.bridgeUrl, action, body);
  }
}
