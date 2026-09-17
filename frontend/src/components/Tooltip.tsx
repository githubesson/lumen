import {
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { TooltipBubble } from "./TitleTooltips";
import {
  OPEN_DELAY,
  markTooltipClosed,
  shouldSkipDelay,
} from "../lib/tooltipTiming";

interface Props {
  /** Rendered inside the tooltip bubble when visible. */
  content: ReactNode;
  /** The trigger element. Wrapped in a span that listens for hover/focus. */
  children: ReactNode;
  /** Delay before showing, in ms. Defaults to the shared OPEN_DELAY. Pass 0 for instant. */
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
  delay = OPEN_DELAY,
  placement = "top",
  className,
}: Props) {
  // Held in state, not a ref: the bubble reads the anchor during render.
  const [anchor, setAnchor] = useState<HTMLSpanElement | null>(null);
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const [instant, setInstant] = useState(false);
  const timer = useRef<number | null>(null);
  const hideTimer = useRef<number | null>(null);
  // The reveal is deferred by a frame, so hiding within that frame has to
  // cancel it -- otherwise the callback flips `visible` back on after hide()
  // turned it off and the exit transition never runs.
  const revealFrame = useRef<number | null>(null);
  // `open` only means "mounted": it commits a frame before the bubble is made
  // visible. Arming the shared skip window off it would credit a tooltip the
  // user never saw, so track the reveal actually completing.
  const revealed = useRef(false);

  const show = () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
    if (hideTimer.current !== null) {
      window.clearTimeout(hideTimer.current);
      hideTimer.current = null;
    }
    revealed.current = false;
    const reveal = () => {
      setOpen(true);
      // Defer the "visible" flip to the next frame so the enter transition
      // runs from the initial (data-closed) state rather than snapping in.
      revealFrame.current = requestAnimationFrame(() => {
        revealFrame.current = null;
        revealed.current = true;
        setVisible(true);
      });
    };
    // A tooltip was up moments ago: the delay has already been paid, so this
    // one is the same hint moving along the row rather than a new arrival.
    if (shouldSkipDelay()) {
      setInstant(true);
      reveal();
      return;
    }
    setInstant(false);
    timer.current = window.setTimeout(reveal, delay);
  };

  const hide = () => {
    if (timer.current !== null) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (revealFrame.current !== null) {
      cancelAnimationFrame(revealFrame.current);
      revealFrame.current = null;
    }
    setVisible(false);
    // Only a tooltip that was actually displayed arms the skip window. A brief
    // sweep across a trigger that never opened must not make the next one
    // instant -- the delay exists to be paid once, not skipped for free.
    if (revealed.current) markTooltipClosed();
    revealed.current = false;
    // Unmount a beat later so the fade-out can play.
    if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = null;
      setOpen(false);
    }, 120);
  };

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
      if (hideTimer.current !== null) window.clearTimeout(hideTimer.current);
      if (revealFrame.current !== null) cancelAnimationFrame(revealFrame.current);
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
            instant={instant}
          >
            {content}
          </TooltipBubble>,
          document.body,
        )}
    </>
  );
}
