import { useEffect, useLayoutEffect, useState } from "react";

interface Slice {
  start: number;
  end: number; // exclusive
  topSpacerPx: number;
  bottomSpacerPx: number;
  rowHeight: number;
}

interface Options {
  /** Fallback row height (px) used until the DOM measurement lands. */
  defaultRowHeight?: number;
  /** Extra rows rendered above/below the viewport to hide the seam during fast scroll. */
  overscan?: number;
}

/**
 * Windowed-slice hook for a list rendered inside a scrollable ancestor.
 *
 * Walks up from `listRef.current` to the first element with overflow-y
 * auto/scroll and subscribes to its scroll events (falls back to `window`
 * when the list scrolls with the page itself). On every scroll — throttled
 * to a single rAF — it computes which rows are currently visible based on
 * the list's top offset, the scroll position, and a row height read from the
 * `--row-h` CSS custom property.
 *
 * The returned `topSpacerPx` / `bottomSpacerPx` are meant to hold the
 * scrollbar in place via spacer elements above and below the rendered slice,
 * so the DOM stays at ~(overscan * 2 + viewport / rowHeight) rows regardless
 * of total list size.
 */
export function useWindowedSlice(
  listRef: React.RefObject<HTMLElement | null>,
  totalCount: number,
  opts: Options = {},
): Slice {
  const overscan = opts.overscan ?? 8;
  const fallback = opts.defaultRowHeight ?? 44;

  const [rowHeight, setRowHeight] = useState(fallback);
  const [range, setRange] = useState<{ start: number; end: number }>({
    start: 0,
    end: Math.min(totalCount, 50),
  });

  // Measure --row-h from the list element. Picks up density changes without a
  // reload because --row-h is defined on [data-density] and inherits down.
  useLayoutEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const raw = getComputedStyle(el).getPropertyValue("--row-h").trim();
    const n = parseFloat(raw);
    if (!Number.isNaN(n) && n > 0 && n !== rowHeight) setRowHeight(n);
  }, [listRef, rowHeight]);

  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const scroller = findScrollParent(el);
    let rafId: number | null = null;

    const computeRange = () => {
      rafId = null;
      const listEl = listRef.current;
      if (!listEl) return;
      const listRect = listEl.getBoundingClientRect();
      let viewportTop: number;
      let viewportHeight: number;
      if (scroller) {
        const sRect = scroller.getBoundingClientRect();
        viewportTop = sRect.top - listRect.top;
        viewportHeight = sRect.height;
      } else {
        viewportTop = -listRect.top;
        viewportHeight = window.innerHeight;
      }
      const start = Math.max(
        0,
        Math.floor(viewportTop / rowHeight) - overscan,
      );
      const end = Math.min(
        totalCount,
        Math.ceil((viewportTop + viewportHeight) / rowHeight) + overscan,
      );
      setRange((prev) =>
        prev.start === start && prev.end === end ? prev : { start, end },
      );
    };

    const scheduleCompute = () => {
      if (rafId !== null) return;
      rafId = requestAnimationFrame(computeRange);
    };

    computeRange();

    // Scroll events on the nearest scrollable ancestor (or window fallback).
    // rAF-throttled so bursts during momentum scroll collapse into one
    // compute per frame.
    const scrollTarget: EventTarget = scroller ?? window;
    scrollTarget.addEventListener(
      "scroll",
      scheduleCompute,
      { passive: true } as AddEventListenerOptions,
    );

    // Viewport resize → ResizeObserver instead of window `resize`. The raw
    // event fires 60–100× per second during a drag, and even with rAF
    // throttling the scheduled commits pile up behind the browser's layout
    // pass, making the UI unresponsive for a beat after the drag ends.
    // ResizeObserver fires once per frame pre-paint and only when dimensions
    // actually change — no flood, no backlog.
    let ro: ResizeObserver | null = null;
    if (typeof ResizeObserver !== "undefined") {
      ro = new ResizeObserver(scheduleCompute);
      ro.observe(scroller ?? document.documentElement);
    }

    return () => {
      scrollTarget.removeEventListener(
        "scroll",
        scheduleCompute as EventListener,
      );
      ro?.disconnect();
      if (rafId !== null) cancelAnimationFrame(rafId);
    };
  }, [listRef, totalCount, rowHeight, overscan]);

  // Clamp range if total shrinks.
  const end = Math.min(range.end, totalCount);
  const start = Math.min(range.start, end);

  return {
    start,
    end,
    rowHeight,
    topSpacerPx: start * rowHeight,
    bottomSpacerPx: Math.max(0, (totalCount - end) * rowHeight),
  };
}

function findScrollParent(el: HTMLElement): HTMLElement | null {
  let p: HTMLElement | null = el.parentElement;
  while (p && p !== document.body) {
    const s = getComputedStyle(p);
    if (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflow)) {
      return p;
    }
    p = p.parentElement;
  }
  return null;
}
