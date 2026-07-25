import { defineConfig } from 'vitest/config';

/**
 * Unit tests cover the platform-agnostic seams only — the navigation reducer,
 * server-URL parsing and the audio adapter's event contract (with the native
 * module mocked). Anything that renders React Native views belongs in the
 * manual pass against a real build, since there is no macOS test renderer.
 */
export default defineConfig({
  test: {
    include: ['src/tests/**/*.test.ts'],
    environment: 'jsdom',
  },
});
