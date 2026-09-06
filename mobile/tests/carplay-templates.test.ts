/**
 * CarPlay template builders. Pure functions with no native or React
 * dependency, so the row shapes, the destination round-trip and the head-unit
 * item cap can be checked without a car (or a simulator) attached.
 */
import { describe, expect, it } from "vitest";
import type { Album, Playlist, TrackListItem } from "@music-library/core";

import {
  buildAlbumsTemplate,
  buildHomeTab,
  buildLibraryTabs,
  buildLockedTemplate,
  buildPlaylistsTemplate,
  buildQueueTemplate,
  buildSignedOutTemplate,
  buildTrackListTemplate,
  CARPLAY_TAB,
  decodeDestination,
  encodeDestination,
  greetingFor,
  nowPlayingNavButton,
  pushedTemplateId,
  recentAlbumTiles,
  type CarPlayDestination,
} from "../lib/carplay/templates";
import type { CarPlayListItem, CarPlayListTemplate } from "../modules/carplay";

const LIMITS = {
  maximumItemCount: 100,
  maximumSectionCount: 10,
  maximumTabCount: 5,
  maximumImageRowCount: 4,
};

function track(id: string, overrides: Partial<TrackListItem> = {}) {
  return {
    id,
    title: `Track ${id}`,
    artist: "Artist",
    duration_ms: 0,
    ...overrides,
  } satisfies TrackListItem;
}

function allItems(template: CarPlayListTemplate): CarPlayListItem[] {
  return template.sections.flatMap((section) => section.items);
}

function ids(template: CarPlayListTemplate): string[] {
  return allItems(template).map((item) => item.id);
}

/** The rows the driver actually chooses between, minus Play/Shuffle. */
function contentRows(template: CarPlayListTemplate): CarPlayListItem[] {
  return allItems(template).filter(
    (item) => item.id !== "play-list" && item.id !== "shuffle-list",
  );
}

const emptyLists = {
  greeting: "Good afternoon",
  recent: { tracks: [] },
  favorites: { tracks: [] },
  playlists: { playlists: [] },
  albums: { albums: [] },
};

const emptyHome = {
  greeting: "Good afternoon",
  recent: [],
  favorites: [],
  playlists: [],
  albums: [],
};

describe("destination encoding", () => {
  const cases: CarPlayDestination[] = [
    { kind: "now-playing" },
    { kind: "recent" },
    { kind: "favorites" },
    { kind: "playlists" },
    { kind: "albums" },
    { kind: "queue" },
    { kind: "play-list" },
    { kind: "shuffle-list" },
    { kind: "playlist", id: "p1" },
    { kind: "album", id: "a1" },
    { kind: "track", id: "t1" },
    { kind: "queued", id: "3" },
  ];

  it.each(cases)("round-trips %j", (destination) => {
    expect(decodeDestination(encodeDestination(destination))).toEqual(
      destination,
    );
  });

  it("keeps colons inside ids", () => {
    const destination = { kind: "track", id: "tidal:12345" } as const;
    expect(decodeDestination(encodeDestination(destination))).toEqual(
      destination,
    );
  });

  it("rejects unknown and malformed rows", () => {
    expect(decodeDestination("nonsense")).toBeNull();
    expect(decodeDestination("track:")).toBeNull();
    expect(decodeDestination("nonsense:1")).toBeNull();
    // A bare keyed kind carries no id, so it leads nowhere.
    expect(decodeDestination("playlist")).toBeNull();
  });

  it("keeps pushed screens off the tab ids they mirror", () => {
    // Both exist at once: pushing Playlists from elsewhere must not take over
    // the tab's in-place updates.
    expect(pushedTemplateId({ kind: "playlists" })).not.toBe(
      CARPLAY_TAB.playlists,
    );
  });
});

describe("root", () => {
  it("prompts to sign in instead of showing an empty library", () => {
    const root = buildSignedOutTemplate();
    expect(allItems(root)).toHaveLength(0);
    expect(root.emptyText).toMatch(/sign in/i);
  });

  it("never sends the driver to their phone", () => {
    // A CarPlay app may report a condition such as a required login, but must
    // not ask people to pick up their iPhone and act on it.
    const wording = [
      buildSignedOutTemplate(),
      buildLockedTemplate(),
      buildHomeTab({ limits: LIMITS, ...emptyHome }),
      ...buildLibraryTabs({ limits: LIMITS, ...emptyLists }),
    ].flatMap((template) => [template.emptyTitle, template.emptyText]);

    for (const text of wording) {
      expect(text ?? "").not.toMatch(/phone|device/i);
    }
  });

  it("waits rather than calling an unreadable session a signed-out one", () => {
    // Nothing is readable until the phone's first unlock since it booted, so
    // "not signed in" would be a guess — and the wrong one for most drives.
    const root = buildLockedTemplate();
    expect(root.loading).toBe(true);
    expect(root.emptyText).not.toMatch(/sign in/i);
  });

  it("lays out the browse tabs in reach order, each with an icon", () => {
    const tabs = buildLibraryTabs({ limits: LIMITS, ...emptyLists });

    expect(tabs.map((tab) => tab.id)).toEqual([
      CARPLAY_TAB.home,
      CARPLAY_TAB.recent,
      CARPLAY_TAB.favorites,
      CARPLAY_TAB.playlists,
      CARPLAY_TAB.albums,
    ]);
    expect(tabs.map((tab) => tab.tabTitle)).toEqual([
      "Home",
      "Recent",
      "Favorites",
      "Playlists",
      "Albums",
    ]);
    expect(tabs.every((tab) => !!tab.tabSymbol)).toBe(true);
  });

  it("carries the jump back to now playing on every tab", () => {
    const playing = buildLibraryTabs({
      limits: LIMITS,
      ...emptyLists,
      currentTrack: track("t1"),
    });
    const idle = buildLibraryTabs({ limits: LIMITS, ...emptyLists });

    expect(playing.every((tab) => tab.navButton?.enabled)).toBe(true);
    expect(playing[0].navButton?.id).toBe("now-playing");
    // Nothing to go back to, so the button is there but dimmed.
    expect(idle.every((tab) => tab.navButton?.enabled === false)).toBe(true);
  });

  it("drops the tabs a narrow head unit would drop silently", () => {
    const tabs = buildLibraryTabs({
      limits: { ...LIMITS, maximumTabCount: 3 },
      ...emptyLists,
    });

    expect(tabs.map((tab) => tab.id)).toEqual([
      CARPLAY_TAB.home,
      CARPLAY_TAB.recent,
      CARPLAY_TAB.favorites,
    ]);
  });

  it("reports a tab that is still loading apart from one that failed", () => {
    const [, recent] = buildLibraryTabs({
      limits: LIMITS,
      ...emptyLists,
      recent: { tracks: undefined, loading: true },
    });
    const [, failed] = buildLibraryTabs({
      limits: LIMITS,
      ...emptyLists,
      recent: { tracks: undefined },
    });

    expect(recent).toMatchObject({ loading: true, emptyText: "Loading…" });
    expect(failed.emptyTitle).toMatch(/offline/i);
    expect(failed.loading).toBeFalsy();
  });
});

describe("home tab", () => {
  const albums: Album[] = [
    {
      id: "a1",
      title: "An Album",
      artist_name: "Someone",
      is_compilation: false,
      track_count: 9,
      duration_ms: 0,
      has_cover: true,
    },
  ];

  it("greets by time of day", () => {
    expect(greetingFor(new Date(2026, 0, 1, 8))).toBe("Good morning");
    expect(greetingFor(new Date(2026, 0, 1, 14))).toBe("Good afternoon");
    expect(greetingFor(new Date(2026, 0, 1, 21))).toBe("Good evening");
  });

  it("stacks a shelf of covers under each heading, with a way to see all", () => {
    const home = buildHomeTab({
      ...emptyHome,
      limits: LIMITS,
      recent: [track("t1", { album_id: "a1" })],
      favorites: [track("t2"), track("t3")],
      albums,
      coverFor: (item) => `https://covers/${item.id}.jpg`,
    });

    const shelves = home.sections.filter((section) =>
      section.items.some((item) => item.images?.length),
    );
    expect(shelves.map((section) => section.header)).toEqual([
      "Good afternoon",
      "Favorites",
      "Albums",
    ]);
    // Each heading's chevron leads to the tab holding the full list.
    expect(shelves.map((section) => section.headerButtonId)).toEqual([
      "recent",
      "favorites",
      "albums",
    ]);
    expect(shelves[0].items[0].images).toEqual([
      { id: "album:a1", imageUrl: "https://covers/t1.jpg" },
    ]);
    expect(shelves[1].items[0].images?.map((image) => image.id)).toEqual([
      "track:t2",
      "track:t3",
    ]);
  });

  it("leads with what is playing", () => {
    const home = buildHomeTab({
      ...emptyHome,
      limits: LIMITS,
      currentTrack: track("t1", { title: "Song" }),
    });

    expect(home.sections[0].items[0]).toMatchObject({
      id: "now-playing",
      text: "Song",
      isPlaying: true,
      showsDisclosureIndicator: true,
    });
  });

  it("counts each album once, however often it was played", () => {
    const tiles = recentAlbumTiles(
      [
        track("t1", { album_id: "a1" }),
        track("t2", { album_id: "a1" }),
        track("t3", { album_id: "a2" }),
        track("t4"),
      ],
      4,
      () => "cover",
    );

    expect(tiles.map((tile) => tile.id)).toEqual(["album:a1", "album:a2"]);
  });

  it("shows no more covers than the car will draw", () => {
    const home = buildHomeTab({
      ...emptyHome,
      limits: { ...LIMITS, maximumImageRowCount: 2 },
      favorites: [track("t1"), track("t2"), track("t3")],
    });

    const shelf = home.sections.find((section) => section.header === "Favorites");
    expect(shelf?.items[0].images).toHaveLength(2);
  });

  it("says the library is empty rather than showing a blank screen", () => {
    const home = buildHomeTab({ ...emptyHome, limits: LIMITS });

    expect(allItems(home)).toHaveLength(0);
    expect(home.emptyTitle).toBe("Nothing here yet");

    const loading = buildHomeTab({ ...emptyHome, limits: LIMITS, loading: true });
    expect(loading).toMatchObject({ loading: true, emptyText: "Loading…" });
  });
});

describe("queue", () => {
  it("numbers pushed queue rows from the current position", () => {
    const queue = [track("t1"), track("t2"), track("t3"), track("t4")];
    const pushed = buildQueueTemplate({ limits: LIMITS, queue, index: 1 });

    expect(pushed.id).toBe(pushedTemplateId({ kind: "queue" }));
    // Queue positions, not track ids: the same track can sit in the queue
    // twice, and selecting one should jump rather than restart the list.
    expect(ids(pushed)).toEqual(["queued:2", "queued:3"]);
    expect(pushed.sections[0].header).toBe("2 songs");
  });

  it("dims the now-playing button when nothing is playing", () => {
    expect(nowPlayingNavButton(null)).toMatchObject({
      id: "now-playing",
      enabled: false,
    });
    expect(nowPlayingNavButton(track("t1")).enabled).toBe(true);
  });
});

describe("track list template", () => {
  it("puts Play and Shuffle above the songs", () => {
    const template = buildTrackListTemplate({
      id: "album:a1",
      title: "An Album",
      limits: LIMITS,
      tracks: [track("t1"), track("t2")],
    });

    expect(template.sections[0].items.map((item) => item.id)).toEqual([
      "play-list",
      "shuffle-list",
    ]);
    expect(ids(template).slice(2)).toEqual(["track:t1", "track:t2"]);
  });

  it("leaves them off a list there is nothing to choose within", () => {
    const template = buildTrackListTemplate({
      id: "album:a1",
      title: "An Album",
      limits: LIMITS,
      tracks: [track("t1")],
    });

    expect(ids(template)).toEqual(["track:t1"]);
  });

  it("gives every row artwork and a placeholder to hold its place", () => {
    const template = buildTrackListTemplate({
      id: "favorites",
      title: "Favorites",
      limits: LIMITS,
      tracks: [track("t1", { album_id: "a1" })],
      coverFor: (item) => `file:///covers/${item.id}.jpg`,
    });

    expect(contentRows(template)[0]).toMatchObject({
      imageUrl: "file:///covers/t1.jpg",
      symbol: "music.note",
    });
  });

  it("marks the current track and dims unplayable ones", () => {
    const template = buildTrackListTemplate({
      id: "favorites",
      title: "Favorites",
      limits: LIMITS,
      tracks: [track("t1"), track("t2")],
      currentTrackId: "t2",
      isPlayable: (id) => id !== "t1",
    });

    expect(contentRows(template)).toMatchObject([
      { id: "track:t1", isPlaying: false, enabled: false },
      { id: "track:t2", isPlaying: true, enabled: true },
    ]);
  });

  it("falls back to the album when a track has no artist", () => {
    const template = buildTrackListTemplate({
      id: "album:a1",
      title: "Album",
      limits: LIMITS,
      tracks: [track("t1", { artist: undefined, album_title: "The Album" })],
    });

    expect(contentRows(template)[0]).toMatchObject({
      detailText: "The Album",
    });
  });

  it("sums up the list in the section header", () => {
    const template = buildTrackListTemplate({
      id: "album:a1",
      title: "Album",
      limits: LIMITS,
      tracks: [
        track("t1", { duration_ms: 4 * 60_000 }),
        track("t2", { duration_ms: 6 * 60_000 }),
      ],
    });

    expect(template.sections[1].header).toBe("2 songs · 10 min");
  });

  it("says how much of a long list the head unit is showing", () => {
    const template = buildTrackListTemplate({
      id: "recent",
      title: "Recent",
      limits: { ...LIMITS, maximumItemCount: 4 },
      tracks: [track("t1"), track("t2"), track("t3")],
    });

    // Two rows go to Play and Shuffle, leaving room for two of the three.
    expect(contentRows(template)).toHaveLength(2);
    expect(template.sections[1].header).toBe("First 2 of 3 songs");
  });

  it("distinguishes an unloadable list from an empty one", () => {
    const unavailable = buildTrackListTemplate({
      id: "recent",
      title: "Recent",
      limits: LIMITS,
      tracks: undefined,
    });
    const loading = buildTrackListTemplate({
      id: "recent",
      title: "Recent",
      limits: LIMITS,
      tracks: undefined,
      loading: true,
    });
    const empty = buildTrackListTemplate({
      id: "recent",
      title: "Recent",
      limits: LIMITS,
      tracks: [],
      emptyText: "Songs you play show up here.",
    });

    expect(unavailable.emptyTitle).toMatch(/offline/i);
    expect(loading).toMatchObject({ loading: true, emptyText: "Loading…" });
    expect(empty.emptyText).toBe("Songs you play show up here.");
    expect(empty.emptyTitle).toBeUndefined();
  });
});

describe("browse templates", () => {
  const playlists: Playlist[] = [
    {
      id: "p1",
      owner_id: "u1",
      name: "Road Trip",
      visibility: "private",
      is_smart: false,
      created_at: "",
      updated_at: "",
    },
    {
      id: "p2",
      owner_id: "u1",
      name: "Recently Added",
      visibility: "private",
      is_smart: true,
      created_at: "",
      updated_at: "",
    },
  ];

  const albums: Album[] = [
    {
      id: "a1",
      title: "An Album",
      artist_name: "Someone",
      is_compilation: false,
      track_count: 9,
      duration_ms: 0,
      has_cover: true,
    },
    {
      id: "a2",
      title: "Coverless",
      is_compilation: false,
      track_count: 3,
      duration_ms: 0,
      has_cover: false,
    },
  ];

  it("builds playlist rows that push their tracks", () => {
    const template = buildPlaylistsTemplate({ limits: LIMITS, playlists });

    expect(allItems(template)).toMatchObject([
      {
        id: "playlist:p1",
        text: "Road Trip",
        detailText: undefined,
        showsDisclosureIndicator: true,
      },
      {
        id: "playlist:p2",
        text: "Recently Added",
        detailText: "Smart playlist",
        symbol: "sparkles",
      },
    ]);
    expect(template.sections[0].header).toBe("2 playlists");
  });

  it("builds album rows with their cover and their artist", () => {
    const template = buildAlbumsTemplate({ limits: LIMITS, albums });
    const rows = allItems(template);

    expect(rows[0]).toMatchObject({
      id: "album:a1",
      text: "An Album",
      detailText: "Someone",
    });
    expect(rows[0].imageUrl).toContain("/api/albums/a1/cover");
    // Nothing to show is better than a broken image request.
    expect(rows[1].imageUrl).toBeUndefined();
    expect(template.sections[0].header).toBe("2 albums");
  });

  it("reports an unloadable browse list as offline", () => {
    expect(
      buildPlaylistsTemplate({ limits: LIMITS, playlists: undefined })
        .emptyTitle,
    ).toMatch(/offline/i);
    expect(
      buildAlbumsTemplate({ limits: LIMITS, albums: undefined }).emptyTitle,
    ).toMatch(/offline/i);
  });
});
