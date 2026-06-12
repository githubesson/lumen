# mobile

Lumen for iOS and Android — an Expo Router / React Native client for the
self-hosted music library.

## Stack

- Expo SDK 55, React 19, React Native 0.83, file-based routes under `app/`
- `expo-audio` with background playback, lock-screen / now-playing controls
- React Query for data fetching, FlashList for big lists
- Shared logic from [`@music-library/core`](../core/) via a synced copy in
  `packages/music-library-core` (see below)
- Custom config plugins (`plugins/`) and native modules (`modules/`),
  including Instagram story sharing for Replay

## Configure

The repo ships with placeholder app config — fill in your own details first:

```sh
npm run configure
```

It prompts for your backend URL, bundle identifier, Expo owner, and the
optional EAS / App Store Connect / Instagram IDs, then rewrites `app.json`
and (re)creates `eas.json` (which is gitignored — it holds personal IDs).
Non-interactive: `npm run configure -- --from answers.json` (see the header
of [scripts/configure-app.mjs](scripts/configure-app.mjs) for the shape).

Prefer to keep those values out of git entirely? Put them in
`app.local.json` instead — [app.config.js](app.config.js) deep-merges it
over `app.json` at config-resolution time, and it's gitignored.

The backend URL can also be set per-build with `EXPO_PUBLIC_API_BASE_URL`
instead of `app.json`.

## Develop

```sh
npm install        # postinstall runs sync:core + patch-package
npm run start      # Expo dev server
npm run android
npm run ios
npm run lint
```

The app uses native modules, so it runs in a [development
build](https://docs.expo.dev/develop/development-builds/introduction/)
(`expo-dev-client`), not Expo Go.

## Shared core

Metro can't resolve symlinks outside the project root, so the shared package
is **copied** into `packages/music-library-core` by
[scripts/sync-core-package.mjs](scripts/sync-core-package.mjs):

```sh
npm run sync:core   # re-run after editing ../core
```

The copy is gitignored — always edit [`../core`](../core/), never the copy.

## Layout

```
app/          Expo Router routes (tabs, players, playlists, admin, replay)
components/   shared UI
context/      React contexts (auth, player, …)
lib/          helpers, API glue
theme/        design tokens
adapters/     platform adapters for the core package
modules/      custom native modules
plugins/      Expo config plugins
scripts/      sync-core-package.mjs and friends
```

## Builds

Builds go through [EAS](https://docs.expo.dev/eas/). `eas.json` is not
tracked (it carries personal project/app IDs) — `npm run configure` creates
it with the standard development / preview / production profiles, plus an
`eas submit` block if you provide an App Store Connect app ID.
