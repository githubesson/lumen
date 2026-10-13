import { describe, expect, it } from "vitest";
import {
  albumArtistName,
  albumArtists,
  albumCredits,
  albumLength,
  albumSubtitle,
  artistMetaParts,
  artistSubtitle,
  creditsOnly,
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
  const minutes = (...mins: number[]) => mins.map((m) => ({ duration_ms: m * 60_000 }));

  it("links the album artist when the server says it has a page", () => {
    expect(albumCredits({ artist_id: "ar-1", artist_name: "Band", artist_has_page: true })).toEqual([
      { name: "Band", artistId: "ar-1" },
    ]);
    // A name with commas in it is one artist, linked whole.
    expect(
      albumCredits({ artist_id: "ar-2", artist_name: "Earth, Wind & Fire", artist_has_page: true }),
    ).toEqual([{ name: "Earth, Wind & Fire", artistId: "ar-2" }]);
  });

  it("leaves the album artist unlinked without a page to open", () => {
    // Nothing in the library credits it, as on a compilation, or it is
    // known only from TIDAL plays.
    expect(
      albumCredits({ artist_id: "ar-va", artist_name: "Various Artists", artist_has_page: false }),
    ).toEqual([{ name: "Various Artists" }]);
    // A server too old to say.
    expect(albumCredits({ artist_id: "ar-1", artist_name: "Band" })).toEqual([{ name: "Band" }]);
    // No library id at all.
    expect(albumCredits({ artist_name: "Band", artist_has_page: true })).toEqual([{ name: "Band" }]);
  });

  it("credits every main artist of a TIDAL release, linking only the album artist", () => {
    expect(
      albumCredits({ artist_id: "ar-1", artist_name: "A", artist_has_page: true, artist_names: ["A", "B", "a"] }),
    ).toEqual([{ name: "A", artistId: "ar-1" }, { name: "B" }]);
    expect(albumCredits({ artists: ["A", "B"], artist: "A" })).toEqual([{ name: "A" }, { name: "B" }]);
    expect(albumCredits({ artist: "Foo Â· Bar" })).toEqual([{ name: "Foo · Bar" }]);
    expect(albumCredits({})).toEqual([]);
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

describe("creditsOnly", () => {
  it("is true when every artist a track credits is one of the album's", () => {
    const album = ["Halden Marsh", "Kestrel Bay"];
    expect(creditsOnly("Halden Marsh", album)).toBe(true);
    expect(creditsOnly("Kestrel Bay, Halden Marsh", album)).toBe(true);
    expect(creditsOnly("halden marsh, KESTREL BAY", album)).toBe(true);
    // Anyone else on the track.
    expect(creditsOnly("Halden Marsh, Hana Okoro", album)).toBe(false);
    expect(creditsOnly("Hana Okoro", album)).toBe(false);
    // A part of a name is not the name.
    expect(creditsOnly("Kestrel", album)).toBe(false);
    expect(creditsOnly("Kestrel Bay Band", album)).toBe(false);
  });

  it("keeps names with the separator in them whole", () => {
    const album = ["Earth, Wind & Fire", "Kestrel Bay"];
    expect(creditsOnly("Earth, Wind & Fire", album)).toBe(true);
    expect(creditsOnly("Kestrel Bay, Earth, Wind & Fire", album)).toBe(true);
    expect(creditsOnly("Earth", album)).toBe(false);
    expect(creditsOnly("Earth, Wind", album)).toBe(false);
    expect(creditsOnly("Earth, Wind & Fire, Hana Okoro", album)).toBe(false);
    // Billed as two artists, "Earth" and "Wind & Fire" each count.
    expect(creditsOnly("Wind & Fire, Earth", ["Earth", "Wind & Fire"])).toBe(true);
  });

  it("is false for a track crediting no one, or an album billing no one", () => {
    expect(creditsOnly(undefined, ["Band"])).toBe(false);
    expect(creditsOnly("  ", ["Band"])).toBe(false);
    expect(creditsOnly("Band", [])).toBe(false);
    expect(creditsOnly("Band", [""])).toBe(false);
  });
});
