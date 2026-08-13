/**
 * Whether the phone should keep a now-playing session (lock screen,
 * Control Center, Dynamic Island, CarPlay).
 *
 * Pause is not a reason to drop the session. Music players leave the current
 * track published with playbackRate 0 so the OS can resume it. The session
 * goes away only when nothing is loaded locally, or another device owns
 * playback.
 */
export function shouldExposeNowPlayingSession(opts: {
  hasTrack: boolean;
  isCasting: boolean;
}): boolean {
  return opts.hasTrack && !opts.isCasting;
}
