import { describe, expect, it } from "vitest";
import type { Album, TrackDetail } from "../src/api";
import { buildAlbumPatch, buildTrackPatch } from "../src/metadata-edit";

const track: TrackDetail = {
  id: "t",
  source: "local",
  title: "Song",
  album_title: "Album",
  year: 2020,
  genre: "Rock",
  track_no: 2,
  disc_no: 1,
  duration_ms: 1000,
  format: "flac",
  file_size: 100,
  has_cover: false,
  favorited: false,
  artists: [
    { id: "a", name: "A B", role: "artist" },
    { id: "c", name: "C", role: "composer" },
  ],
};
const form = {
  title: "Song",
  artists: "A B",
  albumTitle: "Album",
  albumArtist: "",
  year: "2020",
  genre: "Rock",
  trackNo: "2",
  discNo: "1",
};
const album: Album = {
  id: "a",
  title: "Album",
  artist_name: "A B",
  is_compilation: false,
  release_year: 2020,
  track_count: 1,
  duration_ms: 1000,
  has_cover: false,
};
const albumForm = {
  title: "Album",
  albumArtist: "A B",
  year: "2020",
  isCompilation: false,
};

describe("metadata patches", () => {
  it("omits unchanged fields, composers, and an untouched album artist", () => {
    expect(buildTrackPatch(track, form)).toEqual({});
    expect(buildAlbumPatch(album, albumForm)).toEqual({});
  });
  it("compares artists individually, including order and empty credits", () => {
    expect(buildTrackPatch(track, { ...form, artists: "A, B" })).toEqual({
      artists: ["A", "B"],
    });
    expect(buildTrackPatch(track, { ...form, artists: "" })).toEqual({
      artists: [],
    });
    const multi = {
      ...track,
      artists: [
        { id: "a", name: "A", role: "artist" },
        { id: "b", name: "B", role: "artist" },
      ],
    };
    expect(buildTrackPatch(multi, { ...form, artists: "B, A" })).toEqual({
      artists: ["B", "A"],
    });
  });
  it("normalizes whitespace and preserves existing titles when the field is blank", () => {
    expect(
      buildTrackPatch(track, {
        ...form,
        title: "  Song  ",
        artists: " A B, ",
        albumArtist: "  ",
        genre: " Rock ",
      }),
    ).toEqual({});
    expect(buildAlbumPatch(album, { ...albumForm, title: " " })).toEqual({});
    expect(buildTrackPatch(track, { ...form, albumArtist: " New " })).toEqual({
      album_artist: "New",
    });
  });
  it("supports deliberate clearing of optional metadata", () => {
    expect(
      buildTrackPatch(track, {
        ...form,
        year: "",
        genre: "",
        trackNo: "",
        discNo: "",
        albumTitle: "",
      }),
    ).toEqual({ year: 0, genre: "", track_no: 0, disc_no: 0, album_title: "" });
    expect(
      buildAlbumPatch(album, {
        ...albumForm,
        year: "",
        albumArtist: "",
        isCompilation: true,
      }),
    ).toEqual({ release_year: 0, album_artist: "", is_compilation: true });
  });
});
