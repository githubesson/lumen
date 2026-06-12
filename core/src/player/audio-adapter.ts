/**
 * Platform-agnostic audio playback surface consumed by `usePlayerCore`.
 * The web implementation wraps an HTMLAudioElement; the mobile implementation
 * wraps `expo-audio`'s `useAudioPlayer`. As long as events fire and the state
 * queries return sensible numbers, the shared hook behaves identically.
 *
 * Event semantics (matched to the web audio element's native events):
 *   - `loadedmetadata`: duration is now available.
 *   - `timeupdate`:     periodic (platform-defined cadence) position ping.
 *   - `play`:           started (or resumed after a stall).
 *   - `pause`:          paused (programmatically or by the user).
 *   - `seeked`:         seek completed and position settled.
 *   - `ended`:          reached end of source.
 *
 * Every call to `on` must return an unsubscribe function.
 */
export type AudioAdapterEvent =
  | "loadedmetadata"
  | "timeupdate"
  | "play"
  | "pause"
  | "seeked"
  | "ended";

export interface AudioAdapter {
  /** Replace the current source; does not auto-play. */
  load(url: string): void;
  /**
   * Begin playback (or resume). Must be idempotent when already playing.
   * Resolves on success; rejects if the platform refused (e.g. web autoplay
   * block) so the hook can flip `isPlaying` back to false.
   */
  play(): Promise<void>;
  /** Pause playback. Must be idempotent when already paused. */
  pause(): void;
  /** Seek to position in seconds. Must clamp or ignore out-of-range values gracefully. */
  seek(seconds: number): void;
  /** Set volume in [0, 1]. */
  setVolume(v: number): void;
  /** Set muted flag independently of volume. */
  setMuted(m: boolean): void;
  /** Current playhead position in seconds. */
  currentTime(): number;
  /** Total duration in seconds, or NaN/0 if unknown. */
  duration(): number;
  /** Subscribe to an event. Returns an unsubscribe function. */
  on(event: AudioAdapterEvent, handler: () => void): () => void;
  /** Release any resources held by this adapter. */
  dispose(): void;
}
