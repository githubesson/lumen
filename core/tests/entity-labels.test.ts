import { describe, expect, it } from "vitest";
import {
  albumArtistName,
  albumArtists,
  albumCredits,
  albumLength,
  albumSubtitle,
  artistMetaParts,
  artistSubtitle,
  libraryAlbumFacts,
  libraryAlbumMetaParts,
  metaLine,
  tidalAlbumFacts,
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

describe("album page", () => {
  const track = (artist: string, source?: "local" | "tidal") => ({ artist, source });
  const minutes = (...mins: number[]) => mins.map((m) => ({ duration_ms: m * 60_000 }));

  it("links the album artist when a library track credits it", () => {
    expect(
      albumCredits({ artist_id: "ar-1", artist_name: "Band" }, [track("Band"), track("Band, Guest")]),
    ).toEqual([{ name: "Band", artistId: "ar-1" }]);
    // A feature alone still credits the artist; case doesn't matter.
    expect(albumCredits({ artist_id: "ar-1", artist_name: "band" }, [track("Guest, Band")])).toEqual([
      { name: "band", artistId: "ar-1" },
    ]);
    // Names with commas in them still match whole.
    expect(
      albumCredits({ artist_id: "ar-2", artist_name: "Tyler, The Creator" }, [
        track("Tyler, The Creator, Guest"),
      ]),
    ).toEqual([{ name: "Tyler, The Creator", artistId: "ar-2" }]);
  });

  it("leaves the album artist unlinked when its page would be empty", () => {
    // Nothing on the album credits it, as on a compilation.
    expect(
      albumCredits({ artist_id: "ar-va", artist_name: "Various Artists" }, [track("A"), track("B")]),
    ).toEqual([{ name: "Various Artists" }]);
    // Only part of a longer name.
    expect(albumCredits({ artist_id: "ar-1", artist_name: "Band" }, [track("Band of Horses")])).toEqual([
      { name: "Band" },
    ]);
    // A TIDAL row says nothing about the library's artists.
    expect(albumCredits({ artist_id: "ar-1", artist_name: "Band" }, [track("Band", "tidal")])).toEqual([
      { name: "Band" },
    ]);
    // No library id at all.
    expect(albumCredits({ artist_name: "Band" }, [track("Band")])).toEqual([{ name: "Band" }]);
  });

  it("credits every main artist of a TIDAL release, linking only the album artist", () => {
    expect(
      albumCredits({ artist_id: "ar-1", artist_name: "A", artist_names: ["A", "B", "a"] }, [track("A, B")]),
    ).toEqual([{ name: "A", artistId: "ar-1" }, { name: "B" }]);
    expect(albumCredits({ artists: ["A", "B"], artist: "A" }, [track("A, B", "tidal")])).toEqual([
      { name: "A" },
      { name: "B" },
    ]);
    expect(albumCredits({ artist: "Foo Â· Bar" }, [])).toEqual([{ name: "Foo · Bar" }]);
    expect(albumCredits({}, [track("A")])).toEqual([]);
  });

  it("measures the list's length", () => {
    expect(albumLength(minutes(3, 4.5, 2))).toBe("3 tracks · 9 min");
    expect(albumLength(minutes(40, 35))).toBe("2 tracks · 1 hr 15 min");
    expect(albumLength(minutes(0.5))).toBe("1 track · 1 min");
    // Unknown lengths add nothing, and with none known only the count shows.
    expect(albumLength([{ duration_ms: 0 }, { duration_ms: Number.NaN }, ...minutes(2)])).toBe(
      "3 tracks · 2 min",
    );
    expect(albumLength([{ duration_ms: 0 }])).toBe("1 track");
    expect(albumLength([])).toBe("0 tracks");
  });

  it("lists a library album's details, leaving unknown ones out", () => {
    expect(libraryAlbumFacts({ release_year: 2021 }, minutes(3, 4))).toEqual([
      { key: "released", label: "Released", value: "2021" },
      { key: "length", label: "Length", value: "2 tracks · 7 min" },
    ]);
    expect(libraryAlbumFacts({}, minutes(3))).toEqual([
      { key: "length", label: "Length", value: "1 track · 3 min" },
    ]);
    // A copy of a TIDAL release says how much of it is saved.
    expect(
      libraryAlbumFacts({ tidal_album_id: "9", saved_count: 1, release_year: 2021 }, minutes(3, 4)).map(
        (fact) => fact.value,
      ),
    ).toEqual(["2021", "2 tracks · 7 min", "1 of 2 tracks"]);
    expect(libraryAlbumFacts({ saved_count: 1 }, minutes(3)).map((fact) => fact.key)).toEqual(["length"]);
  });

  it("lists a TIDAL album's saved count only when something is saved", () => {
    expect(tidalAlbumFacts({ saved_count: 0, release_year: 2020 }, minutes(3)).map((f) => f.key)).toEqual([
      "released",
      "length",
    ]);
    expect(tidalAlbumFacts({ saved_count: 2 }, minutes(3, 3, 3))).toEqual([
      { key: "length", label: "Length", value: "3 tracks · 9 min" },
      { key: "saved", label: "Saved", value: "2 of 3 tracks" },
    ]);
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
