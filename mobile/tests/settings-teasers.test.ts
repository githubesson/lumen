import { describe, expect, it } from "vitest";
import type { ReplayData } from "@music-library/core";
import { accountInitials, roleLabel } from "../lib/settings/account";
import { replayTeaser } from "../lib/settings/replay-teaser";

function replay(overrides: Partial<ReplayData> = {}): ReplayData {
  return {
    summary: {
      total_plays: 4812,
      total_ms: 1,
      unique_tracks: 1,
      unique_artists: 1,
      headline_artist: { id: "ar1", name: "Młody West", plays: 300 },
    },
    top_tracks: [],
    top_artists: [{ id: "ar2", name: "Someone Else", plays: 200 }],
    top_albums: [],
    top_genres: [],
    activity: [],
    bucket: "month",
    available_years: [2026],
    ...overrides,
  };
}

describe("replayTeaser", () => {
  it("names the year's top artist", () => {
    expect(replayTeaser(replay(), 138).subtitle).toBe("Młody West on top");
  });

  it("falls back to the top artists list, then the play count", () => {
    const noHeadline = replay();
    delete noHeadline.summary.headline_artist;
    expect(replayTeaser(noHeadline, 138).subtitle).toBe("Someone Else on top");
    expect(replayTeaser({ ...noHeadline, top_artists: [] }, 138).subtitle).toBe(
      `${(4812).toLocaleString()} plays`,
    );
  });

  it("has a plain row before the answer and an honest one for an empty year", () => {
    expect(replayTeaser(undefined, 138)).toEqual({ subtitle: null, covers: [] });
    const empty = replay();
    empty.summary.total_plays = 0;
    expect(replayTeaser(empty, 138)).toEqual({
      subtitle: "No plays yet this year",
      covers: [],
    });
  });

  it("copes with an older server's answer missing lists", () => {
    const partial = { summary: { total_plays: 3 } } as unknown as ReplayData;
    expect(replayTeaser(partial, 138)).toEqual({ subtitle: "3 plays", covers: [] });
  });

  it("collects up to four covers: top albums, then top tracks for the gaps", () => {
    const teaser = replayTeaser(
      replay({
        top_albums: [
          { id: "al1", title: "One", plays: 9 },
          // A TIDAL album has no library cover to show.
          { id: "td1", title: "Tidal", plays: 8, source: "tidal" },
          { id: "al2", title: "Two", plays: 7 },
        ],
        top_tracks: [
          // Its album is already in the collage.
          { id: "t1", title: "a", album_id: "al1", duration_ms: 1, plays: 5 },
          { id: "t2", title: "b", album_id: "al3", duration_ms: 1, plays: 4 },
          { id: "t3", title: "c", album_id: "al4", duration_ms: 1, plays: 3 },
          { id: "t4", title: "d", album_id: "al5", duration_ms: 1, plays: 2 },
        ],
      }),
      138,
    );
    expect(teaser.covers).toHaveLength(4);
    expect(teaser.covers[0]).toContain("/api/albums/al1/cover");
    expect(teaser.covers[1]).toContain("/api/albums/al2/cover");
    expect(teaser.covers[2]).toContain("/api/albums/al3/cover");
    expect(teaser.covers[3]).toContain("/api/albums/al4/cover");
    expect(teaser.covers.join(" ")).not.toContain("td1");
  });
});

describe("account labels", () => {
  it("takes the username's first two letters, as the desktop avatar does", () => {
    expect(accountInitials("esson")).toBe("ES");
    expect(accountInitials("  j ")).toBe("J");
    expect(accountInitials("🎧music")).toBe("🎧M");
    expect(accountInitials("")).toBe("?");
    expect(accountInitials(undefined)).toBe("?");
  });

  it("words the role as the invitation form does", () => {
    expect(roleLabel("admin")).toBe("Admin");
    expect(roleLabel("user")).toBe("User");
    expect(roleLabel(undefined)).toBe("");
  });
});
