// https://docs.expo.dev/guides/using-eslint/
const { defineConfig } = require('eslint/config');
const expoConfig = require('eslint-config-expo/flat');

module.exports = defineConfig([
  expoConfig,
  {
    ignores: [
      'dist/*',
      // Synced build artifact (scripts/sync-core-package.mjs) — lint the
      // canonical source in ../core, not the copy.
      'packages/music-library-core/*',
      // Native module build output.
      'modules/*/build',
    ],
  },
]);
