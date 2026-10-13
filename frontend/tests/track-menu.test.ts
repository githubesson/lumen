import { expect, it } from "vitest";
import {
  addBatches,
  favoriteToggleIds,
  selectionArtists,
  selectionCovers,
  uniqueTracks,
} from "../src/lib/trackMenu";

const t = (id: string, extra: Record<string, string> = {}) => ({ id, title: id, duration_ms: 1, ...extra });

it("splits adds into batches the server accepts", () => {
  expect(addBatches(["a", "b", "c", "d", "e"], 2)).toEqual([["a", "b"], ["c", "d"], ["e"]]);
  expect(addBatches([], 2)).toEqual([]);
});

it("stacks one cover per album and lists each artist once", () => {
  const tracks = [
    t("1", { album_id: "x", artist: "Ada" }),
    t("2", { album_id: "x", artist: "Ada" }),
    t("3", { album_id: "y", artist: "Ben" }),
    t("4", { artist: "" }),
    t("5", { album_id: "z", artist: "Cy" }),
  ];
  expect(selectionCovers(tracks).map((track) => track.id)).toEqual(["1", "3", "4"]);
  expect(selectionArtists(tracks)).toBe("Ada, Ben, Cy");
});

it("repeats a cover when the selection has fewer albums than the stack", () => {
  const oneAlbum = ["1", "2", "3", "4"].map((id) => t(id, { album_id: "x" }));
  expect(selectionCovers(oneAlbum).map((track) => track.id)).toEqual(["1", "2", "3"]);
  const twoAlbums = [t("1", { album_id: "x" }), t("2", { album_id: "x" }), t("3", { album_id: "y" })];
  expect(selectionCovers(twoAlbums).map((track) => track.id)).toEqual(["1", "2", "3"]);
  expect(selectionCovers(twoAlbums.slice(0, 2)).map((track) => track.id)).toEqual(["1", "2"]);
});

it("toggles the missing favorites, or all of them when every one is", () => {
  const tracks = [t("a"), t("b"), t("c")];
  expect(favoriteToggleIds(tracks, (id) => id === "b")).toEqual(["a", "c"]);
  expect(favoriteToggleIds(tracks, () => false)).toEqual(["a", "b", "c"]);
  expect(favoriteToggleIds(tracks, () => true)).toEqual(["a", "b", "c"]);
});

it("keeps each track once, in order", () => {
  expect(uniqueTracks([t("a"), t("b"), t("a")]).map((track) => track.id)).toEqual(["a", "b"]);
});
