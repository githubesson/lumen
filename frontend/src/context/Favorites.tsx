// Thin re-export of the platform-agnostic favorites provider. The shared
// implementation lives in `@music-library/core` so the mobile app can use
// the identical optimistic-toggle flow.
export {
  FavoritesProvider,
  useFavorites,
  type FavoritesState,
} from "@music-library/core";
