import { describe, expect, it } from "vitest";
import { qk } from "../lib/query-keys";

describe("qk.lyrics", () => {
  it("includes the duration the lyrics request sends", () => {
    // The server picks the recording by duration, so two lengths of the same
    // title must not share a cached answer.
    expect(qk.lyrics("t1", "Song", "Artist", "Album", 182)).toEqual([
      "lyrics", "t1", "Song", "Artist", "Album", 182,
    ]);
    expect(qk.lyrics("t1", "Song", "Artist", "Album", 182)).not.toEqual(
      qk.lyrics("t1", "Song", "Artist", "Album", 240),
    );
    expect(qk.lyrics("t1", "Song")).toEqual(["lyrics", "t1", "Song", "", "", ""]);
  });
});
