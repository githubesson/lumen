import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  OPEN_DELAY,
  markTooltipClosed,
  resetTooltipSkip,
  shouldSkipDelay,
} from "../lib/tooltipTiming";

type Side = "top" | "bottom" | "right";

interface Active {
  el: HTMLElement;
  text: string;
  side: Side;
  /** Whether `text` came from a `title` that was lifted off the element. */
  fromTitle: boolean;
  /** Closed by a click, scroll, or Escape; stays closed until re-hovered. */
  dismissed?: boolean;
  /** Opened inside the skip-delay window, so it shows with no transition. */
  instant?: boolean;
  /**
   * A truncation hint on text that isn't clipped. Recomputed whenever the
   * text changes. The title stays blanked so the native tooltip can't show.
   */
  unclippedHint?: boolean;
}

const canOpen = (a: Active) => !a.dismissed && !a.unclippedHint;

const TARGETS = "[title], button[aria-label], a[aria-label]";
const DESCRIPTION_ID = "title-tooltip-description";

const GAP = 6;
const EDGE = 8;

/**
 * App-wide replacement for native `title=` tooltips. Hovering (or keyboard
 * focusing) any element with a `title` shows a styled bubble instead of the OS
 * tooltip. Icon-only buttons and links without a title use their
 * `aria-label`, so every icon control gets a hint.
 *
 * While a tooltip is active its element's title is blanked to "" (an empty
 * title suppresses the native tooltip) and restored afterwards. Blanking
 * rather than removing keeps React's updates observable: if React changes or
 * removes the title meanwhile, that shows up as a mutation instead of a no-op.
 *
 * Elements can opt into a side with `data-tooltip-side="right"` (e.g. the
 * collapsed sidebar rail). On non-interactive text, a title that repeats the
 * element's leading text is a truncation hint and shows only when clipped.
 * Hover inside a rich <Tooltip> trigger is left to that component.
 *
 * Blanking a title also drops what assistive tech derived from it, so while
 * engaged the text is kept available: via a hidden description element
 * referenced from aria-describedby, or, when the title was the element's only
 * accessible name, a temporary aria-label.
 */
export default function TitleTooltips() {
  const [active, setActive] = useState<Active | null>(null);
  const [visible, setVisible] = useState(false);
  const activeRef = useRef<Active | null>(null);
  const openTimer = useRef<number | null>(null);
  /** Whether the bubble currently being shown skipped its open delay. */
  const instantRef = useRef(false);
  /** Whether the bubble for activeRef is currently rendered. */
  const shownRef = useRef(false);
  /** Whether that bubble reached its visible state -- `shownRef` is set a frame
   *  earlier, when it is merely mounted, which is too early to credit the
   *  shared skip window with a tooltip the user saw. */
  const revealedRef = useRef(false);

  useEffect(() => {
    let observer: MutationObserver | null = null;

    // Written synchronously (not via React state) so the description is in
    // place when focus lands, before the visual bubble's open delay.
    const description = document.createElement("span");
    description.id = DESCRIPTION_ID;
    description.hidden = true;
    document.body.appendChild(description);
    /** Attributes we changed on the engaged element, restored on release. */
    let a11y: { el: HTMLElement; describedBy: string | null; addedLabel: boolean } | null = null;

    const attachA11y = (el: HTMLElement, text: string) => {
      detachA11y();
      const hasName =
        el.hasAttribute("aria-label") ||
        el.hasAttribute("aria-labelledby") ||
        !!(el.textContent ?? "").trim();
      if (!hasName) {
        // The title was the accessible name itself; keep it as the name.
        el.setAttribute("aria-label", text);
        a11y = { el, describedBy: null, addedLabel: true };
        return;
      }
      description.textContent = text;
      const describedBy = el.getAttribute("aria-describedby");
      el.setAttribute(
        "aria-describedby",
        describedBy ? `${describedBy} ${DESCRIPTION_ID}` : DESCRIPTION_ID,
      );
      a11y = { el, describedBy, addedLabel: false };
    };

    const updateA11y = (text: string) => {
      if (!a11y) return;
      if (a11y.addedLabel) a11y.el.setAttribute("aria-label", text);
      else description.textContent = text;
    };

    const detachA11y = () => {
      if (!a11y) return;
      const { el, describedBy, addedLabel } = a11y;
      a11y = null;
      if (addedLabel) {
        el.removeAttribute("aria-label");
      } else if (describedBy == null) {
        el.removeAttribute("aria-describedby");
      } else {
        el.setAttribute("aria-describedby", describedBy);
      }
      description.textContent = "";
    };

    const clearTimer = () => {
      if (openTimer.current !== null) {
        window.clearTimeout(openTimer.current);
        openTimer.current = null;
      }
    };

    const release = () => {
      clearTimer();
      observer?.disconnect();
      observer = null;
      const current = activeRef.current;
      if (!current) return;
      detachA11y();
      // Restore the blanked title unless React changed or removed it meanwhile.
      if (current.fromTitle && current.el.getAttribute("title") === "") {
        current.el.setAttribute("title", current.text);
      }
      activeRef.current = null;
      // Same rule as the rich <Tooltip>: hovering a trigger and leaving before
      // the bubble was actually revealed must not arm the skip window.
      const wasRevealed = revealedRef.current;
      shownRef.current = false;
      revealedRef.current = false;
      if (wasRevealed) markTooltipClosed();
      setVisible(false);
      setActive(null);
    };

    const scheduleOpen = (el: HTMLElement) => {
      const open = () => {
        openTimer.current = null;
        const current = activeRef.current;
        // Compare by element: a label update may have replaced the object.
        if (current?.el !== el) return;
        shownRef.current = true;
        // Copied off the ref here rather than read during render: the flag
        // has to travel with the object React renders.
        const next = { ...current, instant: instantRef.current };
        activeRef.current = next;
        setActive(next);
        requestAnimationFrame(() => {
          if (activeRef.current?.el !== el) return;
          revealedRef.current = true;
          setVisible(true);
        });
      };
      clearTimer();
      if (shouldSkipDelay()) {
        instantRef.current = true;
        open();
      } else {
        instantRef.current = false;
        openTimer.current = window.setTimeout(open, OPEN_DELAY);
      }
    };

    const engage = (el: HTMLElement) => {
      if (activeRef.current?.el === el) return;
      release();
      const title = el.getAttribute("title")?.trim();
      const fromTitle = !!title;
      const text = title || iconOnlyLabel(el);
      if (!text) return;
      const unclippedHint =
        fromTitle && isRedundantTruncationTitle(el, text) && !isTruncated(el);

      if (fromTitle) {
        el.setAttribute("title", "");
        attachA11y(el, text);
      }
      const side = (el.dataset.tooltipSide as Side | undefined) ?? "top";
      const next: Active = { el, text, side, fromTitle, unclippedHint };
      activeRef.current = next;

      // React may update the label while the tooltip is showing (e.g. a
      // toggle button switching Play/Pause). Lift a new title again, or re-read
      // the aria-label, and show the new text.
      observer = new MutationObserver(() => {
        const current = activeRef.current;
        if (!current || current.el !== el) return;
        const title = el.getAttribute("title");
        if (title != null) {
          const text = title.trim();
          if (!text) {
            // Our own blanking, or our aria-label/describedby bookkeeping.
            if (!current.fromTitle) {
              const label = iconOnlyLabel(el);
              if (!label || label === current.text) return;
              activeRef.current = { ...current, text: label };
            } else return;
          } else {
            el.setAttribute("title", "");
            if (current.fromTitle) updateA11y(text);
            else attachA11y(el, text);
            // The element's text usually changed in the same commit (e.g. the
            // player advancing to a new track), so re-check clipping.
            activeRef.current = {
              ...current,
              text,
              fromTitle: true,
              unclippedHint: isRedundantTruncationTitle(el, text) && !isTruncated(el),
            };
          }
        } else if (current.fromTitle) {
          // React removed the title prop: never restore it, and fall back to
          // an icon-only aria-label or dismiss. Undo our a11y attributes first
          // so a temporary aria-label isn't mistaken for the element's own.
          detachA11y();
          const label = iconOnlyLabel(el);
          activeRef.current = {
            ...current,
            text: label,
            fromTitle: false,
            unclippedHint: false,
          };
          if (!label) {
            clearTimer();
            shownRef.current = false;
            setVisible(false);
            setActive(null);
            return;
          }
        } else {
          const label = iconOnlyLabel(el);
          if (!label || label === current.text) return;
          activeRef.current = { ...current, text: label };
        }
        const updated = activeRef.current;
        if (!canOpen(updated)) {
          // e.g. the new text fits: close a bubble that is now redundant.
          clearTimer();
          if (shownRef.current) {
            shownRef.current = false;
            setVisible(false);
            setActive(null);
          }
        } else if (shownRef.current) {
          setActive(updated);
        } else if (openTimer.current === null) {
          // A label came back (e.g. the title returned after a layout
          // toggle) while still hovered: re-arm the tooltip.
          scheduleOpen(el);
        }
      });
      observer.observe(el, {
        attributes: true,
        attributeFilter: ["title", "aria-label"],
      });

      if (!unclippedHint) scheduleOpen(el);
    };

    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target instanceof Element ? e.target : null;
      // Rich <Tooltip> triggers own their hint; don't also surface a titled
      // ancestor's tooltip underneath them.
      if (target?.closest("[data-tooltip-trigger]")) {
        release();
        return;
      }
      const current = activeRef.current;
      if (current && target && current.el.contains(target)) {
        // Still inside the active element, unless a nested titled child
        // took over.
        const nested = target.closest<HTMLElement>(TARGETS);
        if (!nested || !current.el.contains(nested)) return;
        engage(nested);
        return;
      }
      const el = target?.closest<HTMLElement>(TARGETS);
      if (el && !(el instanceof SVGElement) && tooltipText(el)) engage(el);
      else release();
    };

    const onFocusIn = (e: FocusEvent) => {
      const target = e.target instanceof HTMLElement ? e.target : null;
      if (!target || !target.matches(":focus-visible")) return;
      if (target.matches(TARGETS) && tooltipText(target)) engage(target);
    };

    const onFocusOut = (e: FocusEvent) => {
      if (activeRef.current?.el === e.target) release();
    };

    const onDismiss = () => release();
    // Clicking, scrolling, or Escape hides the bubble but keeps the title
    // lifted until the pointer leaves, so the native tooltip can't take over.
    const onHide = () => {
      clearTimer();
      if (!activeRef.current) return;
      activeRef.current = { ...activeRef.current, dismissed: true };
      shownRef.current = false;
      revealedRef.current = false;
      resetTooltipSkip();
      setVisible(false);
      setActive(null);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onHide();
    };

    document.addEventListener("pointerover", onPointerOver);
    document.addEventListener("pointerdown", onHide, true);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("scroll", onHide, true);
    window.addEventListener("blur", onDismiss);
    document.documentElement.addEventListener("pointerleave", onDismiss);
    return () => {
      release();
      description.remove();
      document.removeEventListener("pointerover", onPointerOver);
      document.removeEventListener("pointerdown", onHide, true);
      document.removeEventListener("focusin", onFocusIn);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("scroll", onHide, true);
      window.removeEventListener("blur", onDismiss);
      document.documentElement.removeEventListener("pointerleave", onDismiss);
    };
  }, []);

  if (!active) return null;
  return createPortal(
    <TooltipBubble
      anchor={active.el}
      side={active.side}
      visible={visible}
      instant={active.instant}
    >
      {active.text}
    </TooltipBubble>,
    document.body,
  );
}

function iconOnlyLabel(el: HTMLElement) {
  if (!el.matches("button[aria-label], a[aria-label]")) return "";
  if ((el.textContent ?? "").trim()) return "";
  return el.getAttribute("aria-label")?.trim() ?? "";
}

function tooltipText(el: HTMLElement) {
  return el.getAttribute("title")?.trim() || iconOnlyLabel(el);
}

function isRedundantTruncationTitle(el: HTMLElement, text: string) {
  // Controls (e.g. a collapsed nav link whose label is visually hidden) use
  // their title as the label itself, so it is never just a truncation hint.
  if (el.closest("a, button, [role='button'], input, select, textarea")) return false;
  // Leading text plus trailing adornments (a "TIDAL" badge, a "+2" alias
  // hint) still makes the title a copy of what's already on screen.
  return (el.textContent ?? "").trim().startsWith(text);
}

function isTruncated(el: HTMLElement) {
  return el.scrollWidth > el.clientWidth + 1 || el.scrollHeight > el.clientHeight + 1;
}

/**
 * Positioned tooltip bubble with an arrow. Shared by the global title layer
 * and the `Tooltip` component so both look and place identically.
 */
export function TooltipBubble({
  anchor,
  side,
  visible,
  instant,
  children,
}: {
  anchor: HTMLElement;
  side: Side;
  visible: boolean;
  /** Opened inside the skip-delay window: show with no entrance transition. */
  instant?: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number; side: Side; arrow: number } | null>(null);

  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const ar = anchor.getBoundingClientRect();
    // Layout size, not getBoundingClientRect(): the closed state's scale
    // transform would under-measure the bubble and let it overflow the edge.
    const tr = { width: tip.offsetWidth, height: tip.offsetHeight };
    let resolved = side;
    let x: number;
    let y: number;
    if (side === "right") {
      x = ar.right + GAP;
      y = ar.top + ar.height / 2 - tr.height / 2;
      if (x + tr.width > window.innerWidth - EDGE) resolved = "top";
    }
    if (resolved !== "right") {
      x = ar.left + ar.width / 2 - tr.width / 2;
      const above = ar.top - tr.height - GAP;
      const below = ar.bottom + GAP;
      if (resolved === "top" && above < EDGE) resolved = "bottom";
      else if (resolved === "bottom" && below + tr.height > window.innerHeight - EDGE) resolved = "top";
      y = resolved === "top" ? above : below;
    }
    x = Math.min(Math.max(x!, EDGE), window.innerWidth - tr.width - EDGE);
    y = Math.min(Math.max(y!, EDGE), window.innerHeight - tr.height - EDGE);
    const arrow =
      resolved === "right"
        ? ar.top + ar.height / 2 - y
        : ar.left + ar.width / 2 - x;
    setPlace((p) =>
      p && p.x === x && p.y === y && p.side === resolved && p.arrow === arrow
        ? p
        : { x, y, side: resolved, arrow },
    );
  }, [anchor, side, children]);

  return (
    <div
      ref={ref}
      role="tooltip"
      className="tooltip"
      data-side={place?.side ?? side}
      data-instant={instant || undefined}
      data-closed={!visible || !place || undefined}
      style={{
        top: place?.y ?? 0,
        left: place?.x ?? 0,
        ["--tooltip-arrow" as string]: `${place?.arrow ?? 0}px`,
      }}
    >
      {children}
    </div>
  );
}
