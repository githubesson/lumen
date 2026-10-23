import { describe, expect, it } from "vitest";
import type { Playlist } from "@music-library/core";
import { playlistPickerRows } from "../lib/playlist-picker";

function playlist(id: string, name: string, extra: Partial<Playlist> = {}): Playlist {
  return {
    id,
    owner_id: "me",
    name,
    visibility: "private",
    is_smart: false,
    effective_role: "owner",
    created_at: "2026-01-01T00:00:00Z",
    updated_at: "2026-01-01T00:00:00Z",
    ...extra,
  };
}

const lateNight = playlist("p1", "late night", { updated_at: "2026-10-20T00:00:00Z" });
const polski = playlist("p2", "polski rap", { updated_at: "2026-10-19T00:00:00Z" });
const rage = playlist("p3", "rage", { updated_at: "2026-10-18T00:00:00Z" });
const shared = playlist("p4", "999", {
  owner_id: "kilo",
  visibility: "collaborative",
  effective_role: "editor",
  updated_at: "2026-10-15T00:00:00Z",
});
const gym = playlist("p5", "gym", { updated_at: "2026-10-11T00:00:00Z" });
const readOnly = playlist("p6", "car", {
  owner_id: "maja",
  visibility: "collaborative",
  effective_role: "viewer",
  updated_at: "2026-10-21T00:00:00Z",
});
const all = [gym, shared, rage, readOnly, polski, lateNight];

const ids = (rows: ReturnType<typeof playlistPickerRows>) => rows.map((row) => row.id);

describe("playlistPickerRows", () => {
  it("lists only playlists the user can add to, newest change first", () => {
    expect(ids(playlistPickerRows(all, [], ""))).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });

  it("puts the last few used first, then the rest, each once", () => {
    const rows = playlistPickerRows(all, ["p5", "p6", "missing", "p5", "p3", "p2", "p1"], "");
    // The read-only and unknown ids are skipped; three recent ones lead.
    expect(ids(rows)).toEqual(["p5", "p3", "p2", "p1", "p4"]);
  });

  it("narrows by name in the same order, ignoring case", () => {
    expect(ids(playlistPickerRows(all, ["p3"], "A"))).toEqual(["new", "p3", "p1", "p2"]);
  });

  it("offers a new playlist named as typed when no playlist has that name", () => {
    const rows = playlistPickerRows(all, [], "  Night Drive ");
    expect(rows).toEqual([{ type: "new", id: "new", name: "Night Drive" }]);
  });

  it("offers no new playlist when one already has the name", () => {
    expect(ids(playlistPickerRows(all, [], "RAGE "))).toEqual(["p3"]);
    // A name only a read-only playlist has can still be made.
    expect(ids(playlistPickerRows(all, [], "car"))).toEqual(["new"]);
  });

  it("shows everything for a blank search", () => {
    expect(ids(playlistPickerRows(all, [], "   "))).toEqual(["p1", "p2", "p3", "p4", "p5"]);
  });
});
