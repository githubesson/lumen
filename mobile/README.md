# mobile

Lumen for iOS and Android — an Expo Router / React Native client for the
self-hosted music library.

## Stack

- Expo SDK 57, React 19, React Native 0.86, file-based routes under `app/`
  (minimum iOS 16.4 as of SDK 56)
- `expo-audio` with background playback, lock-screen / now-playing controls
- `expo-widgets` Live Activity (`widgets/`) showing playlist download
  progress on the iOS Lock Screen / Dynamic Island (iOS 16.4+; set your
  Apple Team ID via `npm run configure` or `app.local.json` so EAS can sign
  the widget extension)
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

## OTA Updates

The app supports over-the-air updates via `expo-updates`, letting you push JavaScript and asset changes without going through app store review.

### Setup

`npm run configure` sets `updates.url` from the EAS project ID you give it.
To wire it up by hand instead, get the ID with `eas project:info` and add the
endpoint to `app.local.json` (or `app.json`):

```json
{
  "updates": {
    "url": "https://u.expo.dev/YOUR_PROJECT_ID"
  }
}
```

`runtimeVersion` (`fingerprint` policy) lives in `app.json` and the update
channels live in `eas.json` — both are already set, nothing to add there.

Then rebuild — OTA only reaches users who have a build with `expo-updates`
configured:

```sh
eas build --platform ios --profile production
```

### Publishing updates

```sh
eas update --branch production --message "Bug fixes"
eas update --branch preview     --message "Testing new feature"
```

Each build profile carries a matching channel (`development` / `preview` /
`production`), and each channel is mapped to the branch of the same name — so
a build installs the updates published to its own branch. `eas channel:list`
shows the mapping; `eas channel:create <name>` recreates one if it's missing.

### Runtime versions

The `fingerprint` policy hashes the native project — deps, config plugins,
`patches/`, `modules/`. Any native change produces a new runtime version, so
an update can never land on a build that lacks the native code it needs.
Check what a commit hashes to with `npx expo-updates fingerprint:generate`;
if it differs from the installed build's fingerprint, that build needs a
rebuild, not an update.

The tradeoff is that a bare JS fix must be published from a tree whose native
inputs match the build. Switching `app.json` to
`"runtimeVersion": { "policy": "appVersion" }` relaxes that to "any build with
the same `version`", at the risk of shipping JS to a build without the native
side it expects.

The app checks for an update on launch and applies it on the next launch —
that's the `expo-updates` default; no code in `app/` drives it.
