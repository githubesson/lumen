import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface Props {
  /** Rendered inside the tooltip bubble when visible. */
  content: ReactNode;
  /** The trigger element. Wrapped in a span that listens for hover/focus. */
  children: ReactNode;
  /** Delay before showing, in ms. Default 300. Pass 0 for instant. */
  delay?: number;
  /** Preferred placement — flips automatically when it would clip off-screen. */
  placement?: "top" | "bottom";
  /** Optional class on the wrapping trigger span, e.g. to control display. */
  className?: string;
}

/**
 * Tooltip renders `content` in a portaled bubble above (or below) its trigger
 * on hover and keyboard focus. Replaces the native `title=` attribute, which
 * has a long OS-controlled delay and no styling hook. Positioned in viewport
 * coordinates and nudges itself back on-screen if it would clip an edge.
 */
export default function Tooltip({
  content,
  children,
  delay = 300,
  placement = "top",
  className,
}: Props) {
  const anchorRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState({ x: 0, y: 0 });
  const timer = useRef<number | null>(null);

  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      setOpen(true);
      // Defer the "visible" flip to the next frame so the enter transition
      // runs from the initial (data-closed) state rather than snapping in.
      requestAnimationFrame(() => setVisible(true));
    }, delay);
  };

  const hide = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    setVisible(false);
    // Unmount a beat later so the fade-out can play.
    window.setTimeout(() => setOpen(false), 120);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  useLayoutEffect(() => {
    if (!open) return;
    const anchor = anchorRef.current;
    const tip = tipRef.current;
    if (!anchor || !tip) return;
    const ar = anchor.getBoundingClientRect();
    const tr = tip.getBoundingClientRect();
    const pad = 8;
    const gap = 6;
    let x = ar.left + ar.width / 2 - tr.width / 2;
    let y = placement === "top" ? ar.top - tr.height - gap : ar.bottom + gap;
    if (y < pad) y = ar.bottom + gap;
    if (y + tr.height > window.innerHeight - pad) y = ar.top - tr.height - gap;
    if (x < pad) x = pad;
    if (x + tr.width > window.innerWidth - pad) x = window.innerWidth - tr.width - pad;
    if (x !== coords.x || y !== coords.y) setCoords({ x, y });
  }, [open, placement, content, coords.x, coords.y]);

  return (
    <>
      <span
        ref={anchorRef}
        className={className}
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        createPortal(
          <div
            ref={tipRef}
            role="tooltip"
            className="tooltip"
            data-closed={!visible || undefined}
            style={{ top: coords.y, left: coords.x }}
          >
            {content}
          </div>,
          document.body,
        )}
    </>
  );
}
