import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TooltipBubble } from "./TitleTooltips";

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
 * Tooltip renders rich `content` in a portaled bubble above (or below) its
 * trigger on hover and keyboard focus. Plain-text hints can just use `title=`;
 * the app-wide `TitleTooltips` layer styles those the same way.
 */
export default function Tooltip({
  content,
  children,
  delay = 300,
  placement = "top",
  className,
}: Props) {
  // Held in state, not a ref: the bubble reads the anchor during render.
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
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

  return (
    <>
      <span
        ref={setAnchor}
        className={className}
        data-tooltip-trigger=""
        onMouseEnter={show}
        onMouseLeave={hide}
        onFocus={show}
        onBlur={hide}
      >
        {children}
      </span>
      {open &&
        anchor &&
        createPortal(
          <TooltipBubble
            anchor={anchor}
            side={placement}
            visible={visible}
          >
            {content}
          </TooltipBubble>,
          document.body,
        )}
    </>
  );
}
