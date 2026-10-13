import { describe, expect, it } from "vitest";
import { bentoAreas, type BentoTiles } from "../src/components/replay/bentoLayout";

const all: BentoTiles = { feat: true, list: true, genre: true, art: true, alb: true };

/** The rows of a grid-template-areas value, each as its cell names. */
const rows = (areas: string) =>
  [...areas.matchAll(/"([^"]+)"/g)].map((m) => m[1].split(" "));

/** Every name a tile could have, and what each arrangement must cover. */
function check(areas: string, columns: number) {
  const grid = rows(areas);
  for (const row of grid) expect(row).toHaveLength(columns);
  return new Set(grid.flat());
}

describe("bentoAreas", () => {
  it("lays every tile out as the mock does when a period has them all", () => {
    expect(rows(bentoAreas(all).wide)).toEqual([
      ["feat", "feat", "plays", "time"],
      ["feat", "feat", "tracks", "days"],
      ["list", "list", "act", "act"],
      ["list", "list", "genre", "genre"],
      ["art", "art", "alb", "alb"],
    ]);
    expect(rows(bentoAreas(all).narrow)).toEqual([
      ["feat", "feat"],
      ["plays", "time"],
      ["tracks", "days"],
      ["list", "list"],
      ["act", "act"],
      ["genre", "genre"],
      ["art", "art"],
      ["alb", "alb"],
    ]);
  });

  it("gives a missing tile's cells to its neighbours, in every combination", () => {
    const optional = ["feat", "list", "genre", "art", "alb"] as const;
    for (let mask = 0; mask < 1 << optional.length; mask++) {
      const tiles = Object.fromEntries(optional.map((k, i) => [k, !!(mask & (1 << i))])) as unknown as BentoTiles;
      const present = new Set(["plays", "time", "tracks", "days", "act", ...optional.filter((k) => tiles[k])]);
      for (const listFull of [false, true]) {
        const { wide, narrow } = bentoAreas(tiles, { listFull });
        // Exactly the present tiles, on full rows: nothing left for the
        // hairline background to show through.
        expect(check(wide, 4)).toEqual(present);
        expect(check(narrow, 2)).toEqual(present);
      }
    }
  });

  it("puts activity beside genres when there is nothing else on repeat", () => {
    expect(rows(bentoAreas({ ...all, list: false }).wide)[2]).toEqual(["act", "act", "genre", "genre"]);
    expect(rows(bentoAreas({ ...all, list: false, genre: false }).wide)[2]).toEqual(["act", "act", "act", "act"]);
    expect(rows(bentoAreas({ ...all, genre: false }).wide).slice(2, 4)).toEqual([
      ["list", "list", "act", "act"],
      ["art", "art", "alb", "alb"],
    ]);
  });

  it("gives the full track list the panel's width, and keeps the rest whole", () => {
    expect(rows(bentoAreas(all, { listFull: true }).wide).slice(2)).toEqual([
      ["list", "list", "list", "list"],
      ["act", "act", "genre", "genre"],
      ["art", "art", "alb", "alb"],
    ]);
    expect(rows(bentoAreas({ ...all, genre: false }, { listFull: true }).wide)[3]).toEqual(["act", "act", "act", "act"]);
    expect(bentoAreas(all, { listFull: true }).narrow).toBe(bentoAreas(all).narrow);
  });

  it("lets one cover tile take the whole row when the other is missing", () => {
    expect(rows(bentoAreas({ ...all, alb: false }).wide).at(-1)).toEqual(["art", "art", "art", "art"]);
    expect(rows(bentoAreas({ ...all, art: false }).wide).at(-1)).toEqual(["alb", "alb", "alb", "alb"]);
  });
});
