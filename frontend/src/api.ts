// Re-export of the platform-agnostic API client. The implementation lives in
// `@music-library/core` so the mobile app consumes the identical surface.
// The web app runs same-origin (via Vite proxy in dev, nginx/Electron in prod)
// so no baseUrl is set here — leave it as the empty-string default.
export * from "@music-library/core/api";
