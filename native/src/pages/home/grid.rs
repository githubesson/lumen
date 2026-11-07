//! The board's grid (`board.css`'s `.board`): Rune has no CSS grid with row
//! spans, so this places the board's cells the way the browser does and
//! sizes its auto rows from each panel's natural height, then hands back
//! every slot's rectangle for the view to pin.
//!
//! - Columns: six (`repeat(6, minmax(0, 1fr))`) on a board 880 px or wider,
//!   two below that, one below 560 (the container queries on `.board-view`).
//! - Placement: a cell's own lines when the layout gave them (a packed
//!   board), else sparse auto-placement in order. The one-column board
//!   places every panel `auto` (span 1), stacked.
//! - Rows: `grid-auto-rows: auto` in an auto-height grid, so each row is as
//!   tall as its tallest single-row panel, and a panel spanning rows that
//!   don't add up to its height has the rest shared out over them (to rows
//!   with no panel of their own first, as the browser's "distribute extra
//!   space" does), then every panel stretches to its area.

use super::layout::BoardCell;

/// Which board the width gives (the `.board-view` container queries).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum BoardSize {
    /// Six columns.
    Wide,
    /// Two columns, under 880 px.
    Medium,
    /// One column, under 560 px.
    Narrow,
}

impl BoardSize {
    pub fn of(width: f32) -> BoardSize {
        if width < 560.0 {
            BoardSize::Narrow
        } else if width < 880.0 {
            BoardSize::Medium
        } else {
            BoardSize::Wide
        }
    }

    pub fn columns(self) -> usize {
        match self {
            BoardSize::Wide => 6,
            BoardSize::Medium => 2,
            BoardSize::Narrow => 1,
        }
    }
}

/// Where a cell went: grid lines from 0.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Area {
    pub col: usize,
    pub row: usize,
    pub span: usize,
    pub rows: usize,
}

/// Each cell's area on a board of `size`.
pub fn place(cells: &[BoardCell], size: BoardSize) -> Vec<Area> {
    let columns = size.columns();
    let mut taken: Vec<Vec<bool>> = Vec::new();
    let fits = |taken: &mut Vec<Vec<bool>>, row: usize, col: usize, span: usize, rows: usize| {
        while taken.len() < row + rows {
            taken.push(vec![false; columns]);
        }
        (row..row + rows).all(|r| (col..col + span).all(|c| !taken[r][c]))
    };
    let (mut row, mut col) = (0usize, 0usize);
    let mut out = Vec::with_capacity(cells.len());
    for cell in cells {
        let (span, rows, at_col, at_row) = match size {
            BoardSize::Wide => (cell.span, cell.rows, cell.col, cell.row),
            BoardSize::Medium => (cell.span_md, cell.rows_md, cell.col_md, cell.row_md),
            BoardSize::Narrow => (1, 1, None, None),
        };
        let span = span.clamp(1, columns);
        let rows = rows.max(1);
        let area = match (at_col, at_row) {
            (Some(c), Some(r)) => Area { col: (c - 1).min(columns - span), row: r - 1, span, rows },
            _ => {
                loop {
                    if col + span > columns {
                        row += 1;
                        col = 0;
                        continue;
                    }
                    if fits(&mut taken, row, col, span, rows) {
                        break;
                    }
                    col += 1;
                }
                let a = Area { col, row, span, rows };
                col += span;
                a
            }
        };
        while taken.len() < area.row + area.rows {
            taken.push(vec![false; columns]);
        }
        for r in area.row..area.row + area.rows {
            for c in area.col..area.col + area.span {
                taken[r][c] = true;
            }
        }
        out.push(area);
    }
    out
}

/// The board laid out: each slot's `[x, y, w, h]` relative to the board, and
/// the board's height.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Laid {
    pub rects: Vec<[f32; 4]>,
    pub height: f32,
}

/// A cell's width in a grid of `columns` over `width` with `gap`.
pub fn span_width(width: f32, columns: usize, gap: f32, span: usize) -> f32 {
    let col = (width - gap * (columns as f32 - 1.0)) / columns as f32;
    col * span as f32 + gap * (span as f32 - 1.0)
}

/// Sizes the rows from `natural(i, width)`, each cell's height at its width,
/// and places every cell.
pub fn lay_out(areas: &[Area], width: f32, gap: f32, columns: usize, mut natural: impl FnMut(usize, f32) -> f32) -> Laid {
    let col_w = (width - gap * (columns as f32 - 1.0)) / columns as f32;
    let n_rows = areas.iter().map(|a| a.row + a.rows).max().unwrap_or(0);
    let heights: Vec<f32> = areas.iter().enumerate().map(|(i, a)| natural(i, span_width(width, columns, gap, a.span))).collect();
    // Base sizes from the panels in one row; a row only spanning panels
    // cross has none of its own (an infinite growth limit).
    let mut base = vec![0.0f32; n_rows];
    let mut own = vec![false; n_rows];
    for (a, h) in areas.iter().zip(&heights) {
        if a.rows == 1 {
            base[a.row] = base[a.row].max(*h);
            own[a.row] = true;
        }
    }
    // Spanning panels, fewest rows first: the rest of their height goes to
    // their rows without panels of their own, else to all of them, equally.
    let mut spanning: Vec<usize> = (0..areas.len()).filter(|i| areas[*i].rows > 1).collect();
    spanning.sort_by_key(|i| areas[*i].rows);
    for i in spanning {
        let a = areas[i];
        let rows = a.row..a.row + a.rows;
        let have: f32 = base[rows.clone()].iter().sum::<f32>() + gap * (a.rows as f32 - 1.0);
        let extra = heights[i] - have;
        if extra <= 0.0 {
            continue;
        }
        let open: Vec<usize> = rows.clone().filter(|r| !own[*r]).collect();
        let to: Vec<usize> = if open.is_empty() { rows.collect() } else { open };
        let each = extra / to.len() as f32;
        for r in to {
            base[r] += each;
        }
    }
    let mut tops = vec![0.0f32; n_rows + 1];
    for r in 0..n_rows {
        tops[r + 1] = tops[r] + base[r] + gap;
    }
    let rects = areas
        .iter()
        .map(|a| {
            let x = a.col as f32 * (col_w + gap);
            let y = tops[a.row];
            let h = tops[a.row + a.rows] - gap - y;
            [x, y, span_width(width, columns, gap, a.span), h]
        })
        .collect();
    let height = if n_rows == 0 { 0.0 } else { tops[n_rows] - gap };
    Laid { rects, height }
}

#[cfg(test)]
mod tests {
    use super::super::kinds::PanelKind::*;
    use super::super::layout::board_layout;
    use super::*;

    #[test]
    fn places_the_default_board() {
        let cells = board_layout(&[Resume, Repeat, Recent, Favorites, Albums, Playlists, Artists]);
        let areas = place(&cells, BoardSize::Wide);
        let at: Vec<(usize, usize, usize, usize)> = areas.iter().map(|a| (a.col, a.row, a.span, a.rows)).collect();
        assert_eq!(at, [(0, 0, 4, 1), (4, 0, 2, 2), (0, 1, 2, 1), (2, 1, 2, 1), (0, 2, 4, 1), (4, 2, 2, 1), (0, 3, 6, 1)]);
        let narrow = place(&cells, BoardSize::Narrow);
        assert!(narrow.iter().enumerate().all(|(i, a)| (a.col, a.row, a.span, a.rows) == (0, i, 1, 1)));
    }

    #[test]
    fn sizes_rows_like_the_browser() {
        let cells = board_layout(&[Resume, Repeat, Recent, Favorites]);
        let areas = place(&cells, BoardSize::Wide);
        // Hero 202, On repeat 540, the lists 338: the rows hold the hero and
        // the lists, and On repeat stretches over both.
        let laid = lay_out(&areas, 956.0, 16.0, 6, |i, _| [202.0, 540.0, 338.0, 338.0][i]);
        assert_eq!(laid.rects[0], [0.0, 0.0, 632.0, 202.0]);
        assert_eq!(laid.rects[1], [648.0, 0.0, 308.0, 556.0]);
        assert_eq!(laid.rects[2][1], 218.0);
        // A taller On repeat shares its extra over both rows.
        let laid = lay_out(&areas, 956.0, 16.0, 6, |i, _| [202.0, 600.0, 338.0, 338.0][i]);
        assert_eq!(laid.rects[0][3], 224.0);
        assert_eq!(laid.height, 600.0);
    }
}
