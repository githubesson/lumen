import { expect, it } from "vitest";
import type { SearchAlbum, TrackListItem } from "../src/api";
import {
  filterReleases,
  foldReleaseVersions,
  hasReleaseFilters,
  libraryArtistReleases,
  releaseKind,
  releaseSubtitle,
  releaseVersionLabels,
  releaseVersionsOf,
  tidalArtistReleases,
} from "../src/artist-releases";

const minutes = (n: number) => n * 60_000;

function album(id: string, overrides: Partial<SearchAlbum>): SearchAlbum {
  return {
    id,
    title: id,
    is_compilation: false,
    track_count: 10,
    duration_ms: minutes(40),
    has_cover: true,
    source: "tidal",
    ...overrides,
  };
}

it("classifies releases by track count and runtime", () => {
  expect(releaseKind(1, minutes(3))).toBe("Single");
  expect(releaseKind(3, minutes(29))).toBe("Single");
  expect(releaseKind(3, minutes(31))).toBe("Album");
  expect(releaseKind(6, minutes(20))).toBe("EP");
  expect(releaseKind(6, minutes(30))).toBe("Album");
  expect(releaseKind(7, minutes(20))).toBe("Album");
  expect(releaseKind(2, 0)).toBe("Single");
  expect(releaseKind(0, 0)).toBe("Album");
});

it("orders TIDAL releases newest first and keeps same-year order", () => {
  const releases = tidalArtistReleases([
    album("old-album", { release_year: 2020 }),
    album("new-album", { release_year: 2024 }),
    album("undated", { release_year: undefined }),
    album("new-single", { release_year: 2024, track_count: 1, duration_ms: minutes(3), cover_url: "/c" }),
  ]);
  expect(releases.map((r) => r.id)).toEqual(["new-album", "new-single", "old-album", "undated"]);
  expect(releases[1]).toMatchObject({ kind: "Single", cover_url: "/c", release_year: 2024 });
  expect(releaseSubtitle(releases[1])).toBe("2024 · Single");
  expect(releaseSubtitle(releases[3])).toBe("Album");
});

it("filters albums from singles and EPs only when both exist", () => {
  const releases = tidalArtistReleases([
    album("lp", {}),
    album("ep", { track_count: 5, duration_ms: minutes(18) }),
    album("single", { track_count: 1, duration_ms: minutes(3) }),
  ]);
  expect(hasReleaseFilters(releases)).toBe(true);
  expect(filterReleases(releases, "albums").map((r) => r.id)).toEqual(["lp"]);
  expect(filterReleases(releases, "singles").map((r) => r.id)).toEqual(["ep", "single"]);
  expect(filterReleases(releases, "all")).toBe(releases);
  expect(hasReleaseFilters(filterReleases(releases, "albums"))).toBe(false);
});

it("ignores a filter that no longer applies to the releases", () => {
  const albumsOnly = tidalArtistReleases([album("lp", {}), album("lp2", {})]);
  expect(filterReleases(albumsOnly, "singles")).toBe(albumsOnly);
  expect(filterReleases(albumsOnly, "albums")).toBe(albumsOnly);
});

it("groups library tracks into albums in list order", () => {
  const track = (id: string, album_id?: string, album_title?: string): TrackListItem => ({
    id,
    title: id,
    duration_ms: 1000,
    album_id,
    album_title,
    has_cover: true,
  });
  const releases = libraryArtistReleases([
    track("1", "b", "Second"),
    track("2", "a", "First"),
    track("3", "b", "Second"),
    track("4"),
  ]);
  expect(releases).toEqual([
    { id: "b", title: "Second", track_count: 2, has_cover: true, cover_url: undefined },
    { id: "a", title: "First", track_count: 1, has_cover: true, cover_url: undefined },
  ]);
  expect(hasReleaseFilters(releases)).toBe(false);
  expect(releaseSubtitle(releases[0])).toBe("2 tracks");
});

// TIDAL's listing for one artist: an album in explicit, clean and Dolby Atmos.
const roads = (id: string, overrides: Partial<SearchAlbum>) =>
  album(id, { title: "ALL ROADS LEAD HOME", source_id: id, release_year: 2026, explicit: true, ...overrides });

it("folds a release's versions into one tile that opens stereo explicit", () => {
  const releases = foldReleaseVersions(
    tidalArtistReleases([
      roads("atmos", { dolby_atmos: true }),
      roads("clean", { explicit: false }),
      roads("explicit", {}),
      album("other", { release_year: 2025 }),
      // A deluxe edition, and a single sharing the title, keep their own tiles.
      roads("deluxe", { version: "Deluxe" }),
      roads("single", { track_count: 1, duration_ms: minutes(3) }),
    ]),
  );
  expect(releases.map((r) => r.id)).toEqual(["explicit", "deluxe", "single", "other"]);
  expect(releases[0].versions?.map((v) => v.id)).toEqual(["explicit", "clean", "atmos"]);
  expect(releases[1].versions).toBeUndefined();
  expect(releaseSubtitle(releases[0])).toBe("2026 · Album · 3 versions");
  expect(releaseSubtitle(releases[1])).toBe("2026 · Album");
});

it("keeps same-titled albums from different years apart, and folds a clean copy that became an EP", () => {
  const releases = foldReleaseVersions(
    tidalArtistReleases([
      album("weezer-1994", { title: "Weezer", release_year: 1994 }),
      album("weezer-2001", { title: "Weezer", release_year: 2001 }),
      roads("explicit", { track_count: 7, duration_ms: minutes(28) }),
      roads("clean", { explicit: false, track_count: 6, duration_ms: minutes(24) }),
    ]),
  );
  expect(releases.map((r) => [r.id, r.versions?.map((v) => v.id)])).toEqual([
    ["explicit", ["explicit", "clean"]],
    ["weezer-2001", undefined],
    ["weezer-1994", undefined],
  ]);
  expect(releases[0].kind).toBe("Album");
});

it("finds an album's versions among the artist's releases", () => {
  const releases = tidalArtistReleases([
    roads("explicit", {}),
    roads("clean", { explicit: false }),
    album("other", { source_id: "other" }),
  ]);
  expect(releaseVersionsOf(releases, "clean")?.map((v) => v.id)).toEqual(["explicit", "clean"]);
  expect(releaseVersionsOf(releases, "other")).toBeNull();
  expect(releaseVersionsOf(releases, "missing")).toBeNull();
});

it("names versions by what differs between them", () => {
  const labels = (albums: SearchAlbum[]) =>
    releaseVersionLabels(foldReleaseVersions(tidalArtistReleases(albums))[0].versions ?? []);
  expect(
    labels([roads("e", {}), roads("c", { explicit: false }), roads("a", { dolby_atmos: true })]),
  ).toEqual([
    { label: "Explicit", description: "Stereo · Explicit · 10 tracks · 2026" },
    { label: "Clean", description: "Stereo · Clean · 10 tracks · 2026" },
    { label: "Dolby Atmos", description: "Dolby Atmos · Explicit · 10 tracks · 2026" },
  ]);
  // Nothing explicit: no "Clean" anywhere.
  expect(
    labels([roads("s", { explicit: false }), roads("a", { explicit: false, dolby_atmos: true })]),
  ).toEqual([
    { label: "Stereo", description: "Stereo · 10 tracks · 2026" },
    { label: "Dolby Atmos", description: "Dolby Atmos · 10 tracks · 2026" },
  ]);
  expect(
    labels([
      roads("a1", { dolby_atmos: true }),
      roads("a2", { dolby_atmos: true, explicit: false }),
      roads("s", {}),
    ]).map((l) => l.label),
  ).toEqual(["Stereo", "Dolby Atmos · Explicit", "Dolby Atmos · Clean"]);
  // Otherwise alike: the track count, or else a number, tells them apart.
  expect(labels([roads("x", {}), roads("y", { track_count: 12 })]).map((l) => l.label)).toEqual([
    "10 tracks",
    "12 tracks",
  ]);
  expect(labels([roads("x", {}), roads("y", {})]).map((l) => l.label)).toEqual([
    "Version 1",
    "Version 2",
  ]);
  expect(
    labels([roads("x", {}), roads("y", {}), roads("c", { explicit: false })]).map((l) => l.label),
  ).toEqual(["Explicit 1", "Explicit 2", "Clean"]);
});
