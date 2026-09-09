import { afterEach, expect, it, vi } from "vitest";
import { api, searchEntityID } from "../src/api";

afterEach(() => vi.unstubAllGlobals());

it("uses local IDs for local routes and strips remote prefixes for legacy payloads", () => {
  expect(
    searchEntityID({
      id: "local-id",
      source: "local",
      source_id: "upstream-id",
    }),
  ).toBe("local-id");
  expect(searchEntityID({ id: "tidal:42", source: "tidal" })).toBe("42");
  expect(
    searchEntityID({ id: "tidal:42", source: "tidal", source_id: "43" }),
  ).toBe("43");
});

it("keeps mixed cursors out of song-only continuation requests", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(Response.json({ tracks: [], next_offsets: {} }));
  vi.stubGlobal("fetch", fetch);
  await api.searchTracks({
    q: "hello",
    searchOffsets: { tidal: 25, local_album: 50, tidal_artist: 75 },
  });
  const url = new URL(fetch.mock.calls[0][0], "https://example.test");
  expect(url.searchParams.get("sources")).toBe("tidal");
  expect(url.searchParams.get("streams")).toBe("tidal");
  expect(url.searchParams.get("tidal_offset")).toBe("25");
  expect(url.searchParams.has("local_album_offset")).toBe(false);
});

it("preserves entity types and independent stream offsets across mixed pages", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        tracks: [{ id: "tidal:1" }],
        albums: [{ id: "tidal:1", source: "tidal" }],
        artists: [{ id: "local-artist", source: "local" }],
        next_offsets: { tidal: 25, tidal_album: 50 },
        warnings: ["Artists unavailable"],
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        tracks: [],
        albums: [{ id: "tidal:2", source: "tidal" }],
        artists: [],
        next_offsets: {},
      }),
    );
  vi.stubGlobal("fetch", fetch);
  const first = await api.searchPage({ q: "hello", type: "all" });
  expect(first.items.map((result) => result.type)).toEqual([
    "artist",
    "album",
    "track",
  ]);
  expect(first.warnings).toEqual(["Artists unavailable"]);
  const second = await api.searchPage({
    q: "hello",
    type: "all",
    offset: first.items.length,
    searchOffsets: first.nextOffsets,
  });
  const url = new URL(fetch.mock.calls[1][0], "https://example.test");
  expect(url.searchParams.get("type")).toBe("all");
  expect(url.searchParams.get("streams")).toBe("tidal,tidal_album");
  expect(url.searchParams.get("tidal_offset")).toBe("25");
  expect(url.searchParams.get("tidal_album_offset")).toBe("50");
  expect(url.searchParams.has("local_offset")).toBe(false);
  expect(second.nextOffsets).toEqual({});
  expect(second.total).toBe(4);
});

it("sends explicit empty continuation without restarting exhausted sources", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ tracks: [], albums: [], artists: [], next_offsets: {} }),
    );
  vi.stubGlobal("fetch", fetch);
  await api.searchPage({ q: "hello", type: "album", searchOffsets: {} });
  const url = new URL(fetch.mock.calls[0][0], "https://example.test");
  expect(url.searchParams.has("streams")).toBe(true);
  expect(url.searchParams.get("streams")).toBe("");
});

it("keeps legacy song-only consumers on track search and forwards cancellation", async () => {
  const fetch = vi
    .fn()
    .mockResolvedValue(
      Response.json({ tracks: [], albums: [], artists: [], next_offsets: {} }),
    );
  vi.stubGlobal("fetch", fetch);
  const controller = new AbortController();
  const pending = api.searchTracks({ q: "hello", signal: controller.signal });
  expect(
    new URL(fetch.mock.calls[0][0], "https://example.test").searchParams.get(
      "type",
    ),
  ).toBe("track");
  controller.abort();
  expect(fetch.mock.calls[0][1].signal.aborted).toBe(true);
  await pending;
});
