// Barrel export for the shared core. Consumers can also import from the
// individual subpaths (`@music-library/core/api`, `/player`, etc.) via the
// `exports` map in package.json.

export * from "./api";
export * from "./events";
export * from "./storage";
export { AuthProvider, useAuth, type AuthState } from "./auth/auth-core";
export {
  FavoritesProvider,
  useFavorite,
  useFavoriteActions,
  useFavorites,
  type FavoritesState,
} from "./favorites/favorites-core";
export {
  usePlayerCore,
  fisherYatesWithAnchor,
  shouldReportPlay,
  nextRepeatMode,
  clampVolume,
  VOLUME_STORAGE_KEY,
  type AudioAdapter,
  type AudioAdapterEvent,
  type PlayerControls,
  type PlayerState,
  type RepeatMode,
  type TimeState,
  type UsePlayerCoreOptions,
  type UsePlayerCoreReturn,
} from "./player";
