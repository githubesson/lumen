/**
 * Which of Replay's optional tiles a period has. The figures and the activity
 * chart are always there once a period has plays; the rest depend on the data
 * (one played track leaves nothing "also on repeat", untagged music has no
 * genres, and so on).
 */
export interface BentoTiles {
  /** The most played track. */
  feat: boolean;
  /** The tracks after it. */
  list: boolean;
  genre: boolean;
  /** Top artists. */
  art: boolean;
  /** Top albums. */
  alb: boolean;
}

const areas = (rows: string[]) => rows.map((row) => `"${row}"`).join(" ");

/**
 * `grid-template-areas` for the bento, wide (four columns) and narrow (two).
 * The panel is one surface split by hairlines, so a missing tile can't leave
 * a hole: its neighbours take its cells instead. `listFull` gives the track
 * list the panel's whole width, for the full table of top tracks.
 */
export function bentoAreas(
  tiles: BentoTiles,
  { listFull = false }: { listFull?: boolean } = {},
): { wide: string; narrow: string } {
  const wide = tiles.feat
    ? ["feat feat plays time", "feat feat tracks days"]
    : ["plays plays time time", "tracks tracks days days"];
  if (tiles.list && listFull) {
    wide.push("list list list list");
    wide.push(tiles.genre ? "act act genre genre" : "act act act act");
  } else if (tiles.list) {
    wide.push("list list act act");
    if (tiles.genre) wide.push("list list genre genre");
  } else {
    wide.push(tiles.genre ? "act act genre genre" : "act act act act");
  }
  if (tiles.art && tiles.alb) wide.push("art art alb alb");
  else if (tiles.art) wide.push("art art art art");
  else if (tiles.alb) wide.push("alb alb alb alb");

  const narrow = [
    ...(tiles.feat ? ["feat feat"] : []),
    "plays time",
    "tracks days",
    ...(tiles.list ? ["list list"] : []),
    "act act",
    ...(tiles.genre ? ["genre genre"] : []),
    ...(tiles.art ? ["art art"] : []),
    ...(tiles.alb ? ["alb alb"] : []),
  ];
  return { wide: areas(wide), narrow: areas(narrow) };
}
