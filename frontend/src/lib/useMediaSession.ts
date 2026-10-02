import { useEffect, useMemo } from "react";
import {
  buildNowPlayingMetadata,
  shouldExposeNowPlayingSession,
  type PlayerControls,
  type TrackListItem,
} from "@music-library/core";

const ACTIONS = [
  "play",
  "pause",
  "previoustrack",
  "nexttrack",
  "seekto",
] as const satisfies readonly MediaSessionAction[];

/**
 * Media Session API: surfaces local playback in the OS media controls and
 * Bluetooth/keyboard media keys. Takes the *local* player's track and
 * controls; while another device is controlled (`casting`) the session is
 * withdrawn, since these controls drive this device's audio.
 */
export function useMediaSession({
  track,
  playing,
  controls,
  casting,
}: {
  track: TrackListItem | null;
  playing: boolean;
  controls: Pick<PlayerControls, "toggle" | "prev" | "next" | "seek">;
  casting: boolean;
}) {
  const metadata = useMemo(() => buildNowPlayingMetadata(track), [track]);
  const expose = shouldExposeNowPlayingSession({
    hasTrack: metadata !== null,
    isCasting: casting,
  });
  // Destructured so the effect tracks exactly what it reads without depending
  // on the larger controls object.
  const { toggle, prev, next, seek } = controls;

  useEffect(() => {
    if (!("mediaSession" in navigator)) return;
    const session = navigator.mediaSession;
    // Handlers registered for a previous track must not outlive it: an OS or
    // Bluetooth media button pressed after the queue empties would otherwise
    // fire a callback closed over stale `controls`.
    const clear = () => {
      session.metadata = null;
      for (const action of ACTIONS) session.setActionHandler(action, null);
    };
    if (!expose || !metadata) {
      clear();
      // Without a handler the browser falls back to its default "play", which
      // resumes the paused <audio> element: local playback starting next to
      // the remote device's.
      if (casting) session.setActionHandler("play", () => {});
      return clear;
    }
    session.metadata = new MediaMetadata({
      title: metadata.title,
      artist: metadata.artist,
      album: metadata.albumTitle,
      artwork: [{ src: metadata.artworkUrl }],
    });
    // Discrete play/pause (previously both fired the same toggle, so the OS
    // "play" button could pause an already-playing track and vice versa).
    session.setActionHandler("play", () => {
      if (!playing) toggle();
    });
    session.setActionHandler("pause", () => {
      if (playing) toggle();
    });
    session.setActionHandler("previoustrack", prev);
    session.setActionHandler("nexttrack", next);
    session.setActionHandler("seekto", (event) => {
      if (typeof event.seekTime === "number") seek(event.seekTime);
    });
    return clear;
  }, [casting, expose, metadata, next, playing, prev, seek, toggle]);
}
