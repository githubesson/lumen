# mac-native follow-ups

Deliberately out of scope for the first build, which targets a listening app:
auth, browse/search, albums, artists, favorites, playlists, playback, and the
Mac integration around it (menus, shortcuts, media keys, Now Playing).

## Features not yet ported from the iOS client

- **Admin screens** — users, invites, music roots, rescan, importer pins
  (`mobile/app/(tabs)/(settings)/admin-*.tsx`).
- **Replay** — the yearly recap and its shareable images.
- **Uploads** — `api.uploadTracks`, drag-and-drop onto the window would be the
  natural desktop entry point.
- **Metadata editing** — track and album edit, cover replacement.
- **Offline downloads** — `URLSession` background downloads plus a local file
  resolver wired into `usePlayerCore`'s `resolveTrackUri`/`isTrackPlayable`.
- **Cross-device activity / remote control** — core already ships
  `player/activity-sync.ts` and the `/api/activity/ws` protocol; the desktop app
  could both publish and act as a target.
- **Last.fm settings** — connect/disconnect flow.
- **TIDAL album browse screens** — TIDAL-sourced tracks already play, but there
  is no dedicated browse surface.
- **Share images** — the public share/preview endpoints.
- **Playlist editing beyond create/add** — rename, delete, reorder,
  collaborators management, invites. Reorder needs a drag handle; the fallback
  is Move Up/Down in the row context menu.

## Platform work

- **Gapless playback** — implement `prepareNext`/`activatePrepared`/
  `clearPrepared` on `LMPlaybackModule` with a second `AVPlayerItem`. Core falls
  back to `load()` + `play()` while they are absent, so this is purely a
  smoothness win.
- **New Architecture migration** — the app is on the legacy bridge because
  Fabric on react-native-macos is still experimental. Upstream React Native
  removed the legacy renderer after 0.81, so this blocks future upgrades. The
  native surface is small (6 units: playback, menus, context menu, vibrancy,
  SF Symbols, secure field), which is the time to do it.
- **FlashList v2** — requires the New Architecture. `FlatList` is adequate at
  current library sizes; revisit if lists get long enough to drop frames.
- **`secureTextEntry` upstream fix** — `LMSecureField` exists because
  react-native-macos swaps in a backing control that stops emitting change and
  focus events. Worth filing upstream; if fixed, the custom view can go.
- **Native-driver animations** — `useNativeDriver: true` does not apply on
  react-native-macos (a native-driven `opacity` never leaves its initial value),
  so every animation runs on the JS thread. Worth re-testing on future
  react-native-macos releases; moving them back to the native driver would keep
  transitions smooth while a list is settling.
- **Row hover without per-row observers** — hover is currently an
  `onMouseEnter`/`onMouseLeave` pair per row, and each mounted row does work on
  every scroll frame. A single `NSTrackingArea` over the list that reports the
  hovered index would decouple that cost from list length.
- **Auto-update** — Sparkle, or a "new version available" check against the
  releases endpoint.
- **Drag and drop** — drag tracks onto a sidebar playlist, and files onto the
  window to upload. `react-native-macos` exposes `draggedTypes`/`onDrop`.
- **Window restoration** — the frame is remembered; the selected section, scroll
  position and open Now Playing panel are not.
- **Universal binary** — currently built for the host architecture; add x86_64
  if Intel Macs need to be supported.
- **Tighten App Transport Security** — the template's `NSAllowsArbitraryLoads`
  is convenient for plain-HTTP LAN servers but should become a narrower
  exception (or a user-acknowledged opt-in) before wide distribution.
