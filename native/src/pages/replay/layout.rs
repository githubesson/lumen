//! `components/replay/bentoLayout.ts`, and the CSS grid the bento's
//! `grid-template-areas` drive (`replay.css`): which cells each tile takes,
//! the columns' widths, and the auto rows' heights where a tile spans two.

/// `BentoTiles`: which of Replay's optional tiles a period has. The figures
/// and the activity chart are always there once a period has plays; the rest
/// depend on the data.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BentoTiles {
    /// The most played track.
    pub feat: bool,
    /// The tracks after it.
    pub list: bool,
    pub genre: bool,
    /// Top artists.
    pub art: bool,
    /// Top albums.
    pub alb: bool,
}

impl BentoTiles {
    pub const ALL: BentoTiles = BentoTiles { feat: true, list: true, genre: true, art: true, alb: true };
}

/// A `grid-template-areas` value: its rows, each as its cells' tile names.
pub type Areas = Vec<Vec<&'static str>>;

fn row(cells: &'static str) -> Vec<&'static str> {
    cells.split(' ').collect()
}

/// `bentoAreas`: the bento's areas, wide (four columns) and narrow (two).
/// The panel is one surface split by hairlines, so a missing tile can't
/// leave a hole: its neighbours take its cells instead. `list_full` gives the
/// track list the panel's whole width, for the full table of top tracks.
pub fn bento_areas(tiles: BentoTiles, list_full: bool) -> (Areas, Areas) {
    let mut wide: Vec<&'static str> = if tiles.feat {
        vec!["feat feat plays time", "feat feat tracks days"]
    } else {
        vec!["plays plays time time", "tracks tracks days days"]
    };
    if tiles.list && list_full {
        wide.push("list list list list");
        wide.push(if tiles.genre { "act act genre genre" } else { "act act act act" });
    } else if tiles.list {
        wide.push("list list act act");
        if tiles.genre {
            wide.push("list list genre genre");
        }
    } else {
        wide.push(if tiles.genre { "act act genre genre" } else { "act act act act" });
    }
    if tiles.art && tiles.alb {
        wide.push("art art alb alb");
    } else if tiles.art {
        wide.push("art art art art");
    } else if tiles.alb {
        wide.push("alb alb alb alb");
    }

    let mut narrow: Vec<&'static str> = Vec::new();
    if tiles.feat {
        narrow.push("feat feat");
    }
    narrow.extend(["plays time", "tracks days"]);
    if tiles.list {
        narrow.push("list list");
    }
    narrow.push("act act");
    if tiles.genre {
        narrow.push("genre genre");
    }
    if tiles.art {
        narrow.push("art art");
    }
    if tiles.alb {
        narrow.push("alb alb");
    }
    (wide.into_iter().map(row).collect(), narrow.into_iter().map(row).collect())
}

/// One tile's place: rows `r0..r1` and columns `c0..c1` (ends exclusive).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cell {
    pub name: &'static str,
    pub r0: usize,
    pub r1: usize,
    pub c0: usize,
    pub c1: usize,
}

/// Each named area's rectangle, in the order the names first appear.
pub fn cells(areas: &Areas) -> Vec<Cell> {
    let mut out: Vec<Cell> = Vec::new();
    for (r, cols) in areas.iter().enumerate() {
        for (c, name) in cols.iter().enumerate() {
            match out.iter_mut().find(|cell| cell.name == *name) {
                Some(cell) => {
                    cell.r1 = cell.r1.max(r + 1);
                    cell.c0 = cell.c0.min(c);
                    cell.c1 = cell.c1.max(c + 1);
                }
                None => out.push(Cell { name, r0: r, r1: r + 1, c0: c, c1: c + 1 }),
            }
        }
    }
    out
}

/// Consecutive rows no tile crosses the edge of: each band lays out on its
/// own, one under the other.
pub fn bands(areas: &Areas) -> Vec<std::ops::Range<usize>> {
    let all = cells(areas);
    let mut out = Vec::new();
    let mut start = 0;
    let mut end = 0;
    for r in 0..areas.len() {
        end = end.max(r + 1);
        for c in all.iter().filter(|c| c.r0 == r) {
            end = end.max(c.r1);
        }
        if end == r + 1 {
            out.push(start..end);
            start = end;
        }
    }
    out
}

/// A column's width in a grid `n` columns wide with 1 px gaps
/// (`repeat(n, minmax(0, 1fr))` over a `width`-wide box).
pub fn column(width: f32, n: usize) -> f32 {
    ((width - (n as f32 - 1.0)) / n as f32).max(0.0)
}

/// The width a tile spanning `span` columns takes (the gaps between them
/// included).
pub fn span_width(col: f32, span: usize) -> f32 {
    col * span as f32 + (span as f32 - 1.0)
}

/// The heights of a band's auto rows, from what the tiles in each single row
/// need (`rows`) and what the tallest tile spanning all of them needs
/// (`tall`): a spanning tile taller than its rows and the gaps between them
/// shares the difference out equally, as the grid algorithm grows auto rows
/// past their content (CSS Grid §12.5.1, "beyond limits").
pub fn band_rows(rows: &[f32], tall: f32) -> Vec<f32> {
    let n = rows.len().max(1) as f32;
    let have: f32 = rows.iter().sum::<f32>() + (n - 1.0);
    let extra = ((tall - have) / n).max(0.0);
    rows.iter().map(|r| r + extra).collect()
}

#[cfg(test)]
mod tests {
    use std::collections::BTreeSet;

    use super::*;

    const ALL: BentoTiles = BentoTiles::ALL;

    fn rows(areas: &Areas) -> Vec<Vec<&str>> {
        areas.clone()
    }

    /// Every row is `columns` wide; returns the names used.
    fn check(areas: &Areas, columns: usize) -> BTreeSet<&'static str> {
        for r in areas {
            assert_eq!(r.len(), columns, "{areas:?}");
        }
        areas.iter().flatten().copied().collect()
    }

    // replay-bento-layout.test.ts
    #[test]
    fn lays_every_tile_out_as_the_mock_does_when_a_period_has_them_all() {
        let (wide, narrow) = bento_areas(ALL, false);
        assert_eq!(
            rows(&wide),
            [
                vec!["feat", "feat", "plays", "time"],
                vec!["feat", "feat", "tracks", "days"],
                vec!["list", "list", "act", "act"],
                vec!["list", "list", "genre", "genre"],
                vec!["art", "art", "alb", "alb"],
            ]
        );
        assert_eq!(
            rows(&narrow),
            [
                vec!["feat", "feat"],
                vec!["plays", "time"],
                vec!["tracks", "days"],
                vec!["list", "list"],
                vec!["act", "act"],
                vec!["genre", "genre"],
                vec!["art", "art"],
                vec!["alb", "alb"],
            ]
        );
    }

    #[test]
    fn gives_a_missing_tiles_cells_to_its_neighbours_in_every_combination() {
        for mask in 0..32u32 {
            let bit = |i: u32| mask & (1 << i) != 0;
            let tiles = BentoTiles { feat: bit(0), list: bit(1), genre: bit(2), art: bit(3), alb: bit(4) };
            let mut present: BTreeSet<&str> = ["plays", "time", "tracks", "days", "act"].into_iter().collect();
            for (on, name) in [(tiles.feat, "feat"), (tiles.list, "list"), (tiles.genre, "genre"), (tiles.art, "art"), (tiles.alb, "alb")] {
                if on {
                    present.insert(name);
                }
            }
            for list_full in [false, true] {
                let (wide, narrow) = bento_areas(tiles, list_full);
                // Exactly the present tiles, on full rows: nothing left for
                // the hairline background to show through.
                assert_eq!(check(&wide, 4), present);
                assert_eq!(check(&narrow, 2), present);
                // And each a rectangle, so the bands can lay it out.
                for areas in [&wide, &narrow] {
                    for c in cells(areas) {
                        for r in c.r0..c.r1 {
                            for k in c.c0..c.c1 {
                                assert_eq!(areas[r][k], c.name, "{areas:?}");
                            }
                        }
                    }
                }
            }
        }
    }

    #[test]
    fn puts_activity_beside_genres_when_there_is_nothing_else_on_repeat() {
        let wide = |tiles| bento_areas(tiles, false).0;
        assert_eq!(wide(BentoTiles { list: false, ..ALL })[2], ["act", "act", "genre", "genre"]);
        assert_eq!(wide(BentoTiles { list: false, genre: false, ..ALL })[2], ["act", "act", "act", "act"]);
        assert_eq!(
            wide(BentoTiles { genre: false, ..ALL })[2..4],
            [vec!["list", "list", "act", "act"], vec!["art", "art", "alb", "alb"]]
        );
    }

    #[test]
    fn gives_the_full_track_list_the_panels_width_and_keeps_the_rest_whole() {
        assert_eq!(
            bento_areas(ALL, true).0[2..],
            [vec!["list", "list", "list", "list"], vec!["act", "act", "genre", "genre"], vec!["art", "art", "alb", "alb"]]
        );
        assert_eq!(bento_areas(BentoTiles { genre: false, ..ALL }, true).0[3], ["act", "act", "act", "act"]);
        assert_eq!(bento_areas(ALL, true).1, bento_areas(ALL, false).1);
    }

    #[test]
    fn lets_one_cover_tile_take_the_whole_row_when_the_other_is_missing() {
        assert_eq!(bento_areas(BentoTiles { alb: false, ..ALL }, false).0.last().unwrap(), &["art", "art", "art", "art"]);
        assert_eq!(bento_areas(BentoTiles { art: false, ..ALL }, false).0.last().unwrap(), &["alb", "alb", "alb", "alb"]);
    }

    #[test]
    fn bands_keep_spanning_tiles_whole() {
        let (wide, narrow) = bento_areas(ALL, false);
        assert_eq!(bands(&wide), [0..2, 2..4, 4..5]);
        assert_eq!(bands(&narrow).len(), narrow.len());
        assert_eq!(bands(&bento_areas(ALL, true).0), [0..2, 2..3, 3..4, 4..5]);
        let feat = cells(&wide)[0];
        assert_eq!((feat.name, feat.r0, feat.r1, feat.c0, feat.c1), ("feat", 0, 2, 0, 2));
    }

    #[test]
    fn spanning_tiles_grow_their_rows_equally() {
        // The stat rows (114.2 and 114.8) beside the 248 px featured track.
        let r = band_rows(&[114.2, 114.8], 248.0);
        assert!((r[0] - 123.2).abs() < 1e-3 && (r[1] - 123.8).abs() < 1e-3, "{r:?}");
        assert_eq!(band_rows(&[200.0, 100.0], 120.0), [200.0, 100.0]);
        assert_eq!(column(955.0, 4), 238.0);
        assert_eq!(span_width(238.0, 2), 477.0);
    }
}
