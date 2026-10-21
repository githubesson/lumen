import type { ReactNode } from "react";
import { ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from "lucide-react";
import { useScrollEdges } from "../lib/useScrollEdges";

/**
 * A horizontally scrolling `.shelf` of cards, without a scrollbar. The edges
 * fade wherever there's more to scroll to, and on hover arrow buttons page
 * through the row. Touch screens keep the fades and swipe instead. While it
 * scrolls, the row itself takes keyboard focus and the arrow keys scroll it:
 * a card with nothing to click (an artist with no page and nothing to play)
 * has nothing to tab to, so tabbing through the cards alone can't bring the
 * ones past the edge into view.
 */
export default function ShelfScroller({
  label,
  children,
}: {
  /** What the row holds, read out when it takes focus ("Top artists"). */
  label: string;
  children: ReactNode;
}) {
  const { ref, edges, measure, page } = useScrollEdges<HTMLDivElement>("x");

  return (
    <div
      className="shelf-scroller"
      data-back={edges.back || undefined}
      data-forward={edges.forward || undefined}
    >
      <div
        ref={ref}
        className="shelf"
        role="group"
        aria-label={label}
        tabIndex={edges.back || edges.forward ? 0 : undefined}
        onScroll={measure}
      >
        {children}
      </div>
      {/* Pointer shortcuts only: the keyboard scrolls the focused row, and
          focus brings each card it reaches into view, so the arrows stay
          out of the tab order. */}
      <button
        type="button"
        className="shelf-arrow shelf-arrow-back"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!edges.back}
        onClick={() => page(-1)}
      >
        <ChevronLeftIcon className="size-4" />
      </button>
      <button
        type="button"
        className="shelf-arrow shelf-arrow-forward"
        tabIndex={-1}
        aria-hidden="true"
        disabled={!edges.forward}
        onClick={() => page(1)}
      >
        <ChevronRightIcon className="size-4" />
      </button>
    </div>
  );
}
