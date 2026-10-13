// The player's public surface, re-exported whole by the root barrel. Hooks
// and helpers that only the player modules use among themselves are imported
// from their modules (or the `./player/*` subpaths), not listed here.

export {
  canStartTrack,
  extrapolatePosition,
  fisherYatesWithAnchor,
  repeatModeLabel,
  type PlayerControls,
  type PlayerState,
  type PlayOptions,
  type RepeatMode,
  type TimeState,
} from "./player-core";
export {
  createAudioAdapterEmitter,
  type AudioAdapter,
  type AudioAdapterEvent,
} from "./audio-adapter";
export { usePlayerCore } from "./use-player-core";
export {
  activityTrack,
  playbackDeviceButtonLabel,
  playbackDeviceKind,
  playbackDeviceStatus,
  remoteActivityTime,
  remoteCommandError,
  type PlaybackDeviceKind,
} from "./remote-control";
export {
  getLatestPlaybackActivity,
  subscribePlaybackActivity,
  usePlaybackActivityPublisher,
  type PlaybackDevice,
} from "./activity-sync";
export {
  useRemotePlaybackController,
  type RemotePlaybackContextValue,
} from "./use-remote-playback-controller";
export {
  buildNowPlayingMetadata,
  shouldExposeNowPlayingSession,
  type NowPlayingMetadata,
} from "./now-playing";
export {
  listPlaybackState,
  startListPlayback,
  startShuffledListPlayback,
  usePlayFromList,
} from "./play-list";
export { queueProgress, type QueueProgress } from "./queue-progress";
export { useRemoteControlIndicator } from "./remote-control-indicator";
