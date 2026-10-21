import { useCallback, useEffect, useRef, useState } from "react";

/**
 * For a scroller that shows edge fades and arrow buttons instead of a
 * scrollbar: which of its ends have more past them (`back` is the start),
 * and `page`, which scrolls most of a screen toward one end. Pass `measure`
 * as the element's onScroll; new sizes and new children re-measure on their
 * own.
 */
export function useScrollEdges<T extends HTMLElement>(axis: "x" | "y") {
  const ref = useRef<T>(null);
  const [edges, setEdges] = useState({ back: false, forward: false });

  const measure = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    const [offset, size, extent] =
      axis === "x"
        ? [el.scrollLeft, el.clientWidth, el.scrollWidth]
        : [el.scrollTop, el.clientHeight, el.scrollHeight];
    // A pixel of slack: fractional sizes can stop the scroll just short of
    // either end.
    const back = offset > 1;
    const forward = offset + size < extent - 1;
    setEdges((prev) =>
      prev.back === back && prev.forward === forward ? prev : { back, forward },
    );
  }, [axis]);

  // A new size or new children change how far it scrolls. The resize
  // observer also reports once on connect, which takes the first measurement.
  useEffect(() => {
    const el = ref.current;
    // Without it (jsdom) there are no fades or arrows, and it still scrolls.
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

  const page = useCallback(
    (direction: 1 | -1) => {
      const el = ref.current;
      if (!el) return;
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      // Most of a screen, so whatever the edge cut off comes fully into view.
      const distance = direction * (axis === "x" ? el.clientWidth : el.clientHeight) * 0.8;
      el.scrollBy({
        [axis === "x" ? "left" : "top"]: distance,
        behavior: reduce ? "auto" : "smooth",
      });
    },
    [axis],
  );

  return { ref, edges, measure, page };
}
