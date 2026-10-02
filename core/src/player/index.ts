export * from "./player-core";
export {
  createAudioAdapterEmitter,
  type AudioAdapter,
  type AudioAdapterEmitter,
  type AudioAdapterEvent,
} from "./audio-adapter";
export {
  usePlayerCore,
  type UsePlayerCoreOptions,
  type UsePlayerCoreReturn,
} from "./use-player-core";
export {
  activityTrack,
  buildRemoteQueue,
  compactRemoteTrack,
  controlledStateForDevice,
  filterRemoteDevices,
  optimisticControlledState,
  remoteActivityTime,
  remotePlayerState,
  useRemoteActivityClock,
  useRemotePlaybackCommands,
  useRemotePlaybackTarget,
  playbackDeviceButtonLabel,
  playbackDeviceKind,
  playbackDeviceStatus,
  remoteCommandError,
  type ControlledPlaybackState,
  type PlaybackDeviceKind,
  type UseRemotePlaybackCommandsOptions,
  type UseRemotePlaybackCommandsReturn,
} from "./remote-control";
export {
  ACTIVITY_DEVICE_ID_STORAGE_KEY,
  getLatestPlaybackActivity,
  getOrCreateActivityDeviceId,
  sendRemotePlaybackCommand,
  subscribeRemotePlaybackControl,
  subscribePlaybackRemoteSession,
  subscribePlaybackActivity,
  usePlaybackActivityPublisher,
  usePlaybackRemoteSession,
  type PlaybackDevice,
  type PlaybackActivityPublisherOptions,
  type PlaybackCapability,
  type PlaybackRemoteSessionSnapshot,
  type RemotePlaybackCommandAction,
  type RemotePlaybackCommandResult,
  type RemotePlaybackCommandStatus,
  type RemotePlaybackControlEvent,
} from "./activity-sync";

export {
  REMOTE_VOLUME_INTERVAL_MS,
  useRoutedPlayerControls,
  type RoutedPlayerControlsOptions,
} from "./use-routed-player-controls";
export {
  useRemotePlaybackController,
  type RemotePlaybackContextValue,
  type UseRemotePlaybackControllerOptions,
  type UseRemotePlaybackControllerReturn,
} from "./use-remote-playback-controller";
export {
  buildNowPlayingMetadata,
  shouldExposeNowPlayingSession,
  type NowPlayingMetadata,
} from "./now-playing";
export {
  listPlaybackState,
  startListPlayback,
  usePlayFromList,
  type ListPlaybackState,
  type PlayFromList,
} from "./play-list";
export { queueProgress, type QueueProgress } from "./queue-progress";
export {
  REMOTE_CONTROL_INDICATOR_MS,
  useRemoteControlIndicator,
} from "./remote-control-indicator";

export type { PlaybackQueueSnapshot } from "./queue-sync";
