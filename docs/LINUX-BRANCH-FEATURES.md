# Linux branch: added features

Branch `linux-discord-rpc-and-folder-upload` on the fork `genres/lumen`,
based on `main` at `38cac55`. No pull request has been opened.

## Confirmed working

These were confirmed by Bee in the real desktop app on Arch Linux,
connected to musicfiles.net.

| Feature | Confirmed | Evidence |
| ------- | --------- | -------- |
| Choosing a whole folder in **Add music**: its files are listed with their folder paths, and files the server can't take (e.g. `cover.jpg`) are left out by name | 2026-11-10 | Bee's screenshot of a 28-file album folder selection. The upload that followed hit the 413 error that feature 6 now fixes. |

Nothing else is confirmed yet. Everything below is built and tested by
Claude, but not yet confirmed by Bee.

## Checks run

- Frontend: `npm run lint` and `npm run typecheck` pass. In `vitest`, the new
  and changed tests pass. 48 tests in 5 files (`home-board*`,
  `startup-home`, `audio-output`) fail the same way on unmodified `main`
  (`localStorage.clear` is undefined in this Node/jsdom setup). They are
  unrelated to this branch.
- Core: 672/672 pass.
- Backend: `gofmt`, `go vet` and `go test ./...` pass against PostgreSQL 16.

---

## In progress

Built on this branch but not yet confirmed by Bee. Each section says what
was tested and how. Testing was on Arch Linux (Hyprland), using the real
app or web UI against a local server built from this branch, plus
automated tests.

| # | Feature | Where it runs | Needs a server update? | Status |
| - | ------- | ------------- | ---------------------- | ------ |
| 1 | Discord "Listening to" status on Linux | Desktop app | No | Built, tested by Claude; waiting for Bee |
| 2 | Discord status clears when music stops | Desktop app | No | Built, tested by Claude; waiting for Bee |
| 3 | Upload whole folders, mixed with files | Web + desktop | No | Folder selection confirmed (above); full upload waiting for Bee |
| 4 | Edit your own uploads (title, artist, album, cover) | Server + web + desktop | **Yes** | Built, tested on a local server; needs the server update |
| 5 | Personal uploads turned into shared tracks (decision pending) | Server | **Yes** | Decision pending (Bee + developer) |
| 6 | Big uploads no longer fail with 413 behind Cloudflare | Web + desktop | No | Built, tested by Claude; waiting for Bee's retry |
| 7 | Edit details before uploading | Web + desktop | Personal: **yes** · Shared (admin): no | Built, tested on a local server; personal uploads need the server update |
| 8 | Click title, artist or album in the player bar | Web + desktop | No | Built, tested by Claude; waiting for Bee |
| 9 | Cancel an upload, with nothing left behind | Server + web + desktop | Partly (see below) | Built, tested on a local server; waiting for Bee |
| 10 | Home: the round play button on song rows works | Web + desktop | No | Built, tested by Claude; waiting for Bee |
| 11 | Home: Jump back in's title, cover and artists, and song rows' artists, open their pages | Web + desktop | No | Built, tested by Claude; waiting for Bee |

### 1. Discord status on Linux

**What changed:** the `discord-rpc` package only looks for Discord's socket at
`$XDG_RUNTIME_DIR/discord-ipc-N`. Flatpak, Snap and Vesktop Discord keep it in
their own folder, so Lumen never found them. On Linux, Lumen now also checks:

- `app/com.discordapp.Discord` (Flatpak, plus Canary and PTB)
- `app/dev.vencord.Vesktop`, `app/xyz.armcord.ArmCord`
- `snap.discord`, `snap.discord-canary`

Windows and macOS are unchanged.

**Files:** `frontend/electron/discord-ipc-path.ts` (new),
`frontend/electron/discord-presence.ts`.

**Tested:** a packaged Linux build connected to native Discord
(`[discord] connected as client …`), and Discord accepted the activity.
The Flatpak, Snap and Vesktop paths are covered by unit tests only, since
none of those Discord builds are installed on the test machine.

> Source builds: Rich Presence needs `DISCORD_CLIENT_ID` (in
> `frontend/.env` or the environment) when building. Release builds already
> get it from CI. Without it, presence stays off. This was the main reason
> presence "didn't work on Linux" for self-built copies.

### 2. Discord status clears when music stops

**What was wrong (all platforms, Windows included):** when the queue
finished, the last song stayed on your Discord profile as a paused card for
as long as Lumen stayed open.

**What changed:**

- When playback ends by itself (the queue runs out), the card is cleared.
  The audio element fires `pause` before `ended`, so the clear happens on
  `ended`.
- A paused card is removed after **10 minutes**, like Spotify does. Pressing
  play brings it back.

**Files:** `frontend/src/lib/discordPresence.ts`,
`frontend/electron/discord-presence.ts`.

**Tested:** the real desktop app played a track to the end with every
Discord call recorded. Before the fix, the last call was a paused card.
After the fix, the last call was `clear`. Unit tests cover the real
pause-then-ended order and the 10-minute expiry.

### 3. Upload folders and files together

**What changed in the "Add music" dialog:**

- A **Choose folder** button adds a whole folder, subfolders included.
- Dropping a folder now walks everything inside it. Before, the folder was
  rejected.
- Each pick or drop adds to the list instead of replacing it, so files and
  folders can be mixed in one upload. Repeats are skipped, and a **Clear**
  button empties the list.
- The list shows each file's path inside its folder, for example
  `Album/Disc 2/02.ogg`.
- Progress shows as **Uploading 120 of 450…** while the existing
  size-limited batches upload.
- Files the server can't take, such as `.txt` or `.jpg`, are still left out
  and named.

**Files:** `frontend/src/components/UploadDialog.tsx`,
`frontend/src/lib/droppedFiles.ts` (new).

**Tested:** in the real web UI (Playwright), one file plus a nested folder
went in as one selection. `notes.txt` was left out, and all 3 tracks were
added. Unit tests cover folder picks, nested folder drops and duplicate
skipping.

### 4. Edit your own uploads

**What was missing:** editing was admin-only on the server, so people
couldn't fix the titles, artists or covers of their own uploads.

**What changed:**

- `PATCH /api/tracks/{id}`: admins can still edit any track. Anyone else can
  edit only their **own personal uploads** (otherwise 404, checked in the
  same transaction). Non-admins can't move a track into an album by id
  (403).
- `PUT /api/tracks/{id}/cover` (new) sets **your own** cover art for your
  upload. It is stored in the existing per-user `album_personal_covers`
  table, so only you see it and the shared album is never changed. If the
  album already has shared art, the shared art still shows first.
- In the app, **Edit** (right-click menu and the row's pencil) shows on your
  own uploads, and the edit dialog has a **Cover art** picker. A track with
  no album that gets a cover becomes its own single, because covers belong
  to albums.
- Mobile uses the same permission rule, so its edit screen also opens for
  your own uploads. It has no cover picker.

**Files:** `backend/internal/library/store.go`,
`backend/internal/httpapi/handlers/tracks.go`,
`backend/internal/httpapi/handlers/tracks_covers.go`,
`backend/internal/httpapi/router.go`, `core/src/track.ts`, `core/src/api.ts`,
`frontend/src/components/edit/EditTrackDialog.tsx`,
`frontend/src/components/TrackList.tsx`.

**Tested:** against a local server built from this branch, a **non-admin**
user edited "Baby Smoove - lol (Official Music Video)" to the title "lol"
and artist "Baby Smoove" and added a cover. The server returned the new
values, the cover was served as an image, and the library showed it.
A non-admin `album_id` move returned 403. An integration test checks that
other users can't edit or add a cover, and that the cover never reaches the
shared album row.

### 5. Personal uploads becoming shared tracks — decision pending

> **Status:** Bee reports this behaviour may be wanted (uploads ending up in
> the shared library). The fix stays as its own commit (`5c27cd4`, easy to
> drop) until Bee and the main developer decide. The code's own comments say
> `.users/` is meant to stay outside the watcher (`handlers/library.go` and
> `handlers/tracks.go`). For an intended "share my upload" path, admins
> already have the **Global library** choice in the upload dialog.

**What was wrong:** personal uploads are stored in `MUSIC_ROOT/.users/`. The
first personal upload creates that folder while the server is running. The
folder watcher then treated `.users` as new music: its hidden-folder check
skipped only *sub*folders, not the new folder itself. About 2 seconds later,
every personal upload was ingested again as a **shared** track. That removed
its owner (no Edit or Delete for the uploader) and made it visible to all
users, until the next restart.

**What changed:** the watcher ignores new hidden folders.

**Files:** `backend/internal/ingest/watcher.go`.

**Tested:** a regression test fails without the fix and passes with it. In a
fresh end-to-end run, all uploads stayed personal. Before the fix, all 3
became shared.

> **For existing servers:** tracks that were already turned into shared
> tracks stay shared. Fixing those rows (for example, setting `owner_id` back
> from the `.users/<user-id>/` file path) is a data change for the server
> owner to decide on. This branch doesn't do it.

### 6. Big uploads no longer fail with 413

**What was wrong:** uploads were grouped into requests of up to 512 MB (the
server's limit). Cloudflare's free plan refuses request bodies over 100 MB
with **413 Payload Too Large**, and the dialog then showed Cloudflare's raw
HTML page.

**What changed:** files are grouped into requests under **90 MB**. A single
larger file still goes alone, up to the server's limit. A 413 now reads "The
server (or a proxy in front of it, like Cloudflare) refused a request this
large." Mobile uses the same planner, so it gets the smaller requests too.

**Files:** `core/src/upload.ts`, `frontend/src/components/UploadDialog.tsx`.

**Tested:** in the real web UI, a 120 MB folder upload went as 2 requests.
Unit tests cover the grouping and the 413 message.

### 7. Edit details before uploading

In "Add music", turn on **Edit details before uploading** to set:

- each file's **title** and **artists**
- one **album**, **album artist** and **cover** for the whole selection

Blank fields keep the file's own tags. The details are saved to each track
as soon as the upload adds it. A file that matched a track already in the
library is left unchanged. If saving fails, that file says "Added, but saving
the details failed".

- Personal uploads use the owner edit and cover from feature 4, so they need
  the server update.
- Shared ("Global") uploads by an admin use the existing admin edit, and
  the cover becomes the album's cover. These work on today's server.

**Files:** `frontend/src/lib/uploadEdits.ts` (new),
`frontend/src/components/UploadDialog.tsx`.

**Tested:** in the real web UI, a 3-file folder with a new album name,
album artist, cover, and one title and artists line was uploaded. The server
showed the edited title, album and cover. Unit tests cover new-only edits,
one cover per album, admin album covers and failure reporting.

### 8. Click title, artist or album in the player bar

- The **title** opens the song's album.
- Each **artist** opens that artist's page.
- The **album** opens the album.

TIDAL albums open their TIDAL page. A TIDAL artist, or a name the track's
details don't list, opens an artist search instead. The bar only lists the
track's main artist line, so featured artists may not appear there. Links
are off in the mini player.

**Files:** `frontend/src/components/player/NowPlaying.tsx`,
`frontend/src/lib/nowPlayingLinks.ts` (new),
`frontend/src/components/MiniPlayer.tsx`, `frontend/src/styles/player.css`.

**Tested:** in the real web UI, the title, artist and album each opened the
right page. A unit test checks the links.

### 9. Cancel an upload, with nothing left behind

**What was wrong:** the Cancel button (and the dialog's close) was disabled
while uploading.

**What changed:**

- **Cancel upload** works during an upload. It stops the request in flight,
  sends nothing more, and deletes the tracks this upload had already added.
  Personal uploads use the owner delete; admin uploads use the admin delete.
  The selection stays so you can retry, and the dialog says what was removed.
  Closing the dialog with X or Escape during an upload does the same.
- **Server:** if the client disconnects mid-request, the upload stops at the
  next file and undoes the tracks that request had added. It removes the rows
  first, then the files, and only files inside that upload's own folder.
  Half-written files were already removed before this branch.

**Server update needed?** The app-side cancel and cleanup work on today's
server. Undoing a request that had *fully arrived* when the cancel came needs
the server update. Without it, those few files can stay. If the app is closed
mid-upload, requests that had already finished stay.

**Files:** `frontend/src/components/UploadDialog.tsx`, `core/src/api.ts`
(abort signal on `uploadMusic`),
`backend/internal/httpapi/handlers/library.go`.

**Tested:** in the real web UI with a throttled network, a 3-file folder
upload was cancelled during its second request. The dialog said "Removed the
2 tracks it had already added", and the database and disk had the same
track and file count as before. A DB-backed Go test covers the server undo:
it removes only what the request added, leaves the user's other tracks
alone, and never touches files outside the upload folder. A dialog test
covers the cancel.

### 10. Home: the round play button on song rows works

**What was wrong (Bee's report):** on Home's song lists, the white round play
button that appears on hover did nothing when clicked, and it didn't react to
the mouse. On hover, the song's length fades out (opacity 0) so the button
can show in its place. But a see-through element is drawn **above** the row's
click area, so the invisible duration caught the click. Ranked lists, where
the number turns into a play icon, had the same trap.

**What changed:** the faded duration and rank number no longer catch clicks.
The round button is now a real button, as on playlist rows: pointer cursor,
grows slightly on hover, presses in, and plays the song.

**Files:** `frontend/src/components/home/Board.tsx`,
`frontend/src/styles/board.css`.

**Tested:** in the real web UI, the element under the pointer was the hidden
duration before the fix. After it, clicking the button started the song
(player bar "Nothing playing" → "First Wave"). Hover gives a pointer cursor
and the button grows. On a ranked row, the play icon now reaches the row's
play action.

### 11. Home: titles, covers and artists open their pages

On Home's **Jump back in** card:

- the **title** and the **cover** open the album;
- each **artist** opens their page.

On Home's song lists, each **artist name** opens the artist's page. The rest
of the row still plays the song, as before. Recently played songs often don't
include their album, which is also why the card sometimes had no "Open album"
button. Clicking looks the album up first. These use the same links as the
player bar (feature 8), now shared in `frontend/src/components/EntityLinks.tsx`.

**Files:** `frontend/src/components/EntityLinks.tsx` (new),
`frontend/src/components/home/HomePanels.tsx`,
`frontend/src/components/home/Board.tsx`,
`frontend/src/components/player/NowPlaying.tsx`,
`frontend/src/styles/player.css`.

**Tested:** in the real web UI, the card's title, cover and artist each opened
the right page. A row's artist opened the artist page without starting
playback, and clicking a row's title still played the song. A Home test
covers the card's links, including a song with no album id.

### Not done / limits

- Testing the Flatpak, Snap and Vesktop Discord socket paths on a real
  install.
- A cover picker on mobile, and removing a personal cover. Replacing it
  works.
- Repairing tracks an existing server already turned shared (see section 5).
- Features 4 and 5 only work after the server runs this branch.
