import { test, type Page } from "playwright/test";
import {
  albums,
  artists,
  pendingInvites,
  playlistTracks,
  playlists,
  tidalAlbum,
  tidalAlbumPartlySaved,
  tidalAlbumSaved,
  tidalArtist,
  tidalArtistId,
} from "./fixtures";
import { checkUI, go, ready, signedIn } from "./helpers";

// Every signed-in screen, reached in-app so the player bar keeps its track.
test.beforeEach(async ({ page }) => {
  await signedIn(page);
});

/** Clicks without moving the mouse, so no hover state or tooltip is left behind. */
const press = (page: Page, role: "tab" | "button", name: string | RegExp) =>
  page.getByRole(role, { name }).first().dispatchEvent("click");

const rows = (page: Page) => page.locator("tbody tr");

test("home", async ({ page }, testInfo) => {
  await go(page, "/");
  await ready(page, page.locator(".hero-title"));
  // The whole board, down to Top artists (from the Replay fixture).
  await ready(page, page.locator('[data-panel="artists"] .board-artist'));
  await checkUI(page, testInfo);
});

test("home, customizing", async ({ page }, testInfo) => {
  await go(page, "/?customize");
  await ready(page, page.locator('[data-panel="artists"] .board-artist'));
  // One panel picked with Move, so both tile states are checked.
  await press(page, "button", "Move Albums");
  await ready(page, page.getByRole("button", { name: "Swap here" }));
  await checkUI(page, testInfo);
});

test("home, panels in roomier slots", async ({ page }, testInfo) => {
  // Jump back in swapped into On repeat's tall slot, where the album's
  // tracks fill the room under its cover; On repeat takes the wide one.
  await go(page, "/?customize");
  await ready(page, page.locator('[data-panel="artists"] .board-artist'));
  await press(page, "button", "Move Jump back in");
  await press(page, "button", "Swap here with On repeat (Last 30 days)");
  // Leaving by link rather than Done, which hands focus (and its tooltip)
  // to the top bar's Customize button.
  await go(page, "/");
  await ready(page, page.locator('[data-panel="repeat"] .board-row'));
  // Phones stack the board, so every panel is as tall as it needs.
  if ((page.viewportSize()?.width ?? 0) > 760) {
    await ready(page, page.locator('[data-panel="resume"] .board-row:not(.board-placeholder)'));
  }
  await checkUI(page, testInfo);
});

test("library tracks", async ({ page }, testInfo) => {
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

test("library tracks grid", async ({ page }, testInfo) => {
  await press(page, "tab", "Grid");
  await ready(page, page.locator(".grid-cards .card"));
  await checkUI(page, testInfo);
});

test("library albums", async ({ page }, testInfo) => {
  await go(page, "/library?view=albums");
  await ready(page, page.getByText(albums[2].title));
  await checkUI(page, testInfo);
});

test("library artists", async ({ page }, testInfo) => {
  await go(page, "/library?view=artists");
  await ready(page, page.getByText(artists[3].name));
  await checkUI(page, testInfo);
});

test("album detail", async ({ page }, testInfo) => {
  const album = albums.find((a) => a.id === "al-postcard")!;
  await go(page, `/library?album=${album.id}`);
  await ready(page, page.getByRole("heading", { name: album.title }));
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

test("TIDAL album detail", async ({ page }, testInfo) => {
  await go(page, `/library?tidalAlbum=${tidalAlbum.id}`);
  await ready(page, page.getByRole("heading", { name: tidalAlbum.title }));
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

// TIDAL lists the album explicit, clean and in Dolby Atmos: one tile on the
// artist's page, and a switcher on the album's when opened from there.
test("TIDAL artist detail", async ({ page }, testInfo) => {
  await go(page, `/library?tidalArtist=${tidalArtistId}`);
  await ready(page, page.getByRole("heading", { name: tidalArtist.artist!.name }));
  await ready(page, page.locator(".card").filter({ hasText: "3 versions" }));
  await checkUI(page, testInfo);
});

test("TIDAL album detail, versions", async ({ page }, testInfo) => {
  await go(page, `/library?tidalArtist=${tidalArtistId}&tidalAlbum=${tidalAlbum.id}`);
  await ready(page, page.getByRole("heading", { name: tidalAlbum.title }));
  await ready(page, rows(page));
  await ready(page, page.getByRole("tablist", { name: "Version" }));
  await checkUI(page, testInfo);
});

// The library copy: a quiet link in Details while there's more to download,
// then the actions row's one control once all of it is saved.
test("TIDAL album detail, partly saved", async ({ page }, testInfo) => {
  await go(page, `/library?tidalAlbum=${tidalAlbumPartlySaved.id}`);
  await ready(page, page.getByRole("heading", { name: tidalAlbumPartlySaved.title }));
  await ready(page, rows(page));
  await ready(page, page.locator(".album-sleeve-details").getByRole("button", { name: "Open in library" }));
  await checkUI(page, testInfo);
});

test("TIDAL album detail, saved", async ({ page }, testInfo) => {
  await go(page, `/library?tidalAlbum=${tidalAlbumSaved.id}`);
  await ready(page, page.getByRole("heading", { name: tidalAlbumSaved.title }));
  await ready(page, rows(page));
  await ready(page, page.locator(".album-sleeve-more").getByRole("button", { name: "Open in library" }));
  await checkUI(page, testInfo);
});

test("artist detail", async ({ page }, testInfo) => {
  const artist = artists.find((a) => a.id === "ar-lucien")!;
  await go(page, `/library?artist=${artist.id}`);
  await ready(page, page.getByRole("heading", { name: artist.name }));
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

test("search results", async ({ page }, testInfo) => {
  await go(page, "/library?q=night&type=all");
  await ready(page, page.getByRole("heading", { name: "Songs" }));
  await checkUI(page, testInfo);
});

test("favorites", async ({ page }, testInfo) => {
  await go(page, "/favorites");
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

test("recent", async ({ page }, testInfo) => {
  await go(page, "/recent");
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

test("replay", async ({ page }, testInfo) => {
  await go(page, "/replay");
  await ready(page, page.getByText("Also on repeat", { exact: true }));
  await checkUI(page, testInfo);
});

// "Show all" brings back the full table of top tracks across the panel.
test("replay all top tracks", async ({ page }, testInfo) => {
  await go(page, "/replay");
  await ready(page, page.getByText("Also on repeat", { exact: true }));
  await press(page, "button", /^Show all \d+$/);
  await ready(page, page.getByRole("button", { name: "Show fewer" }));
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

// A month: one bar and one strip cell per day, rather than months and a bar.
test("replay this month", async ({ page }, testInfo) => {
  await go(page, "/replay");
  await ready(page, page.getByText("Also on repeat", { exact: true }));
  await press(page, "tab", "This month");
  await ready(page, page.getByText("Every day", { exact: true }));
  await checkUI(page, testInfo);
});

test("playlists", async ({ page }, testInfo) => {
  await go(page, "/playlists");
  await ready(page, page.locator(".view").getByText(playlists[2].name));
  await checkUI(page, testInfo);
});

const shared = playlists.find((p) => p.id === "pl-sunday-coffee")!;

test("playlist tracks", async ({ page }, testInfo) => {
  await go(page, `/playlists/${shared.id}`);
  await ready(page, rows(page));
  await checkUI(page, testInfo);
});

test("playlist collaborators", async ({ page }, testInfo) => {
  await go(page, `/playlists/${shared.id}`);
  await ready(page, rows(page));
  await press(page, "tab", /^Collaborators/);
  await ready(page, page.getByText("theo", { exact: true }));
  await checkUI(page, testInfo);
});

test("playlist settings", async ({ page }, testInfo) => {
  await go(page, `/playlists/${shared.id}`);
  await ready(page, rows(page));
  await press(page, "tab", "Settings");
  await ready(page, page.getByRole("textbox", { name: "Name" }));
  await checkUI(page, testInfo);
});

// Confirmations show what they act on as a card: here the playlist's cover,
// name and size.
test("delete playlist confirmation", async ({ page }, testInfo) => {
  await go(page, `/playlists/${shared.id}`);
  // Its own count, not the library rows still showing as it loads: the card
  // is drawn from what has loaded when Delete is pressed.
  const count = `${playlistTracks(shared.id).length} tracks`;
  await ready(page, page.getByText(count, { exact: true }));
  await press(page, "tab", "Settings");
  await press(page, "button", /^Delete$/);
  const dialog = page.getByRole("alertdialog", { name: "Delete this playlist?" });
  await ready(page, dialog.getByText(`${count} · Collaborative`, { exact: true }));
  await checkUI(page, testInfo);
});

test("new playlist", async ({ page }, testInfo) => {
  await go(page, "/playlists/new");
  await ready(page, page.getByRole("heading", { name: "New playlist" }));
  await checkUI(page, testInfo);
});

test("pending invites", async ({ page }, testInfo) => {
  await go(page, "/invites");
  await ready(page, page.getByText(pendingInvites[1].playlist_name));
  await checkUI(page, testInfo);
});

// /admin/library redirects to /admin, whose default section is the library.
test("admin library", async ({ page }, testInfo) => {
  await go(page, "/admin/library");
  await ready(page, page.getByText("/mnt/nas/uploads/lossless").first());
  await checkUI(page, testInfo, {
    exceptions: [
      {
        // The admin forms sit below the fold of the scrolling content area
        // (and, on phones, partly scrolled sideways), where lintapple's
        // placeholder check finds no background.
        selector: ".admin-section-wrap .input, .admin-section-wrap > p",
        rules: ["text-contrast"],
        reason: "Fields and text outside the visible part of the scrolling content area. lintapple measures the same styles in view.",
      },
    ],
  });
});

test("admin users", async ({ page }, testInfo) => {
  await go(page, "/admin/users");
  await ready(page, page.getByText("oskar.lindqvist"));
  await checkUI(page, testInfo);
});

// A person without a picture shows their initials.
test("disable user confirmation", async ({ page }, testInfo) => {
  await go(page, "/admin/users");
  await ready(page, page.getByText("oskar.lindqvist"));
  await press(page, "button", "Disable jonas");
  const dialog = page.getByRole("alertdialog", { name: "Disable this account?" });
  await ready(page, dialog.getByText("jonas", { exact: true }));
  await checkUI(page, testInfo, {
    exceptions: [
      {
        // axe compares the stack under each line of text, the page beneath
        // the modal included. At 1440px the message's two lines sit over
        // different table rows, so it gives up; the same text is measured
        // over other pages in the other confirmation specs.
        selector: ".confirm-message",
        rules: ["text-contrast"],
        reason: "Two lines of modal text over different table rows behind the scrim, which axe can't resolve. The same style is measured in the other confirmation specs.",
      },
    ],
  });
});

test("admin invites", async ({ page }, testInfo) => {
  await go(page, "/admin/invites");
  await ready(page, page.getByRole("heading", { name: "Active invites" }));
  await checkUI(page, testInfo);
});

// Things without a picture of their own get an icon.
test("revoke invite confirmation", async ({ page }, testInfo) => {
  await go(page, "/admin/invites");
  await ready(page, page.getByRole("heading", { name: "Active invites" }));
  await press(page, "button", /^Revoke /);
  const dialog = page.getByRole("alertdialog", { name: "Revoke this invite?" });
  await ready(page, dialog.getByText("User invite", { exact: true }));
  await checkUI(page, testInfo);
});
