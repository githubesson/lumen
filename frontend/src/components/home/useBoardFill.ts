import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

/**
 * How many items a Home panel shows: its usual number, or as many as fit
 * when its slot has room to spare (moved into a taller or wider slot, or
 * next to a taller panel in its row).
 *
 * The items sit in a fill area, the element `area` goes on, whose only child
 * is their grid. Once measured, the area takes the panel's spare height but
 * counts only the usual rows toward the panel's own (its min-height), so the
 * extra rows use room the board already has and never make a row taller.
 * Until then the items size it as they always did.
 */

/** The usual number of items, or how to work it out from the grid's columns. */
export type FillUsual = number | ((columns: number) => number);

/** A board row's height (`.board-row`), for a list with no row to measure yet. */
export const BOARD_ROW_HEIGHT = 52;

export interface BoardFill {
  /** How many items fit: never fewer than the usual number. */
  count: number;
  /** Props for the fill area. */
  area: {
    ref: (el: HTMLDivElement | null) => void;
    className: string;
    style?: CSSProperties;
    "data-measured"?: "";
  };
}

export interface Fit {
  count: number;
  /** The usual rows' height, which is all the area adds to its panel's. */
  minHeight: number;
}

/** What the fill area measured: its grid, and the room it has. */
export interface FillMetrics {
  /** The area's height. */
  height: number;
  columns: number;
  /** One row of items (the first item's height). */
  row: number;
  /** Between rows. */
  gap: number;
  /** The grid's own top and bottom margins, together. */
  margins: number;
  /** Items in the grid now. */
  items: number;
  /** The min-height the area was given at its last measure, if any. */
  heldAt?: number;
}

const usualFor = (usual: FillUsual, columns: number) => (typeof usual === "number" ? usual : usual(columns));

/**
 * How many items fill the room, in whole rows, and the height the usual
 * ones need: fewer than usual when that's all there is.
 */
export function fitItems(usual: FillUsual, { height, columns, row, gap, margins, items, heldAt }: FillMetrics): Fit {
  const usualCount = usualFor(usual, columns);
  const usualRows = Math.ceil(Math.min(usualCount, items) / columns);
  const minHeight = usualRows > 0 ? margins + usualRows * row + (usualRows - 1) * gap : 0;
  // As tall as its own min-height, the area has no room past it, and that
  // min-height can be out of date (the columns just changed, so the rows
  // did too): count on the one it gets now.
  const room = heldAt !== undefined && height <= heldAt + 1 ? Math.min(height, minHeight) : height;
  // Half a pixel of slack for fractional sizes.
  const rows = Math.floor((room - margins + gap + 0.5) / (row + gap));
  return { count: Math.max(usualCount, rows * columns), minHeight };
}

/**
 * `emptyRow` is the row height to assume while the grid has no items, for a
 * list that only loads once it has room (Jump back in's tracks).
 */
export function useBoardFill(usual: FillUsual, emptyRow?: number): BoardFill {
  const [area, setArea] = useState<HTMLDivElement | null>(null);
  const [fit, setFit] = useState<Fit | null>(null);
  const latest = useRef({ usual, emptyRow });

  const measure = useCallback(() => {
    if (!area) return;
    const { usual, emptyRow } = latest.current;
    const grid = area.firstElementChild;
    const style = grid ? getComputedStyle(grid) : null;
    // "none" when the grid isn't one (or isn't there): a single column.
    const columns = style?.gridTemplateColumns.split(" ").length ?? 1;
    const gap = parseFloat(style?.rowGap ?? "") || 0;
    const margins = (parseFloat(style?.marginTop ?? "") || 0) + (parseFloat(style?.marginBottom ?? "") || 0);
    const first = grid?.firstElementChild;
    const row = first ? first.getBoundingClientRect().height : (emptyRow ?? 0);
    if (!row) {
      setFit((prev) => (prev === null ? prev : null));
      return;
    }
    const metrics = { height: area.clientHeight, columns, row, gap, margins, items: grid?.childElementCount ?? 0 };
    setFit((prev) => {
      const next = fitItems(usual, { ...metrics, heldAt: prev?.minHeight });
      return prev && prev.count === next.count && Math.abs(prev.minHeight - next.minHeight) < 0.5 ? prev : next;
    });
  }, [area]);

  // After every render: the items, or the board around them, may have
  // changed. A change it makes renders again before paint, and the bail-out
  // in `measure` ends that once nothing moves.
  useLayoutEffect(() => {
    latest.current = { usual, emptyRow };
    measure();
  });

  // The slot growing or shrinking later on (a resize, a panel next to it
  // loading).
  useEffect(() => {
    if (!area || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(area);
    return () => observer.disconnect();
  }, [area, measure]);

  return {
    count: fit?.count ?? usualFor(usual, 4),
    area: {
      ref: setArea,
      className: "board-fill",
      style: fit ? ({ "--board-fill-min": `${fit.minHeight}px` } as CSSProperties) : undefined,
      "data-measured": fit ? "" : undefined,
    },
  };
}
