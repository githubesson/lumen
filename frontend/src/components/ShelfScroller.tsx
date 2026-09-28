import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronLeft as ChevronLeftIcon, ChevronRight as ChevronRightIcon } from "lucide-react";

/**
 * A horizontally scrolling `.shelf` of cards, without a scrollbar. The edges
 * fade wherever there's more to scroll to, and on hover arrow buttons page
 * through the row. Touch screens keep the fades and swipe instead.
 */
export default function ShelfScroller({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const [edges, setEdges] = useState({ back: false, forward: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // A pixel of slack: fractional widths can stop scrollLeft just short of
    // either end.
    const back = el.scrollLeft > 1;
    const forward = el.scrollLeft + el.clientWidth < el.scrollWidth - 1;
    setEdges((prev) =>
      prev.back === back && prev.forward === forward ? prev : { back, forward },
    );
  }, []);

  // A new width or new cards change how far the row scrolls. The resize
  // observer also reports once on connect, which takes the first measurement.
  useEffect(() => {
    const el = ref.current;
    // Without it (jsdom) the row keeps no fades or arrows, and still scrolls.
    if (!el || typeof ResizeObserver === "undefined") return;
    const resize = new ResizeObserver(measure);
    resize.observe(el);
    const mutation = new MutationObserver(measure);
    mutation.observe(el, { childList: true });
    return () => {
      resize.disconnect();
      mutation.disconnect();
    };
  }, [measure]);

  const page = (direction: 1 | -1) => {
    const el = ref.current;
    if (!el) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    // Most of a screen, so the card cut off at the edge comes fully into
    // view; scroll snapping then lines the row up on a card.
    el.scrollBy({
      left: direction * el.clientWidth * 0.8,
      behavior: reduce ? "auto" : "smooth",
    });
  };

  return (
    <div
      className="shelf-scroller"
      data-back={edges.back || undefined}
      data-forward={edges.forward || undefined}
    >
      <div ref={ref} className="shelf" onScroll={measure}>
        {children}
      </div>
      {/* Pointer shortcuts only: keyboard focus already scrolls each card
          into view, so the arrows stay out of the tab order. */}
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
