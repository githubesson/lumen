import { useCallback, useEffect, useRef, useState } from "react";
import { findScrollParent } from "../../lib/useWindowedSlice";

// Drag auto-scroll: holding a dragged row within this many px of the
// scroller's edge scrolls it, speed scaling with proximity up to the max.
const DRAG_SCROLL_ZONE = 56;
const DRAG_SCROLL_MAX_STEP = 16;

/**
 * One frame of drag auto-scroll, re-scheduling itself until the drag ends
 * (`clientY` nulled by `stopAutoScroll`).
 *
 * Lives at module scope because it is self-recursive: a `useCallback` that
 * references itself in its own initializer is rejected by the React Compiler.
 */
function autoScrollStep(
  clientY: React.MutableRefObject<number | null>,
  scrollerRef: React.MutableRefObject<HTMLElement | null>,
  rafRef: React.MutableRefObject<number>,
) {
  const y = clientY.current;
  if (y === null) {
    rafRef.current = 0;
    return;
  }
  const scroller = scrollerRef.current;
  // Clamp the scroller's edges to the viewport so a page-tall container
  // still gets usable zones at the visible top and bottom.
  const rect = scroller?.getBoundingClientRect();
  const top = Math.max(rect?.top ?? 0, 0);
  const bottom = Math.min(rect?.bottom ?? window.innerHeight, window.innerHeight);
  let delta = 0;
  if (y < top + DRAG_SCROLL_ZONE) {
    delta = -Math.ceil(((top + DRAG_SCROLL_ZONE - y) / DRAG_SCROLL_ZONE) * DRAG_SCROLL_MAX_STEP);
  } else if (y > bottom - DRAG_SCROLL_ZONE) {
    delta = Math.ceil(((y - (bottom - DRAG_SCROLL_ZONE)) / DRAG_SCROLL_ZONE) * DRAG_SCROLL_MAX_STEP);
  }
  if (delta !== 0) {
    if (scroller) scroller.scrollTop += delta;
    else window.scrollBy(0, delta);
  }
  rafRef.current = requestAnimationFrame(() =>
    autoScrollStep(clientY, scrollerRef, rafRef),
  );
}

function slotFromEvent(index: number, e: React.DragEvent<HTMLTableRowElement>) {
  const rect = e.currentTarget.getBoundingClientRect();
  return e.clientY < rect.top + rect.height / 2 ? index : index + 1;
}

/**
 * Native HTML5 drag-reorder for table rows. `dropSlot` is the insertion gap
 * (0..rowCount); refs mirror the state so drop/end handlers stay referentially
 * stable. `tableRef` locates the scroll parent to auto-scroll during a drag.
 */
export function useDragReorder(
  tableRef: React.RefObject<HTMLElement | null>,
  rowCount: number,
  onReorder: ((from: number, to: number) => void) | undefined,
) {
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropSlot, setDropSlot] = useState<number | null>(null);
  const dragIndexRef = useRef<number | null>(null);
  const onReorderProp = useRef(onReorder);
  useEffect(() => {
    onReorderProp.current = onReorder;
  }, [onReorder]);

  // HTML5 drag suppresses normal wheel/keyboard scrolling targets in odd
  // ways and never auto-scrolls custom containers, so we run our own rAF
  // loop for the whole drag: it nudges the scroll parent whenever the last
  // known pointer Y sits inside the edge zones.
  const dragClientYRef = useRef<number | null>(null);
  const dragScrollerRef = useRef<HTMLElement | null>(null);
  const autoScrollRafRef = useRef(0);

  const stopAutoScroll = useCallback(() => {
    dragClientYRef.current = null;
    dragScrollerRef.current = null;
    if (autoScrollRafRef.current) {
      cancelAnimationFrame(autoScrollRafRef.current);
      autoScrollRafRef.current = 0;
    }
  }, []);
  useEffect(() => stopAutoScroll, [stopAutoScroll]);

  const startAutoScroll = useCallback(() => {
    autoScrollRafRef.current = requestAnimationFrame(() =>
      autoScrollStep(dragClientYRef, dragScrollerRef, autoScrollRafRef),
    );
  }, []);

  const onDragStartRow = useCallback(
    (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
      e.dataTransfer.effectAllowed = "move";
      // Firefox refuses to start a drag without payload data.
      e.dataTransfer.setData("text/plain", String(index));
      dragIndexRef.current = index;
      setDragIndex(index);
      dragScrollerRef.current = tableRef.current
        ? findScrollParent(tableRef.current)
        : null;
      dragClientYRef.current = e.clientY;
      startAutoScroll();
    },
    [tableRef, startAutoScroll],
  );
  const onDragOverRow = useCallback(
    (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
      if (dragIndexRef.current === null) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      dragClientYRef.current = e.clientY;
      setDropSlot(slotFromEvent(index, e));
    },
    [],
  );
  const onDropRow = useCallback(
    (index: number, e: React.DragEvent<HTMLTableRowElement>) => {
      e.preventDefault();
      const from = dragIndexRef.current;
      const slot = slotFromEvent(index, e);
      dragIndexRef.current = null;
      setDragIndex(null);
      setDropSlot(null);
      stopAutoScroll();
      if (from === null) return;
      const to = slot > from ? slot - 1 : slot;
      if (to !== from) onReorderProp.current?.(from, to);
    },
    [stopAutoScroll],
  );
  const onDragEndRow = useCallback(() => {
    dragIndexRef.current = null;
    setDragIndex(null);
    setDropSlot(null);
    stopAutoScroll();
  }, [stopAutoScroll]);

  const dropEdgeFor = (index: number): "above" | "below" | null => {
    if (dragIndex === null || dropSlot === null) return null;
    // Hide the line on no-op slots (right where the row already sits).
    if (dropSlot === dragIndex || dropSlot === dragIndex + 1) return null;
    if (dropSlot === index) return "above";
    if (dropSlot === index + 1 && index === rowCount - 1) return "below";
    return null;
  };

  return {
    dragIndex,
    dropEdgeFor,
    onDragStartRow,
    onDragOverRow,
    onDropRow,
    onDragEndRow,
  };
}
