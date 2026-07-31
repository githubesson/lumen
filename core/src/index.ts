// Barrel export for the shared core. Consumers can also import from the
// individual subpaths (`@music-library/core/api`, `/player`, etc.) via the
// `exports` map in package.json.

export * from "./api";
export * from "./audio-format";
export * from "./events";
export * from "./format";
export * from "./storage";
export * from "./track";
export * from "./track-sort";
export { useDebouncedValue } from "./use-debounced-value";
export { AuthProvider, useAuth, type AuthState } from "./auth/auth-core";
export {
  FavoritesProvider,
  useFavorite,
  useFavoriteActions,
  useFavorites,
  type FavoritesState,
} from "./favorites/favorites-core";
export { withFavorite, withFavoriteId } from "./favorites/favorite-toggle";
export {
  buildPeriodOptions,
  formatListeningTime,
  periodKey,
  periodLabel,
  periodRange,
  periodTitle,
  type ListeningTimeStyle,
  type Period,
} from "./replay/period";
export {
  usePlayerCore,
  activityTrack,
  buildRemoteQueue,
  compactRemoteTrack,
  controlledStateForDevice,
  filterRemoteDevices,
  optimisticControlledState,
  remoteActivityTime,
  useRemoteActivityClock,
  useRemotePlaybackCommands,
  type ControlledPlaybackState,
  type UseRemotePlaybackCommandsOptions,
  type UseRemotePlaybackCommandsReturn,
  fisherYatesWithAnchor,
  shouldReportPlay,
  nextRepeatMode,
  clampVolume,
  VOLUME_STORAGE_KEY,
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
  type AudioAdapter,
  type AudioAdapterEvent,
  type PlaybackDevice,
  type PlaybackActivityPublisherOptions,
  type PlaybackCapability,
  type PlaybackRemoteSessionSnapshot,
  type RemotePlaybackCommandAction,
  type RemotePlaybackCommandResult,
  type RemotePlaybackCommandStatus,
  type RemotePlaybackControlEvent,
  type PlayerControls,
  type PlayerState,
  type RepeatMode,
  type TimeState,
  type UsePlayerCoreOptions,
  type UsePlayerCoreReturn,
} from "./player";
