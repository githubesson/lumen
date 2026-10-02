import { describe, expect, it } from "vitest";
import {
  albumArtistName,
  albumArtists,
  albumSubtitle,
  artistMetaParts,
  artistSubtitle,
  libraryAlbumMetaParts,
  metaLine,
  tidalAlbumMetaParts,
  tidalArtistMetaParts,
} from "../src/entity-labels";

describe("album labels", () => {
  it("falls back to Various Artists or Unknown artist", () => {
    expect(albumArtistName({ artist_name: "Band", is_compilation: false })).toBe("Band");
    expect(albumArtistName({ is_compilation: true })).toBe("Various Artists");
    expect(albumArtistName({ artist_name: "", is_compilation: false })).toBe("Unknown artist");
  });

  it("cleans mojibake in names", () => {
    expect(albumArtistName({ artist_name: "Foo Â· Bar", is_compilation: false })).toBe("Foo · Bar");
    expect(albumArtists({ artist_names: ["Foo Â· Bar"] })).toBe("Foo · Bar");
  });

  it("joins card parts with a middle dot", () => {
    expect(albumSubtitle({ artist_name: "Band", is_compilation: false, track_count: 1 })).toBe(
      "Band · 1 track",
    );
    expect(
      albumSubtitle({ is_compilation: true, track_count: 12, source: "tidal" }),
    ).toBe("Various Artists · 12 tracks · TIDAL");
    expect(
      albumSubtitle(
        { artist_name: "Band", is_compilation: false, track_count: 12, source: "tidal" },
        { trackCount: false },
      ),
    ).toBe("Band · TIDAL");
  });

  it("credits every main artist on an album page, else the album artist", () => {
    expect(albumArtists({ artist_names: ["A", "B"], artist_name: "A" })).toBe("A, B");
    expect(albumArtists({ artist_names: [], artist_name: "A" })).toBe("A");
    expect(albumArtists({ artists: ["A", "B"], artist: "A" })).toBe("A, B");
    expect(albumArtists({ artist: "A" })).toBe("A");
    expect(albumArtists({})).toBe("");
  });

  const texts = (parts: { text: string }[]) => parts.map((part) => part.text);

  it("lists a library album's count, saved part and year", () => {
    expect(libraryAlbumMetaParts({ track_count: 1 })).toEqual([{ key: "tracks", text: "1 track" }]);
    expect(
      libraryAlbumMetaParts({ track_count: 12, tidal_album_id: "9", saved_count: 0, release_year: 2021 }),
    ).toEqual([
      { key: "tracks", text: "12 tracks" },
      { key: "saved", text: "0 saved" },
      { key: "year", text: "2021" },
    ]);
    // saved_count means nothing without the TIDAL release it counts against.
    expect(texts(libraryAlbumMetaParts({ track_count: 12, saved_count: 4 }))).toEqual(["12 tracks"]);
    expect(texts(libraryAlbumMetaParts({ track_count: 12, tidal_album_id: "9" }))).toEqual([
      "12 tracks",
    ]);
  });

  it("lists a TIDAL album's saved part only when something is saved", () => {
    expect(texts(tidalAlbumMetaParts({ track_count: 10, saved_count: 0, release_year: 2020 }))).toEqual([
      "10 tracks",
      "2020",
    ]);
    expect(texts(tidalAlbumMetaParts({ track_count: 10, saved_count: 3 }))).toEqual([
      "10 tracks",
      "3 saved",
    ]);
    expect(metaLine(tidalAlbumMetaParts({ track_count: 10, saved_count: 3, release_year: 2020 }))).toBe(
      "10 tracks · 3 saved · 2020",
    );
    expect(metaLine(["a", "", "b"])).toBe("a · b");
  });
});

describe("artist labels", () => {
  it("counts a library artist's tracks and albums", () => {
    expect(artistMetaParts({ track_count: 1, album_count: 0 })).toEqual(["1 track"]);
    expect(artistSubtitle({ track_count: 12, album_count: 2 })).toBe("12 tracks · 2 albums");
  });

  it("labels a TIDAL artist, keeping an album count when there is one", () => {
    expect(artistSubtitle({ track_count: 0, album_count: 0, source: "tidal" })).toBe("TIDAL artist");
    expect(artistSubtitle({ track_count: 0, album_count: 3, source: "tidal" })).toBe(
      "TIDAL artist · 3 albums",
    );
  });

  it("summarizes a TIDAL artist page", () => {
    expect(tidalArtistMetaParts(8, 1)).toEqual(["8 releases", "1 popular track"]);
    expect(tidalArtistMetaParts(0, 10)).toEqual(["10 popular tracks"]);
    expect(tidalArtistMetaParts(0, 0)).toEqual([]);
  });
});
