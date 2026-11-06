//! `boardLayout.ts`: where each Home panel sits on the board.
//!
//! The board is a six-column grid when wide (three visual columns, so a panel
//! can also take half the width) and two columns when medium; narrow boards
//! stack every panel in one column. Panels without content are left out, and
//! the ones that remain widen to close the gap, so the board never shows
//! holes: with everything present it's
//!
//! ```text
//! Jump back in  Jump back in  On repeat
//! Recently      Favorites     On repeat
//! Albums        Albums        Playlists
//! Top artists   Top artists   Top artists
//! ```
//!
//! and on the medium board Jump back in, On repeat, Recently | Favorites,
//! Albums, Playlists | Top artists.
//!
//! That's the default board. A customized one packs its panels by their own
//! sizes instead (`pack_board`).

use super::kinds::PanelKind;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct BoardCell {
    /// The panel's id (on the default board, also its kind).
    pub id: String,
    /// Columns it spans on the wide board, of six.
    pub span: usize,
    /// Rows it spans on the wide board.
    pub rows: usize,
    /// Columns it spans on the medium board, of two.
    pub span_md: usize,
    /// Rows it spans on the medium board.
    pub rows_md: usize,
    /// Where it starts (grid lines from 1) on a packed board: the wide
    /// board's, then the medium one's. The default board leaves placing to
    /// the grid.
    pub col: Option<usize>,
    pub row: Option<usize>,
    pub col_md: Option<usize>,
    pub row_md: Option<usize>,
}

fn cell(id: PanelKind, span: usize, span_md: usize, rows: usize, rows_md: usize) -> BoardCell {
    BoardCell { id: id.id().to_string(), span, rows, span_md, rows_md, col: None, row: None, col_md: None, row_md: None }
}

/// The panels to render, in order, with their spans. The order is also the
/// reading and focus order; the grid places them in it. `present` holds the
/// default kinds that are on the board.
pub fn board_layout(present: &[PanelKind]) -> Vec<BoardCell> {
    use PanelKind::*;
    let has = |k: PanelKind| present.contains(&k);
    let only = |ids: &[PanelKind]| ids.iter().copied().filter(|k| has(*k)).collect::<Vec<_>>();
    let mut out = Vec::new();

    if has(Repeat) {
        // On repeat runs down the right of Jump back in and the two short
        // lists. On the medium board it takes the full width instead and the
        // short lists pair up under it.
        let middle = only(&[Recent, Favorites]);
        if has(Resume) {
            out.push(cell(Resume, 4, 2, 1, 1));
            out.push(cell(Repeat, 2, 2, if middle.is_empty() { 1 } else { 2 }, 1));
        } else {
            out.push(cell(Repeat, if middle.is_empty() { 6 } else { 2 }, 2, 1, 1));
        }
        for id in &middle {
            out.push(cell(*id, 4 / middle.len(), 2 / middle.len(), 1, 1));
        }
        let albums = has(Albums);
        let playlists = has(Playlists);
        // Medium: Playlists and Top artists pair up when both are there.
        let pair = playlists && has(Artists);
        if albums {
            out.push(cell(Albums, if playlists { 4 } else { 6 }, 2, 1, 1));
        }
        if playlists {
            out.push(cell(Playlists, if albums { 2 } else { 6 }, if pair { 1 } else { 2 }, 1, 1));
        }
        if has(Artists) {
            out.push(cell(Artists, 6, if pair { 1 } else { 2 }, 1, 1));
        }
        return out;
    }

    if has(Resume) {
        out.push(cell(Resume, 6, 2, 1, 1));
    }
    let lists = only(&[Recent, Favorites, Playlists]);
    for (i, id) in lists.iter().enumerate() {
        // Medium: in pairs, and an odd one out takes the full width.
        let alone = lists.len() % 2 == 1 && i == lists.len() - 1;
        out.push(cell(*id, 6 / lists.len(), if alone { 2 } else { 1 }, 1, 1));
    }
    for id in only(&[Albums, Artists]) {
        out.push(cell(id, 6, 2, 1, 1));
    }
    out
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PackItem {
    pub id: String,
    /// Columns it asks for.
    pub w: usize,
    /// Rows it asks for.
    pub h: usize,
}

/// Where a packed panel went: its first column and row (from 0) and its spans.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Placement {
    pub id: String,
    pub col: usize,
    pub row: usize,
    pub w: usize,
    pub h: usize,
}

/// Places panels on a grid of `columns` in order, by the sizes they ask for,
/// and leaves no holes. Each goes in the first place along its row where it
/// fits, as the grid itself would place it. A row is closed once the next
/// panel doesn't fit in what's left of it, and its gaps are filled: the
/// panels that start in the row widen into a gap beside them, sharing it out
/// so the narrowest grow first. A gap with no such panel beside it, under
/// panels from the row above, has them grow down into it.
pub fn pack_board(items: &[PackItem], columns: usize) -> Vec<Placement> {
    struct Packer {
        placed: Vec<Placement>,
        grid: Vec<Vec<Option<usize>>>,
        columns: usize,
    }
    impl Packer {
        fn ensure(&mut self, row: usize) {
            while self.grid.len() <= row {
                self.grid.push(vec![None; self.columns]);
            }
        }
        fn paint(&mut self, i: usize, value: Option<usize>) {
            let p = self.placed[i].clone();
            self.ensure(p.row + p.h - 1);
            for r in p.row..p.row + p.h {
                for c in p.col..p.col + p.w {
                    self.grid[r][c] = value;
                }
            }
        }
        fn free(&mut self, row: usize, col: usize, w: usize, h: usize) -> bool {
            self.ensure(row + h - 1);
            (row..row + h).all(|r| (col..col + w).all(|c| self.grid[r][c].is_none()))
        }
        fn starts_in(&self, i: Option<usize>, row: usize) -> Option<usize> {
            i.filter(|i| self.placed[*i].row == row)
        }
        fn at(&self, row: usize, col: isize) -> Option<usize> {
            if col < 0 || col as usize >= self.columns {
                return None;
            }
            self.grid.get(row).and_then(|r| r[col as usize])
        }
        /// Lays `group` (side by side, in order) out across columns `from` to `to`.
        fn spread(&mut self, group: &[usize], from: usize, to: usize) {
            let mut widths: Vec<usize> = group.iter().map(|i| self.placed[*i].w).collect();
            let total: usize = widths.iter().sum();
            let mut extra = (to + 1 - from) as isize - total as isize;
            while extra > 0 {
                let mut narrowest = 0;
                for (j, w) in widths.iter().enumerate() {
                    if *w < widths[narrowest] {
                        narrowest = j;
                    }
                }
                widths[narrowest] += 1;
                extra -= 1;
            }
            for i in group {
                self.paint(*i, None);
            }
            let mut col = from;
            for (j, i) in group.iter().enumerate() {
                self.placed[*i].col = col;
                self.placed[*i].w = widths[j];
                col += widths[j];
                self.paint(*i, Some(*i));
            }
        }
        fn fill_gap(&mut self, row: usize, a: usize, b: usize) {
            let mut group: Vec<usize> = Vec::new();
            let mut c = a as isize - 1;
            while let Some(i) = self.starts_in(self.at(row, c), row) {
                group.insert(0, i);
                c = self.placed[group[0]].col as isize - 1;
            }
            if !group.is_empty() {
                let from = self.placed[group[0]].col;
                return self.spread(&group, from, b);
            }
            let mut c = b as isize + 1;
            while let Some(i) = self.starts_in(self.at(row, c), row) {
                group.push(i);
                let last = &self.placed[*group.last().unwrap()];
                c = (last.col + last.w) as isize;
            }
            if let Some(last) = group.last() {
                let last = &self.placed[*last];
                let to = last.col + last.w - 1;
                return self.spread(&group, a, to);
            }
            // Both sides are the edge or a panel from a row above, so the
            // panels above the gap span exactly it: they grow down into it.
            let mut above: Vec<usize> = Vec::new();
            if row > 0 {
                for c in a..=b {
                    if let Some(i) = self.grid[row - 1][c]
                        && !above.contains(&i)
                    {
                        above.push(i);
                    }
                }
            }
            for i in above {
                self.placed[i].h += 1;
                self.paint(i, Some(i));
            }
        }
        fn close_row(&mut self, row: usize) {
            self.ensure(row);
            let mut c = 0;
            while c < self.columns {
                if self.grid[row][c].is_some() {
                    c += 1;
                    continue;
                }
                let mut b = c;
                while b + 1 < self.columns && self.grid[row][b + 1].is_none() {
                    b += 1;
                }
                self.fill_gap(row, c, b);
                c = b + 1;
            }
        }
    }

    let mut p = Packer { placed: Vec::new(), grid: Vec::new(), columns };
    let (mut row, mut col) = (0, 0);
    for item in items {
        let w = item.w.clamp(1, columns);
        let h = item.h.max(1);
        loop {
            let mut c = col;
            while c + w <= columns && !p.free(row, c, w, h) {
                c += 1;
            }
            if c + w <= columns {
                p.placed.push(Placement { id: item.id.clone(), col: c, row, w, h });
                let i = p.placed.len() - 1;
                p.paint(i, Some(i));
                col = c + w;
                break;
            }
            p.close_row(row);
            row += 1;
            col = 0;
        }
    }
    let mut r = row;
    while r < p.grid.len() {
        p.close_row(r);
        r += 1;
    }
    p.placed
}

/// A panel's width on the medium board: half for a third or half, else all of it.
pub fn medium_width(w: usize) -> usize {
    if w >= 4 { 2 } else { 1 }
}

/// A customized board: its panels packed by their sizes, on the wide board
/// and the medium one.
pub fn packed_layout(items: &[PackItem]) -> Vec<BoardCell> {
    let wide = pack_board(items, 6);
    let medium_items: Vec<PackItem> = items.iter().map(|i| PackItem { w: medium_width(i.w), ..i.clone() }).collect();
    let medium = pack_board(&medium_items, 2);
    items
        .iter()
        .enumerate()
        .map(|(i, item)| BoardCell {
            id: item.id.clone(),
            span: wide[i].w,
            rows: wide[i].h,
            col: Some(wide[i].col + 1),
            row: Some(wide[i].row + 1),
            span_md: medium[i].w,
            rows_md: medium[i].h,
            col_md: Some(medium[i].col + 1),
            row_md: Some(medium[i].row + 1),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::super::arrangement::default_arrangement;
    use super::super::kinds::{PANEL_HEIGHTS, PANEL_WIDTHS};
    use super::*;
    use PanelKind::*;

    const ALL: [PanelKind; 7] = [Resume, Repeat, Recent, Favorites, Albums, Playlists, Artists];

    /// CSS grid's sparse auto-placement, for spans only.
    pub fn place(cells: &[BoardCell], columns: usize, medium: bool) -> Vec<Vec<Option<String>>> {
        let mut grid: Vec<Vec<Option<String>>> = Vec::new();
        let (mut row, mut col) = (0usize, 0usize);
        for cell in cells {
            let (span, rows) = if medium { (cell.span_md, cell.rows_md) } else { (cell.span, cell.rows) };
            loop {
                if col + span > columns {
                    row += 1;
                    col = 0;
                    continue;
                }
                while grid.len() < row + rows {
                    grid.push(vec![None; columns]);
                }
                if (row..row + rows).all(|r| (col..col + span).all(|c| grid[r][c].is_none())) {
                    break;
                }
                col += 1;
            }
            for r in row..row + rows {
                for c in col..col + span {
                    grid[r][c] = Some(cell.id.clone());
                }
            }
            col += span;
        }
        grid
    }

    fn rows(r: &[&[&str]]) -> Vec<Vec<Option<String>>> {
        r.iter().map(|row| row.iter().map(|s| Some(s.to_string())).collect()).collect()
    }

    #[test]
    fn full_board_like_the_mock() {
        let cells = board_layout(&ALL);
        assert_eq!(
            place(&cells, 6, false),
            rows(&[
                &["resume", "resume", "resume", "resume", "repeat", "repeat"],
                &["recent", "recent", "favorites", "favorites", "repeat", "repeat"],
                &["albums", "albums", "albums", "albums", "playlists", "playlists"],
                &["artists"; 6],
            ])
        );
        assert_eq!(
            place(&cells, 2, true),
            rows(&[&["resume", "resume"], &["repeat", "repeat"], &["recent", "favorites"], &["albums", "albums"], &["playlists", "artists"]])
        );
    }

    #[test]
    fn lists_share_a_row_without_repeat() {
        let cells = board_layout(&[Resume, Recent, Favorites, Albums, Playlists]);
        assert_eq!(
            place(&cells, 6, false),
            rows(&[&["resume"; 6], &["recent", "recent", "favorites", "favorites", "playlists", "playlists"], &["albums"; 6]])
        );
        assert_eq!(
            place(&cells, 2, true),
            rows(&[&["resume", "resume"], &["recent", "favorites"], &["playlists", "playlists"], &["albums", "albums"]])
        );
        assert_eq!(board_layout(&[Resume]), vec![cell(Resume, 6, 2, 1, 1)]);
    }

    #[test]
    fn repeat_takes_the_top_without_resume() {
        let cells = board_layout(&ALL[1..]);
        assert_eq!(
            place(&cells, 6, false),
            rows(&[
                &["repeat", "repeat", "recent", "recent", "favorites", "favorites"],
                &["albums", "albums", "albums", "albums", "playlists", "playlists"],
                &["artists"; 6],
            ])
        );
    }

    #[test]
    fn never_a_hole() {
        for mask in 0u32..(1 << ALL.len()) {
            let present: Vec<PanelKind> = ALL.iter().enumerate().filter(|(i, _)| mask & (1 << i) != 0).map(|(_, k)| *k).collect();
            let cells = board_layout(&present);
            let mut ids: Vec<String> = cells.iter().map(|c| c.id.clone()).collect();
            let mut want: Vec<String> = present.iter().map(|k| k.id().to_string()).collect();
            ids.sort();
            want.sort();
            assert_eq!(ids, want);
            for (columns, medium) in [(6, false), (2, true)] {
                assert!(place(&cells, columns, medium).iter().flatten().all(Option::is_some), "{present:?} at {columns}");
            }
        }
    }

    fn grid_of(placements: &[Placement], columns: usize) -> Vec<Vec<Option<String>>> {
        let mut grid: Vec<Vec<Option<String>>> = Vec::new();
        for p in placements {
            for r in p.row..p.row + p.h {
                while grid.len() <= r {
                    grid.push(vec![None; columns]);
                }
                for c in p.col..p.col + p.w {
                    assert!(c < columns && grid[r][c].is_none(), "{} overlaps at {r},{c}", p.id);
                    grid[r][c] = Some(p.id.clone());
                }
            }
        }
        grid
    }

    fn item(id: &str, w: usize, h: usize) -> PackItem {
        PackItem { id: id.into(), w, h }
    }

    #[test]
    fn packs_default_panels_into_the_default_shape() {
        let items: Vec<PackItem> =
            default_arrangement().panels.iter().map(|p| item(&p.id, p.w as usize, p.h as usize)).collect();
        assert_eq!(grid_of(&pack_board(&items, 6), 6), place(&board_layout(&ALL), 6, false));
        let cells = packed_layout(&items);
        let spans: Vec<_> = cells.iter().map(|c| (c.id.clone(), c.span, c.rows)).collect();
        let want: Vec<_> = board_layout(&ALL).iter().map(|c| (c.id.clone(), c.span, c.rows)).collect();
        assert_eq!(spans, want);
    }

    #[test]
    fn widens_the_narrowest_first() {
        let two = pack_board(&[item("a", 2, 1), item("b", 2, 1), item("c", 6, 1)], 6);
        assert_eq!(grid_of(&two, 6), rows(&[&["a", "a", "a", "b", "b", "b"], &["c"; 6]]));
        assert_eq!(grid_of(&pack_board(&[item("a", 2, 1), item("b", 3, 1)], 6), 6), rows(&[&["a", "a", "a", "b", "b", "b"]]));
        assert_eq!(grid_of(&pack_board(&[item("a", 4, 1)], 6), 6), rows(&[&["a"; 6]]));
    }

    #[test]
    fn grows_down_beside_a_tall_one() {
        let placed = pack_board(&[item("a", 4, 1), item("tall", 2, 2), item("c", 6, 1)], 6);
        assert_eq!(
            grid_of(&placed, 6),
            rows(&[&["a", "a", "a", "a", "tall", "tall"], &["a", "a", "a", "a", "tall", "tall"], &["c"; 6]])
        );
        let placed = pack_board(&[item("tall", 2, 2), item("b", 2, 1), item("c", 6, 1)], 6);
        assert_eq!(
            grid_of(&placed, 6),
            rows(&[&["tall", "tall", "tall", "b", "b", "b"], &["tall", "tall", "tall", "b", "b", "b"], &["c"; 6]])
        );
    }

    #[test]
    fn never_a_hole_or_a_lost_panel() {
        let shapes: Vec<(usize, usize)> =
            PANEL_WIDTHS.iter().flat_map(|w| PANEL_HEIGHTS.iter().map(move |h| (*w as usize, *h as usize))).collect();
        let mut boards: Vec<Vec<PackItem>> = vec![vec![]];
        let mut failures = Vec::new();
        for length in 1..=5 {
            boards = boards
                .iter()
                .flat_map(|b| shapes.iter().map(move |(w, h)| [b.clone(), vec![item(&format!("p{length}"), *w, *h)]].concat()))
                .collect();
            for board in &boards {
                for columns in [6, 2] {
                    let items: Vec<PackItem> = if columns == 2 {
                        board.iter().map(|i| PackItem { w: medium_width(i.w), ..i.clone() }).collect()
                    } else {
                        board.clone()
                    };
                    let placed = pack_board(&items, columns);
                    let ok = placed.len() == items.len()
                        && placed.iter().zip(&items).all(|(p, i)| p.id == i.id && p.w >= i.w.min(columns) && p.h >= i.h)
                        && grid_of(&placed, columns).iter().flatten().all(Option::is_some);
                    if !ok {
                        failures.push(format!("{board:?} on {columns}"));
                    }
                }
            }
        }
        assert!(failures.is_empty(), "{failures:?}");
    }
}
