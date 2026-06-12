// Thin re-export of the platform-agnostic auth provider. The shared
// implementation lives in `@music-library/core` so the mobile app can use
// the identical flow.
export { AuthProvider, useAuth, type AuthState } from "@music-library/core";
