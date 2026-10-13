import { test, type Page } from "playwright/test";
import {
  albums,
  artists,
  pendingInvites,
  playlists,
  tidalAlbum,
  tidalAlbumPartlySaved,
  tidalAlbumSaved,
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
  await press(page, "button", "Move");
  await ready(page, page.getByRole("button", { name: "Swap here" }));
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

test("admin invites", async ({ page }, testInfo) => {
  await go(page, "/admin/invites");
  await ready(page, page.getByRole("heading", { name: "Active invites" }));
  await checkUI(page, testInfo);
});
