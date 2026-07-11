export * from "./player-core";
export type {
  AudioAdapter,
  AudioAdapterEvent,
} from "./audio-adapter";
export {
  usePlayerCore,
  type UsePlayerCoreOptions,
  type UsePlayerCoreReturn,
} from "./use-player-core";
export {
  ACTIVITY_DEVICE_ID_STORAGE_KEY,
  getPlaybackRemoteSession,
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
