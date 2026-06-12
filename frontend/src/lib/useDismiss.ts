import { useEffect, type RefObject } from "react";

/**
 * Dismiss a popover/menu on outside mousedown or Escape. Replaces the
 * hand-rolled copies in TrackContextMenu / QueuePopover / TweaksPanel / Select
 * that had drifted (e.g. capture-phase in one, not the others — the classic
 * "menu won't close" source).
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  opts: {
    onDismiss: () => void;
    /** When false, no listeners are attached (e.g. while closed). */
    enabled?: boolean;
    /** Listen on the capture phase so portal children can't stopPropagation. */
    capture?: boolean;
    /** Return true for a target that should NOT dismiss (e.g. the toggle button). */
    ignore?: (target: Node) => boolean;
  },
): void {
  const { onDismiss, enabled = true, capture = false, ignore } = opts;
  useEffect(() => {
    if (!enabled) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node | null;
      if (!target) return;
      if (ref.current?.contains(target)) return;
      if (ignore?.(target)) return;
      onDismiss();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onDismiss();
    };
    window.addEventListener("mousedown", onDown, capture);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown, capture);
      window.removeEventListener("keydown", onKey);
    };
  }, [ref, onDismiss, enabled, capture, ignore]);
}
