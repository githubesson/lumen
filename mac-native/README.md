# Lumen for macOS

A native macOS client for the Lumen music library, built with
[react-native-macos](https://microsoft.github.io/react-native-macos) on top of
the shared `@music-library/core` package.

It is a sibling of `frontend/` (React + Electron) and `mobile/` (Expo/iOS), and
shares their API client, player logic, auth and favorites — only rendering and
the platform bridges are its own.

## Requirements

- macOS 14+ and Xcode
- Node 20+
- CocoaPods

## Getting started

```bash
npm install                 # also vendors ../core via `npm run sync:core`
npm run pods                # pod install --project-directory=macos
npm start                   # Metro
npm run macos               # build and run
```

On first launch the app asks for a server address (there is no build-time URL;
a DMG has no idea where your library lives). It is probed before being saved and
persisted afterwards, so you only do this once. Sign-in uses the same
session-cookie auth as the other clients, held in the app's `NSURLSession`
cookie jar.

## Architecture

Everything that is not rendering comes from `../core`:

| Concern | Source |
| --- | --- |
| REST client, types, media URLs | `core/src/api.ts` |
| Queue, shuffle, repeat, scrobbling | `core/src/player/use-player-core.ts` |
| Auth session | `core/src/auth/auth-core.tsx` |
| Favorites | `core/src/favorites/favorites-core.tsx` |

Core stays platform-agnostic by taking two injected adapters:

- `src/adapters/avplayer-adapter.ts` implements core's `AudioAdapter` over the
  native `LMPlaybackModule`.
- `src/adapters/async-storage-adapter.ts` implements core's `Storage`.

`../core` is vendored into `packages/music-library-core` by
`scripts/sync-core-package.mjs` (run on install and on every start), because
Metro will not resolve a source-only package outside the project root. **Never
edit the vendored copy — edit `../core` and re-run `npm run sync:core`.** CI can
enforce this with `node scripts/sync-core-package.mjs --check`.

## Native modules

Swift lives in a CocoaPods development pod at `macos/LumenNative`, so Swift
compiles without adding a bridging header to the ObjC app target.

| Unit | Purpose |
| --- | --- |
| `LMPlaybackModule` | `AVPlayer` playback, `MPNowPlayingInfoCenter`, `MPRemoteCommandCenter` (media keys) |
| `LMMenuCommandsModule` | Builds the Playback and Go menus, prunes the template's document menus, routes shortcuts and the conditional Space key |
| `LMContextMenuModule` / `LMContextMenuTarget` | Real `NSMenu` context menus, and the right-click reporting RN-macOS lacks |
| `LMVisualEffectView` | `NSVisualEffectView` vibrancy for the sidebar, dock and Now Playing panel |
| `LMSFSymbolView` | SF Symbols via `NSImage(systemSymbolName:)` |
| `LMSecureField` | `NSSecureTextField`; RN's `secureTextEntry` does not emit change or focus events on macOS |
| `LMGlassEffectView` | Liquid Glass (`NSGlassEffectView`, macOS 26) for the dock and Now Playing panel, with a vibrancy fallback |
| `LMSearchField`, `LMSegmentedControl`, `LMButton` | The real AppKit controls, so focus rings, pressed states and the macOS 26 glass treatment come from the system |
| `LMTrackTable` | `NSTableView` with recycled native cells — track lists are not React views |
| `LMShellModule` + `LMSidebar` + `LMToolbar` | `NSSplitViewController` with a source-list `NSOutlineView` sidebar and an `NSToolbar`; React renders only the content pane |

### Why the shell is AppKit, not React Native

The window's structure — split view, sidebar, toolbar, track lists — is native.
Two reasons, both measured rather than assumed:

**Performance.** Sampling a scroll of the React Native track list put ~58% of
main-thread time in `NSTextStorage`/`NSLayoutManager` teardown and
`_CFXNotificationRegistrarRemoveObservers`. Every `<Text>` allocates a TextKit
stack, and every `RCTView` with `onMouseEnter` registers a notification observer
on the enclosing clip view (`RCTView.m`), so tearing one down walks a registrar
that grows with the number of hovering rows. Tightening virtualization made it
worse by increasing the churn rate. The same scroll on `NSTableView` samples 0%
there and leaves the main thread 99% idle.

**Appearance.** A hand-drawn sidebar and toolbar cannot reproduce the current
system look — the inset source-list selection, group-header typography, sidebar
vibrancy, the toolbar's capsule search field and automatic Liquid Glass
grouping. Apple's guidance is blunt about it: "Avoid creating custom window UI …
Custom frames or controls risk making your app feel broken" (HIG, Windows).

### Platform notes worth knowing before editing

- **Every view manager subclasses `RCTView`**, never the AppKit class directly.
  React Native applies the whole standard view prop set to whatever a manager
  returns, and a non-`RCTView` dies on `doesNotRecognizeSelector` the first time
  something like `mouseDownCanMoveWindow` is set.
- **Custom direct events need unique names.** `onChange` collides with RN's
  built-in bubbling `topChange` and throws "Event cannot be both direct and
  bubbling", which is why the events are `onSegmentChange`, `onButtonPress`,
  `onSearchChange` and so on.
- **`useNativeDriver` must be `false`.** Native-driven animations do not apply
  on react-native-macos — a native-driven `opacity` stays at its initial value,
  which renders the whole pane invisible. All animation here runs on the JS
  driver.
- **Hover costs something per mounted row.** `onMouseEnter`/`onMouseLeave` make
  react-native-macos observe the enclosing scroll view's bounds and convert
  coordinates on every scroll frame, per view. Keep them off long lists; the
  native table tracks hover with a single `NSTrackingArea`.
- **Content runs under the toolbar on purpose.** The glass toolbar tints itself
  from what is behind it, so laying the content out inside the safe area left it
  sampling the empty window background and rendering light over a dark app.
  Screens leave room via `CONTENT_TOP_INSET` instead.
- **`NSApp.appearance` has to be set explicitly.** AppKit chrome does not follow
  the JS theme; `Shell.setAppearance` is what keeps the toolbar, sidebar and
  menus in step with it.

## Keyboard

Shortcuts are real menu items so they are discoverable and work regardless of
focus.

| Shortcut | Action |
| --- | --- |
| Space | Play/pause — passed through when a text field has focus |
| ⌘→ / ⌘← | Next / previous track |
| ⌥⌘S / ⌥⌘R | Shuffle / repeat |
| ⌘↑ / ⌘↓ / ⌥⌘M | Volume up / down / mute |
| ⌘1–⌘4, ⌘, | Home, Browse, Favorites, Playlists, Settings |
| ⌘N | Now Playing panel (Escape closes it) |
| ⌘[ | Back |
| ⌘F | Search |

## Testing

```bash
npm test          # vitest: navigation reducer, server URL, adapter contract
npm run typecheck
```

The tests cover the platform-agnostic seams; there is no macOS renderer for
React Native, so UI is verified by running the app.

## Distribution

```bash
scripts/build-release.sh          # archive, export, notarize, staple
node scripts/make-dmg.mjs         # DMG with the app and an /Applications alias
```

Both need a Developer ID certificate and a `notarytool` keychain profile; see
the comments at the top of `scripts/build-release.sh`.

## Scope

This build is a listening app. Admin, Replay, uploads, metadata editing,
offline downloads and cross-device remote control are tracked in
[FOLLOWUPS.md](./FOLLOWUPS.md).
