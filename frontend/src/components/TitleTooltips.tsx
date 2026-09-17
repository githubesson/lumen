import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

type Side = "top" | "bottom" | "right";

interface Active {
  el: HTMLElement;
  text: string;
  side: Side;
  /** Whether `text` came from a `title` that was lifted off the element. */
  fromTitle: boolean;
}

const TARGETS = "[title], button[aria-label], a[aria-label]";

const OPEN_DELAY = 500;
/** After a tooltip closes, neighbours open instantly for this long. */
const SKIP_DELAY_WINDOW = 300;
const GAP = 6;
const EDGE = 8;

/**
 * App-wide replacement for native `title=` tooltips. Hovering (or keyboard
 * focusing) any element with a `title` shows a styled bubble instead of the OS
 * tooltip. Icon-only buttons and links without a title use their
 * `aria-label`, so every icon control gets a hint. The attribute is lifted off the element while it is active, so the
 * native tooltip never appears, and put back afterwards so React's view of the
 * DOM stays accurate.
 *
 * Elements can opt into a side with `data-tooltip-side="right"` (e.g. the
 * collapsed sidebar rail). On non-interactive text, a title that only repeats
 * the element's own text is a truncation hint and shows only when clipped.
 */
export default function TitleTooltips() {
  const [active, setActive] = useState<Active | null>(null);
  const [visible, setVisible] = useState(false);
  const activeRef = useRef<Active | null>(null);
  const openTimer = useRef<number | null>(null);
  const lastClosedAt = useRef(0);

  useEffect(() => {
    let observer: MutationObserver | null = null;

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
      // Restore the lifted title unless React set a newer one meanwhile.
      if (current.fromTitle && !current.el.hasAttribute("title")) {
        current.el.setAttribute("title", current.text);
      }
      activeRef.current = null;
      lastClosedAt.current = Date.now();
      setVisible(false);
      setActive(null);
    };

    const engage = (el: HTMLElement) => {
      if (activeRef.current?.el === el) return;
      release();
      const title = el.getAttribute("title")?.trim();
      const fromTitle = !!title;
      const text = title || iconOnlyLabel(el);
      if (!text) return;
      if (fromTitle && isRedundantTruncationTitle(el, text) && !isTruncated(el)) return;

      if (fromTitle) el.removeAttribute("title");
      const side = (el.dataset.tooltipSide as Side | undefined) ?? "top";
      const next: Active = { el, text, side, fromTitle };
      activeRef.current = next;

      // React may update the title while the tooltip is showing (e.g. a
      // toggle button's label). Lift it again and show the new text.
      observer = new MutationObserver(() => {
        const updated = el.getAttribute("title");
        if (updated == null || !activeRef.current) return;
        el.removeAttribute("title");
        activeRef.current = { ...activeRef.current, text: updated.trim() };
        setActive(activeRef.current);
      });
      observer.observe(el, { attributes: true, attributeFilter: ["title"] });

      const open = () => {
        openTimer.current = null;
        if (activeRef.current !== next) return;
        setActive(next);
        requestAnimationFrame(() => {
          if (activeRef.current === next) setVisible(true);
        });
      };
      if (Date.now() - lastClosedAt.current < SKIP_DELAY_WINDOW) open();
      else openTimer.current = window.setTimeout(open, OPEN_DELAY);
    };

    const onPointerOver = (e: PointerEvent) => {
      if (e.pointerType === "touch") return;
      const target = e.target instanceof Element ? e.target : null;
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
      lastClosedAt.current = 0;
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
  return (el.textContent ?? "").trim() === text;
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
  children,
}: {
  anchor: HTMLElement;
  side: Side;
  visible: boolean;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [place, setPlace] = useState<{ x: number; y: number; side: Side; arrow: number } | null>(null);

  useLayoutEffect(() => {
    const tip = ref.current;
    if (!tip) return;
    const ar = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
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
