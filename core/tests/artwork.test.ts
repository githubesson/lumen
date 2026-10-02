import { afterEach, describe, expect, it } from "vitest";
import {
  albumArtUrl,
  albumCoverUrl,
  artistImageUrl,
  setBaseUrl,
  trackArtUrl,
} from "../src/api";

afterEach(() => setBaseUrl(""));

describe("albumCoverUrl", () => {
  it("adds a size and a cache-busting version as query parameters", () => {
    expect(albumCoverUrl("a1")).toBe("/api/albums/a1/cover");
    expect(albumCoverUrl("a1", 300)).toBe("/api/albums/a1/cover?size=300");
    expect(albumCoverUrl("a1", undefined, 1700)).toBe("/api/albums/a1/cover?v=1700");
    expect(albumCoverUrl("a1", 299.6, 1700)).toBe("/api/albums/a1/cover?size=300&v=1700");
  });

  it("leaves off a zero version or a bad size", () => {
    expect(albumCoverUrl("a1", 0, 0)).toBe("/api/albums/a1/cover");
    expect(albumCoverUrl("a1", Number.NaN, "")).toBe("/api/albums/a1/cover");
  });

  it("is absolute on mobile", () => {
    setBaseUrl("https://music.example");
    expect(albumCoverUrl("a 1", 64)).toBe("https://music.example/api/albums/a%201/cover?size=64");
  });
});

describe("albumArtUrl", () => {
  it("prefers a remote cover, sized when it's one of ours", () => {
    expect(albumArtUrl({ id: "a1", has_cover: false, cover_url: "/api/covers/remote?u=x" }, 64)).toBe(
      "/api/covers/remote?u=x&size=64",
    );
    expect(albumArtUrl({ id: "a1", cover_url: "https://cdn.example/c.jpg" }, 64)).toBe(
      "https://cdn.example/c.jpg",
    );
  });

  it("tries the library cover unless the payload says there is none", () => {
    expect(albumArtUrl({ id: "a1", has_cover: true }, 64)).toBe("/api/albums/a1/cover?size=64");
    // Releases built from track rows don't know: try it.
    expect(albumArtUrl({ id: "a1" }, 64)).toBe("/api/albums/a1/cover?size=64");
    expect(albumArtUrl({ id: "a1", has_cover: false }, 64)).toBeNull();
  });

  it("never asks the library for a TIDAL release's cover", () => {
    expect(albumArtUrl({ id: "tidal:9", source: "tidal" })).toBeNull();
    expect(albumArtUrl({ id: "9", source: "tidal", cover_url: "/api/covers/remote?u=y" })).toBe(
      "/api/covers/remote?u=y",
    );
  });

  it("passes a version through to the library cover only", () => {
    expect(albumArtUrl({ id: "a1", has_cover: true }, undefined, 5)).toBe("/api/albums/a1/cover?v=5");
  });
});

describe("trackArtUrl", () => {
  it("skips a track that says it has no art", () => {
    expect(trackArtUrl({ id: "t1", album_id: "a1", has_cover: false })).toBeNull();
    expect(trackArtUrl({ id: "t1", album_id: "a1" }, 64)).toBe("/api/albums/a1/cover?size=64");
    expect(trackArtUrl({ id: "t1" }, 64)).toBe("/api/tracks/t1/cover?size=64");
  });

  it("uses a remote cover even when has_cover is false", () => {
    expect(trackArtUrl({ id: "t1", has_cover: false, cover_url: "/api/covers/remote?u=z" })).toBe(
      "/api/covers/remote?u=z",
    );
  });
});

describe("artistImageUrl", () => {
  it("prefers the artist's own picture", () => {
    expect(artistImageUrl({ cover_url: "/api/covers/remote?u=a" }, [{ id: "t1" }], 128)).toBe(
      "/api/covers/remote?u=a&size=128",
    );
  });

  it("borrows the first track cover that may exist", () => {
    expect(
      artistImageUrl(null, [{ id: "t1", has_cover: false }, { id: "t2", album_id: "a2" }], 128),
    ).toBe("/api/albums/a2/cover?size=128");
    expect(artistImageUrl({}, [{ id: "t1", album_id: "a1" }])).toBe("/api/albums/a1/cover");
  });

  it("has nothing for an artist with no picture or tracks with art", () => {
    expect(artistImageUrl(undefined, [])).toBeNull();
    expect(artistImageUrl({ cover_url: "" }, [{ id: "t1", has_cover: false }])).toBeNull();
  });
});
