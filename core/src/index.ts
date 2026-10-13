// Barrel export for the shared core. Consumers can also import from the
// individual subpaths (`@music-library/core/api`, `/player`, etc.) via the
// `exports` map in package.json.

export * from "./api";
export {
  ARTIST_POPULAR_PREVIEW_COUNT,
  filterReleases,
  hasReleaseFilters,
  libraryArtistReleases,
  RELEASE_FILTER_OPTIONS,
  releaseSubtitle,
  tidalArtistReleases,
  type ArtistRelease,
  type ReleaseFilter,
} from "./artist-releases";
export * from "./audio-format";
export * from "./entity-labels";
export * from "./entity-target";
export * from "./events";
export * from "./format";
export * from "./storage";
export * from "./track";
export * from "./track-sort";
export { useDebouncedValue } from "./use-debounced-value";
export { useEditDraft, type EditDraft } from "./use-edit-draft";
export { AuthProvider, useAuth, type AuthState } from "./auth/auth-core";
export {
  FavoritesProvider,
  useFavorites,
  type FavoritesState,
} from "./favorites/favorites-core";
export { createToggleGuard, withFavorite } from "./favorites/favorite-toggle";
export {
  buildPeriodOptions,
  formatListeningTime,
  periodKey,
  periodLabel,
  periodRange,
  periodTitle,
  type Period,
} from "./replay/period";
export * from "./player";

export {
  activeLineIndex,
  activeWordIndexForLine,
  LYRICS_NOT_FOUND_MESSAGE,
  lyricsContent,
  lyricsErrorMessage,
  lyricsRequest,
  lyricsTimingDuration,
  type LyricsContent,
  type SyncedLine,
} from "./lyrics";
export * from "./metadata-edit";
export {
  adjustSnippetWindow,
  normalizeSnippetSelection,
  parseTrackShareParams,
  shareClipName,
  snippetDragTarget,
  snippetHandleBounds,
  snippetWindow,
} from "./share-snippet";
export * from "./auth/validation";

export { useLastFMConnection } from "./lastfm/use-lastfm-connection";

export * from "./admin/invites";
export * from "./admin/invite-links";
export * from "./admin/music-roots";
export * from "./tidal/status";
export * from "./tidal/track-info";
export { useTidalDeviceLogin } from "./tidal/use-tidal-device-login";
export * from "./auth/errors";
export { lastFMConnectionState } from "./lastfm/use-lastfm-connection";
export * from "./playlist-permissions";
export {
  isValidPlaylistName,
  playlistCoverSizeError,
  playlistDetailsForm,
  playlistDetailsPayload,
  playlistSubtitle,
  samePlaylistDetails,
  type PlaylistDetailsPayload,
} from "./playlist-details";
export * from "./playlist-tracks";
export * from "./upload";
export * from "./replay/replay";
export { useLocalDay, type ResumeSubscriber } from "./replay/use-local-day";
export { useShareLinkSession } from "./share-link-session";
