//! `useBoardFill.ts`: how many items a Home panel shows, its usual number,
//! or as many as fit when its slot has room to spare (moved into a taller or
//! wider slot, or next to a taller panel in its row).
//!
//! The web measures the fill area after each render. Here the board's grid
//! is laid out by [`super::grid`] from each panel's natural height (its
//! usual rows), so the room a fill area gets is known when the view is built:
//! the panel's slot height minus what the rest of the panel takes. The area
//! counts only the usual rows toward its panel's height, so extra rows use
//! room the board already has and never make a row taller.

/// The usual number of items, or how to work it out from the grid's columns.
#[derive(Clone, Copy)]
pub enum FillUsual {
    Count(usize),
    /// `A_ROW`: at least four, a whole row of the grid.
    ARow,
}

impl FillUsual {
    pub fn of(self, columns: usize) -> usize {
        match self {
            FillUsual::Count(n) => n,
            FillUsual::ARow => columns.max(4),
        }
    }
}

/// What the fill area measures: its grid, and the room it has.
#[derive(Clone, Copy, Debug, Default)]
pub struct FillMetrics {
    /// The area's height.
    pub height: f32,
    pub columns: usize,
    /// One row of items.
    pub row: f32,
    /// Between rows.
    pub gap: f32,
    /// The grid's own top and bottom margins, together.
    pub margins: f32,
    /// Items in the grid now.
    pub items: usize,
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Fit {
    pub count: usize,
    /// The usual rows' height, which is all the area adds to its panel's.
    pub min_height: f32,
}

/// `fitItems`: how many items fill the room, in whole rows, and the height
/// the usual ones need (fewer than usual when that's all there is).
pub fn fit_items(usual: FillUsual, m: FillMetrics) -> Fit {
    let usual_count = usual.of(m.columns);
    let usual_rows = usual_count.min(m.items).div_ceil(m.columns);
    let min_height =
        if usual_rows > 0 { m.margins + usual_rows as f32 * m.row + (usual_rows - 1) as f32 * m.gap } else { 0.0 };
    // Half a pixel of slack for fractional sizes.
    let rows = ((m.height - m.margins + m.gap + 0.5) / (m.row + m.gap)).floor().max(0.0) as usize;
    Fit { count: usual_count.max(rows * m.columns), min_height }
}

/// The usual rows' height for `items` items of a grid (`minHeight` alone):
/// what a fill area adds to its panel's natural height.
pub fn usual_height(usual: FillUsual, columns: usize, items: usize, row: f32, gap: f32, margins: f32) -> f32 {
    fit_items(usual, FillMetrics { height: 0.0, columns, row, gap, margins, items }).min_height
}

/// How many items fit in `room` (the area's height once laid out).
pub fn count_in(usual: FillUsual, room: f32, columns: usize, row: f32, gap: f32, margins: f32, items: usize) -> usize {
    fit_items(usual, FillMetrics { height: room, columns, row, gap, margins, items }).count
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rows(f: impl FnOnce(&mut FillMetrics)) -> FillMetrics {
        let mut m = FillMetrics { height: 260.0, columns: 1, row: 52.0, gap: 0.0, margins: 0.0, items: 20 };
        f(&mut m);
        m
    }
    const FIVE: FillUsual = FillUsual::Count(5);

    #[test]
    fn keeps_the_usual_rows_without_room() {
        assert_eq!(fit_items(FIVE, rows(|_| {})), Fit { count: 5, min_height: 260.0 });
        assert_eq!(fit_items(FIVE, rows(|m| m.height = 311.0)), Fit { count: 5, min_height: 260.0 });
    }

    #[test]
    fn fills_a_taller_slot_with_whole_rows() {
        assert_eq!(fit_items(FIVE, rows(|m| m.height = 312.0)).count, 6);
        assert_eq!(fit_items(FIVE, rows(|m| m.height = 700.0)).count, 13);
        assert_eq!(fit_items(FIVE, rows(|m| m.height = 700.0)).min_height, 260.0);
    }

    #[test]
    fn fills_the_last_row_of_two_columns() {
        assert_eq!(fit_items(FIVE, rows(|m| (m.columns, m.height) = (2, 156.0))), Fit { count: 6, min_height: 156.0 });
    }

    #[test]
    fn counts_only_the_items_there_are() {
        assert_eq!(fit_items(FIVE, rows(|m| (m.items, m.height) = (3, 156.0))), Fit { count: 5, min_height: 156.0 });
        assert_eq!(fit_items(FIVE, rows(|m| (m.items, m.height) = (0, 0.0))), Fit { count: 5, min_height: 0.0 });
    }

    #[test]
    fn fills_a_row_of_covers() {
        let grid = |m: &mut FillMetrics| (m.row, m.gap, m.margins, m.items) = (200.0, 4.0, -4.0, 12);
        let at = |columns, height| rows(|m| {
            grid(m);
            (m.columns, m.height) = (columns, height);
        });
        assert_eq!(fit_items(FillUsual::ARow, at(6, 196.0)), Fit { count: 6, min_height: 196.0 });
        assert_eq!(fit_items(FillUsual::ARow, at(2, 400.0)), Fit { count: 4, min_height: 400.0 });
        assert_eq!(fit_items(FillUsual::ARow, at(4, 400.0)).count, 8);
    }

    #[test]
    fn shows_nothing_unasked_until_a_row_fits() {
        let at = |height| rows(|m| (m.margins, m.items, m.height) = (12.0, 0, height));
        assert_eq!(fit_items(FillUsual::Count(0), at(60.0)), Fit { count: 0, min_height: 0.0 });
        assert_eq!(fit_items(FillUsual::Count(0), at(64.0)), Fit { count: 1, min_height: 0.0 });
        assert_eq!(fit_items(FillUsual::Count(0), at(200.0)).count, 3);
    }
}
